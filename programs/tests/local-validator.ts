import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from '@solana/kit';
import { depositInstruction } from './src/basket';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, REPO_ROOT } from './src/env';
import { buildWorld, type Ledger, type MintName } from './src/world';

// Starts a local validator with the two built programs loaded, builds the same world of vaults the
// fixtures hold (src/world.ts) by sending real transactions, writes what it made to <dir>/world.json,
// prints READY and keeps the validator up until it is told to stop. For the adapter's integration test:
//
//   pnpm exec tsx programs/tests/local-validator.ts <dir> <rpc port>      (from the repo root)
//
// Every key is made here, lives in this process only, and holds nothing outside this validator.

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) throw new Error('usage: local-validator.ts <dir> <rpc port>');
const port = Number(portArg);
const url = `http://127.0.0.1:${port}`;
const rpc = createSolanaRpc(url);

const SCOPE_BYTES = 28_712;
/** Round numbers at free indexes, as in the fixtures: not market data. `age` is seconds before the start. */
const PRICES: Record<MintName, { index: number; value: bigint; exponent: bigint; age: number }> = {
  usdc: { index: 13, value: 100_000_000n, exponent: 8n, age: 20 },
  spyx: { index: 344, value: 10_000_000_000n, exponent: 8n, age: 30 },
  nvdax: { index: 332, value: 500_000n, exponent: 4n, age: 45 },
  gold: { index: 100, value: 2_005n, exponent: 1n, age: 400 },
  tslax: { index: 338, value: 20n, exponent: 0n, age: 0 },
};
const EMPTY_INDEX = 7;

const decimal = (value: bigint, exponent: bigint) => {
  const digits = value.toString().padStart(Number(exponent) + 1, '0');
  const whole = digits.slice(0, digits.length - Number(exponent));
  const frac = digits.slice(digits.length - Number(exponent)).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

/** A price account in Scope's layout, as a file the validator loads at start. No program writes it. */
function priceAccountFile(address: Address, startedAt: number): string {
  const data = new Uint8Array(SCOPE_BYTES);
  data.set(createHash('sha256').update('account:OraclePrices').digest().subarray(0, 8), 0);
  data.set(getAddressEncoder().encode(MOCK_ROUTER_PROGRAM), 8);
  const view = new DataView(data.buffer);
  for (const { index, value, exponent, age } of Object.values(PRICES)) {
    const at = 40 + 56 * index;
    view.setBigUint64(at, value, true);
    view.setBigUint64(at + 8, exponent, true);
    view.setBigUint64(at + 24, BigInt(startedAt - age), true);
  }
  const file = join(dir as string, 'price-account.json');
  writeFileSync(
    file,
    JSON.stringify({
      pubkey: address,
      account: {
        lamports: 1_000_000_000,
        data: [Buffer.from(data).toString('base64'), 'base64'],
        // The test exchange stands in for the price program, as Config says below.
        owner: MOCK_ROUTER_PROGRAM,
        executable: false,
        rentEpoch: 0,
        space: SCOPE_BYTES,
      },
    }),
  );
  return file;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilUp(validator: ChildProcess): Promise<void> {
  for (let i = 0; i < 240; i++) {
    if (validator.exitCode !== null) throw new Error('the validator stopped while starting');
    try {
      // Healthy, and a few confirmed slots in: a transaction sent at slot 0 is refused.
      const healthy = (await rpc.getHealth().send()) === 'ok';
      if (healthy && (await rpc.getSlot({ commitment: 'confirmed' }).send()) > 3n) return;
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error('the validator did not come up in two minutes');
}

/** Sends one transaction and waits for a confirmed block. Returns its signature and whether it failed. */
async function sendAndWait(
  payer: TransactionSigner,
  instructions: Instruction[],
  skipPreflight = false,
): Promise<{ signature: string; failed: boolean }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: 'base64',
      skipPreflight,
      preflightCommitment: 'confirmed',
    })
    .send();
  for (let i = 0; i < 120; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
      return { signature, failed: status.err !== null };
    await sleep(250);
  }
  throw new Error(`transaction ${signature} did not confirm`);
}

async function main(): Promise<void> {
  for (const binary of ['basket.so', 'mock_router.so'])
    if (!existsSync(join(REPO_ROOT, 'target', 'deploy', binary)))
      throw new Error(`target/deploy/${binary} is not built: see programs/README.md`);
  mkdirSync(dir as string, { recursive: true });

  const deployer = await generateKeyPairSigner();
  const priceAccount = (await generateKeyPairSigner()).address;
  const startedAt = Math.floor(Date.now() / 1000);
  const deploy = (name: string) => join(REPO_ROOT, 'target', 'deploy', name);

  // Its own ports throughout, so it runs beside any other validator on the machine.
  const validator = spawn(
    'solana-test-validator',
    [
      ...['--ledger', join(dir as string, 'ledger'), '--reset', '--quiet'],
      ...['--bind-address', '127.0.0.1', '--rpc-port', String(port)],
      ...['--faucet-port', String(port + 2), '--gossip-port', String(port + 3)],
      ...['--dynamic-port-range', `${port + 10}-${port + 40}`],
      // The deployer starts with the validator's SOL and is the vault program's upgrade authority.
      ...['--mint', deployer.address],
      ...['--upgradeable-program', BASKET_PROGRAM, deploy('basket.so'), deployer.address],
      ...['--bpf-program', MOCK_ROUTER_PROGRAM, deploy('mock_router.so')],
      ...['--account', priceAccount, priceAccountFile(priceAccount, startedAt)],
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => {
    validator.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();

  try {
    await waitUntilUp(validator);
    const signatures: string[] = [];
    const ledger: Ledger = {
      send: async (payer, instructions) => {
        const { signature, failed } = await sendAndWait(payer, instructions);
        if (failed) throw new Error(`transaction ${signature} failed`);
        signatures.push(signature);
      },
      rent: (bytes) => rpc.getMinimumBalanceForRentExemption(bytes).send(),
    };
    const world = await buildWorld(ledger, deployer);

    // One transaction that lands and fails with the vault's own error: a deposit of a token that is
    // not the cash mint. Sent without the node's dry run, which would refuse it before it lands.
    const refused = await sendAndWait(
      world.signers.owner,
      [
        await depositInstruction({
          owner: world.signers.owner,
          vault: world.names.vaults.following,
          mint: world.mints.spyx,
          amount: 1n,
        }),
      ],
      true,
    );
    if (!refused.failed) throw new Error('the vault took a deposit that is not cash');

    writeFileSync(
      join(dir as string, 'world.json'),
      JSON.stringify(
        {
          rpcUrl: url,
          names: world.names,
          expected: world.expected,
          prices: {
            account: priceAccount,
            owner: MOCK_ROUTER_PROGRAM,
            entries: Object.fromEntries(
              Object.entries(PRICES).map(([name, p]) => [
                name,
                { index: p.index, usdPerToken: decimal(p.value, p.exponent), ageSeconds: p.age },
              ]),
            ),
            emptyIndex: EMPTY_INDEX,
          },
          landedTxId: signatures.at(-1),
          revertedTx: { txId: refused.signature, code: 'NotCashMint' },
          transactions: signatures.length + 1,
        },
        null,
        2,
      ),
    );
    console.log('READY');
  } catch (error) {
    validator.kill('SIGTERM');
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

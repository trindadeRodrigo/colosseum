import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, createSolanaRpc, generateKeyPairSigner } from '@solana/kit';
import { depositInstruction } from './src/basket';
import { BASKET_PROGRAM, MOCK_ROUTER_PROGRAM, REPO_ROOT } from './src/env';
import { sendAndWait, waitUntilUp } from './src/validator';
import {
  buildWorld,
  type Ledger,
  WORLD_EMPTY_INDEX,
  worldPriceAccount,
  worldPricesExpected,
} from './src/world';

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

/** A price account in Scope's layout, as a file the validator loads at start. No program writes it. */
function priceAccountFile(address: Address, startedAt: number): string {
  const data = worldPriceAccount(0n, BigInt(startedAt), MOCK_ROUTER_PROGRAM);
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
        space: data.length,
      },
    }),
  );
  return file;
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
    await waitUntilUp(rpc, validator);
    const signatures: string[] = [];
    const ledger: Ledger = {
      send: async (payer, instructions) => {
        const { signature, failed } = await sendAndWait(rpc, payer, instructions);
        if (failed) throw new Error(`transaction ${signature} failed`);
        signatures.push(signature);
      },
      rent: (bytes) => rpc.getMinimumBalanceForRentExemption(bytes).send(),
    };
    const world = await buildWorld(ledger, deployer, priceAccount);

    // One transaction that lands and fails with the vault's own error: a deposit of a token that is
    // not the cash mint. Sent without the node's dry run, which would refuse it before it lands.
    const refused = await sendAndWait(
      rpc,
      world.signers.owner,
      [
        await depositInstruction({
          owner: world.signers.owner,
          vault: world.names.vaults.following,
          mint: world.mints.spyx,
          amount: 1n,
        }),
      ],
      { skipPreflight: true },
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
            entries: worldPricesExpected(),
            emptyIndex: WORLD_EMPTY_INDEX,
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

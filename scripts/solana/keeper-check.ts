import { readFileSync } from 'node:fs';
import { loadKeypair } from '@colosseum/chain-solana/server';
import {
  assertNode,
  associatedTokenAddress,
  createSolanaVaultAdapter,
  createTokenAccountInstruction,
  createVaultRpc,
  deploymentAddresses,
  deploymentAssets,
  recipeAddress,
  SolanaDeploymentRecord,
  TOKEN_PROGRAM,
  vaultAddress,
} from '@colosseum/chain-solana/vault';
import { type BuiltTx, parseChainConfigs, type Recipe } from '@colosseum/schemas';
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type IInstruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from '@solana/kit';

// The keeper's check on Solana devnet (KEEP-1): a vault that follows a shared portfolio with auto-follow
// on, and a new version of that portfolio published, for the keeper to adopt and rebalance.
//
//   SOLANA_RPC_URL=<devnet> SOLANA_DEPLOYER_KEYPAIR=<path> pnpm exec tsx scripts/solana/keeper-check.ts setup
//
// It makes a test creator and a test owner (keys in this process only), funds them from the deploy key
// (0.15 SOL each, 300 test dollars to the owner), publishes a portfolio of three stocks with an oracle
// (gold has none on devnet, and a portfolio holding it does not auto-follow: gate GOLD-ONE-TAP), opens the
// owner's vault following it with auto-follow off, buys the three at the portfolio's weights, switches
// auto-follow on, waits one publish delay and publishes the next version, weights only, which takes
// effect one publish delay later. Then the keeper (apps/keeper) adopts it and rebalances. Devnet only: the node has to answer devnet's genesis, from the record.
// Every signature is printed with its explorer link. Nothing here touches mainnet.

const record = SolanaDeploymentRecord.parse(
  JSON.parse(
    readFileSync(new URL('../../deployments/solana-devnet.json', import.meta.url), 'utf8'),
  ),
);
const explorer = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const say = (what: string, sig: string) => console.log(`${what}\t${sig}\t${explorer(sig)}`);

async function main() {
  const [mode] = process.argv.slice(2);
  const url = process.env.SOLANA_RPC_URL?.trim();
  const deployerPath = process.env.SOLANA_DEPLOYER_KEYPAIR?.trim();
  if (!url || !deployerPath) throw new Error('set SOLANA_RPC_URL and SOLANA_DEPLOYER_KEYPAIR');
  const rpc = createVaultRpc(url);
  await assertNode(rpc, record);
  const deployer = await loadKeypair(deployerPath);
  if (deployer.address !== record.roles.tokenAuthority)
    throw new Error("the deploy key is not the record's token authority");

  const { program, router, priceAccount } = deploymentAddresses(record);
  const config = parseChainConfigs(
    {
      CHAIN_NETWORK_SOLANA: 'testnet',
      CHAIN_ROUTER_SOLANA: router,
      CHAIN_PRICE_SOURCE_SOLANA: priceAccount,
    },
    { solana: { program } },
  ).solana;
  const adapter = createSolanaVaultAdapter({
    config,
    rpc,
    assets: deploymentAssets(record),
    autoFollow: true,
  });

  const signers = new Map<string, KeyPairSigner>([[deployer.address, deployer]]);
  /** The public devnet node drops a call now and then: a call that did not get an answer is asked again. */
  async function retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (e) {
        const unavailable =
          e instanceof Error && /did not answer|fetch failed|429|503/.test(e.message);
        if (!unavailable || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }
  }
  async function sendWire(wire: string): Promise<string> {
    // The same signed bytes sent again land once, so a send that got no answer is sent again.
    const sig = await retry(() =>
      rpc
        .sendTransaction(wire as never, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send(),
    );
    for (let i = 0; i < 120; i++) {
      const answer = await rpc
        .getSignatureStatuses([sig])
        .send()
        .catch(() => null);
      const s = answer?.value[0];
      if (s?.err) throw new Error(`${sig} failed: ${JSON.stringify(s.err)}`);
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized')
        return sig;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`${sig} did not confirm`);
  }
  async function run(payer: KeyPairSigner, ixs: IInstruction[], what: string) {
    const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const tx = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(payer.address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(value, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    );
    const signed = await signTransaction([payer.keyPair], tx);
    say(what, await sendWire(getBase64EncodedWireTransaction(signed)));
  }
  async function must(build: BuiltTx | (() => Promise<BuiltTx>), what: string) {
    const tx = typeof build === 'function' ? await retry(build) : build;
    const signer = signers.get(tx.signer);
    if (!signer) throw new Error(`no key for ${tx.signer}`);
    const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(tx.payload));
    const signed = await signTransaction([signer.keyPair], decoded);
    say(what, await sendWire(getBase64EncodedWireTransaction(signed)));
  }
  const recipe = (creator: Address, version: number, weights: [string, number][]): Recipe => ({
    schemaVersion: 1,
    familyId:
      'ee'.repeat(16) +
      creator
        .slice(0, 32)
        .split('')
        .map((c) => (c.charCodeAt(0) % 16).toString(16))
        .join(''),
    chain: 'solana',
    onchainId: null,
    creator,
    kind: 'community',
    version,
    effectiveAt: 0,
    components: weights.map(([asset, weightBps]) => ({
      kind: 'asset',
      asset: `solana:${asset}`,
      weightBps,
    })),
    metaHash: version.toString(16).padStart(2, '0').repeat(32),
    maxFeeBps: 0,
    flags: 0,
  });

  if (mode === 'setup') {
    const [creator, owner] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    signers.set(creator.address, creator);
    signers.set(owner.address, owner);
    console.log(`creator\t${creator.address}\nowner\t${owner.address}`);
    const sol = (lamports: bigint, to: Address): IInstruction => ({
      programAddress: '11111111111111111111111111111111' as Address,
      accounts: [
        { address: deployer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: to, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([lamports]).buffer)]),
    });
    const cash = { mint: record.cash.mint as Address, tokenProgram: TOKEN_PROGRAM };
    const ownerCash = await associatedTokenAddress(owner.address, cash.mint, TOKEN_PROGRAM);
    await run(
      deployer,
      [
        sol(150_000_000n, creator.address),
        sol(150_000_000n, owner.address),
        createTokenAccountInstruction({
          payer: deployer.address,
          account: ownerCash,
          holder: owner.address,
          token: cash,
        }),
        {
          programAddress: TOKEN_PROGRAM,
          accounts: [
            { address: cash.mint, role: AccountRole.WRITABLE },
            { address: ownerCash, role: AccountRole.WRITABLE },
            { address: deployer.address, role: AccountRole.READONLY_SIGNER },
          ],
          data: new Uint8Array([7, ...new Uint8Array(new BigUint64Array([300_000_000n]).buffer)]),
        },
      ],
      'fund the test creator and owner',
    );
    const first = recipe(creator.address, 1, [
      ['spyx', 4_000],
      ['qqqx', 3_000],
      ['nvdax', 3_000],
    ]);
    await must(
      () => adapter.buildPublishRecipe({ creator: creator.address, recipe: first }),
      'publish version 1',
    );
    const at = await recipeAddress(
      program as Address,
      creator.address,
      new Uint8Array(Buffer.from(first.familyId, 'hex')),
    );
    console.log(`recipe\t${at}`);
    await must(
      () =>
        adapter.buildCreateVault({
          owner: owner.address,
          basketId: '1',
          targets: [],
          recipeOnchainId: at,
          expectedVersion: 1,
          autoFollow: false,
          depositRaw: '300000000',
          slippageBps: 100,
        }),
      'open the vault, following version 1, auto-follow off',
    );
    const vault = await vaultAddress(program as Address, owner.address, 1n);
    console.log(`vault\t${vault}`);
    for (const [asset, dollars] of [
      ['spyx', 120],
      ['qqqx', 90],
      ['nvdax', 90],
    ] as const)
      await must(
        () =>
          adapter.buildOwnerSwap({
            vault,
            trades: [
              {
                sell: 'solana:usdc',
                buy: `solana:${asset}`,
                amountInRaw: String(dollars * 1_000_000),
              },
            ],
            slippageBps: 100,
          }),
        `the owner buys $${dollars} of ${asset}`,
      );
    await must(
      () => adapter.buildSetAutoFollow({ vault, on: true }),
      'auto-follow on, after the buys',
    );
    // The creator's key is needed once more, for the next version: kept in this process only, so the
    // update runs here after one publish delay.
    console.log(
      `waiting ${record.params.publishDelayS + 5} s, one publish delay, before the next version`,
    );
    await new Promise((r) => setTimeout(r, (record.params.publishDelayS + 5) * 1000));
    const second = recipe(creator.address, 2, [
      ['spyx', 5_000],
      ['qqqx', 2_000],
      ['nvdax', 3_000],
    ]);
    await must(
      () => adapter.buildPublishRecipe({ creator: creator.address, recipe: second }),
      'publish version 2, weights only',
    );
    const { pending } = await adapter.getRecipe(at);
    console.log(`version 2 takes effect at ${pending?.effectiveAt} (unix s)`);
    return;
  }
  throw new Error(`usage: keeper-check.ts setup (got ${mode ?? 'nothing'})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

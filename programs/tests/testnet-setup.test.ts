import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, isSome, type KeyPairSigner } from '@solana/kit';
import { decodeMint } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ASSET_KEEPER, readAssets, readConfig } from './src/basket';
import { createWorld, fundedSigner, MOCK_ROUTER_PROGRAM, REPO_ROOT, setClock } from './src/env';
import { SESSION } from './src/keeper';
import { decodeRouter, routerAddress } from './src/mock-router';
import { clusterOf, DEVNET_GENESIS, liteChain, MAINNET_GENESIS } from './src/testnet/chain';
import { planOf, type SetupPlan } from './src/testnet/config';
import { lifecycle } from './src/testnet/lifecycle';
import { type Deployment, guardSolanaEntry, setUp } from './src/testnet/setup';
import { mintExtensionEntries, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './src/tokens';

const CONFIG_FILE = join(REPO_ROOT, 'scripts', 'testnet', 'solana', 'devnet.config.json');

// The set-up of a Solana test network (scripts/testnet/solana/setup.ts), run here in LiteSVM with
// the config file that is committed for devnet: the same steps, the same transactions, and then a
// vault living on what they made. On a real cluster only the transport differs.
describe('the test-network set-up', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let keeper: KeyPairSigner;
  let writer: KeyPairSigner;
  let plan: SetupPlan;
  let deployment: Deployment;
  let firstRun: number;
  let dryRun: { transactions: number; lines: string[] };
  const lines: string[] = [];

  const file = () => JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  const withRoles = (config: ReturnType<typeof file>) => ({
    ...config,
    roles: {
      guardian: guardian.address,
      defaultKeeper: keeper.address,
      priceWriter: writer.address,
    },
  });
  const run = (
    chosen: SetupPlan = plan,
    options: { dryRun?: boolean; log?: (line: string) => void } = {},
  ) =>
    setUp(liteChain(svm), admin, chosen, {
      dryRun: options.dryRun ?? false,
      log: options.log ?? (() => {}),
      withLookupTable: false,
    });
  const data = (account: Address) => {
    const found = svm.getAccount(account);
    if (!found.exists) throw new Error(`no account at ${account}`);
    return found;
  };

  beforeAll(async () => {
    ({ svm, deployer: admin } = await createWorld());
    guardian = await fundedSigner(svm);
    keeper = await fundedSigner(svm);
    writer = await fundedSigner(svm);
    setClock(svm, SESSION);
    plan = planOf(withRoles(file()));
    const printed: string[] = [];
    const dry = await run(plan, { dryRun: true, log: (line) => printed.push(line) });
    dryRun = { transactions: dry.transactions, lines: printed };
    const real = await run(plan, { log: (line) => lines.push(line) });
    firstRun = real.transactions;
    deployment = real.deployment;
  });

  it('prints every transaction of a dry run and sends none of them', () => {
    expect(dryRun.transactions).toBe(firstRun);
    expect(dryRun.lines.filter((line) => line === '    not sent: dry run')).toHaveLength(firstRun);
    expect(dryRun.lines.some((line) => line.startsWith('    sent: '))).toBe(false);
    // Each transaction is printed with its instructions, their accounts and their data.
    expect(dryRun.lines.filter((line) => /^#\d+ /.test(line))).toHaveLength(firstRun);
    expect(dryRun.lines.some((line) => line.includes('basket: init_config'))).toBe(true);
    expect(dryRun.lines.some((line) => /^ {6}sw [1-9A-HJ-NP-Za-km-z]{32,44}$/.test(line))).toBe(
      true,
    );
  });

  it('sends transactions a cluster takes: none is over 1,232 bytes', () => {
    const sizes = lines
      .map((line) => line.match(/^ {4}sent: \S+ \((\d+) bytes\)$/)?.[1])
      .filter((bytes): bytes is string => bytes !== undefined)
      .map(Number);
    expect(sizes).toHaveLength(firstRun);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1_232);
  });

  it('sends nothing the second time', async () => {
    const printed: string[] = [];
    const again = await run(plan, { log: (line) => printed.push(line) });
    expect(again.transactions).toBe(0);
    expect(printed.at(-1)).toBe('nothing to send: the network is as the config says');
    expect(again.deployment).toEqual(deployment);
  });

  it('makes the thirteen test tokens and the test dollar, each saying it is a test token', () => {
    expect(deployment.assets.map((asset) => asset.symbol)).toEqual([
      'tSPYx',
      'tQQQx',
      'tNVDAx',
      'tTSLAx',
      'tAAPLx',
      'tGOOGLx',
      'tMETAx',
      'tMSTRx',
      'tCRCLx',
      'tHOODx',
      'tGLDx',
      'tjlUSDC',
      'tsyrupUSDC',
    ]);
    expect(deployment.cash).toMatchObject({ symbol: 'tUSDC', tokenProgram: 'token', decimals: 6 });
    for (const token of [deployment.cash, ...deployment.assets]) {
      expect(token.name).toBe(`Test ${token.modelOf} (test network, no value)`);
      const account = data(token.mint);
      const program = token.tokenProgram === 'token-2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      expect([token.symbol, account.programAddress]).toEqual([token.symbol, program]);
      const mint = decodeMint(account).data;
      expect([token.symbol, mint.decimals]).toEqual([token.symbol, token.decimals]);
      // The admin can mint, freeze and, on a stock token, change the multiplier.
      expect(mint.mintAuthority).toEqual({ __option: 'Some', value: admin.address });
    }
  });

  it("gives a stock token the real mint's extensions, in the real mint's order", () => {
    // SPYx on mainnet: metadata pointer 18, permanent delegate 12, default account state 6, scaled
    // UI amount 25, pausable 26, confidential transfer 4, transfer hook 14, and its metadata 19.
    const real = [18, 12, 6, 25, 26, 4, 14, 19];
    for (const asset of deployment.assets.filter((a) => a.tokenProgram === 'token-2022')) {
      const account = data(asset.mint);
      const types = mintExtensionEntries(new Uint8Array(account.data)).map((e) => e.type);
      expect([asset.symbol, types]).toEqual([asset.symbol, real]);
      const mint = decodeMint(account).data;
      const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
      const hook = extensions.find((e) => e.__kind === 'TransferHook');
      // An authority and no program: the vault program lists it, as it lists the real one.
      expect(hook).toMatchObject({ programId: '11111111111111111111111111111111' });
      const named = extensions.find((e) => e.__kind === 'TokenMetadata');
      expect(named).toMatchObject({ name: asset.name, symbol: asset.symbol });
      const scaled = extensions.find((e) => e.__kind === 'ScaledUiAmountConfig');
      expect(scaled).toMatchObject({ authority: admin.address });
    }
    const spyx = deployment.assets.find((a) => a.id === 'solana:spyx');
    if (!spyx) throw new Error('no SPYx');
    const mint = decodeMint(data(spyx.mint)).data;
    const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
    expect(extensions.find((e) => e.__kind === 'ScaledUiAmountConfig')).toMatchObject({
      multiplier: 1.0057146,
    });
  });

  it("makes the exchange's price account and names it everywhere it is read", async () => {
    const prices = deployment.accounts.priceAccount;
    const account = data(prices);
    expect(account.programAddress).toBe(MOCK_ROUTER_PROGRAM);
    expect(account.data.length).toBe(28_712);
    const router = decodeRouter(new Uint8Array(data(await routerAddress()).data));
    expect([router.admin, router.prices, router.priceWriter]).toEqual([
      admin.address,
      prices,
      writer.address,
    ]);
    expect((await readAssets(svm)).priceAccounts[0]).toBe(prices);
    // Every token has a first price and an average, stamped with the cluster's clock.
    const view = new DataView(account.data.buffer, account.data.byteOffset);
    for (const asset of deployment.assets)
      for (const index of [asset.priceIndex, asset.twapIndex]) {
        const at = 40 + 56 * index;
        expect([asset.symbol, view.getBigUint64(at, true) > 0n]).toEqual([asset.symbol, true]);
        expect(view.getBigUint64(at + 8, true)).toBe(8n);
        expect(view.getBigUint64(at + 24, true)).toBe(SESSION);
      }
  });

  it("initialises the vault program's Config from the config file, and never launches", async () => {
    const config = await readConfig(svm);
    expect(config).toMatchObject({
      admin: admin.address,
      guardian: guardian.address,
      defaultKeeper: keeper.address,
      routerProgram: MOCK_ROUTER_PROGRAM,
      priceOwner: MOCK_ROUTER_PROGRAM,
      cashMint: deployment.cash.mint,
      launched: false,
      keeperPaused: false,
      lossCapBps: 100,
      toleranceBps: 75,
      bandBps: 50,
    });
  });

  it('lists every token with the entries of the index table, and switches the keeper on', async () => {
    const table: { assets: { symbol: string; priceIndex: number; twapIndex: number }[] } =
      JSON.parse(
        readFileSync(join(REPO_ROOT, 'fixtures', 'solana-vault', 'scope-indexes.json'), 'utf8'),
      );
    const listed = (await readAssets(svm)).assets;
    expect(listed).toHaveLength(13);
    for (const asset of deployment.assets) {
      const entry = listed.find((e) => e.mint === asset.mint);
      const real = table.assets.find((row) => row.symbol === asset.modelOf);
      expect([asset.symbol, entry]).toEqual([
        asset.symbol,
        expect.objectContaining({
          priceSlot: 0,
          priceKind: 1,
          priceIndex: real?.priceIndex ?? asset.priceIndex,
          twapIndex: real?.twapIndex ?? asset.twapIndex,
          decimals: asset.decimals,
          session: asset.session,
          flags: ASSET_KEEPER,
          minPrice: BigInt(asset.range?.minPrice ?? 0),
          maxPrice: BigInt(asset.range?.maxPrice ?? 0),
        }),
      ]);
      expect([asset.symbol, asset.indexSource]).toEqual([
        asset.symbol,
        real ? 'scope-indexes' : 'test-network',
      ]);
    }
    // The dollar token is never a position, so it is not on the list.
    expect(listed.some((e) => e.mint === deployment.cash.mint)).toBe(false);
  });

  it('sends one transaction when the config changes one thing', async () => {
    const changed = file();
    const spyx = changed.tokens.find((t: { id: string }) => t.id === 'solana:spyx');
    spyx.keeper = { minUsd: '650', maxUsd: '900' };
    const printed: string[] = [];
    const moved = await run(planOf(withRoles(changed)), { log: (line) => printed.push(line) });
    expect(moved.transactions).toBe(1);
    expect(
      printed.some((line) => line.includes('upsert_asset tSPYx: flags 1, range 650000000')),
    ).toBe(true);
    // And off again, by taking the range away.
    spyx.keeper = null;
    const off = await run(planOf(withRoles(changed)));
    expect(off.transactions).toBe(1);
    const entry = (await readAssets(svm)).assets.find((e) => e.mint === deployment.assets[0]?.mint);
    expect(entry).toMatchObject({ flags: 0, minPrice: 0n, maxPrice: 0n });
    // Back to what the committed file says, for the tests below.
    expect((await run()).transactions).toBe(1);
    expect((await run()).transactions).toBe(0);
  });

  it("writes what the SDK's guard reads: the program, the router, and every mint once", () => {
    const entry = guardSolanaEntry(deployment);
    expect(Object.keys(entry).sort()).toEqual(['assets', 'cash', 'family', 'program', 'router']);
    expect(entry.cash).toBe('solana:usdc');
    expect(Object.keys(entry.assets)).toHaveLength(14);
    for (const id of Object.keys(entry.assets)) expect(id).toMatch(/^solana:[a-z0-9][a-z0-9-]*$/);
    const addresses = [
      entry.program,
      entry.router,
      ...Object.values(entry.assets).map((a) => a.mint),
    ];
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('carries a vault through its life: create, deposit, a swap, a keeper leg, an accept', async () => {
    const owner = await fundedSigner(svm);
    const creator = await fundedSigner(svm);
    const printed: string[] = [];
    const lived = await lifecycle(
      liteChain(svm),
      deployment,
      { admin, owner, keeper, creator },
      (line) => printed.push(line),
    );
    expect(lived.steps.map((s) => s.what.split(':')[0])).toEqual([
      'the admin hands the owner 1,000 test dollars',
      'create',
      'deposit',
      'swap',
      'prices written again, stamped now',
      'keeper leg',
      'publish',
      'accept',
    ]);
    // 400 dollars of tSPYx at 773.62 less 15 bps, and 250 of tjlUSDC at one dollar less 5 bps.
    expect(lived.holds).toEqual({
      'solana:usdc': 350_000000n,
      'solana:spyx': 51_627_413n,
      'solana:jlusdc': 249_875_000n,
    });
    // The leg lost its spread, 5 bps of 250 dollars, and the counter holds it.
    expect(lived.lossAccum).toBe(125_000n);
    expect(lived.acceptedVersion).toBe(1);
  });

  it('refuses a config with a role left out, a range its first price is outside of, or an entry used twice', () => {
    const base = file();
    expect(() => planOf(base)).toThrow(/roles\.guardian is not set/);
    const outside = withRoles(file());
    outside.tokens[0].keeper = { minUsd: '100', maxUsd: '200' };
    expect(() => planOf(outside)).toThrow(/first price is outside the range/);
    const wide = withRoles(file());
    wide.tokens[0].keeper = { minUsd: '400', maxUsd: '801' };
    expect(() => planOf(wide)).toThrow(/at most twice/);
    const twice = withRoles(file());
    twice.tokens[10].priceIndex = 344;
    expect(() => planOf(twice)).toThrow(/share price entry 344/);
    const unknown = withRoles(file());
    unknown.tokens[0].modelOf = 'MSFTx';
    expect(() => planOf(unknown)).toThrow(/MSFTx has no entry/);
  });

  it('runs on devnet and on this machine, and refuses mainnet wherever it is served from', () => {
    expect(clusterOf('https://api.devnet.solana.com', DEVNET_GENESIS)).toBe('devnet');
    expect(clusterOf('http://127.0.0.1:8899', 'LocalGenesis1111111111111111111111111111111')).toBe(
      'local',
    );
    for (const url of ['https://api.mainnet-beta.solana.com', 'http://127.0.0.1:8899'])
      expect(() => clusterOf(url, MAINNET_GENESIS)).toThrow(/mainnet/);
    const elsewhere = 'OtherCluster1111111111111111111111111111111';
    expect(() => clusterOf('https://rpc.example.com', elsewhere)).toThrow(
      /neither devnet nor on this machine/,
    );
  });

  it('keeps "admin" for a role as the key that runs the set-up', () => {
    const own = file();
    own.roles = { guardian: 'admin', defaultKeeper: 'admin', priceWriter: null };
    expect(planOf(own).roles).toEqual({
      guardian: 'admin',
      defaultKeeper: 'admin',
      priceWriter: null,
    });
  });
});

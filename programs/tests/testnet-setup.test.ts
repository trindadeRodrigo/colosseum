import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  isSome,
  type KeyPairSigner,
  type RpcTransport,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from '@solana/kit';
import { decodeMint } from '@solana-program/token-2022';
import type { LiteSVM } from 'litesvm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ASSET_KEEPER, readAssets, readConfig } from './src/basket';
import {
  createWorld,
  expectError,
  fundedSigner,
  MOCK_ROUTER_PROGRAM,
  REPO_ROOT,
  send,
  setClock,
} from './src/env';
import { SESSION } from './src/keeper';
import {
  decodeRouter,
  MOCK_ROUTER_ERR,
  routerAddress,
  writePriceInstruction,
} from './src/mock-router';
import {
  clusterOf,
  DEVNET_GENESIS,
  keypairFromFile,
  liteChain,
  MAINNET_GENESIS,
  retryOn429,
} from './src/testnet/chain';
import { planOf, type SetupPlan } from './src/testnet/config';
import { insideRepo } from './src/testnet/folder';
import { lifecycle } from './src/testnet/lifecycle';
import { type DeployedAsset, type Deployment, guardSolanaEntry, setUp } from './src/testnet/setup';
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
  /** The tokens the committed config lists with their keeper switch off and their range kept. */
  const switchedOff = (): string[] =>
    file()
      .tokens.filter((t: { keeper: { on?: boolean } | null }) => t.keeper?.on === false)
      .map((t: { id: string }) => t.id);
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
    // The clock reads Oct 7, 2026: the market's twelve closed days from there to the end of 2027.
    const held = config.closedDays.filter((day) => day !== 0);
    const dates = held.map((day) => new Date(day * 86_400_000).toISOString().slice(0, 10)).sort();
    expect(dates).toEqual([
      '2026-11-26',
      '2026-12-25',
      '2027-01-01',
      '2027-01-18',
      '2027-02-15',
      '2027-03-26',
      '2027-05-31',
      '2027-06-18',
      '2027-07-05',
      '2027-09-06',
      '2027-11-25',
      '2027-12-24',
    ]);
    expect(deployment.closedDays).toEqual(dates);
  });

  it('lists every token with the entries of the index table, and switches the keeper on but for gold', async () => {
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
          // Gate UNIVERSE: tGLDx's price is a pool's mid, not an oracle's, so the vault does not
          // rebalance it. Its range stays, so the price copier still bounds what it writes.
          flags: switchedOff().includes(asset.id) ? 0 : ASSET_KEEPER,
          minPrice: BigInt(asset.range?.minPrice ?? 0),
          maxPrice: BigInt(asset.range?.maxPrice ?? 0),
        }),
      ]);
      expect([asset.symbol, asset.indexSource]).toEqual([
        asset.symbol,
        real ? 'scope-indexes' : 'test-network',
      ]);
    }
    for (const id of switchedOff()) {
      const off = deployment.assets.find((a) => a.id === id);
      expect(off?.keeperOn).toBe(false);
      expect(off?.range).not.toBeNull();
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
    // 400 dollars of tSPYx at 776.80 less 15 bps, and 250 of tjlUSDC at one dollar less 5 bps.
    expect(lived.holds).toEqual({
      'solana:usdc': 350_000000n,
      'solana:spyx': 51_416_065n,
      'solana:jlusdc': 249_875_000n,
    });
    // The leg lost its spread, 5 bps of 250 dollars, and the counter holds it.
    expect(lived.lossAccum).toBe(125_000n);
    expect(lived.acceptedVersion).toBe(1);
  });

  it('switches a listed token off and keeps its range, as the devnet run did for gold', async () => {
    const [id] = switchedOff();
    if (!id) throw new Error('the committed config switches no token off');
    const token = deployment.assets.find((a) => a.id === id) as DeployedAsset;
    const entryOf = async () => (await readAssets(svm)).assets.find((e) => e.mint === token.mint);
    // The listing as it was before the change: on, with its range.
    const on = withRoles(file());
    const changed = on.tokens.find((t: { id: string }) => t.id === id);
    changed.keeper = { minUsd: changed.keeper.minUsd, maxUsd: changed.keeper.maxUsd };
    expect((await run(planOf(on))).transactions).toBe(1);
    expect(await entryOf()).toMatchObject({ flags: ASSET_KEEPER });
    // The committed config: one upsert_asset, flags 0, the same range.
    const printed: string[] = [];
    const off = await run(plan, { log: (line) => printed.push(line) });
    expect(off.transactions).toBe(1);
    expect(
      printed.some((line) => line.includes(`upsert_asset ${token.symbol}: flags 0, range`)),
    ).toBe(true);
    expect(await entryOf()).toMatchObject({
      flags: 0,
      minPrice: BigInt(token.range?.minPrice ?? 0),
      maxPrice: BigInt(token.range?.maxPrice ?? 0),
    });
    expect(off.deployment.assets.find((a) => a.id === id)).toMatchObject({ keeperOn: false });
    expect((await run()).transactions).toBe(0);
  });

  it('refuses a config with a role left out, a range its first price is outside of, or an entry used twice', () => {
    const base = { ...file(), roles: { guardian: null, defaultKeeper: null, priceWriter: null } };
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
    const notBoolean = withRoles(file());
    notBoolean.tokens[0].keeper = { ...notBoolean.tokens[0].keeper, on: 'no' };
    expect(() => planOf(notBoolean)).toThrow(/keeper\.on is true or false/);
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

// A network that has drifted from its config: a role taken away, a token dropped, a mint made with
// another extension set. The set-up brings the chain to the config, or refuses, and its record
// says what the chain holds.
describe('the test-network set-up, on a network that differs from its config', () => {
  let svm: LiteSVM;
  let admin: KeyPairSigner;
  let guardian: KeyPairSigner;
  let keeper: KeyPairSigner;
  let writer: KeyPairSigner;
  // The stock tokens of this network are made without the pausable extension.
  const omitted = ['PausableConfig'];
  const config = (priceWriter: string | null) => ({
    ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')),
    roles: { guardian: guardian.address, defaultKeeper: keeper.address, priceWriter },
  });
  const run = (
    file: ReturnType<typeof config>,
    options: {
      omit?: string[];
      previous?: Deployment;
      guardIds?: Record<string, string>;
      requireIds?: boolean;
      log?: (line: string) => void;
    } = {},
  ) =>
    setUp(liteChain(svm), admin, planOf(file), {
      dryRun: false,
      log: options.log ?? (() => {}),
      withLookupTable: false,
      omitExtensions: options.omit ?? omitted,
      previous: options.previous ?? null,
      guardIds: options.guardIds ?? {},
      requireIds: options.requireIds ?? false,
    });

  beforeAll(async () => {
    ({ svm, deployer: admin } = await createWorld());
    guardian = await fundedSigner(svm);
    keeper = await fundedSigner(svm);
    writer = await fundedSigner(svm);
    setClock(svm, SESSION);
    await run(config(writer.address));
  });

  it('revokes a price writer the config no longer names, and records none', async () => {
    const printed: string[] = [];
    const again = await run(config(null), { log: (line) => printed.push(line) });
    expect(again.transactions).toBe(1);
    expect(
      printed.some((line) => line.includes(`the price writer ${writer.address} is revoked`)),
    ).toBe(true);
    const held = await liteChain(svm).account(await routerAddress());
    expect(held && decodeRouter(held.data).priceWriter).toBe('11111111111111111111111111111111');
    expect(again.deployment.roles.priceWriter).toBeNull();
    // The old writer can no longer write the price a vault is valued at.
    const spyx = again.deployment.assets[0] as DeployedAsset;
    const entry = { value: 1n, exponent: 8n, unixTimestamp: SESSION };
    const sent = await send(svm, writer, [
      await writePriceInstruction(writer, again.deployment.accounts.priceAccount, {
        priceIndex: spyx.priceIndex,
        twapIndex: spyx.twapIndex,
        price: entry,
        twap: entry,
      }),
    ]);
    expectError(sent, MOCK_ROUTER_ERR.NotPriceWriter);
    expect((await run(config(null))).transactions).toBe(0);
  });

  it('refuses a mint whose extensions are not the ones this run asks for', async () => {
    await expect(run(config(null), { omit: [] })).rejects.toThrow(
      /tSPYx: the mint at \S+ has the extensions \[MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmountConfig, ConfidentialTransferMint, TransferHook, TokenMetadata\], and this run asks for \[MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmountConfig, PausableConfig, ConfidentialTransferMint, TransferHook, TokenMetadata\]/,
    );
    // The same set as the run that made them passes.
    expect((await run(config(null))).transactions).toBe(0);
  });

  it('switches the keeper off for a token the config drops, and keeps it in the record and the guard file', async () => {
    const full = await run(config(null));
    const tsla = full.deployment.assets.find((a) => a.id === 'solana:tslax') as DeployedAsset;
    const fewer = config(null);
    fewer.tokens = fewer.tokens.filter((t: { id: string }) => t.id !== 'solana:tslax');
    const printed: string[] = [];
    const dropped = await run(fewer, { previous: full.deployment, log: (l) => printed.push(l) });
    expect(dropped.transactions).toBe(1);
    expect(
      printed.some((line) =>
        line.includes(`tTSLAx (${tsla.mint}) is listed and the config no longer names it`),
      ),
    ).toBe(true);
    const entry = (await readAssets(svm)).assets.find((e) => e.mint === tsla.mint);
    expect(entry).toMatchObject({
      flags: 0,
      minPrice: 0n,
      maxPrice: 0n,
      priceIndex: tsla.priceIndex,
    });
    expect(dropped.deployment.assets.some((a) => a.id === 'solana:tslax')).toBe(false);
    expect(dropped.deployment.retired).toEqual([
      {
        id: 'solana:tslax',
        symbol: 'tTSLAx',
        mint: tsla.mint,
        tokenProgram: 'token-2022',
        keeperOn: false,
      },
    ]);
    expect(guardSolanaEntry(dropped.deployment).assets['solana:tslax']).toEqual({
      mint: tsla.mint,
      tokenProgram: 'token-2022',
    });
    // A second run sends nothing and still records it, from the record it wrote.
    const again = await run(fewer, { previous: dropped.deployment });
    expect(again.transactions).toBe(0);
    expect(again.deployment.retired).toEqual(dropped.deployment.retired);
    // Back in the config, it is listed and switched on as before.
    expect((await run(config(null))).transactions).toBe(1);
    expect((await readAssets(svm)).assets.find((e) => e.mint === tsla.mint)?.flags).toBe(
      ASSET_KEEPER,
    );
  });

  it("names a dropped token from the guard's file when there is no earlier record", async () => {
    const full = await run(config(null));
    const tsla = full.deployment.assets.find((a) => a.id === 'solana:tslax') as DeployedAsset;
    const guardIds = Object.fromEntries(
      Object.entries(guardSolanaEntry(full.deployment).assets).map(([id, a]) => [a.mint, id]),
    );
    const fewer = config(null);
    fewer.tokens = fewer.tokens.filter((t: { id: string }) => t.id !== 'solana:tslax');
    const dropped = await run(fewer, { guardIds, requireIds: true });
    expect(dropped.transactions).toBe(1);
    expect(dropped.deployment.retired).toEqual([
      {
        id: 'solana:tslax',
        symbol: null,
        mint: tsla.mint,
        tokenProgram: 'token-2022',
        keeperOn: false,
      },
    ]);
    expect(guardSolanaEntry(dropped.deployment).assets['solana:tslax']).toEqual({
      mint: tsla.mint,
      tokenProgram: 'token-2022',
    });
    expect((await run(config(null))).transactions).toBe(1);
  });

  it('refuses on devnet, before sending anything, a dropped token nothing names; a local run goes on', async () => {
    const full = await run(config(null));
    const tsla = full.deployment.assets.find((a) => a.id === 'solana:tslax') as DeployedAsset;
    const fewer = config(null);
    fewer.tokens = fewer.tokens.filter((t: { id: string }) => t.id !== 'solana:tslax');
    const printed: string[] = [];
    await expect(
      run(fewer, { requireIds: true, log: (line) => printed.push(line) }),
    ).rejects.toThrow(`the asset list holds ${tsla.mint}, which the config does not list`);
    expect(printed.some((line) => line.startsWith('#'))).toBe(false);
    expect((await readAssets(svm)).assets.find((e) => e.mint === tsla.mint)?.flags).toBe(
      ASSET_KEEPER,
    );
    // A local run switches it off and records it with no id.
    const local = await run(fewer);
    expect(local.transactions).toBe(1);
    expect(local.deployment.retired).toMatchObject([{ id: null, mint: tsla.mint }]);
    expect((await run(config(null))).transactions).toBe(1);
  });
});

describe('the key file the set-up signs with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tnet-key-'));
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };

  it('is named in an error, and nothing of what it holds is', async () => {
    const secret = 'S3CRET-not-a-key-file-0123456789';
    const cases = [
      [file('text.json', secret), /^the key file \S+text\.json is not JSON$/],
      [file('short.json', `[${'7,'.repeat(31)}7]`), /is not a list of 64 bytes$/],
      [file('halves.json', JSON.stringify(Array.from({ length: 64 }, (_, i) => i))), /halves/],
      [join(dir, 'missing.json'), /cannot be read \(ENOENT\)$/],
    ] as const;
    for (const [path, message] of cases) {
      const error = await keypairFromFile(path).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toMatch(/S3CRET|\b7,7\b|\b0,1,2\b/);
    }
  });

  it('gives the signer of a key file in the Solana CLI form', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const key = await createKeyPairSignerFromPrivateKeyBytes(secret);
    const path = file(
      'good.json',
      JSON.stringify([...secret, ...getAddressEncoder().encode(key.address)]),
    );
    expect((await keypairFromFile(path)).address).toBe(key.address);
  });
});

describe('the rehearsal folder', () => {
  it('is refused inside the repository, however it is written', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'tnet-link-')), 'repo');
    symlinkSync(REPO_ROOT, link);
    const inside = [
      REPO_ROOT,
      join(REPO_ROOT, 'rehearsal'),
      'rehearsal',
      './programs/../rehearsal',
      // Through a link to the repository.
      join(link, 'rehearsal'),
    ];
    const cwd = process.cwd();
    process.chdir(REPO_ROOT);
    try {
      for (const path of inside) expect([path, insideRepo(path)]).toEqual([path, true]);
      for (const path of [tmpdir(), join(tmpdir(), 'rehearsal'), '../outside-the-repo'])
        expect([path, insideRepo(path)]).toEqual([path, false]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('the RPC transport the set-up runs on', () => {
  const httpError = (statusCode: number) =>
    new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      headers: new Headers(),
      message: 'HTTP error',
      statusCode,
    });
  const failing = (errors: SolanaError[], answer: unknown) => {
    let calls = 0;
    const transport = (async () => {
      calls++;
      const error = errors.shift();
      if (error) throw error;
      return answer;
    }) as unknown as RpcTransport;
    return { transport, calls: () => calls };
  };
  const config = { payload: {}, signal: undefined } as unknown as Parameters<RpcTransport>[0];

  it('waits and asks again when the node answers 429, doubling the wait', async () => {
    const waits: number[] = [];
    const { transport, calls } = failing([httpError(429), httpError(429)], { result: 7 });
    const answer = await retryOn429(transport, { wait: async (ms) => void waits.push(ms) })(config);
    expect(answer).toEqual({ result: 7 });
    expect(calls()).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('throws any other error at once, and a 429 after the last try', async () => {
    const other = failing([httpError(500)], null);
    await expect(retryOn429(other.transport, { wait: async () => {} })(config)).rejects.toThrow();
    expect(other.calls()).toBe(1);
    const limited = failing(
      Array.from({ length: 5 }, () => httpError(429)),
      null,
    );
    await expect(
      retryOn429(limited.transport, { tries: 3, wait: async () => {} })(config),
    ).rejects.toThrow();
    expect(limited.calls()).toBe(3);
  });
});

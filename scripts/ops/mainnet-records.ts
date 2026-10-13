import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { readDeploymentFile } from '@colosseum/sdk';
import { parseRecord } from './authority';

// After a person has deployed the vault contracts on Robinhood Chain mainnet: writes the two files the
// app runs on from what the deploy itself left behind, so that nobody copies an address by hand.
//
//   pnpm ops:mainnet-records            fills both files, validates them, regenerates the guard's tables
//   pnpm ops:mainnet-records --check    the same without writing: prints what it would write
//   --safe 2:0x…,0x…                    the Safe's threshold and owners as read from the chain, for the record
//
// It reads forge's own record of the transactions it sent
// (contracts/broadcast/Deploy.s.sol/4663/run-latest.json), the deploy file they were made from
// (contracts/script/config/4663.json) and the guard's file as committed (for each token's id and pool).
// It sends nothing, holds no key and asks no node. The last step, the authority check, does read the
// chain: it is printed as a command for whoever has the node's address.
//
// It refuses rather than guess: a deploy file that still holds a value nobody confirmed, a broadcast of
// another chain, a transaction without its own receipt of success, a contract the deploy did not create
// exactly once, a deploy file whose guardian, keeper, routers, tokens or timelock are not the ones the
// broadcast set, a token the guard's file does not list or lists with another address, decimals or pool.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZERO = `0x${'0'.repeat(40)}`;
const CHAIN_ID = 4663;

type Json = Record<string, unknown>;
type Broadcast = {
  chain: number;
  transactions: {
    hash?: string | null;
    transactionType: string;
    contractName: string | null;
    contractAddress: string | null;
    function?: string | null;
    arguments?: string[] | null;
    transaction?: { from?: string; to?: string | null; input?: string | null };
  }[];
  receipts: { transactionHash?: string; blockNumber: string; status?: string }[];
};

// The calls the deploy makes on the factory, by selector: forge does not decode a call made through a
// proxy, so its call data is read here. tests/mainnet-records.test.ts holds these to a real broadcast.
const SELECTOR = {
  setGuardian: '0x8a0dac4a', // setGuardian(address)
  setKeeper: '0x748747e6', // setKeeper(address)
  setRouter: '0x83f1d681', // setRouter(address,uint8)
  setCashToken: '0xb85e776d', // setCashToken(address)
  setAsset: '0xc03633a6', // setAsset(address,(…AssetConfig))
  updateDelay: '64d62353', // updateDelay(uint256), inside the timelock's batch
} as const;

/** The nth 32-byte word of a call's arguments, as an address or as a number. */
const wordAddress = (input: string, n: number) =>
  `0x${input.slice(10 + n * 64 + 24, 10 + (n + 1) * 64)}`.toLowerCase();
const wordNumber = (input: string, n: number) =>
  Number(BigInt(`0x${input.slice(10 + n * 64, 10 + (n + 1) * 64)}`));
/** forge prints an address list as `[0x…, 0x…]`. */
const addressesIn = (text: string) =>
  (text.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase());

/** What the tool knows of a token beyond what the deploy file says: how a person reads it. */
const KINDS: Record<string, { name: string; kind: 'stock' | 'etf' | 'gold' | 'dollar_yield' }> = {
  NVDA: { name: 'NVIDIA', kind: 'stock' },
  AAPL: { name: 'Apple', kind: 'stock' },
  MSFT: { name: 'Microsoft', kind: 'stock' },
  GOOGL: { name: 'Alphabet Class A', kind: 'stock' },
  AMZN: { name: 'Amazon', kind: 'stock' },
  META: { name: 'Meta Platforms', kind: 'stock' },
  TSLA: { name: 'Tesla', kind: 'stock' },
  SPY: { name: 'SPDR S&P 500 ETF Trust', kind: 'etf' },
  QQQ: { name: 'Invesco QQQ', kind: 'etf' },
  GLD: { name: 'SPDR Gold Trust', kind: 'gold' },
  SGOV: { name: 'iShares 0-3 Month Treasury Bond', kind: 'dollar_yield' },
};

const lower = (address: string) => address.toLowerCase();
const fail = (message: string): never => {
  throw new Error(message);
};

/** The one contract of that name the deploy created, in order of creation when there are several. */
function created(broadcast: Broadcast, name: string): string[] {
  return broadcast.transactions
    .filter((t) => t.transactionType === 'CREATE' && t.contractName === name)
    .map((t) => lower(t.contractAddress ?? fail(`a ${name} was created with no address recorded`)));
}

export type Built = {
  record: Json;
  guard: Json;
  /** What a person should look at: a name or a kind the tool had to assume. */
  notes: string[];
};

/**
 * Pure: the deploy record and the guard's file, from the three inputs as text. Throws with what is
 * wrong; never fills a gap with a guess.
 */
export function buildRecords(input: {
  broadcast: string;
  config: string;
  guard: string;
  /** The Safe's threshold and owners as a person read them from the chain; the authority check holds them to it. */
  safe?: { threshold: number; owners: string[] };
}): Built {
  if (/TODO/.test(input.config))
    fail('the deploy file still holds a TODO: a deploy from it would have been refused');
  const broadcast = JSON.parse(input.broadcast) as Broadcast;
  const config = JSON.parse(input.config) as Json & {
    chainId: number;
    timelock: { owner: string; delay: number };
    guardian: string;
    keeper: string;
    keeperEnabled?: boolean;
    sequencerFeed: string;
    publishDelay: number;
    cashToken: string;
    routers: { router: string; pull: number }[];
    assets: (Json & {
      token: string;
      feed: string;
      tokenDecimals: number;
      feedDecimals: number;
      maxAge: number;
      session: number;
      maxWeightBps: number;
      flags: number;
      averageFeed: string;
      minPrice: number | string;
      maxPrice: number | string;
      pool?: { fee: number; tickSpacing: number };
      maxTradeUsd?: number | null;
      average?: { pool: string; minLiquidity: string; usable: boolean } | null;
    })[];
  };
  const guard = JSON.parse(input.guard) as Json & {
    chains: {
      robinhood: Json & {
        evmChainId: number;
        cash: string;
        assets: Record<
          string,
          { address: string; decimals: number; pool?: { fee: number; tickSpacing: number } }
        >;
      };
    };
  };
  if (broadcast.chain !== CHAIN_ID || config.chainId !== CHAIN_ID)
    fail(
      `the broadcast is of chain ${broadcast.chain} and the deploy file of ${config.chainId}: both must be ${CHAIN_ID}`,
    );
  if (guard.chains.robinhood.evmChainId !== CHAIN_ID)
    fail(`the guard's file is for chain ${guard.chains.robinhood.evmChainId}`);
  // One receipt for each transaction, by its hash, and each one a success. A receipt that does not say
  // is not taken as one.
  if (!broadcast.transactions.length) fail('the broadcast holds no transaction');
  const receipts = new Map<string, Broadcast['receipts'][number][]>();
  for (const r of broadcast.receipts) {
    const hash = r.transactionHash?.toLowerCase() ?? fail('a receipt names no transaction');
    receipts.set(hash, [...(receipts.get(hash) ?? []), r]);
  }
  for (const t of broadcast.transactions) {
    const hash =
      t.hash?.toLowerCase() ?? fail('a transaction of the broadcast has no hash: it was not sent');
    const mine = receipts.get(hash) ?? [];
    if (mine.length !== 1)
      fail(
        `the transaction ${hash} has ${mine.length} receipts, not one: the deploy did not finish`,
      );
    if (mine[0]?.status === undefined || BigInt(mine[0].status) !== 1n)
      fail(`the transaction ${hash} did not succeed, or its receipt does not say`);
    receipts.delete(hash);
  }
  if (receipts.size) fail(`${receipts.size} receipts are of no transaction of the broadcast`);

  const one = (name: string): string => {
    const made = created(broadcast, name);
    return made.length === 1
      ? (made[0] as string)
      : fail(`the deploy created ${made.length} ${name}, not one`);
  };
  const factoryLogic = one('VaultFactory');
  const registryLogic = one('IndexRegistry');
  // Each proxy is told apart by the logic it was created for (its constructor's first argument), never
  // by which came first.
  const proxies = broadcast.transactions.filter(
    (t) => t.transactionType === 'CREATE' && t.contractName === 'ERC1967Proxy',
  );
  if (proxies.length !== 2) fail(`the deploy created ${proxies.length} proxies, not two`);
  const proxyOf = (logic: string, what: string): string => {
    const made = proxies.filter((t) => t.arguments?.[0]?.toLowerCase() === logic);
    if (made.length !== 1)
      fail(`${made.length} proxies were created for the ${what} logic, not one`);
    return lower(made[0]?.contractAddress ?? fail(`the ${what} proxy has no address recorded`));
  };
  const contracts = {
    factory: proxyOf(factoryLogic, 'factory'),
    registry: proxyOf(registryLogic, 'registry'),
    beacon: one('VaultBeacon'),
    vaultLogic: one('BasketVault'),
    factoryLogic,
    registryLogic,
  };

  // What the deploy itself did, read from its calls on the factory and from the timelock's creation,
  // and held to the deploy file: a file edited since the deploy, or another file, is refused here.
  const deployer = lower(
    broadcast.transactions[0]?.transaction?.from ?? fail('the first transaction names no sender'),
  );
  const calls = (selector: string) =>
    broadcast.transactions
      .filter(
        (t) => t.transactionType === 'CALL' && lower(t.transaction?.to ?? '') === contracts.factory,
      )
      .map((t) => t.transaction?.input ?? '')
      .filter((input) => input.startsWith(selector));
  const lastOf = (selector: string, what: string) =>
    calls(selector).at(-1) ?? fail(`the deploy made no ${what} call on the factory`);
  const did = {
    guardian: wordAddress(lastOf(SELECTOR.setGuardian, 'setGuardian'), 0),
    keeper: wordAddress(lastOf(SELECTOR.setKeeper, 'setKeeper'), 0),
    cash: wordAddress(lastOf(SELECTOR.setCashToken, 'setCashToken'), 0),
    routers: calls(SELECTOR.setRouter)
      .map((input) => ({ address: wordAddress(input, 0), pull: wordNumber(input, 1) }))
      .filter((r) => r.pull !== 0),
    tokens: calls(SELECTOR.setAsset).map((input) => wordAddress(input, 0)),
  };
  const timelock = one('TimelockController');
  const timelockCreate = broadcast.transactions.find(
    (t) => t.transactionType === 'CREATE' && t.contractName === 'TimelockController',
  );
  const proposers = addressesIn(timelockCreate?.arguments?.[1] ?? '').filter((a) => a !== deployer);
  const executors = addressesIn(timelockCreate?.arguments?.[2] ?? '').filter((a) => a !== deployer);
  const batch = broadcast.transactions.find(
    (t) => t.transactionType === 'CALL' && (t.function ?? '').startsWith('executeBatch('),
  );
  const delayWord = (batch?.arguments?.[2] ?? '').match(
    new RegExp(`0x${SELECTOR.updateDelay}([0-9a-fA-F]{64})`),
  );
  if (!delayWord)
    fail("the deploy did not set the timelock's delay: no updateDelay in its hand-over batch");
  const delay = Number(BigInt(`0x${delayWord?.[1]}`));
  const same = (what: string, deployed: unknown, filed: unknown) => {
    if (JSON.stringify(deployed) !== JSON.stringify(filed))
      fail(
        `the deploy file is not the one this deploy ran from: ${what} was ${JSON.stringify(deployed)} in the deploy and is ${JSON.stringify(filed)} in the file`,
      );
  };
  same('the guardian', did.guardian, lower(config.guardian));
  same('the keeper', did.keeper, lower(config.keeper));
  same('the cash token', did.cash, lower(config.cashToken));
  same(
    'the routers',
    did.routers,
    config.routers.map((r) => ({ address: lower(r.router), pull: r.pull })),
  );
  same(
    'the listed tokens',
    did.tokens,
    config.assets.map((a) => lower(a.token)),
  );
  same("the timelock's proposers", proposers, [lower(config.timelock.owner)]);
  same("the timelock's executors", executors, [lower(config.timelock.owner)]);
  same("the timelock's delay", delay, config.timelock.delay);

  const deployBlock = Number(
    broadcast.receipts.map((r) => BigInt(r.blockNumber)).reduce((a, b) => (a < b ? a : b)),
  );

  const safe = proposers[0] as string;
  const byAddress = new Map(
    Object.entries(guard.chains.robinhood.assets).map(([id, a]) => [
      lower(a.address),
      { id, ...a },
    ]),
  );
  const notes: string[] = [];
  const cashRow = byAddress.get(lower(config.cashToken));
  if (!cashRow || cashRow.id !== guard.chains.robinhood.cash)
    fail("the guard's file does not name the deploy file's cash token as its cash");
  const cashConfig = config.assets.find((a) => lower(a.token) === lower(config.cashToken));
  if (!cashConfig) fail('the deploy file does not list its cash token among its assets');

  const assets = config.assets
    .filter((a) => lower(a.token) !== lower(config.cashToken))
    .map((a) => {
      const row =
        byAddress.get(lower(a.token)) ?? fail(`the guard's file lists no token at ${a.token}`);
      const symbol = row.id.replace(/^robinhood:/, '').toUpperCase();
      if (row.decimals !== a.tokenDecimals)
        fail(
          `${symbol}: the guard's file says ${row.decimals} decimals and the deploy file ${a.tokenDecimals}`,
        );
      if (!a.pool) fail(`${symbol}: the deploy file states no pool`);
      if (!row.pool || row.pool.fee !== a.pool?.fee || row.pool.tickSpacing !== a.pool?.tickSpacing)
        fail(`${symbol}: the guard's file and the deploy file name different pools`);
      const known = KINDS[symbol];
      if (!known)
        notes.push(
          `${symbol}: no name or kind is known to this tool; written as a stock named ${symbol}`,
        );
      const ranged = BigInt(a.minPrice) !== 0n || BigInt(a.maxPrice) !== 0n;
      return {
        id: row.id,
        symbol,
        name: known?.name ?? symbol,
        address: lower(a.token),
        decimals: a.tokenDecimals,
        modelOf: symbol,
        kind: known?.kind ?? 'stock',
        feed: lower(a.feed),
        feedDecimals: a.feedDecimals,
        averageFeed: lower(a.averageFeed),
        maxAge: a.maxAge,
        session: a.session,
        maxWeightBps: a.maxWeightBps,
        keeperOn: (a.flags & 1) === 1,
        range: ranged ? { minPrice: String(a.minPrice), maxPrice: String(a.maxPrice) } : null,
        pool: { fee: a.pool?.fee, tickSpacing: a.pool?.tickSpacing },
        maxTradeUsd: a.maxTradeUsd ?? null,
        average: a.average
          ? {
              pool: lower(a.average.pool),
              minLiquidity: String(a.average.minLiquidity),
              usable: a.average.usable,
            }
          : null,
      };
    });
  const listed = new Set([lower(config.cashToken), ...assets.map((a) => a.address)]);
  const extra = [...byAddress.keys()].filter((address) => !listed.has(address));
  if (extra.length) fail(`the guard's file lists a token the deploy did not: ${extra.join(', ')}`);

  const record: Json = {
    network: 'robinhood-mainnet',
    chain: 'robinhood',
    provenance: 'live',
    evmChainId: CHAIN_ID,
    deployBlock,
    contracts,
    roles: {
      admin: timelock,
      guardian: did.guardian,
      keeper: did.keeper,
      priceWriter: null,
      tokenIssuer: null,
    },
    sequencerFeed: lower(config.sequencerFeed) === ZERO ? null : lower(config.sequencerFeed),
    priceBoundBps: config.priceBoundBps ?? null,
    staleRailBps: config.staleRailBps ?? null,
    sessionPriceAge: config.sessionPriceAge ?? null,
    maxTradeUsdNotLive: config.maxTradeUsdNotLive ?? null,
    staleRailMaxAge: config.staleRailMaxAge ?? null,
    routers: did.routers,
    cash: {
      id: cashRow?.id,
      symbol: 'USDG',
      name: 'Global Dollar',
      address: lower(config.cashToken),
      decimals: cashConfig?.tokenDecimals,
    },
    assets,
    retired: [],
    timelock: {
      address: timelock,
      minDelay: delay,
      proposers: [safe],
      cancellers: [safe],
      executors: [safe],
      ...(input.safe
        ? { safe: { threshold: input.safe.threshold, owners: input.safe.owners.map(lower) } }
        : {}),
    },
    expected: {
      launched: false,
      publishDelay: config.publishDelay,
      keeperEnabled: config.keeperEnabled === true,
    },
  };

  const { placeholder: _placeholder, todo: _todo, ...kept } = guard;
  const filled: Json = {
    ...kept,
    chains: {
      ...guard.chains,
      robinhood: {
        ...guard.chains.robinhood,
        factory: contracts.factory,
        beacon: contracts.beacon,
        registry: contracts.registry,
      },
    },
  };
  return { record, guard: filled, notes };
}

/** Holds what was built to the three readers that will read it. Throws with the first that refuses. */
export function validate(built: Built): void {
  EvmDeploymentRecord.parse(built.record);
  parseRecord(JSON.stringify(built.record));
  const read = readDeploymentFile(built.guard);
  if (read.robinhood?.family !== 'evm') fail("the guard's file has no Robinhood Chain entry");
}

/**
 * Writes every file or none: each is written beside itself under another name first, and only when all
 * of those are on disk are they moved into place. A failure part way leaves the files as they were.
 */
export function writeBoth(files: readonly (readonly [string, string])[]): void {
  const temp = (path: string) => `${path}.writing`;
  try {
    for (const [path, text] of files) writeFileSync(temp(path), text);
  } catch (e) {
    for (const [path] of files) rmSync(temp(path), { force: true });
    throw e;
  }
  for (const [path] of files) renameSync(temp(path), path);
}

const DEFAULTS = {
  broadcast: join(
    ROOT,
    'contracts',
    'broadcast',
    'Deploy.s.sol',
    String(CHAIN_ID),
    'run-latest.json',
  ),
  config: join(ROOT, 'contracts', 'script', 'config', `${CHAIN_ID}.json`),
  guard: join(ROOT, 'packages', 'sdk', 'deployments', 'mainnet.json'),
  record: join(ROOT, 'deployments', 'robinhood-mainnet.json'),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : (args[at + 1] ?? fallback);
  };
  const paths = {
    broadcast: value('--broadcast', DEFAULTS.broadcast),
    config: value('--config', DEFAULTS.config),
    guard: value('--guard', DEFAULTS.guard),
    record: value('--record', DEFAULTS.record),
  };
  // --safe 2:0xowner,0xowner — what getThreshold() and getOwners() of the Safe answered.
  const safeArg = value('--safe', '');
  const [threshold, owners] = safeArg.split(':');
  try {
    if (!existsSync(paths.broadcast))
      fail(`there is no broadcast at ${paths.broadcast}: nothing was deployed from this checkout`);
    const built = buildRecords({
      broadcast: readFileSync(paths.broadcast, 'utf8'),
      config: readFileSync(paths.config, 'utf8'),
      guard: readFileSync(paths.guard, 'utf8'),
      ...(safeArg
        ? {
            safe: {
              threshold: Number(threshold),
              owners: addressesIn(owners ?? ''),
            },
          }
        : {}),
    });
    validate(built);
    for (const note of built.notes) console.log(`LOOK\t${note}`);
    if (args.includes('--check')) {
      console.log(JSON.stringify(built.record, null, 2));
      console.log('checked: nothing written');
    } else {
      writeBoth([
        [paths.record, `${JSON.stringify(built.record, null, 2)}\n`],
        [paths.guard, `${JSON.stringify(built.guard, null, 2)}\n`],
      ]);
      console.log(`wrote ${paths.record}`);
      console.log(`wrote ${paths.guard}`);
      execFileSync('pnpm', ['--filter', '@colosseum/sdk', 'tables'], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      execFileSync('pnpm', ['biome', 'format', '--write', paths.record, paths.guard], {
        cwd: ROOT,
        stdio: 'inherit',
      });
      console.log('next, read-only, with the node in ROBINHOOD_RPC_URL:');
      console.log(
        '  pnpm ops:authority-check --record deployments/robinhood-mainnet.json --rpc-env ROBINHOOD_RPC_URL',
      );
    }
  } catch (e) {
    console.error(`refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

import {
  BYREAL_CLMM_PROGRAM,
  type ByrealTickArray,
  byrealArraysCheck,
  byrealClState,
  byrealFee,
  byrealLiquidityCheck,
  decodeByrealTickArray,
  decodeClmmPool,
  swapExactIn,
} from '@colosseum/risk';
import type { AccountReader, ByrealInCapture, RegPool } from '../lib-split';

// PLAN-UNIVERSE RU.15 — Byreal's pools of the tracked stocks, as data. No client and no environment here: the
// search, the reads and the clock are in pools.ts. Nothing in this file compares a pool price with an oracle, and no
// oracle account is read anywhere: a pool's dynamic fee is reported as switched on or off from the pool's own bytes.

export const BYREAL_POOLS_METHOD = 'byreal-pools-0.1';

/** The first 8 bytes of the accounts a Byreal pool owns where Raydium keeps its tick arrays (hex). */
export const BYREAL_ACCOUNT_KINDS: Record<string, 'fixed' | 'dynamic' | 'bitmapExtension'> = {
  c09b55cd31f9812a: 'fixed',
  '6a8b98247599b838': 'dynamic',
  '3c9624db61808b99': 'bitmapExtension',
};
const FIXED_ARRAY_SIZE = 10_240;
const DYNAMIC_HEADER_SIZE = 216;
const TICK_SIZE = 168;
/** Bytes of each child account the search reads: the first 8, the pool, the first tick, the slot table, two counts. */
export const BYREAL_CHILD_SLICE = 112;

export const DOLLARS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};
const SOL = 'So11111111111111111111111111111111111111112';

/** One child account of a pool as the search read it: its size and its first `BYREAL_CHILD_SLICE` bytes. */
export type ByrealChild = { address: string; space: number; head: Uint8Array };

export type ByrealArrayCounts = {
  fixed: number;
  dynamic: number;
  bitmapExtension: number;
  /** Accounts that name the pool at byte 8 and are none of the three: counted, with their first 8 bytes. */
  other: number;
  otherKinds: string[];
  /** A fixed array that is not 10,240 bytes, or a dynamic one that is not 216 + 168 × its own count of ticks. */
  sizeMismatch: number;
  /** Ticks allocated in the dynamic arrays, by their own count (byte 108). */
  dynamicTicks: number;
};

/** The arrays of one pool by kind, told apart by each account's own first 8 bytes and by nothing else. */
export function countByrealArrays(children: readonly ByrealChild[]): ByrealArrayCounts {
  const c: ByrealArrayCounts = {
    fixed: 0,
    dynamic: 0,
    bitmapExtension: 0,
    other: 0,
    otherKinds: [],
    sizeMismatch: 0,
    dynamicTicks: 0,
  };
  for (const a of children) {
    const disc = Buffer.from(a.head.subarray(0, 8)).toString('hex');
    const kind = BYREAL_ACCOUNT_KINDS[disc];
    if (kind === 'fixed') {
      c.fixed++;
      if (a.space !== FIXED_ARRAY_SIZE) c.sizeMismatch++;
    } else if (kind === 'dynamic') {
      c.dynamic++;
      const allocated = a.head[108] as number;
      c.dynamicTicks += allocated;
      if (a.space !== DYNAMIC_HEADER_SIZE + allocated * TICK_SIZE) c.sizeMismatch++;
    } else if (kind === 'bitmapExtension') c.bitmapExtension++;
    else {
      c.other++;
      if (!c.otherKinds.includes(disc)) c.otherKinds.push(disc);
    }
  }
  return c;
}

/**
 * A pool's fee settings as its own account and its config say them, in millionths. Read here byte by byte for the
 * table of step 1; what a swap pays is `byrealFee` of `packages/risk`, which the validation checks.
 */
export type ByrealFeeSettings = {
  /** `trade_fee_rate` of the config the pool names; null when the config was not read. */
  configRate: number | null;
  /** The pool's own rate (byte 393); 0 means not set, and the config's rate applies. */
  poolRate: number;
  /** The flag byte (1096) as stored. */
  flag: number;
  decay: {
    on: boolean;
    onSalesOfToken0: boolean;
    onSalesOfToken1: boolean;
    initPct: number;
    decreasePct: number;
    intervalSeconds: number;
  };
  dynamic: { on: boolean; token1IsQuote: boolean; feedsSet: boolean };
};

export function byrealFeeSettings(pool: Uint8Array, config: Uint8Array | null): ByrealFeeSettings {
  const v = new DataView(pool.buffer, pool.byteOffset, pool.byteLength);
  const flag = v.getUint8(1096);
  const anySet = (from: number) => pool.subarray(from, from + 32).some((b) => b !== 0);
  return {
    configRate: config
      ? new DataView(config.buffer, config.byteOffset, config.byteLength).getUint32(47, true)
      : null,
    poolRate: v.getUint32(393, true),
    flag,
    decay: {
      on: (flag & 1) !== 0,
      onSalesOfToken0: (flag & 2) !== 0,
      onSalesOfToken1: (flag & 4) !== 0,
      initPct: v.getUint8(1097),
      decreasePct: v.getUint8(1098),
      intervalSeconds: v.getUint8(1099),
    },
    dynamic: {
      on: (flag & 16) !== 0,
      token1IsQuote: (flag & 8) !== 0,
      feedsSet: anySet(1112) && anySet(1144),
    },
  };
}

export type ByrealPoolRow = {
  pool: string;
  /** The tracked stocks the pool holds (one, or two for a pool of two tracked stocks). */
  stocks: string[];
  mint0: string;
  mint1: string;
  symbol0: string | null;
  symbol1: string | null;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  tickCurrent: number;
  liquidity: string;
  /** Bit 4 of the pool's status byte: swaps are switched off. */
  swapDisabled: boolean;
  openTime: number;
  /** What each vault holds, in the token's own units; null when the vault account was not returned. */
  vault0: number | null;
  vault1: number | null;
  /**
   * For a stock against a dollar token: the stock side at the pool's own price, the dollar side, and their sum. Null
   * for any other pair: nothing here prices a token from outside the pool.
   */
  usd: { stock: number; dollars: number; total: number } | null;
  arrays: ByrealArrayCounts;
  fee: ByrealFeeSettings;
  slots: { pool: number; arrays: number };
};

const tokenAmount = (data: Uint8Array | null): bigint | null =>
  data && data.length >= 72
    ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true)
    : null;

export function byrealPoolRow(
  address: string,
  pool: Uint8Array,
  parts: {
    config: Uint8Array | null;
    vault0: Uint8Array | null;
    vault1: Uint8Array | null;
    children: readonly ByrealChild[];
    slots: { pool: number; arrays: number };
  },
  stocks: ReadonlyMap<string, string>,
): ByrealPoolRow {
  const h = decodeClmmPool(pool);
  const v = new DataView(pool.buffer, pool.byteOffset, pool.byteLength);
  const symbol = (mint: string) =>
    stocks.get(mint) ?? DOLLARS[mint] ?? (mint === SOL ? 'SOL' : null);
  const ui = (raw: bigint | null, decimals: number) =>
    raw === null ? null : Number(raw) / 10 ** decimals;
  const vault0 = ui(tokenAmount(parts.vault0), h.decimals0);
  const vault1 = ui(tokenAmount(parts.vault1), h.decimals1);
  // token1 per token0, in the tokens' own units
  const price01 = (Number(h.sqrtPriceX64) / 2 ** 64) ** 2 * 10 ** (h.decimals0 - h.decimals1);
  let usd: ByrealPoolRow['usd'] = null;
  if (vault0 !== null && vault1 !== null) {
    if (stocks.has(h.mint0) && DOLLARS[h.mint1])
      usd = { stock: vault0 * price01, dollars: vault1, total: vault0 * price01 + vault1 };
    else if (stocks.has(h.mint1) && DOLLARS[h.mint0])
      usd = { stock: vault1 / price01, dollars: vault0, total: vault1 / price01 + vault0 };
  }
  return {
    pool: address,
    stocks: [h.mint0, h.mint1].map((m) => stocks.get(m)).filter((s): s is string => !!s),
    mint0: h.mint0,
    mint1: h.mint1,
    symbol0: symbol(h.mint0),
    symbol1: symbol(h.mint1),
    decimals0: h.decimals0,
    decimals1: h.decimals1,
    tickSpacing: h.tickSpacing,
    tickCurrent: h.tickCurrent,
    liquidity: h.liquidity.toString(),
    swapDisabled: (v.getUint8(389) & 16) !== 0,
    openTime: Number(v.getBigUint64(1080, true)),
    vault0,
    vault1,
    usd,
    arrays: countByrealArrays(parts.children),
    fee: byrealFeeSettings(pool, parts.config),
    slots: parts.slots,
  };
}

export type ByrealPoolsFile = {
  method: string;
  source: string;
  fetchedAt: string;
  provenance: 'live';
  program: string;
  /** The tracked stocks searched for, and the file they were read from. */
  tracked: Array<{ symbol: string; mint: string }>;
  trackedSource: string;
  rows: ByrealPoolRow[];
  rpc: { calls: number; searchCalls: number; retries429: number; errors: number; seconds: number };
};

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n).toLocaleString('en-US')}`;
const amount = (n: number | null) =>
  n === null
    ? 'not read'
    : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 6 });
const pct = (millionths: number) => `${(millionths / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`;
const name = (symbol: string | null, mint: string) => symbol ?? `${mint.slice(0, 6)}…`;

/** What a row's fee cell says: the config's rate, the pool's own when set, and the two switches. */
export function feeCell(f: ByrealFeeSettings): string {
  const parts = [
    f.configRate === null ? 'config not read' : `config ${pct(f.configRate)}`,
    f.poolRate ? `pool’s own ${pct(f.poolRate)}` : 'no rate of its own',
    f.decay.on
      ? `decaying fee ON (${f.decay.initPct}% at opening, −${f.decay.decreasePct}% every ${f.decay.intervalSeconds} s, on sales of ${[f.decay.onSalesOfToken0 && 'token 0', f.decay.onSalesOfToken1 && 'token 1'].filter(Boolean).join(' and ')})`
      : 'decaying fee off',
    f.dynamic.on ? 'dynamic fee ON' : 'dynamic fee off',
  ];
  return parts.join(' · ');
}

/** The table of step 1, one row a pool, largest dollar pools first, then the pools with no dollar side. */
export function byrealPoolsTable(file: ByrealPoolsFile, unquoted: readonly string[]): string {
  const rows = [...file.rows].sort(
    (a, b) => (b.usd?.total ?? -1) - (a.usd?.total ?? -1) || a.pool.localeCompare(b.pool),
  );
  const lines = [
    '| Pool | Tokens (0 / 1) | Tick spacing | Vault 0 | Vault 1 | Money at the pool’s own price | Arrays: fixed / dynamic (ticks) / other | Fee |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const other = r.arrays.bitmapExtension + r.arrays.other;
    lines.push(
      `| \`${r.pool.slice(0, 6)}…\` | ${name(r.symbol0, r.mint0)} / ${name(r.symbol1, r.mint1)} | ${r.tickSpacing} | ${amount(r.vault0)} | ${amount(r.vault1)} | ${r.usd ? `${money(r.usd.total)} (${money(r.usd.dollars)} dollars)` : 'not priced: no dollar side'}${r.liquidity === '0' ? ' · no liquidity at the price' : ''}${r.swapDisabled ? ' · swaps switched off' : ''} | ${r.arrays.fixed} / ${r.arrays.dynamic} (${r.arrays.dynamicTicks}) / ${other}${r.arrays.sizeMismatch ? ` · ${r.arrays.sizeMismatch} of a size its kind does not have` : ''} | ${feeCell(r.fee)} |`,
    );
  }
  const have = new Set(file.rows.flatMap((r) => r.stocks));
  const dynamicOn = file.rows.filter((r) => r.fee.dynamic.on);
  const decayOn = file.rows.filter((r) => r.fee.decay.on);
  const ownRate = file.rows.filter((r) => r.fee.poolRate !== 0);
  const tracked = file.tracked.map((t) => t.symbol);
  lines.push(
    '',
    `Pools: ${file.rows.length}, of ${have.size} of the ${tracked.length} tracked stocks (${tracked.filter((s) => have.has(s)).join(', ') || 'none'}). No pool: ${tracked.filter((s) => !have.has(s)).join(', ') || 'none'}.`,
    `Of the ${unquoted.length} stocks with no Jupiter quotes: with a pool, ${unquoted.filter((s) => have.has(s)).join(', ') || 'none'}; with none, ${unquoted.filter((s) => !have.has(s)).join(', ') || 'none'}.`,
    `Dynamic fee switched on: ${dynamicOn.length} (${dynamicOn.map((r) => `\`${r.pool.slice(0, 6)}…\``).join(', ') || 'none'}). Decaying fee switched on: ${decayOn.length} (${decayOn.map((r) => `\`${r.pool.slice(0, 6)}…\``).join(', ') || 'none'}). A rate of its own: ${ownRate.length}.`,
    `Read ${file.fetchedAt}: ${file.rpc.calls} RPC calls (${file.rpc.searchCalls} of them the search by mint), ${file.rpc.retries429} answered 429 and asked again, ${file.rpc.seconds.toFixed(1)} s. Method ${file.method}.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// The pools of the table as a capture takes them (`pnpm risk:split-capture --byreal`)
// ---------------------------------------------------------------------------------------------------------------------

/** DU1 of PLAN-UNIVERSE: a pool counts from $1,000 of measured money. */
export const BYREAL_MIN_POOL_USD = 1_000;

export type ByrealForCapture = {
  /** The pools to route, as rows of the kind the registry gives, in the table's order of address. */
  pools: RegPool[];
  /** For each of them, every account that names it at byte 8: its arrays of both kinds and the accounts that are neither. */
  children: Record<string, string[]>;
  meta: ByrealInCapture;
};

/**
 * The Byreal pools one capture adds, from a table of `pnpm risk:byreal-pools` and three fresh reads: the pools, then
 * their fee configs and vaults, then the transfer fee of their mints. A pool of the table is taken when it pairs one
 * tracked stock with a dollar token, its vaults hold `minUsd` or more at the pool's own price, and its fee is priced
 * from its own accounts (`byrealFee`). Every other pool of the table is left out with its reason, and so is one the
 * read did not return. The pool's money is measured here, at `slot`, and is what picks the router's reference pool;
 * the bytes the router is built from are read afterwards by the capture itself.
 *
 * No client here: the three readers and the listing are passed in. No oracle account is asked for.
 */
export async function byrealForCapture(
  table: ByrealPoolsFile & { file: string },
  opts: { only: ReadonlySet<string> | null; minUsd?: number },
  deps: {
    read: AccountReader;
    /** Transfer fee of each mint in basis points, 0 for a mint that charges none. */
    transferFeeBps: (mints: string[]) => Promise<Map<string, number>>;
    /** Every account of the program that names the pool at byte 8. */
    listChildren: (pool: string) => Promise<string[]>;
    rpcCalls: () => number;
  },
): Promise<ByrealForCapture> {
  const minUsd = opts.minUsd ?? BYREAL_MIN_POOL_USD;
  const calls0 = deps.rpcCalls();
  const stocks = new Map(table.tracked.map((t) => [t.mint, t.symbol]));
  const rows = [...table.rows].sort((a, b) => a.pool.localeCompare(b.pool));
  const heads = await deps.read(rows.map((r) => r.pool));
  const headers = new Map<string, ReturnType<typeof decodeClmmPool>>();
  for (const r of rows) {
    const d = heads.accounts.get(r.pool)?.data;
    try {
      if (d) headers.set(r.pool, decodeClmmPool(d));
    } catch {
      // left out below as not returned as a pool
    }
  }
  const side = await deps.read([
    ...new Set([...headers.values()].flatMap((h) => [h.ammConfig, h.vault0, h.vault1])),
  ]);
  const feeBps = await deps.transferFeeBps([
    ...new Set([...headers.values()].flatMap((h) => [h.mint0, h.mint1])),
  ]);

  const pools: RegPool[] = [];
  const leftOut: ByrealInCapture['leftOut'] = [];
  for (const r of rows) {
    const out = (reason: string) => leftOut.push({ pool: r.pool, stocks: r.stocks, reason });
    const head = heads.accounts.get(r.pool)?.data;
    const h = headers.get(r.pool);
    if (!head || !h) {
      out('not_returned_as_a_pool');
      continue;
    }
    // the table is a file: a pool it names has to be Byreal's own account, when the reader says who owns it;
    // the program is the package's, never the file's own `program`
    const owner = heads.accounts.get(r.pool)?.owner;
    if (owner !== undefined && owner !== BYREAL_CLMM_PROGRAM) {
      out('not_owned_by_the_program');
      continue;
    }
    const stock0 = stocks.has(h.mint0);
    const stock1 = stocks.has(h.mint1);
    if (stock0 && stock1) {
      out('pairs_two_tracked_stocks');
      continue;
    }
    const assetIsToken0 = stock0;
    const assetMint = assetIsToken0 ? h.mint0 : h.mint1;
    const quoteMint = assetIsToken0 ? h.mint1 : h.mint0;
    if (!stocks.has(assetMint)) {
      out('holds_no_tracked_stock');
      continue;
    }
    if (!DOLLARS[quoteMint]) {
      out('other_token_is_not_a_dollar_token');
      continue;
    }
    if (opts.only && !opts.only.has(stocks.get(assetMint) as string)) {
      out('stock_not_named_by_only');
      continue;
    }
    const config = side.accounts.get(h.ammConfig)?.data ?? null;
    if (!config) {
      out('fee_config_not_returned');
      continue;
    }
    const fee = byrealFee(head, config);
    if (!fee.priced) {
      out(fee.reason);
      continue;
    }
    const row = byrealPoolRow(
      r.pool,
      head,
      {
        config,
        vault0: side.accounts.get(h.vault0)?.data ?? null,
        vault1: side.accounts.get(h.vault1)?.data ?? null,
        children: [],
        slots: { pool: heads.slot, arrays: heads.slot },
      },
      stocks,
    );
    if (!row.usd) {
      out('vaults_not_returned');
      continue;
    }
    if (!(row.usd.total >= minUsd)) {
      out(`under_${minUsd}_usd`);
      continue;
    }
    const bps0 = feeBps.get(h.mint0);
    const bps1 = feeBps.get(h.mint1);
    if (bps0 === undefined || bps1 === undefined) {
      out('mint_not_returned');
      continue;
    }
    pools.push({
      address: r.pool,
      venue: 'byreal_clmm',
      assetMint,
      assetIsToken0,
      transferFeeBps0: bps0,
      transferFeeBps1: bps1,
      assetSymbol: stocks.get(assetMint) as string,
      quoteMint,
      quoteSymbol: DOLLARS[quoteMint] ?? null,
      exitPath: 'direct_usd',
      tier: 'not_in_registry',
      tvlUsd: row.usd.total,
      decimals0: h.decimals0,
      decimals1: h.decimals1,
      vault0: h.vault0,
      vault1: h.vault1,
    });
  }
  const children: Record<string, string[]> = {};
  for (const p of pools) children[p.address] = (await deps.listChildren(p.address)).sort();
  return {
    pools,
    children,
    meta: {
      table: { file: table.file, fetchedAt: table.fetchedAt, method: table.method },
      minUsd,
      pools: pools.map((p) => p.address),
      leftOut,
      slot: side.slot,
      rpcCalls: deps.rpcCalls() - calls0,
      source:
        'Solana RPC: getMultipleAccounts of the table’s pools, of their fee configs and vaults and (jsonParsed) of their mints; getProgramAccounts of the accounts that name each pool taken at byte 8, addresses only',
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The validation of decision D4 (`pnpm risk:byreal-validate`), and the pool it freezes for the tests
// ---------------------------------------------------------------------------------------------------------------------

export const BYREAL_VALIDATE_METHOD = 'byreal-validate-0.1';
/** The largest relative difference to Jupiter's same-pool quote that the Raydium decoder met (PLAN-RISK section 2). */
export const BYREAL_QUOTE_TOLERANCE = 2e-8;

/** One pool against the liquidity check: what its accounts are, and whether its ticks add up exactly. */
export type ByrealInvariantRow = {
  pool: string;
  stocks: string[];
  /** The accounts that name the pool at byte 8, by what their own first 8 bytes say. */
  accounts: { fixed: number; dynamic: number; neither: number };
  /** Ticks that carry liquidity, by the kind of array they were read from. */
  ticks: { fixed: number; dynamic: number };
  tickCurrent: number;
  stored: string;
  atPrice: string;
  total: string;
  holds: boolean;
  /** What a reader threw, when one did: the pool is then not read and `holds` is false. */
  error: string | null;
  slots: { pool: number; arrays: number };
};

export function byrealInvariantRow(
  pool: string,
  stocks: string[],
  head: Uint8Array,
  children: readonly Uint8Array[],
  slots: { pool: number; arrays: number },
): ByrealInvariantRow {
  const h = decodeClmmPool(head);
  const row: ByrealInvariantRow = {
    pool,
    stocks,
    accounts: { fixed: 0, dynamic: 0, neither: 0 },
    ticks: { fixed: 0, dynamic: 0 },
    tickCurrent: h.tickCurrent,
    stored: h.liquidity.toString(),
    atPrice: '0',
    total: '0',
    holds: false,
    error: null,
    slots,
  };
  try {
    const arrays: ByrealTickArray[] = [];
    for (const c of children) {
      const a = decodeByrealTickArray(c, h.tickSpacing);
      if (!a || a.pool !== pool) {
        row.accounts.neither++;
        continue;
      }
      row.accounts[a.kind]++;
      row.ticks[a.kind] += a.ticks.length;
      arrays.push(a);
    }
    const check = byrealLiquidityCheck(h, arrays);
    const named = byrealArraysCheck(head, arrays);
    row.atPrice = check.atPrice.toString();
    row.total = check.total.toString();
    row.holds = check.holds && named.holds;
    if (!named.holds)
      row.error = `${named.missing.length} array(s) the pool's bitmap names were not read, ${named.unnamed.length} read that it does not name`;
  } catch (e) {
    row.error = String(e).slice(0, 200);
  }
  return row;
}

/** One simulated trade through one pool beside Jupiter's own quote through the same pool. */
export type ByrealQuoteRow = {
  side: 'sell' | 'buy';
  usd: number;
  /** Raw units sent: the stock for a sale, the dollar token for a purchase. */
  amountIn: string;
  /** The pool account as read just before the quote was asked for (base64), and the slots of the reads around it. */
  head: string;
  slotBefore: number;
  slotAfter: number;
  /** The pool's price, tick and liquidity were the same in the read after the quote as in the read before it. */
  sameState: boolean;
  /** Jupiter's own slot for the quote lies between the slots of the two reads, ends included. */
  bracketed: boolean;
  fetchedAt: string;
  /** Null when Jupiter gave no quote through this pool alone, with what it answered. */
  jupiter: {
    outAmount: string;
    contextSlot: number | null;
    ammKey: string;
    label: string | null;
    feeAmount: string | null;
    feeMint: string | null;
  } | null;
  jupiterError: string | null;
  /** Our simulation on `head` and the pool's arrays: raw units out, and the part of the amount left unfilled. */
  simOut: number;
  unfilledShare: number;
  ticksCrossed: number;
  /** (ours − Jupiter's) ÷ Jupiter's; null when there is no quote to set it against. */
  relDiff: number | null;
};

/** One pool of the validation, frozen: its config, every account it owns, and each quote with the pool account it was set against. */
export type ByrealValidatedPool = {
  pool: string;
  stock: string;
  stockMint: string;
  quoteMint: string;
  stockIsToken0: boolean;
  /** The rate used, in millionths, and whether it is the pool's own or its config's. */
  tradeFeeRate: number;
  feeFrom: 'pool' | 'config';
  config: { address: string; data: string };
  /** Every account that names the pool at byte 8, whole (base64), read at `childrenSlot`. */
  children: Record<string, string>;
  childrenSlot: number;
  accounts: { fixed: number; dynamic: number; neither: number };
  quotes: ByrealQuoteRow[];
  /**
   * Earlier tries of a trade that were not one state on both sides (the pool changed between the two reads, or
   * Jupiter's slot was outside them) and were asked again: kept with their numbers, counted nowhere.
   */
  retaken: ByrealQuoteRow[];
};

export type ByrealValidationFile = {
  method: string;
  source: string;
  fetchedAt: string;
  provenance: 'live';
  program: string;
  table: { file: string; fetchedAt: string };
  tolerance: number;
  invariant: ByrealInvariantRow[];
  /** A pool whose check did not hold at the first read is read once more; both reads are kept, the first here. */
  invariantFirstReads: ByrealInvariantRow[];
  quoted: ByrealValidatedPool[];
  jupiterQuotes: number;
  rpc: { calls: number; retries429: number; errors: number; seconds: number };
};

/** The simulated output of one trade on a pool's state: raw units of the token received. */
export function byrealSimulate(
  pool: string,
  head: Uint8Array,
  config: Uint8Array,
  children: readonly Uint8Array[],
  stockIsToken0: boolean,
  side: 'sell' | 'buy',
  amountIn: number,
): { out: number; unfilledShare: number; ticksCrossed: number } {
  const { state } = byrealClState(pool, head, config, children);
  const r = swapExactIn(state, amountIn, side === 'sell' ? stockIsToken0 : !stockIsToken0);
  return {
    out: r.amountOut,
    unfilledShare: amountIn > 0 ? r.unfilledIn / amountIn : 0,
    ticksCrossed: r.ticksCrossed,
  };
}

/**
 * What a validation found, and what it did not compare: nothing is tuned, each failure is named with its number. Two
 * answers are kept apart. `everyComparisonWithin`: the liquidity check holds on every pool and every quote of one
 * state is inside the tolerance, which is the validation Step 2 ran on the four decoders. `threePoolsWithAllSix`: at
 * least three pools have all six trades (a sale and a purchase at each size) compared and inside it, which is what
 * RU.15 asked for; a pool Jupiter does not quote at a size cannot give it, whatever the decoder does.
 */
export function byrealVerdict(file: ByrealValidationFile): {
  invariant: { pools: number; hold: number; failed: Array<{ pool: string; why: string }> };
  quotes: {
    pools: number;
    compared: number;
    within: number;
    maxAbsRelDiff: number | null;
    outside: Array<{ pool: string; side: string; usd: number; relDiff: number }>;
    notCompared: Array<{ pool: string; side: string; usd: number; why: string }>;
    /** Pools with every one of the six trades compared and inside the tolerance. */
    poolsWithAllSixWithin: string[];
  };
  everyComparisonWithin: boolean;
  threePoolsWithAllSix: boolean;
} {
  const failed = file.invariant
    .filter((r) => !r.holds)
    .map((r) => ({
      pool: r.pool,
      why: r.error ?? `at the price ${r.atPrice}, stored ${r.stored}, all ticks ${r.total}`,
    }));
  const outside: Array<{ pool: string; side: string; usd: number; relDiff: number }> = [];
  const notCompared: Array<{ pool: string; side: string; usd: number; why: string }> = [];
  const allSix: string[] = [];
  let compared = 0;
  let within = 0;
  let max: number | null = null;
  for (const p of file.quoted) {
    let ok = 0;
    for (const q of p.quotes) {
      if (q.relDiff === null) {
        notCompared.push({
          pool: p.pool,
          side: q.side,
          usd: q.usd,
          why: q.jupiterError ?? 'no quote through this pool alone',
        });
        continue;
      }
      if (!q.sameState || !q.bracketed) {
        notCompared.push({
          pool: p.pool,
          side: q.side,
          usd: q.usd,
          why: `${q.sameState ? 'Jupiter’s slot is outside the two reads of the pool' : 'the pool changed between the read before the quote and the read after it'} (relDiff ${q.relDiff.toExponential(2)})`,
        });
        continue;
      }
      compared++;
      const d = Math.abs(q.relDiff);
      if (max === null || d > max) max = d;
      if (d <= file.tolerance) {
        within++;
        ok++;
      } else outside.push({ pool: p.pool, side: q.side, usd: q.usd, relDiff: q.relDiff });
    }
    const trades = new Set(p.quotes.map((q) => `${q.side} ${q.usd}`));
    if (ok === 6 && p.quotes.length === 6 && trades.size === 6 && !allSix.includes(p.pool))
      allSix.push(p.pool);
  }
  return {
    invariant: {
      pools: file.invariant.length,
      hold: file.invariant.length - failed.length,
      failed,
    },
    quotes: {
      pools: file.quoted.length,
      compared,
      within,
      maxAbsRelDiff: max,
      outside,
      notCompared,
      poolsWithAllSixWithin: allSix,
    },
    everyComparisonWithin: failed.length === 0 && outside.length === 0 && compared > 0,
    threePoolsWithAllSix: allSix.length >= 3,
  };
}

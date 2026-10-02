// The arithmetic of the EVM depth collector, with no I/O: mid price, trade sizes, cost against a pool's
// own mid, and the best single pool per size. Method evmq-0.1 (README.md).

export const METHOD_VERSION = 'evmq-0.1';
export const METHOD = 'best_single_pool_exact_in_vs_own_pool_mid';

/** Rodrigo's size grid: NOTIONALS in scripts/risk/collector/pools.ts. A test keeps the two equal. */
export const GRID_USD = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];

/**
 * Dollars per whole token at a pool's price. sqrtPriceX96² / 2¹⁹² is raw token1 per raw token0;
 * the dollar token counts as one dollar.
 */
export function midUsd(
  sqrtPriceX96: bigint,
  tokenIs0: boolean,
  tokenDecimals: number,
  dollarDecimals: number,
): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw1Per0 = s * s;
  const dollarRawPerTokenRaw = tokenIs0 ? raw1Per0 : 1 / raw1Per0;
  return dollarRawPerTokenRaw * 10 ** (tokenDecimals - dollarDecimals);
}

/** Whole units to raw units, keeping at most 12 decimal places. */
export function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`not an amount: ${amount}`);
  const [int = '0', frac = ''] = amount.toFixed(Math.min(decimals, 12)).split('.');
  return BigInt(int + frac.padEnd(decimals, '0'));
}

export const fromRaw = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/** Tokens to sell into a pool at each size: the size in dollars at that pool's own mid. */
export const sellAmounts = (poolMidUsd: number, tokenDecimals: number, grid = GRID_USD): bigint[] =>
  grid.map((n) => toRaw(n / poolMidUsd, tokenDecimals));

/** Dollar tokens to spend at each size. */
export const buyAmounts = (dollarDecimals: number, grid = GRID_USD): bigint[] =>
  grid.map((n) => toRaw(n, dollarDecimals));

/**
 * The pools whose mid is within `maxGap` (a share, 0.02 = 2%) of the median mid. A pool far from the
 * others is stale or drained; measured against its own mid it would look cheap when it is not.
 */
export function nearMedian<T extends { midUsd: number }>(pools: T[], maxGap: number): T[] {
  const sorted = pools.map((p) => p.midUsd).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const h = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? (sorted[h] as number)
      : ((sorted[h - 1] as number) + (sorted[h] as number)) / 2;
  return pools.filter((p) => Math.abs(p.midUsd / median - 1) <= maxGap);
}

/**
 * One pool's answer at one size: what it paid out, and how much of the amount it took in.
 * `filledIn` is null where the quoter does not report it (the deployed v4 Quoter).
 */
export type Quote = { out: bigint; filledIn: bigint | null };

export type Side = 'sell' | 'buy';

export type PoolQuotes = {
  /** Pool address (v3-style) or pool id (v4). */
  pool: string;
  /** The pool's own mid, dollars per whole token, at the block of the quotes. */
  midUsd: number;
  /** Raw amount sent in at each size: tokens for a sale, dollar tokens for a purchase. */
  sellIn: bigint[];
  buyIn: bigint[];
  /** One entry per grid size; null = this pool gave no quote at that size. */
  sell: Array<Quote | null>;
  buy: Array<Quote | null>;
};

/** One size of a curve. The first four keys are Rodrigo's CurvePoint (packages/risk simulate.ts). */
export type CurvePoint = {
  notionalUsd: number;
  /** Dollars received (sell), or tokens received valued at the pool's own mid (buy). Null = no pool quoted. */
  outUsd: number | null;
  /** (1 − outUsd / notionalUsd) × 100: price impact, pool fees and any unfilled part together. */
  costPct: number | null;
  /** Share of the amount the pool could not take. Null where the quoter does not report it. */
  unfilledShare: number | null;
  /** The pool with the lowest cost at this size, and the mid the cost is measured against. */
  pool: string | null;
  midUsd: number | null;
  /** How many pools gave a quote at this size. */
  quoted: number;
};

/** One pool's quote at one size as dollars out for `notionalUsd` in, both at that pool's own mid. */
export function outUsdOf(
  side: Side,
  q: Quote,
  poolMidUsd: number,
  tokenDecimals: number,
  dollarDecimals: number,
): number {
  return side === 'sell'
    ? fromRaw(q.out, dollarDecimals)
    : fromRaw(q.out, tokenDecimals) * poolMidUsd;
}

export const costPct = (notionalUsd: number, outUsd: number) => (1 - outUsd / notionalUsd) * 100;

/**
 * Per size, the single pool that loses the least against its own mid. A tie keeps the pool listed
 * first (the deepest).
 */
export function bestPerSize(
  side: Side,
  pools: PoolQuotes[],
  decimals: { token: number; dollar: number },
  grid = GRID_USD,
): CurvePoint[] {
  return grid.map((notionalUsd, i) => {
    let best: { p: PoolQuotes; q: Quote; outUsd: number } | null = null;
    let quoted = 0;
    for (const p of pools) {
      const q = p[side][i];
      if (!q) continue;
      quoted++;
      const outUsd = outUsdOf(side, q, p.midUsd, decimals.token, decimals.dollar);
      if (!best || outUsd > best.outUsd) best = { p, q, outUsd };
    }
    if (!best) {
      return {
        notionalUsd,
        outUsd: null,
        costPct: null,
        unfilledShare: null,
        pool: null,
        midUsd: null,
        quoted,
      };
    }
    const sent = (side === 'sell' ? best.p.sellIn : best.p.buyIn)[i] ?? 0n;
    const unfilledShare =
      best.q.filledIn === null || sent === 0n
        ? null
        : Math.max(0, 1 - Number(best.q.filledIn) / Number(sent));
    return {
      notionalUsd,
      outUsd: best.outUsd,
      costPct: costPct(notionalUsd, best.outUsd),
      unfilledShare,
      pool: best.p.pool,
      midUsd: best.p.midUsd,
      quoted,
    };
  });
}

/** One row of risk_asset_snapshots, as written to the JSONL file (keys are the Drizzle column names). */
export type AssetSnapshotRow = {
  assetMint: string;
  asset: string;
  fetchedAt: string;
  slot: number;
  refPool: string;
  refMidUsd: number;
  pools: number;
  sell: CurvePoint[];
  buy: CurvePoint[];
  methodVersion: string;
  source: string;
  method: string;
  provenance: 'live';
};

export type RowInput = {
  token: { symbol: string; address: string; decimals: number };
  dollarDecimals: number;
  /** Time of the block every figure was read at. */
  blockTime: Date;
  blockNumber: number;
  /** The pools quoted, deepest first. The first one is the row's reference pool. */
  pools: PoolQuotes[];
  source: string;
  grid?: number[];
};

export function buildRow(r: RowInput): AssetSnapshotRow {
  const ref = r.pools[0];
  if (!ref) throw new Error(`${r.token.symbol}: no pool to build a row from`);
  const decimals = { token: r.token.decimals, dollar: r.dollarDecimals };
  return {
    assetMint: r.token.address,
    asset: r.token.symbol,
    fetchedAt: r.blockTime.toISOString(),
    slot: r.blockNumber,
    refPool: ref.pool,
    refMidUsd: ref.midUsd,
    pools: r.pools.length,
    sell: bestPerSize('sell', r.pools, decimals, r.grid),
    buy: bestPerSize('buy', r.pools, decimals, r.grid),
    methodVersion: METHOD_VERSION,
    source: r.source,
    method: METHOD,
    provenance: 'live',
  };
}

const isPoint = (p: unknown): boolean => {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.notionalUsd === 'number' && (o.outUsd === null || typeof o.outUsd === 'number');
};

/** A parsed JSONL line that has every column the table needs, or null. */
export function parseRow(line: unknown): AssetSnapshotRow | null {
  if (typeof line !== 'object' || line === null) return null;
  const r = line as Record<string, unknown>;
  const text = ['assetMint', 'asset', 'fetchedAt', 'refPool', 'methodVersion', 'source', 'method'];
  if (text.some((k) => typeof r[k] !== 'string' || r[k] === '')) return null;
  if (Number.isNaN(Date.parse(r.fetchedAt as string))) return null;
  if (!['slot', 'refMidUsd', 'pools'].every((k) => Number.isFinite(r[k]))) return null;
  if (!Array.isArray(r.sell) || !Array.isArray(r.buy)) return null;
  if (![...r.sell, ...r.buy].every(isPoint)) return null;
  if (r.provenance !== 'live') return null;
  return r as unknown as AssetSnapshotRow;
}

/** The row as the Drizzle table takes it: its columns and nothing else, with the time as a Date. */
export const toDbRow = (r: AssetSnapshotRow) => ({
  assetMint: r.assetMint,
  asset: r.asset,
  fetchedAt: new Date(r.fetchedAt),
  slot: r.slot,
  refPool: r.refPool,
  refMidUsd: r.refMidUsd,
  pools: r.pools,
  sell: r.sell,
  buy: r.buy,
  methodVersion: r.methodVersion,
  source: r.source,
  method: r.method,
  provenance: r.provenance,
});

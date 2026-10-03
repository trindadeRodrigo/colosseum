import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Db, riskPools } from '@colosseum/db';
import { type RegimeParams, regimeAt } from '@colosseum/risk';
import { DISCLAIMER } from '@colosseum/schemas';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * `GET /risk/assets/:id/split`: how one routed sale (or purchase) divides across the asset's pools, leg by leg, from
 * the split snapshot (`pnpm risk:split-snapshot`, item 4 / DA7, run hourly by item 18's job): for each simulated size,
 * the amount sent to each pool, what came out in USD, the pool's fee rate and any unfilled share, plus the cost split.
 * It reads the job's files (`<dir>/<YYYY-MM-DD>.jsonl`), no RPC. Sizes are the job's grid; the answer gives the one
 * nearest the asked size (on a log scale) and says which. `regime` keeps the newest snapshot taken in that time of week.
 */
export const SPLIT_SIZES = [100, 500, 2_500, 10_000, 50_000, 250_000, 1_000_000, 5_000_000];
const Regime = z.enum(['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday']);

export function splitDir(): string {
  return (
    process.env.RISK_SPLIT_DIR ??
    join(process.env.RISK_DATA_DIR ?? join(homedir(), '.colosseum', 'risk', 'data'), 'split')
  );
}

export type SplitRow = {
  assetMint: string;
  asset: string;
  fetchedAt: string;
  slot: number | null;
  side: 'sell' | 'buy';
  notionalUsd: number;
  outUsd: number;
  costPct: number;
  poolsUsed: number;
  pools: number;
  refPool: string | null;
  refMidUsd: number | null;
  split: {
    total: number;
    poolFee: number;
    transferFee: number;
    basis: number;
    impact: number;
  } | null;
  legs: Array<{
    pool: string;
    amountIn: number;
    unfilledShare: number;
    outUsd: number;
    midUsd: number | null;
    feeRate: number | null;
  }>;
  solUsd: number | null;
  source: string;
  method: string;
  methodVersion: string;
};

/** The size of the grid nearest `n` on a log scale. */
export function nearestSize(n: number, sizes: number[] = SPLIT_SIZES): number {
  return sizes.reduce((a, b) => (Math.abs(Math.log(b / n)) < Math.abs(Math.log(a / n)) ? b : a));
}

/** The split files with a per-file cache keyed by modification time; only one asset's lines are parsed per read. */
export function splitStore(dir: string = splitDir()) {
  const cache = new Map<string, { mtime: number; byAsset: Map<string, SplitRow[]> }>();
  function file(f: string) {
    const path = join(dir, f);
    const mtime = statSync(path).mtimeMs;
    const hit = cache.get(f);
    if (hit && hit.mtime === mtime) return hit.byAsset;
    const byAsset = new Map<string, SplitRow[]>();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as SplitRow;
        if (!r.assetMint || !Array.isArray(r.legs)) continue;
        const list = byAsset.get(r.assetMint) ?? [];
        list.push(r);
        byAsset.set(r.assetMint, list);
      } catch {
        // a torn last line while the job writes: skipped
      }
    }
    cache.set(f, { mtime, byAsset });
    return byAsset;
  }
  return {
    /** Every row of one asset and side, newest first, across the newest `days` files. */
    rows(assetMint: string, side: 'sell' | 'buy', days = 3): SplitRow[] {
      if (!existsSync(dir)) return [];
      const files = readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .slice(-days);
      return files
        .flatMap((f) => file(f).get(assetMint) ?? [])
        .filter((r) => r.side === side)
        .sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1));
    },
  };
}
export type SplitStore = ReturnType<typeof splitStore>;

const Leg = z.object({
  pool: z.string(),
  venue: z.string().nullable(),
  quote: z.string().nullable(),
  exitPath: z.string().nullable(),
  amountIn: z.number(),
  amountInUsd: z.number().nullable(),
  outUsd: z.number(),
  share: z.number(),
  costPct: z.number().nullable(),
  feeRate: z.number().nullable(),
  unfilledShare: z.number(),
});
export const SplitResponse = z.object({
  asset: z.string(),
  assetMint: z.string(),
  side: z.enum(['sell', 'buy']),
  askedUsd: z.number(),
  notionalUsd: z.number().nullable(),
  sizes: z.array(z.number()),
  regime: Regime.nullable(),
  fetchedAt: z.string().nullable(),
  slot: z.number().nullable(),
  outUsd: z.number().nullable(),
  costPct: z.number().nullable(),
  split: z
    .object({
      total: z.number(),
      poolFee: z.number(),
      transferFee: z.number(),
      basis: z.number(),
      impact: z.number(),
    })
    .nullable(),
  poolsUsed: z.number().nullable(),
  poolsConsidered: z.number().nullable(),
  refMidUsd: z.number().nullable(),
  solUsd: z.number().nullable(),
  legs: z.array(Leg),
  reason: z.enum(['not_collected', 'no_samples_in_regime']).nullable(),
  source: z.string(),
  method: z.string(),
  methodVersion: z.string(),
  provenance: z.literal('live'),
  disclaimer: z.string(),
});

export async function registerRiskSplitRoute(
  app: FastifyInstance,
  db: Db,
  resolveAsset: (id: string) => Promise<{ mint: string; symbol: string } | null>,
  regimeParams: RegimeParams,
  store: SplitStore = splitStore(),
) {
  const f = app.withTypeProvider<ZodTypeProvider>();
  f.get(
    '/risk/assets/:id/split',
    {
      schema: {
        summary:
          'How one routed sale or purchase divides across the asset’s pools, leg by leg (the hourly split snapshot, at the simulated size nearest the asked one)',
        description: `Sizes simulated: ${SPLIT_SIZES.join(', ')} USD. Each leg: the pool, the asset amount sent in (sell) or USD spent (buy), its value at the reference price, the USD out, its share of the sale, its own cost and the pool's fee rate. regime keeps the newest snapshot taken in that time of week; without it, the newest of all. No snapshot: reason not_collected (none for the asset) or no_samples_in_regime.\n\n${DISCLAIMER.en}`,
        params: z.object({ id: z.string() }),
        querystring: z.object({
          side: z.enum(['sell', 'buy']).default('sell'),
          sizeUsd: z.coerce.number().positive(),
          regime: Regime.optional(),
        }),
        response: { 200: SplitResponse, 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const a = await resolveAsset(req.params.id);
      if (!a) return reply.code(404).send({ error: `unknown asset ${req.params.id}` });
      const { side, sizeUsd, regime } = req.query;
      const size = nearestSize(sizeUsd);
      const all = store.rows(a.mint, side);
      const rows = all.filter(
        (r) =>
          r.notionalUsd === size &&
          (!regime || regimeAt(new Date(r.fetchedAt), regimeParams) === regime),
      );
      const r = rows[0];
      const base = {
        asset: a.symbol,
        assetMint: a.mint,
        side,
        askedUsd: sizeUsd,
        sizes: SPLIT_SIZES,
        provenance: 'live' as const,
        disclaimer: DISCLAIMER.en,
      };
      if (!r)
        return {
          ...base,
          notionalUsd: null,
          regime: regime ?? null,
          fetchedAt: null,
          slot: null,
          outUsd: null,
          costPct: null,
          split: null,
          poolsUsed: null,
          poolsConsidered: null,
          refMidUsd: null,
          solUsd: null,
          legs: [],
          reason: all.length ? ('no_samples_in_regime' as const) : ('not_collected' as const),
          source: 'split snapshot (pnpm risk:split-snapshot)',
          method: 'no snapshot at this size' + (regime ? ' in this time of week' : ''),
          methodVersion: 'split-0.1',
        };
      const meta = r.legs.length
        ? await db
            .select({
              address: riskPools.address,
              venue: riskPools.venue,
              quote: riskPools.quoteSymbol,
              exitPath: riskPools.exitPath,
            })
            .from(riskPools)
            .where(
              inArray(
                riskPools.address,
                r.legs.map((l) => l.pool),
              ),
            )
        : [];
      const by = new Map(meta.map((m) => [m.address, m]));
      const ref = r.refMidUsd;
      const filled = r.legs.reduce((s, l) => s + l.amountIn * (1 - (l.unfilledShare ?? 0)), 0);
      const legs = r.legs
        .map((l) => {
          const m = by.get(l.pool);
          // sell: amountIn is the asset (UI units), valued at the reference mid; buy: amountIn is USD spent
          const inUsd = side === 'sell' ? (ref != null ? l.amountIn * ref : null) : l.amountIn;
          return {
            pool: l.pool,
            venue: m?.venue ?? null,
            quote: m?.quote ?? null,
            exitPath: m?.exitPath ?? null,
            amountIn: l.amountIn,
            amountInUsd: inUsd,
            outUsd: l.outUsd,
            share: filled > 0 ? (l.amountIn * (1 - (l.unfilledShare ?? 0))) / filled : 0,
            costPct: side === 'sell' && inUsd ? 1 - l.outUsd / inUsd : null,
            feeRate: l.feeRate ?? null,
            unfilledShare: l.unfilledShare ?? 0,
          };
        })
        .sort((x, y) => y.share - x.share);
      return {
        ...base,
        notionalUsd: r.notionalUsd,
        regime: regimeAt(new Date(r.fetchedAt), regimeParams),
        fetchedAt: r.fetchedAt,
        slot: r.slot ?? null,
        outUsd: r.outUsd,
        costPct: r.costPct / 100,
        split: r.split,
        poolsUsed: r.poolsUsed,
        poolsConsidered: r.pools,
        refMidUsd: ref,
        solUsd: r.solUsd ?? null,
        legs,
        reason: null,
        source: `${r.source}; hourly split snapshot (pnpm risk:split-snapshot)`,
        method: `${r.method}; leg value in = amount × the reference mid (${r.refPool ?? 'reference pool not named'}); leg cost = 1 − USD out ÷ value in; share = the leg's filled amount ÷ the sale's filled amount; size ${r.notionalUsd} USD, the grid size nearest ${sizeUsd}`,
        methodVersion: r.methodVersion,
      };
    },
  );
}

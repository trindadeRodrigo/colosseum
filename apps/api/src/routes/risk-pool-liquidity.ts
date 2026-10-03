import { createRpc, type SolanaRpc } from '@colosseum/chain-solana';
import { ask } from '@colosseum/chain-solana/vault';
import { type Db, riskAssetSnapshots, riskPools } from '@colosseum/db';
import { DISCLAIMER } from '@colosseum/schemas';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  CHILD_OFFSETS,
  type Distribution,
  distributionFromBytes,
  POOL_LIQUIDITY_METHOD_VERSION,
  type PoolRow,
} from '../pool-liquidity';
import {
  RECORDED_SOURCE,
  type Recorded,
  type RecordedStore,
  recordedStore,
} from '../pool-recorded';

/**
 * `GET /risk/pools/:address/liquidity`: one registry pool's liquidity by price band, read live over RPC (pool head
 * plus its tick or bin arrays, found the way the collector finds them) and decoded by packages/risk/src/pools.
 * Each pool's answer is kept 60 s, its child-account list 10 min, so a page cannot hammer the RPC. RPC errors
 * never carry the transport's text (it can hold the RPC's address).
 */
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = 'So11111111111111111111111111111111111111112';
export const ANSWER_TTL_MS = 60_000;

/**
 * DA3 (PLAN-ANALYTICS §6): no `getProgramAccounts` scans during this weekend's collection; larger reads start Mon Oct 5
 * (00:00 ET). The child-account listing below is such a scan, so before then it refuses and the route answers 503
 * with the gate in words. Moving the date is a decision (`/decide`), not an edit here.
 */
export const DA3_SCANS_FROM = Date.parse('2026-10-05T04:00:00Z');
export function assertScanAllowed(now: number = Date.now()): void {
  if (now < DA3_SCANS_FROM)
    throw new Error(
      'gate DA3: getProgramAccounts scans start Mon Oct 5 (00:00 ET); this pool’s tick arrays cannot be listed before then',
    );
}
const CHILDREN_TTL_MS = 10 * 60_000;
const SOURCE =
  'Solana RPC getMultipleAccounts (pool + tick/bin arrays), decoded by packages/risk/src/pools';

export type ChainReader = {
  /** Account bytes in one slot; missing accounts are left out. */
  accounts(keys: string[]): Promise<{ slot: number; data: Map<string, Uint8Array> }>;
  /** Accounts of `program` holding `pool` at `offset` (addresses only). */
  children(program: string, offset: number, pool: string): Promise<string[]>;
  /** USD per SOL with where it came from, or null. */
  solUsd(): Promise<{ usd: number; source: string } | null>;
};

/**
 * What the RPC node said, for the operator: the JSON-RPC error code and server message only (kit's error
 * context), with anything URL-shaped removed. Null when there is none.
 */
export function rpcDetail(e: unknown): string | null {
  type Err = { name?: string; code?: unknown; context?: Record<string, unknown>; cause?: Err };
  const cause = (e as Err)?.cause;
  const ctx = cause?.context ?? {};
  const parts = [
    ctx.__code,
    ctx.__serverMessage,
    ctx.statusCode,
    cause && !cause.context ? cause.name : undefined,
    cause?.cause?.code ?? cause?.code,
  ]
    .filter((x) => x !== undefined && x !== null)
    .map((x) =>
      String(x)
        .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
        .replace(/\S*api[-_]?key\S*/gi, '<redacted>'),
    );
  return parts.length ? parts.join(' ').slice(0, 200) : null;
}

export function rpcChainReader(): ChainReader {
  let rpc: SolanaRpc | null = null;
  const client = () => {
    rpc ??= createRpc();
    return rpc;
  };
  type Addr = Parameters<SolanaRpc['getMultipleAccounts']>[0][number];
  return {
    async accounts(keys) {
      const data = new Map<string, Uint8Array>();
      let slot = 0;
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        const c = client(); // outside `ask`: a missing RPC setting is said as such
        const r = await ask('getMultipleAccounts', () =>
          c.getMultipleAccounts(batch as Addr[], { encoding: 'base64' }).send(),
        );
        slot = Math.max(slot, Number(r.context.slot));
        r.value.forEach((v, k) => {
          if (v) data.set(batch[k] as string, new Uint8Array(Buffer.from(v.data[0], 'base64')));
        });
      }
      return { slot, data };
    },
    async children(program, offset, pool) {
      assertScanAllowed();
      const c = client();
      const r = await ask('getProgramAccounts', () =>
        c
          .getProgramAccounts(program as Addr, {
            encoding: 'base64',
            dataSlice: { offset: 0, length: 0 },
            filters: [
              {
                memcmp: {
                  offset: BigInt(offset),
                  bytes: pool as never,
                  encoding: 'base58',
                },
              },
            ],
          })
          .send(),
      );
      return (r as unknown as Array<{ pubkey: string }>).map((a) => a.pubkey);
    },
    async solUsd() {
      // the collector's source for SOL-quoted curves
      try {
        const r = (await (
          await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, {
            signal: AbortSignal.timeout(5_000),
          })
        ).json()) as Record<string, { usdPrice?: number }>;
        const usd = r[SOL]?.usdPrice;
        return usd && usd > 0 ? { usd, source: 'lite-api.jup.ag/price/v3' } : null;
      } catch {
        return null;
      }
    },
  };
}

type Answer = {
  midPrice: number | null;
  fetchedAt: string | null;
  slot: number | null;
  distribution: Distribution | null;
  reason: 'not_applicable' | null;
  quoteUsd: number | null;
  quoteUsdSource: string | null;
};

/** One pool's accounts as read in one slot, with its quote's USD price; bands are computed from it per request. */
type Snapshot = {
  fetchedAt: string;
  slot: number;
  head: Uint8Array;
  kids: Uint8Array[];
  q: { usd: number; source: string } | null;
};

/**
 * The pool-liquidity reads with their caches; `now` and `reader` are seams for tests. The RPC read is kept per pool
 * address for `ANSWER_TTL_MS`, whatever `bands` and `rangePct` are asked, so a page cannot hammer the RPC by varying
 * them; the keys are registry pools only (the route answers 404 before reading anything else), and expired entries
 * are dropped on every read.
 */
export function poolLiquidityService(reader: ChainReader, now: () => number = Date.now) {
  const reads = new Map<string, { at: number; value: Promise<Snapshot | null> }>();
  const kids = new Map<string, { at: number; keys: string[] }>();
  let sol: { at: number; value: Promise<{ usd: number; source: string } | null> } | null = null;

  async function quotePrice(quoteMint: string) {
    if (quoteMint === USDC || quoteMint === USDT) return { usd: 1, source: 'stable_par' };
    if (quoteMint !== SOL) return null;
    if (!sol || now() - sol.at > ANSWER_TTL_MS) sol = { at: now(), value: reader.solUsd() };
    return sol.value;
  }

  async function read(
    p: PoolRow & { program: string; quoteMint: string },
  ): Promise<Snapshot | null> {
    const offsets = CHILD_OFFSETS[p.venue];
    if (!offsets) return null;
    let k = kids.get(p.address);
    if (!k || now() - k.at > CHILDREN_TTL_MS) {
      const keys: string[] = [];
      for (const off of offsets) keys.push(...(await reader.children(p.program, off, p.address)));
      k = { at: now(), keys };
      kids.set(p.address, k);
    }
    const fetchedAt = new Date(now()).toISOString();
    const { slot, data } = await reader.accounts([p.address, ...k.keys]);
    const head = data.get(p.address);
    if (!head) throw new Error('pool account not found on chain');
    return {
      fetchedAt,
      slot,
      head,
      kids: k.keys.map((x) => data.get(x)).filter((x): x is Uint8Array => !!x),
      q: await quotePrice(p.quoteMint),
    };
  }

  function snapshot(p: PoolRow & { program: string; quoteMint: string }) {
    const t = now();
    for (const [key, e] of reads) if (t - e.at > ANSWER_TTL_MS) reads.delete(key);
    const hit = reads.get(p.address);
    if (hit) return hit.value;
    const value = read(p);
    reads.set(p.address, { at: t, value });
    // a failed read is not kept
    value.catch(() => reads.delete(p.address));
    return value;
  }

  return {
    async get(
      p: PoolRow & { program: string; quoteMint: string },
      bands: number,
      rangePct: number,
    ): Promise<Answer> {
      const s = await snapshot(p);
      if (!s)
        return {
          midPrice: null,
          fetchedAt: null,
          slot: null,
          distribution: null,
          reason: 'not_applicable',
          quoteUsd: null,
          quoteUsdSource: null,
        };
      const distribution = distributionFromBytes(p, s.head, s.kids, {
        quoteUsd: s.q?.usd ?? null,
        bands,
        rangePct,
      });
      return {
        midPrice: distribution?.midPrice ?? null,
        fetchedAt: s.fetchedAt,
        slot: s.slot,
        distribution,
        reason: distribution ? null : 'not_applicable',
        quoteUsd: s.q?.usd ?? null,
        quoteUsdSource: s.q?.source ?? null,
      };
    },
  };
}

const Band = z.object({
  priceLow: z.number(),
  priceHigh: z.number(),
  side: z.enum(['asset', 'quote']),
  amount: z.number(),
  amountUsd: z.number().nullable(),
  liquidity: z.number().nullable(),
});
export const PoolLiquidityResponse = z.object({
  pool: z.string(),
  venue: z.string(),
  asset: z.string(),
  quote: z.string().nullable(),
  midPrice: z.number().nullable(),
  priceUnit: z.literal('quote per asset'),
  /** live: read now over RPC; recorded: the collector's newest hourly recording (fetchedAt says when). */
  basis: z.enum(['live', 'recorded']),
  fetchedAt: z.string().nullable(),
  slot: z.number().nullable(),
  distribution: z.literal('bands').nullable(),
  reason: z.enum(['not_applicable']).nullable(),
  bands: z.array(Band).nullable(),
  totalAssetUsd: z.number().nullable(),
  totalQuoteUsd: z.number().nullable(),
  totalAsset: z.number().nullable(),
  totalQuote: z.number().nullable(),
  quoteUsd: z.number().nullable(),
  quoteUsdSource: z.string().nullable(),
  usdNullReason: z.string().nullable(),
  source: z.string(),
  method: z.string(),
  methodVersion: z.string(),
  provenance: z.literal('live'),
  disclaimer: z.string(),
});

const HistoryPoint = z.object({
  t: z.string(),
  slot: z.number().nullable(),
  midPrice: z.number().nullable(),
  assetUsd: z.number().nullable(),
  quoteSideUsd: z.number().nullable(),
  valueUsd: z.number().nullable(),
  quoteUsd: z.number().nullable(),
  usdNullReason: z.string().nullable(),
});
export const PoolLiquidityHistoryResponse = z.object({
  pool: z.string(),
  venue: z.string(),
  asset: z.string(),
  quote: z.string().nullable(),
  resolution: z.literal('hour'),
  rangePct: z.number(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  points: z.array(HistoryPoint),
  reason: z.enum(['not_applicable', 'not_collected']).nullable(),
  source: z.string(),
  method: z.string(),
  methodVersion: z.string(),
  provenance: z.literal('live'),
  disclaimer: z.string(),
});

/** Range of the value series: wide enough to hold every position but a full-range one's far tails. */
const VALUE_RANGE_PCT = 0.99;
const STABLE_QUOTES = new Set([USDC, USDT]);
const bandMethod = (bands: number, rangePct: number) =>
  `${bands} equal-width bands across mid × (1 ± ${rangePct}), the band holding the price split at it; concentrated liquidity: L between initialized ticks from cumulative liquidityNet, token0 = L·(1/√a − 1/√b) above the price, token1 = L·(√b − √a) below, over the tick arrays read; bins: each bin's X and Y amounts at its price (the active bin's asset above the price, its quote below)`;
const USD_LIVE =
  'USD: asset × mid × quote USD, quote × quote USD (USDC/USDT at par, SOL from Jupiter Price v3, as the collector’s curves)';
const USD_RECORDED =
  'USD: USDC/USDT at par; any other quote implied from the asset’s routed reference price at that hour (risk_asset_snapshots.ref_mid_usd ÷ the pool mid, the newest within 2 h before the recording)';

export async function registerPoolLiquidityRoute(
  app: FastifyInstance,
  db: Db,
  reader: ChainReader = rpcChainReader(),
  store: RecordedStore = recordedStore(),
  now: () => number = Date.now,
) {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const service = poolLiquidityService(reader);

  /** Reference prices of one asset in a window, oldest first, for implying a non-stable quote's USD price. */
  async function refMids(assetMint: string, from: number, to: number) {
    return db
      .select({ t: riskAssetSnapshots.fetchedAt, usd: riskAssetSnapshots.refMidUsd })
      .from(riskAssetSnapshots)
      .where(
        and(
          eq(riskAssetSnapshots.assetMint, assetMint),
          gte(riskAssetSnapshots.fetchedAt, new Date(from - 2 * 3_600_000)),
          lte(riskAssetSnapshots.fetchedAt, new Date(to)),
        ),
      )
      .orderBy(asc(riskAssetSnapshots.fetchedAt));
  }
  const refAt = (mids: Array<{ t: Date; usd: number }>, at: number) => {
    let best: number | null = null;
    for (const m of mids) {
      const t = m.t.getTime();
      if (t > at) break;
      if (at - t <= 2 * 3_600_000) best = m.usd;
    }
    return best;
  };
  /** A recording decoded, with the quote priced at par or from the asset's reference price at that hour. */
  function decodeRecorded(
    p: PoolRow & { quoteMint: string },
    rec: Recorded,
    bands: number,
    rangePct: number,
    refUsd: number | null,
  ) {
    const bare = distributionFromBytes(p, rec.head, rec.kids, { quoteUsd: null, bands, rangePct });
    if (!bare) return { d: null, quoteUsd: null, quoteUsdSource: null };
    if (STABLE_QUOTES.has(p.quoteMint))
      return {
        d: distributionFromBytes(p, rec.head, rec.kids, { quoteUsd: 1, bands, rangePct }),
        quoteUsd: 1,
        quoteUsdSource: 'stable_par',
      };
    const q = refUsd != null && bare.midPrice > 0 ? refUsd / bare.midPrice : null;
    return {
      d:
        q == null
          ? bare
          : distributionFromBytes(p, rec.head, rec.kids, { quoteUsd: q, bands, rangePct }),
      quoteUsd: q,
      quoteUsdSource: q == null ? null : 'implied_from_reference_mid',
    };
  }

  f.get(
    '/risk/pools/:address/liquidity',
    {
      schema: {
        summary:
          'Liquidity distribution of one registry pool around its current price: asset above the price, quote below, by price band (read live and kept 60 s, or the collector’s newest hourly recording when a live read is not possible)',
        description: `Concentrated-liquidity pools: active liquidity per band from cumulative liquidityNet, as token amounts. Bin pools: the bins' amounts. Constant-product pools: distribution null, reason not_applicable. basis=auto (default) reads live and falls back to the newest recording when the live read is gated (DA3), has no RPC or fails; basis=live never falls back; basis=recorded reads only the recording. The answer's basis and fetchedAt say which.\n\n${DISCLAIMER.en}`,
        params: z.object({ address: z.string() }),
        querystring: z.object({
          bands: z.coerce.number().int().min(2).max(200).default(60),
          rangePct: z.coerce.number().positive().max(0.9).default(0.3),
          basis: z.enum(['auto', 'live', 'recorded']).default('auto'),
        }),
        response: {
          200: PoolLiquidityResponse,
          404: z.object({ error: z.string() }),
          503: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const [p] = await db
        .select()
        .from(riskPools)
        .where(eq(riskPools.address, req.params.address))
        .limit(1);
      if (!p) return reply.code(404).send({ error: `unknown pool ${req.params.address}` });
      const { bands, rangePct, basis } = req.query;
      const common = {
        pool: p.address,
        venue: p.venue,
        asset: p.assetSymbol,
        quote: p.quoteSymbol,
        priceUnit: 'quote per asset' as const,
        methodVersion: POOL_LIQUIDITY_METHOD_VERSION,
        provenance: 'live' as const,
        disclaimer: DISCLAIMER.en,
      };
      const recorded = async () => {
        const rec = store.latest(p.address);
        if (!rec) return null;
        const at = Date.parse(rec.fetchedAt);
        const ref = STABLE_QUOTES.has(p.quoteMint)
          ? null
          : refAt(await refMids(p.assetMint, at, at), at);
        const r = decodeRecorded(p, rec, bands, rangePct, ref);
        const d = r.d;
        return {
          ...common,
          midPrice: d?.midPrice ?? null,
          basis: 'recorded' as const,
          fetchedAt: rec.fetchedAt,
          slot: rec.slot,
          distribution: d ? ('bands' as const) : null,
          reason: d ? null : ('not_applicable' as const),
          bands: d?.bands ?? null,
          totalAssetUsd: d?.totalAssetUsd ?? null,
          totalQuoteUsd: d?.totalQuoteUsd ?? null,
          totalAsset: d?.totalAsset ?? null,
          totalQuote: d?.totalQuote ?? null,
          quoteUsd: r.quoteUsd,
          quoteUsdSource: r.quoteUsdSource,
          usdNullReason: d && r.quoteUsd === null ? 'no_quote_price' : null,
          source: RECORDED_SOURCE,
          method: d
            ? `${bandMethod(bands, rangePct)}, over every array in the recording; ${USD_RECORDED}; liquidity is L at the band's middle (null for bins)`
            : 'no price bands in this pool’s recording (not_applicable)',
        };
      };
      if (basis === 'recorded') {
        const r = await recorded();
        return r ?? reply.code(404).send({ error: `no recording of pool ${p.address}` });
      }
      let a: Answer;
      try {
        a = await service.get(p, bands, rangePct);
      } catch (e) {
        if (basis === 'auto') {
          const r = await recorded();
          if (r) return r;
        }
        // the transport's text is never passed on (it can carry the RPC's address)
        const msg = String((e as Error)?.message ?? '');
        const error = /SOLANA_RPC_URL is not set/.test(msg)
          ? 'no Solana RPC configured on this server (SOLANA_RPC_URL is not set)'
          : /did not answer|not found on chain|^gate DA3/.test(msg)
            ? msg
            : 'the Solana RPC read failed';
        return reply.code(503).send({ error: [error, rpcDetail(e)].filter(Boolean).join(': ') });
      }
      const d = a.distribution;
      return {
        ...common,
        midPrice: a.midPrice,
        basis: 'live' as const,
        fetchedAt: a.fetchedAt,
        slot: a.slot,
        distribution: d ? ('bands' as const) : null,
        reason: a.reason,
        bands: d?.bands ?? null,
        totalAssetUsd: d?.totalAssetUsd ?? null,
        totalQuoteUsd: d?.totalQuoteUsd ?? null,
        totalAsset: d?.totalAsset ?? null,
        totalQuote: d?.totalQuote ?? null,
        quoteUsd: a.quoteUsd,
        quoteUsdSource: a.quoteUsdSource,
        usdNullReason: d && a.quoteUsd === null ? 'no_quote_price' : null,
        source: SOURCE,
        method: d
          ? `${bandMethod(bands, rangePct)}, over the fetched tick arrays; ${USD_LIVE}; liquidity is L at the band's middle (null for bins)`
          : 'constant-product pool: no price bands to read (not_applicable); no RPC read',
      };
    },
  );

  f.get(
    '/risk/pools/:address/liquidity/history',
    {
      schema: {
        summary:
          'One pool’s liquidity value hour by hour, from the collector’s hourly recordings (no RPC): asset side, quote side and their sum in USD',
        description: `For the concentrated-liquidity pools the collector records (the top 80% of registry TVL). Value = the token amounts held by the pool's liquidity within mid × (1 ± ${VALUE_RANGE_PCT}), over every tick or bin array in the recording, in USD; uncollected fees and a full-range position's far tails are not counted. Pools without recordings: reason not_collected; constant-product pools: not_applicable.\n\n${DISCLAIMER.en}`,
        params: z.object({ address: z.string() }),
        querystring: z.object({
          hours: z.coerce
            .number()
            .int()
            .positive()
            .max(24 * 31)
            .default(24 * 30),
        }),
        response: { 200: PoolLiquidityHistoryResponse, 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const [p] = await db
        .select()
        .from(riskPools)
        .where(eq(riskPools.address, req.params.address))
        .limit(1);
      if (!p) return reply.code(404).send({ error: `unknown pool ${req.params.address}` });
      const since = now() - req.query.hours * 3_600_000;
      // the reference prices of the whole window, read once; the recordings one at a time (pool-recorded.ts)
      const mids =
        CHILD_OFFSETS[p.venue] && !STABLE_QUOTES.has(p.quoteMint)
          ? await refMids(p.assetMint, since, now())
          : [];
      const points = [];
      for (const rec of CHILD_OFFSETS[p.venue] ? store.since(p.address, since) : []) {
        const at = Date.parse(rec.fetchedAt);
        const r = decodeRecorded(
          p,
          rec,
          2,
          VALUE_RANGE_PCT,
          STABLE_QUOTES.has(p.quoteMint) ? null : refAt(mids, at),
        );
        const d = r.d;
        const priced = d && d.totalAssetUsd != null && d.totalQuoteUsd != null;
        points.push({
          t: rec.fetchedAt,
          slot: rec.slot,
          midPrice: d?.midPrice ?? null,
          assetUsd: priced ? d.totalAssetUsd : null,
          quoteSideUsd: priced ? d.totalQuoteUsd : null,
          valueUsd: priced ? (d.totalAssetUsd as number) + (d.totalQuoteUsd as number) : null,
          quoteUsd: r.quoteUsd,
          usdNullReason: !d ? 'not_applicable' : priced ? null : 'no_quote_price',
        });
      }
      return {
        pool: p.address,
        venue: p.venue,
        asset: p.assetSymbol,
        quote: p.quoteSymbol,
        resolution: 'hour' as const,
        rangePct: VALUE_RANGE_PCT,
        from: points[0]?.t ?? null,
        to: points[points.length - 1]?.t ?? null,
        points,
        reason: !CHILD_OFFSETS[p.venue]
          ? ('not_applicable' as const)
          : points.length
            ? null
            : ('not_collected' as const),
        source: RECORDED_SOURCE,
        method: `per hourly recording: the token amounts held by the pool's liquidity within mid × (1 ± ${VALUE_RANGE_PCT}), ${bandMethod(2, VALUE_RANGE_PCT)}; ${USD_RECORDED}; valueUsd = asset side + quote side; uncollected fees are not counted`,
        methodVersion: POOL_LIQUIDITY_METHOD_VERSION,
        provenance: 'live' as const,
        disclaimer: DISCLAIMER.en,
      };
    },
  );

  f.get(
    '/risk/pools/recorded',
    {
      schema: {
        summary:
          'The pools the collector records hourly (pool head and every tick or bin array), with the first and last recording',
        description: DISCLAIMER.en,
        response: {
          200: z.object({
            pools: z.array(
              z.object({
                address: z.string(),
                venue: z.string(),
                asset: z.string(),
                quote: z.string().nullable(),
                hours: z.number(),
                from: z.string().nullable(),
                to: z.string().nullable(),
              }),
            ),
            source: z.string(),
            disclaimer: z.string(),
          }),
        },
      },
    },
    async () => {
      const list = store.pools();
      const rows = list.length
        ? await db
            .select()
            .from(riskPools)
            .where(
              inArray(
                riskPools.address,
                list.map((x) => x.pool),
              ),
            )
        : [];
      const by = new Map(rows.map((r) => [r.address, r]));
      const hourOf = (f: string) => {
        const m = /(\d{4}-\d{2}-\d{2})[/\\](\d{2})[/\\]/.exec(f);
        return m ? `${m[1]}T${m[2]}:00:00.000Z` : null;
      };
      return {
        pools: list
          .filter((x) => by.has(x.pool))
          .map((x) => {
            const r = by.get(x.pool) as (typeof rows)[number];
            return {
              address: x.pool,
              venue: r.venue,
              asset: r.assetSymbol,
              quote: r.quoteSymbol,
              hours: x.files.length,
              from: hourOf(x.files[0] ?? ''),
              to: hourOf(x.files[x.files.length - 1] ?? ''),
            };
          })
          .sort((a, b) => a.asset.localeCompare(b.asset)),
        source: RECORDED_SOURCE,
        disclaimer: DISCLAIMER.en,
      };
    },
  );
}

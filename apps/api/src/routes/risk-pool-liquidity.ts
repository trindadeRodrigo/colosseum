import { createRpc, type SolanaRpc } from '@colosseum/chain-solana';
import { ask } from '@colosseum/chain-solana/vault';
import { type Db, riskPools } from '@colosseum/db';
import { DISCLAIMER } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';
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

/** The pool-liquidity reads with their caches; `now` and `reader` are seams for tests. */
export function poolLiquidityService(reader: ChainReader, now: () => number = Date.now) {
  const answers = new Map<string, { at: number; value: Promise<Answer> }>();
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
    bands: number,
    rangePct: number,
  ): Promise<Answer> {
    const offsets = CHILD_OFFSETS[p.venue];
    if (!offsets)
      return {
        midPrice: null,
        fetchedAt: null,
        slot: null,
        distribution: null,
        reason: 'not_applicable',
        quoteUsd: null,
        quoteUsdSource: null,
      };
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
    const q = await quotePrice(p.quoteMint);
    const distribution = distributionFromBytes(
      p,
      head,
      k.keys.map((x) => data.get(x)).filter((x): x is Uint8Array => !!x),
      { quoteUsd: q?.usd ?? null, bands, rangePct },
    );
    return {
      midPrice: distribution?.midPrice ?? null,
      fetchedAt,
      slot,
      distribution,
      reason: distribution ? null : 'not_applicable',
      quoteUsd: q?.usd ?? null,
      quoteUsdSource: q?.source ?? null,
    };
  }

  return {
    get(p: PoolRow & { program: string; quoteMint: string }, bands: number, rangePct: number) {
      const key = `${p.address}|${bands}|${rangePct}`;
      const hit = answers.get(key);
      if (hit && now() - hit.at <= ANSWER_TTL_MS) return hit.value;
      const value = read(p, bands, rangePct);
      answers.set(key, { at: now(), value });
      // a failed read is not kept
      value.catch(() => answers.delete(key));
      return value;
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

export async function registerPoolLiquidityRoute(
  app: FastifyInstance,
  db: Db,
  reader: ChainReader = rpcChainReader(),
) {
  const f = app.withTypeProvider<ZodTypeProvider>();
  const service = poolLiquidityService(reader);
  f.get(
    '/risk/pools/:address/liquidity',
    {
      schema: {
        summary:
          'Liquidity distribution of one registry pool around its current price: asset above the price, quote below, by price band (read live, kept 60 s)',
        description: `Concentrated-liquidity pools: active liquidity per band from cumulative liquidityNet, as token amounts. Bin pools: the bins' amounts. Constant-product pools: distribution null, reason not_applicable.\n\n${DISCLAIMER.en}`,
        params: z.object({ address: z.string() }),
        querystring: z.object({
          bands: z.coerce.number().int().min(2).max(200).default(60),
          rangePct: z.coerce.number().positive().max(0.9).default(0.3),
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
      let a: Answer;
      try {
        a = await service.get(p, req.query.bands, req.query.rangePct);
      } catch (e) {
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
        pool: p.address,
        venue: p.venue,
        asset: p.assetSymbol,
        quote: p.quoteSymbol,
        midPrice: a.midPrice,
        priceUnit: 'quote per asset' as const,
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
          ? `${req.query.bands} equal-width bands across mid × (1 ± ${req.query.rangePct}), the band holding the price split at it; concentrated liquidity: L between initialized ticks from cumulative liquidityNet, token0 = L·(1/√a − 1/√b) above the price, token1 = L·(√b − √a) below, over the fetched tick arrays; bins: each bin's X and Y amounts at its price (the active bin's asset above the price, its quote below); USD: asset × mid × quote USD, quote × quote USD (USDC/USDT at par, SOL from Jupiter Price v3, as the collector's curves); liquidity is L at the band's middle (null for bins)`
          : 'constant-product pool: no price bands to read (not_applicable); no RPC read',
        methodVersion: POOL_LIQUIDITY_METHOD_VERSION,
        provenance: 'live' as const,
        disclaimer: DISCLAIMER.en,
      };
    },
  );
}

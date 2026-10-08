import type { Db } from '@colosseum/db';
import { defaultFactsParams } from '@colosseum/risk';
import {
  type AssetFacts,
  type Fact,
  type FactRegime,
  finiteFacts,
  type Provenance,
} from '@colosseum/schemas';
import { loadAssetFacts } from './facts';
import type { AgentAnalytics, AgentAnalyticsResult, AnalyticsFigure } from './orders/vault-agent';
import { resolveExitTwins } from './plan-inputs';

// What the vault and new-goal conversations hand the model from Bearing besides the plan inputs: a few
// figures of each listed asset's fact sheet (facts.ts), each with its pin or null with the reason. A sheet
// is about 44 KB and ten queries, so the model never sees one: it gets these figures as evidence it may
// cite, and explains them in words (orders/vault-agent.ts). A test-network token reads the sheet of the
// mainnet token it models, as the plan inputs do, and its figures are labelled sandbox with the model named.
//
// Outside the /v1 route table: the sheets read the risk layer's fixtures from files, which no file the /v1
// routes reach may do (apps/api/src/orders/orders.test.ts).

type Sheet = (db: Db, id: string, sizeUsd: number) => Promise<AssetFacts | null>;
type Read = Extract<AgentAnalyticsResult, { assets: unknown }>;

/** Ten minutes: the collectors write hourly at most. */
const TTL_MS = 10 * 60_000;
/** Sheets read at once across every conversation: each holds one of the pool's 15 connections. */
const CONCURRENCY = 3;
/** The reply goes on without the figures past this; the reads carry on and fill the cache. */
const TIMEOUT_MS = 8_000;
const MAX_ENTRIES = 64;

/** The figures the model reads, from one sheet, each with the regime it is about or none. */
export function projectSheet(sheet: AssetFacts): AnalyticsFigure[] {
  const figure = (
    metric: AnalyticsFigure['metric'],
    fact: Fact,
    regime: FactRegime | null,
  ): AnalyticsFigure => {
    const at = regime ? { regime } : {};
    return fact.value === null
      ? { metric, ...at, value: null, reason: fact.reason }
      : {
          metric,
          ...at,
          value: fact.value,
          unit: fact.unit,
          source: fact.source,
          method: `${fact.method} (${fact.methodVersion})`,
          fetchedAt: fact.fetchedAt,
          provenance: fact.provenance,
          // the size it was measured at, when that is not the sheet's (an LP-exit grid point)
          ...(fact.sizeUsd !== undefined && fact.sizeUsd !== sheet.sizeUsd
            ? { sizeUsd: fact.sizeUsd }
            : {}),
          ...(fact.quality === 'lower_bound' ? { lowerBound: true } : {}),
        };
  };
  const worst = sheet.costs.find((cost) => cost.regime === sheet.worstRegime);
  // With no regime measured, every regime's exit says why; the first one speaks for the worst.
  const unmeasured = sheet.costs.find((cost) => cost.exit.total.value === null)?.exit.total;
  const none: Fact = unmeasured ?? { value: null, reason: 'not_collected', unit: 'fraction' };
  const volume = sheet.flow?.byWindow.find((row) => row.window === '28d')?.volumeUsd;
  return [
    figure('exit_worst', worst?.exit.total ?? none, sheet.worstRegime),
    // the other regimes: the worst one is above
    ...sheet.costs
      .filter((cost) => cost.regime !== sheet.worstRegime)
      .map((cost) => figure('exit', cost.exit.total, cost.regime)),
    figure('cap1pct', worst?.exitCapacityUsd ?? { ...none, unit: 'usd' }, sheet.worstRegime),
    figure('weekend', sheet.weekendRatio, null),
    figure('lp_top1', sheet.liquidityStability.lpTop1Share, null),
    figure('lp_exit', sheet.liquidityStability.lpExitCost, null),
    // the variation is measured in the worst regime, which the fact names
    figure(
      'cap_variation',
      sheet.liquidityStability.capacityVariation,
      sheet.liquidityStability.capacityVariation.regime ?? null,
    ),
    figure('volume_28d', volume ?? { value: null, reason: 'not_collected', unit: 'usd' }, null),
    figure('volatility', sheet.marketRisk.volatilityAnnual, null),
    figure('drawdown', sheet.marketRisk.maxDrawdown, null),
  ];
}

/**
 * On a chain that is not live, no figure says live: a test-network token's figures are its mainnet
 * model's, labelled sandbox, with the source naming whose they are.
 */
function relabel(
  figures: AnalyticsFigure[],
  provenance: Provenance | undefined,
  twin: { twinSymbol: string; symbol: string } | undefined,
): AnalyticsFigure[] {
  if (!provenance || provenance === 'live') return figures;
  return figures.map((figure) =>
    figure.value === null
      ? figure
      : {
          ...figure,
          provenance: figure.provenance === 'live' ? provenance : figure.provenance,
          source: twin
            ? `${figure.source}; mainnet ${twin.twinSymbol} figures applied to the test-network token ${twin.symbol}`
            : figure.source,
        },
  );
}

/** At most `n` reads at once; the rest wait their turn, and a finished read hands its turn on. */
function limiter(n: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    else running += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/** Two significant figures: a vault's value moves with its prices, and its reads are kept by this. */
export function roundSize(usd: number): number {
  const step = 10 ** Math.max(0, Math.floor(Math.log10(usd)) - 1);
  return Math.round(usd / step) * step;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The collectors store an EVM address in lower case; a shelf may spell it checksummed. */
const stored = (address: string) => (EVM_ADDRESS.test(address) ? address.toLowerCase() : address);

export function createAgentAnalytics(
  deps: {
    sheet?: Sheet;
    twins?: typeof resolveExitTwins;
    concurrency?: number;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): AgentAnalytics {
  const sheet: Sheet = deps.sheet ?? ((db, id, sizeUsd) => loadAssetFacts(db, id, { sizeUsd }));
  const twins = deps.twins ?? resolveExitTwins;
  const ttl = deps.ttlMs ?? TTL_MS;
  const timeout = deps.timeoutMs ?? TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const limit = limiter(deps.concurrency ?? CONCURRENCY);
  const { refSizeUsd, tau } = defaultFactsParams();
  type Entry = { at: number; read: Promise<Read['assets']>; waiting: number; dropped: boolean };
  const cache = new Map<string, Entry>();

  return async ({ db, chain, assets, provenance, sizeUsd }) => {
    const vault = sizeUsd !== null && Number.isFinite(sizeUsd) && sizeUsd >= 1;
    const size = vault ? roundSize(sizeUsd) : refSizeUsd;
    const base = { sizeUsd: size, basis: vault ? ('vault' as const) : ('reference' as const), tau };
    const listed = assets.filter((asset) => asset.chain === chain && asset.cls !== 'cash');
    const key = [chain, provenance ?? '', size, ...listed.map((asset) => asset.id).sort()].join(
      '|',
    );
    for (const [k, entry] of cache) if (now() - entry.at > ttl) cache.delete(k);
    let entry = cache.get(key);
    if (!entry) {
      const fresh: Entry = { at: now(), read: Promise.resolve([]), waiting: 0, dropped: false };
      // A sheet whose every caller has gone on without it is not started.
      const sheetOf = (id: string) =>
        limit(() =>
          fresh.dropped ? Promise.reject(new Error('dropped')) : sheet(db, stored(id), size),
        );
      fresh.read = (async () => {
        const twinOf = new Map(
          (await twins(db, listed, provenance)).map((twin) => [twin.id, twin]),
        );
        return Promise.all(
          listed.map(async (asset) => {
            const twin = twinOf.get(asset.id);
            const found = await sheetOf(twin?.twinMint ?? asset.address);
            return {
              assetId: asset.id,
              modelledOn: twin?.twinSymbol ?? null,
              figures: found ? relabel(projectSheet(finiteFacts(found)), provenance, twin) : null,
            };
          }),
        );
      })();
      entry = fresh;
      cache.set(key, fresh);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      // A failed or dropped read is not kept: the next conversation tries again.
      fresh.read.catch(() => {
        if (cache.get(key) === fresh) cache.delete(key);
      });
    }
    const current = entry;
    current.waiting += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        current.read,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeout);
        }),
      ]);
      if (result === 'timeout') {
        current.waiting -= 1;
        if (current.waiting === 0) {
          current.dropped = true;
          if (cache.get(key) === current) cache.delete(key);
        }
        return { unavailable: 'analytics_timeout' };
      }
      current.waiting -= 1;
      return { ...base, assets: result };
    } catch {
      current.waiting -= 1;
      return { unavailable: 'analytics_failed' };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The server's reader: one cache and one limit on reads for every conversation. */
export const bearingAgentAnalytics = createAgentAnalytics();

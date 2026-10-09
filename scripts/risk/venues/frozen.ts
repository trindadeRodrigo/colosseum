import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseQuotes, type StoredQuote } from '../lib-routing-gap';
import solanaList from '../universe/solana.json';
import {
  type ByrealProbeFile,
  type CutPoolRow,
  DECODED_PROGRAMS,
  type DiscoveryRow,
  type ExcludedPool,
  type FlowRow,
  type KnownPool,
  type RoutePoolsFile,
} from './lib';
import type { RegistryRow, SolanaInputs } from './table';

// PLAN-UNIVERSE RU.13 — the rows frozen under fixtures/, read back as the table's inputs. `pnpm risk:venues --fixtures`
// and the tests both read them through here, so the tables of the frozen window can be made from the repository
// alone: no collector's home, no database, no network.

export const FROZEN = {
  /** Jupiter's stored quotes of one window, line for line. */
  quotes: 'fixtures/risk/venues/quotes-20261006T2115-20261007T0110.jsonl.gz',
  /** One stored row for each shape of route. */
  cases: 'fixtures/risk/venues/quotes-cases.jsonl',
  routePools: 'fixtures/risk/venues/route-pools-20261007T1222.json',
  byreal: 'fixtures/risk/venues/byreal-5pobXo-20261007T1222.json',
  excluded: 'fixtures/risk/venues/registry-excluded-20261001T0138.json',
  discovery: 'fixtures/risk/venues/discovery-dexscreener-20261001T0049.json.gz',
  robinhood: 'fixtures/risk/venues/robinhood-20261005T2011.json.gz',
  /** The registry run of Oct 1, as RU.1 and RU.4 froze it: every pool found, and the collected pools' detail. */
  known: 'fixtures/risk/universe/solana-registry-20261001T0139.json.gz',
  registryDetail: 'fixtures/risk/universe/solana-registry-detail-20261001T0139.json.gz',
} as const;

export const readFrozen = <T>(file: string): T =>
  JSON.parse(
    file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString() : readFileSync(file, 'utf8'),
  ) as T;

/** Quote rows from a `.jsonl` file, gzipped or not. */
export const readQuotes = (file: string): StoredQuote[] =>
  parseQuotes(
    file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString() : readFileSync(file, 'utf8'),
  );

export type FrozenRobinhood = {
  flow: { source: string; rows: FlowRow[] };
  cut: {
    source: string;
    method: string;
    fetchedAt: string;
    dexscreenerAtCap: string[];
    pools: CutPoolRow[];
  };
};

/** The tracked stocks of the committed Solana list: mint to symbol. */
export const trackedStocks = (): Map<string, string> =>
  new Map(solanaList.assets.map((a) => [a.address, a.symbol]));

/**
 * The collector's registry as the frozen copies hold it: the detail file gives each collected pool's venue, exit path
 * and two mints, the base file its symbol and its money, and the program follows from the venue.
 */
export function frozenRegistry(): {
  fetchedAt: string;
  source: string;
  pools: RegistryRow[];
  known: KnownPool[];
} {
  const base = readFrozen<{ fetched_at: string; source: string; pools: KnownPool[] }>(FROZEN.known);
  const detail = readFrozen<{
    pools: Array<{
      address: string;
      mint: string;
      quoteMint: string;
      venue: string;
      exitPath: string;
    }>;
  }>(FROZEN.registryDetail);
  const programOf = Object.fromEntries(Object.entries(DECODED_PROGRAMS).map(([p, v]) => [v, p]));
  const byAddress = new Map(base.pools.map((p) => [p.address, p]));
  return {
    fetchedAt: base.fetched_at,
    source: base.source,
    known: base.pools,
    pools: detail.pools.map((p) => {
      const known = byAddress.get(p.address);
      const program = programOf[p.venue];
      if (!known || !program) throw new Error(`${p.address}: not in both frozen registry files`);
      return {
        address: p.address,
        venue: p.venue,
        exitPath: p.exitPath,
        program,
        assetMint: p.mint,
        assetSymbol: known.asset,
        quoteMint: p.quoteMint,
        tvlUsd: known.tvlUsd,
      };
    }),
  };
}

/** Everything the Solana table reads, from the frozen files. */
export function frozenSolana(): SolanaInputs {
  const registry = frozenRegistry();
  const excluded = readFrozen<{
    source: string;
    fetchedAt: string;
    minPoolTvlUsd: number | null;
    excluded: ExcludedPool[];
  }>(FROZEN.excluded);
  if (excluded.fetchedAt !== registry.fetchedAt)
    throw new Error('the frozen excluded pools and the frozen registry are not one run');
  return {
    tracked: trackedStocks(),
    quotes: readQuotes(FROZEN.quotes),
    quotesSource: `${FROZEN.quotes}: the rows scripts/risk/collector/quotes.ts stored from https://api.jup.ag/swap/v1/quote in that window, line for line`,
    routePools: readFrozen<RoutePoolsFile>(FROZEN.routePools),
    registry: {
      source: `${FROZEN.registryDetail}, ${FROZEN.known} and ${FROZEN.excluded} (registry-0.1)`,
      fetchedAt: registry.fetchedAt,
      minPoolTvlUsd: excluded.minPoolTvlUsd,
      pools: registry.pools,
      excluded: excluded.excluded,
    },
    known: { source: registry.source, fetchedAt: registry.fetchedAt, pools: registry.known },
    discovery: readFrozen<{ rows: DiscoveryRow[] }>(FROZEN.discovery).rows,
  };
}

export const frozenByreal = (): ByrealProbeFile => readFrozen<ByrealProbeFile>(FROZEN.byreal);
export const frozenRobinhood = (): FrozenRobinhood => readFrozen<FrozenRobinhood>(FROZEN.robinhood);

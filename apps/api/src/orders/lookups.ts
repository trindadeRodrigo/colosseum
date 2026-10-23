import type { Db } from '@colosseum/db';
import type {
  BasketAsset,
  ChainId,
  FactNullReason,
  Provenance,
  VaultAgentSource,
} from '@colosseum/schemas';

// What the asset lookups answer (gate FIGURES-BY-REFERENCE as amended 2026-10-14): the facts of one listed
// asset from the data the server holds, each an evidence a reference may name. Types only, so a /v1 route
// can be handed the reader (asset-lookups.ts, outside the /v1 route table, which reads the risk layer's
// fixtures) without reaching it.

export const LOOKUP_PARTS = ['profile', 'price_history', 'pools', 'lending', 'bearing'] as const;
export type LookupPart = (typeof LOOKUP_PARTS)[number];
export const LOOKUP_WINDOWS = ['24h', '7d', '30d'] as const;
export type LookupWindow = (typeof LOOKUP_WINDOWS)[number];

/** A measured figure: an evidence with what it measures in words (no digit), its value and unit. */
export type LookupFact = VaultAgentSource & {
  assetId: string;
  label: string;
  value: number;
  unit: string;
  /** The true value is at least this. */
  lowerBound?: true;
  /** The reading is past its age limit: this is its age, in seconds. */
  staleAgeSec?: number;
  /**
   * A figure over a window shown with some of its hours not collected (at most 5% of them): how many are
   * missing, of the window's `windowHours`. Absent when none is.
   */
  missingHours?: number;
  windowHours?: number;
};
/** A figure that is not measured: the id it would have had, what it measures, and why. */
export type LookupMissing = {
  id: string;
  assetId: string;
  label: string;
  reason: FactNullReason;
  /** The hours of the window the data does not reach. */
  missingHours?: number;
};
/**
 * One part's answer. `modelledOn`: the mainnet token a test-network token's facts are read from. `unread`:
 * the read is still running (`reading`, its answer fills the cache for the next ask) or failed.
 */
export type LookupAnswer = {
  facts: LookupFact[];
  missing: LookupMissing[];
  modelledOn: string | null;
  unread?: 'reading' | 'failed';
};
export type LookupQuery = {
  db: Db;
  chain: ChainId;
  asset: BasketAsset;
  /** The label of the chain's figures as it runs now; `mock` and `sandbox` relabel every fact. */
  provenance?: Provenance;
  /** How long to wait for a read that is not kept, in milliseconds. Default 2,500. */
  waitMs?: number;
};
/** The reads, each answering within its wait and never throwing. */
export type AssetLookups = {
  profile(q: LookupQuery): Promise<LookupAnswer>;
  priceHistory(q: LookupQuery & { window: LookupWindow }): Promise<LookupAnswer>;
  pools(q: LookupQuery): Promise<LookupAnswer>;
  lending(q: LookupQuery): Promise<LookupAnswer>;
  bearing(q: LookupQuery): Promise<LookupAnswer>;
};

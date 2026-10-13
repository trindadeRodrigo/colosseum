import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, riskAssetSnapshots, riskPriceObservations } from '@colosseum/db';
import {
  defaultOracleFactsParams,
  defaultRegimeParams,
  type OracleFactsInput,
  type VaultPriceLimits,
} from '@colosseum/risk';
import type { AssetList } from '@colosseum/schemas';
import { type AnyColumn, and, eq, gte, lte, sql } from 'drizzle-orm';

// The rows behind the `oracle` block of an asset sheet (PLAN-UNIVERSE RU.9). The oracle and what it is comes from
// the chain's asset list (scripts/risk/universe/<chain>.json, gate UNIVERSE); its readings from
// risk_price_observations; the pool mid from risk_asset_snapshots.ref_mid_usd, the collector's own mid of the
// asset's reference pool. The two are handed over apart (gate ORACLE-VS-DEX). Read-only.

const ROOT = process.env.REPO_ROOT ?? join(import.meta.dirname, '..', '..', '..');
const files = new Map<string, unknown>();
/** A committed file of the repository, read once for the life of the process. */
function json<T>(path: string): T {
  if (!files.has(path)) files.set(path, JSON.parse(readFileSync(join(ROOT, path), 'utf8')));
  return files.get(path) as T;
}

/** Days of readings behind the oracle figures. */
export const ORACLE_WINDOW_DAYS = 28;

/** How each kind of oracle is stored in risk_price_observations. Scope: the collector's own read of the entry, which
 *  carries Scope's timestamp; the prices klend logs on a refresh carry none and are left out. */
const STORED = {
  chainlink: { priceSource: 'chainlink', method: null },
  scope: { priceSource: 'kamino_scope', method: 'scope_feed_read' },
} as const;

/** A Solana address is matched exactly; an EVM one whatever its case, so a row spelled another way is still found. */
const sameAddress = (column: AnyColumn, chain: string, address: string) =>
  chain === 'solana' ? eq(column, address) : sql`lower(${column}) = ${address.toLowerCase()}`;

type ListRow = { list: AssetList; asset: AssetList['assets'][number] };
let lists: AssetList[] | null = null;
/** The row of the asset lists for an address: exact on Solana, whatever the case on an EVM chain. */
export function listedAsset(mint: string): ListRow | null {
  lists ??= ['solana', 'robinhood'].map(
    (chain) => json(`scripts/risk/universe/${chain}.json`) as AssetList,
  );
  for (const list of lists) {
    const asset = list.assets.find((a) =>
      list.chain === 'solana' ? a.address === mint : a.address === mint.toLowerCase(),
    );
    if (asset) return { list, asset };
  }
  return null;
}

type LimitsFile = {
  source: string;
  method: string;
  fetchedAt: string;
  provenance: VaultPriceLimits['provenance'];
  chains: Record<
    string,
    Pick<
      VaultPriceLimits,
      | 'maxAgeSeconds'
      | 'maxAgeNote'
      | 'maxDistanceBps'
      | 'maxDistanceNote'
      | 'maxDistancePlaceholder'
    >
  >;
  session: Omit<VaultPriceLimits['session'], 'closedDays'>;
};

/** The limits the vault of the asset's chain holds today, from the fixture that transcribes the design. */
export function vaultPriceLimits(chain: string): VaultPriceLimits {
  const f = json('fixtures/risk/vault-price-limits.json') as LimitsFile;
  const calendar = json('fixtures/risk/us-market-holidays.json') as {
    closed: string[];
    earlyClose13ET: string[];
  };
  const own = f.chains[chain === 'solana' ? 'solana' : 'evm'] as LimitsFile['chains'][string];
  return {
    ...own,
    session: {
      label: f.session.label,
      weekdaysUtc: f.session.weekdaysUtc,
      fromUtcMinute: f.session.fromUtcMinute,
      toUtcMinute: f.session.toUtcMinute,
      closedDays: new Set([...calendar.closed, ...calendar.earlyClose13ET]),
    },
    source: `fixtures/risk/vault-price-limits.json (${f.source})`,
    fetchedAt: f.fetchedAt,
    method: f.method,
    provenance: f.provenance,
  };
}

/**
 * What `buildOracleFacts` needs for one asset, or undefined when the address is on no asset list (the sheet then has
 * no `oracle` block). A Scope price is read through each Kamino reserve that uses it: the readings of the reserve
 * with the most rows in the window are used, and the source names it.
 */
export async function loadOracleInput(
  db: Db,
  mint: string | null,
  now: Date,
): Promise<OracleFactsInput | undefined> {
  const row = mint ? listedAsset(mint) : null;
  if (!mint || !row) return undefined;
  const { list, asset } = row;
  const o = asset.oracle;
  const base = {
    feedReason: asset.oracleReason,
    autoRebalanceOpen: asset.autoRebalanceOpen,
    limits: vaultPriceLimits(list.chain),
    regimeParams: defaultRegimeParams(json('fixtures/risk/us-market-holidays.json')),
    params: defaultOracleFactsParams(),
  };
  if (!o) return { ...base, feed: null, readings: null, mids: null };
  const feed = {
    kind: o.kind,
    ref: o.ref,
    account: o.account,
    averageRef: o.twapRef,
    description: o.description,
    prices: o.prices,
    pricesReason: o.pricesReason,
    source: o.source,
    fetchedAt: o.fetchedAt,
    method: o.method,
    provenance: o.provenance,
  };
  const from = new Date(now.getTime() - ORACLE_WINDOW_DAYS * 86_400_000);
  const stored = STORED[o.kind];
  const obs = await db
    .select({
      observedAt: riskPriceObservations.observedAt,
      price: riskPriceObservations.price,
      sourceTs: riskPriceObservations.sourceTs,
      ref: riskPriceObservations.ref,
      source: riskPriceObservations.source,
      method: riskPriceObservations.method,
      methodVersion: riskPriceObservations.methodVersion,
      provenance: riskPriceObservations.provenance,
    })
    .from(riskPriceObservations)
    .where(
      and(
        eq(riskPriceObservations.chain, list.chain),
        sameAddress(riskPriceObservations.mint, list.chain, mint),
        eq(riskPriceObservations.priceSource, stored.priceSource),
        eq(riskPriceObservations.quote, 'usd'),
        gte(riskPriceObservations.observedAt, from),
        lte(riskPriceObservations.observedAt, now),
        stored.method ? eq(riskPriceObservations.method, stored.method) : undefined,
        // a Chainlink reading is the feed's own, by its proxy
        o.kind === 'chainlink'
          ? sql`lower(${riskPriceObservations.ref}) = ${o.ref.toLowerCase()}`
          : undefined,
      ),
    )
    .orderBy(riskPriceObservations.observedAt, riskPriceObservations.ref);
  const perRef = new Map<string, number>();
  for (const r of obs) perRef.set(r.ref, (perRef.get(r.ref) ?? 0) + 1);
  const ref = [...perRef].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const used = obs.filter((r) => r.ref === ref);
  const head = used[0];
  const snaps = head
    ? await db
        .select({
          fetchedAt: riskAssetSnapshots.fetchedAt,
          refMidUsd: riskAssetSnapshots.refMidUsd,
          source: riskAssetSnapshots.source,
          methodVersion: riskAssetSnapshots.methodVersion,
          provenance: riskAssetSnapshots.provenance,
        })
        .from(riskAssetSnapshots)
        .where(
          and(
            sameAddress(riskAssetSnapshots.assetMint, list.chain, mint),
            gte(riskAssetSnapshots.fetchedAt, new Date(from.getTime() - 3_600_000)),
            // Nothing after `now`: a sheet built for a past time stays the same when later snapshots land.
            lte(riskAssetSnapshots.fetchedAt, now),
          ),
        )
        .orderBy(riskAssetSnapshots.fetchedAt)
    : [];
  const mid = snaps[0];
  return {
    ...base,
    feed,
    readings: head
      ? {
          source:
            o.kind === 'scope'
              ? `risk_price_observations (${head.source}), Scope price as read for Kamino reserve ${ref}${perRef.size > 1 ? `, one of ${perRef.size} reserves read` : ''}`
              : `risk_price_observations (${head.source.replace(/ at block \d+/, " at each run's block")})`,
          method: head.method,
          methodVersion: head.methodVersion,
          provenance: head.provenance,
          rows: used.map((r) => ({
            at: r.observedAt.toISOString(),
            price: r.price,
            sourceTs: r.sourceTs?.toISOString() ?? null,
          })),
        }
      : null,
    mids: mid
      ? {
          source: 'risk_asset_snapshots.ref_mid_usd',
          method: "the collector's mid of the asset's reference pool",
          methodVersion: mid.methodVersion,
          provenance: mid.provenance,
          rows: snaps.map((s) => ({ at: s.fetchedAt.toISOString(), midUsd: s.refMidUsd })),
        }
      : null,
  };
}

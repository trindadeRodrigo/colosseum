// Step 10b item 8 — what the lending tables may hold. Pure functions; the import script (scripts/risk/lending-import.ts)
// reads the files and writes the rows.
//
//   Positions   Obligations and Jupiter Lend positions are stored locally only (D13). The table gets one row per
//               market, collateral asset and hour: counts, collateral and debt, LTV buckets and the share of the
//               asset's collateral held by the largest 1, 3 and 10 positions. A position counts under its dominant
//               collateral asset by USD, as in the reconstruction (item 7), so live and history rows mean the same.
//   Events      The decode pass keeps every account it names. Before a row is written, `scrubLendingPayload` keeps
//               only numbers, non-address strings and addresses on a public list (registry reserves, vaults,
//               markets, their token accounts, mints and oracles; DEX pools). Owners, obligations, positions,
//               liquidators, signers and recipients are not on it, so they never reach a row.

import { ltvBucket, ltvBucketLabels } from './reconstruct';

// ---------------------------------------------------------------------------------------------------------------
// Position aggregates

/** One position at one hour. `ltv` is debt over collateral value (fraction); null when a price is missing. */
export type LendingPositionInput = {
  asset: string;
  collateralUnits: number;
  collateralUsd: number | null;
  debtUsd: number | null;
  /** Debt in whole tokens by debt asset. */
  debt: Record<string, number>;
  ltv: number | null;
  /** State not known at this hour (Jupiter Lend position in a liquidated branch): counted, not valued. */
  stateUnknown?: boolean;
};

export type LendingBucket = {
  positions: number;
  collateralUnits: number;
  collateralUsd: number | null;
  debtUsd: number | null;
};

export type LendingPositionAggregate = {
  collateralAsset: string;
  positions: number;
  positionsWithDebt: number;
  positionsStateUnknown: number;
  collateralUnits: number;
  collateralUsd: number | null;
  debtUsd: number | null;
  debtByAsset: Record<string, number>;
  buckets: Record<string, LendingBucket>;
  ltvNull: number;
  ltvNullUnits: number;
  top1: number | null;
  top3: number | null;
  top10: number | null;
};

const addNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : a + b;

/** Share of the total held by the largest `n` values; null when the total is not positive. */
export function topShare(values: readonly number[], n: number): number | null {
  const total = values.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  const top = [...values].sort((a, b) => b - a).slice(0, n);
  return top.reduce((s, v) => s + v, 0) / total;
}

/** Aggregate one market's positions at one hour by collateral asset. Positions without debt sit in the first
 *  bucket (LTV 0) whatever the price; a position with debt and no LTV is counted in `ltvNull` with its units.
 *  USD sums are null as soon as one member's USD is null. Top-N shares are over collateral units. */
export function aggregateLendingPositions(
  positions: readonly LendingPositionInput[],
  edges: readonly number[],
): LendingPositionAggregate[] {
  const groups = new Map<string, LendingPositionInput[]>();
  for (const p of positions) {
    const g = groups.get(p.asset) ?? [];
    g.push(p);
    groups.set(p.asset, g);
  }
  const order = ltvBucketLabels(edges);
  const out: LendingPositionAggregate[] = [];
  for (const [asset, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const a: LendingPositionAggregate = {
      collateralAsset: asset,
      positions: list.length,
      positionsWithDebt: 0,
      positionsStateUnknown: 0,
      collateralUnits: 0,
      collateralUsd: 0,
      debtUsd: 0,
      debtByAsset: {},
      buckets: {},
      ltvNull: 0,
      ltvNullUnits: 0,
      top1: null,
      top3: null,
      top10: null,
    };
    const valued: number[] = [];
    for (const p of list) {
      if (p.stateUnknown) {
        a.positionsStateUnknown++;
        continue;
      }
      const hasDebt = Object.values(p.debt).some((v) => v > 0);
      if (hasDebt) a.positionsWithDebt++;
      a.collateralUnits += p.collateralUnits;
      a.collateralUsd = addNullable(a.collateralUsd, p.collateralUsd);
      a.debtUsd = addNullable(a.debtUsd, p.debtUsd);
      for (const [k, v] of Object.entries(p.debt)) a.debtByAsset[k] = (a.debtByAsset[k] ?? 0) + v;
      valued.push(p.collateralUnits);
      const ltvPct = !hasDebt ? 0 : p.ltv === null ? null : 100 * p.ltv;
      if (ltvPct === null) {
        a.ltvNull++;
        a.ltvNullUnits += p.collateralUnits;
        continue;
      }
      const label = ltvBucket(ltvPct, edges);
      const b = a.buckets[label] ?? {
        positions: 0,
        collateralUnits: 0,
        collateralUsd: 0,
        debtUsd: 0,
      };
      b.positions++;
      b.collateralUnits += p.collateralUnits;
      b.collateralUsd = addNullable(b.collateralUsd, p.collateralUsd);
      b.debtUsd = addNullable(b.debtUsd, p.debtUsd);
      a.buckets[label] = b;
    }
    a.buckets = Object.fromEntries(
      order.flatMap((l) => (a.buckets[l] ? [[l, a.buckets[l] as LendingBucket]] : [])),
    );
    a.top1 = topShare(valued, 1);
    a.top3 = topShare(valued, 3);
    a.top10 = topShare(valued, 10);
    out.push(a);
  }
  return out;
}

/** A Kamino obligation row of the collector (`lending-positions/<day>/<HH>/kamino-<market>.jsonl.gz`). */
export type KaminoObligationRow = {
  deposits: Array<{ symbol: string; amount: number; usd: number | null }>;
  borrows: Array<{ symbol: string; amount: number; usd: number | null }>;
  collateralUsd: number | null;
  debtUsd: number | null;
  ltv: number | null;
};

/** The obligation as an aggregate input: dominant collateral asset by USD (`none` without collateral, `mixed` when it
 *  holds several and a price is missing), units summed over its deposits as in the reconstruction. Owner and address
 *  are not read. */
export function kaminoPositionInput(o: KaminoObligationRow): LendingPositionInput | null {
  let best: { sym: string; usd: number } | null = null;
  let units = 0;
  let usd: number | null = 0;
  const syms = new Set<string>();
  for (const d of o.deposits) {
    if (!(d.amount > 0)) continue;
    units += d.amount;
    usd = addNullable(usd, d.usd);
    syms.add(d.symbol);
    if (!best || (d.usd ?? -1) > best.usd) best = { sym: d.symbol, usd: d.usd ?? -1 };
  }
  const debt: Record<string, number> = {};
  let debtUsd: number | null = 0;
  for (const b of o.borrows) {
    if (!(b.amount > 0)) continue;
    debt[b.symbol] = (debt[b.symbol] ?? 0) + b.amount;
    debtUsd = addNullable(debtUsd, b.usd);
  }
  if (!best && Object.keys(debt).length === 0) return null;
  const asset = !best ? 'none' : syms.size > 1 && usd === null ? 'mixed' : best.sym;
  return { asset, collateralUnits: units, collateralUsd: usd, debtUsd, debt, ltv: o.ltv };
}

/** A Jupiter Lend position row of the collector. */
export type JupiterLendPositionRow = {
  collateral: number;
  debt: number;
  ltv: number | null;
  liquidatedBranch?: boolean;
};

/** The position as an aggregate input. USD needs the vault's oracle price in the debt token and a USD price for the
 *  debt token (USDC at par); otherwise USD is null and the LTV, computed by the collector in debt-token terms, still
 *  places the position in its bucket. */
export function jupiterLendPositionInput(
  p: JupiterLendPositionRow,
  v: {
    symbol: string;
    debtSymbol: string;
    oraclePrice: number | null;
    debtPriceUsd: number | null;
  },
): LendingPositionInput | null {
  if (!(p.collateral > 0) && !(p.debt > 0)) return null;
  const usd = v.debtPriceUsd === null || v.oraclePrice === null ? null : v.debtPriceUsd;
  return {
    asset: v.symbol,
    collateralUnits: p.collateral,
    collateralUsd: usd === null ? null : p.collateral * (v.oraclePrice as number) * usd,
    debtUsd: usd === null ? null : p.debt * usd,
    debt: p.debt > 0 ? { [v.debtSymbol]: p.debt } : {},
    ltv: p.ltv,
    stateUnknown: p.liquidatedBranch === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Event payloads

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DIGITS = /^-?\d+$/;

/** Keys whose value identifies one position even when it is a number (Jupiter Lend NFT id). */
const POSITION_KEYS = new Set([
  'nftId',
  'positionId',
  'positionMint',
  'obligation',
  'owner',
  'liquidator',
]);

/** True when the string has the shape of a Solana address (and is not a plain integer). */
export const looksLikeAddress = (s: string) => BASE58_ADDRESS.test(s) && !DIGITS.test(s);

/** Every address found anywhere in the given values (registry rows, pool rows), except under the keys in `skip`. */
export function collectAddresses(
  values: unknown,
  skip: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (looksLikeAddress(v)) out.add(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x);
  };
  walk(values);
  return out;
}

/** Copy of a payload with every address not in `allowed`, and every key in POSITION_KEYS, removed. Arrays keep their
 *  other items; an object or array emptied by the scrub is dropped. Returns the count of removed values too. */
export function scrubLendingPayload(
  value: unknown,
  allowed: { has(a: string): boolean },
): { value: unknown; removed: number } {
  let removed = 0;
  const DROP = Symbol('drop');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (looksLikeAddress(v) && !allowed.has(v)) {
        removed++;
        return DROP;
      }
      return v;
    }
    if (Array.isArray(v)) {
      const xs = v.map(walk).filter((x) => x !== DROP);
      return xs.length || !v.length ? xs : DROP;
    }
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (POSITION_KEYS.has(k)) {
          removed++;
          continue;
        }
        const y = walk(x);
        if (y !== DROP) o[k] = y;
      }
      return Object.keys(o).length || !Object.keys(v).length ? o : DROP;
    }
    return v;
  };
  const out = walk(value);
  return { value: out === DROP ? null : out, removed };
}

// ---------------------------------------------------------------------------------------------------------------
// Event rows

/** Decode-pass event kinds not stored as rows: obligation bookkeeping (`admin`) and configuration instructions,
 *  whose effect is stored as configuration-change rows (value changes only, with old and new). */
export const LENDING_EVENT_KINDS_NOT_STORED = new Set([
  'admin',
  'config',
  'market_config',
  'vault_config',
  'vault_allocation_config',
]);

const VENUE_OF_PROGRAM: Record<string, string> = {
  klend: 'kamino',
  kvault: 'kamino_vault',
  jl_vaults: 'jupiter_lend',
  jl_liquidity: 'jupiter_lend',
  jl_lending: 'jupiter_lend',
  jl_flashloan: 'jupiter_lend',
};
export const lendingVenueOfProgram = (program: string) => VENUE_OF_PROGRAM[program] ?? program;

/** Event account keys, in the order used to pick the registry row an event belongs to. */
const POOL_KEYS = [
  'vaultState',
  'vault_config',
  'protocol',
  'reserve',
  'withdrawReserve',
  'depositReserve',
  'repayReserve',
  'borrowReserve',
  'sourceBorrowReserve',
  'targetBorrowReserve',
  'vault_state',
  'token_reserve',
  'supply_token',
];

const PROTOCOL_VAULT_ROLES = new Set([
  'liquidity_supply',
  'collateral_supply',
  'fee_vault',
  'withdraw_queue',
  'kvault_token',
  'kvault_ctoken',
  'jl_liquidity_vault',
]);
const PROTOCOL_MINT_ROLES = new Set(['ctoken_mint', 'kvault_shares_mint', 'jl_ftoken_mint']);

/** One decoded event as the decode pass writes it (`decoded/<day>.jsonl.gz`, field `ev`). */
export type DecodedLendingEvent = {
  program: string;
  ix: string;
  kind: string;
  path: string;
  parentPath?: string;
  caller?: string;
  accounts: Record<string, string>;
  args?: Record<string, unknown>;
  flows: Array<{ account: string; role: string; delta: string; mint?: string }>;
  supply?: unknown;
  events?: unknown;
  liquidation?: Record<string, unknown>;
  ok: boolean;
};

/** Which registry row each address belongs to. Kamino reserve token accounts and cToken mint → the reserve; Jupiter
 *  Lend vault state and its own layer positions → the vault; curated-vault token, share and cToken accounts → the
 *  curated vault. The Jupiter Lend liquidity layer is shared by vaults, so its token reserves and token vaults map to
 *  the token reserve itself (market `jupiter_lend:liquidity`, as in the 5-minute rows), and the layer's global
 *  account to nothing. */
export function lendingPoolIndex(
  rows: ReadonlyArray<{
    account: string;
    market: string;
    role: string;
    accounts: Record<string, unknown>;
  }>,
) {
  const poolOf = new Map<string, string>();
  const marketOf = new Map<string, string>();
  for (const r of rows) {
    poolOf.set(r.account, r.account);
    marketOf.set(r.account, r.market);
  }
  const put = (a: unknown, p: string) => {
    if (typeof a === 'string' && looksLikeAddress(a) && !poolOf.has(a)) poolOf.set(a, p);
  };
  for (const r of rows) {
    const a = r.accounts;
    if (r.role === 'vault') {
      for (const [res, vault] of [
        [a.supplyReserve, a.liquidityVaultSupply],
        [a.borrowReserve, a.liquidityVaultBorrow],
      ] as const) {
        if (typeof res !== 'string') continue;
        put(res, res);
        marketOf.set(res, 'jupiter_lend:liquidity');
        put(vault, res);
      }
      for (const k of ['state', 'supplyPosition', 'borrowPosition']) put(a[k], r.account);
    } else if (r.role === 'curated_vault') {
      for (const k of ['tokenVault', 'sharesMint']) put(a[k], r.account);
      for (const al of (a.allocations as Array<{ ctokenVault?: string }> | undefined) ?? [])
        put(al.ctokenVault, r.account);
    } else {
      for (const k of [
        'liquiditySupplyVault',
        'liquidityFeeVault',
        'collateralMint',
        'collateralSupplyVault',
      ])
        put(a[k], r.account);
    }
  }
  return { poolOf, marketOf };
}

export type LendingEventContext = {
  /** Any registry address (row account, its token accounts, the Jupiter Lend vault state) → the row's account. */
  poolOf: ReadonlyMap<string, string>;
  /** Registry row account → its market. */
  marketOf: ReadonlyMap<string, string>;
  /** Addresses allowed in a payload (see `collectAddresses`). */
  allowed: ReadonlySet<string>;
};

export type LendingEventRow = {
  signature: string;
  eventKey: string;
  slot: number;
  blockTime: Date;
  venue: string;
  program: string;
  market: string | null;
  pool: string | null;
  kind: string;
  ix: string | null;
  caller: string | null;
  flows: unknown;
  detail: unknown;
};

/** Registry row an event belongs to: its first reserve or vault account in the registry, else the first flow on a
 *  registry token account. Null when it touches none (a curated vault's klend call into a reserve we do not track). */
export function lendingEventPool(e: DecodedLendingEvent, poolOf: ReadonlyMap<string, string>) {
  for (const k of POOL_KEYS) {
    const a = e.accounts[k];
    const p = a === undefined ? undefined : poolOf.get(a);
    if (p) return p;
  }
  for (const f of e.flows) {
    const p = poolOf.get(f.account);
    if (p) return p;
  }
  return null;
}

/** Rows for one decoded transaction's events: kinds in LENDING_EVENT_KINDS_NOT_STORED and events outside the registry
 *  (neither the event nor its inner lending instructions touch a registry account) are skipped (counted by the caller from the return). Liquidations keep their sale rows and the programs invoked;
 *  the position, liquidator and every other address off the public list are removed. */
export function lendingEventRows(
  tx: { s: string; sl: number; t: number; ev?: DecodedLendingEvent[] },
  ctx: LendingEventContext,
): { rows: LendingEventRow[]; skippedKind: number; skippedUnregistered: number; removed: number } {
  const rows: LendingEventRow[] = [];
  let skippedKind = 0;
  let skippedUnregistered = 0;
  let removed = 0;
  for (const e of tx.ev ?? []) {
    if (LENDING_EVENT_KINDS_NOT_STORED.has(e.kind)) {
      skippedKind++;
      continue;
    }
    // an instruction that names no registry account (a Jupiter Lend `flashloan_borrow`: signer and mint only, the
    // tokens leave through its inner liquidity-layer call) belongs where its inner lending instructions do
    const pool =
      lendingEventPool(e, ctx.poolOf) ??
      (tx.ev ?? [])
        .filter((c) => c.parentPath === e.path)
        .map((c) => lendingEventPool(c, ctx.poolOf))
        .find((p) => p !== null) ??
      null;
    if (!pool) {
      skippedUnregistered++;
      continue;
    }
    const otherPrograms = (e.liquidation?.otherPrograms as string[] | undefined) ?? undefined;
    const raw = {
      ...(e.parentPath ? { parentPath: e.parentPath } : {}),
      accounts: e.accounts,
      ...(e.args ? { args: e.args } : {}),
      ...(e.supply ? { supply: e.supply } : {}),
      ...(e.events ? { events: e.events } : {}),
      ...(e.liquidation ? { liquidation: { ...e.liquidation, otherPrograms: undefined } } : {}),
      ok: e.ok,
    };
    // flows are moves on protocol token accounts (the decoder's vault roles), never a user's account: kept whole,
    // and their accounts, mints and the protocol mints whose supply changed are public for this event's payload
    const local = new Set<string>();
    const here = { has: (a: string) => ctx.allowed.has(a) || local.has(a) };
    for (const f of e.flows) {
      if (!PROTOCOL_VAULT_ROLES.has(f.role))
        throw new Error(`flow role ${f.role} is not a protocol vault`);
      local.add(f.account);
      if (f.mint) local.add(f.mint);
    }
    for (const m of (e.supply as Array<{ mint: string; role: string }> | undefined) ?? [])
      if (PROTOCOL_MINT_ROLES.has(m.role)) local.add(m.mint);
    const d = scrubLendingPayload(JSON.parse(JSON.stringify(raw)), here);
    removed += d.removed;
    const detail = d.value as Record<string, unknown>;
    // program ids invoked beside a liquidation are programs, not wallets: kept as they are
    if (otherPrograms && detail.liquidation)
      (detail.liquidation as Record<string, unknown>).otherPrograms = otherPrograms;
    rows.push({
      signature: tx.s,
      eventKey: e.path,
      slot: tx.sl,
      blockTime: new Date(tx.t * 1000),
      venue: lendingVenueOfProgram(e.program),
      program: e.program,
      // the pool's own market: a curated vault's call into a reserve we do not track names that reserve's market,
      // which stays out like any address off the public list
      market: ctx.marketOf.get(pool) ?? null,
      pool,
      kind: e.kind,
      ix: e.ix,
      caller: e.caller ?? null,
      flows: e.flows,
      detail,
    });
  }
  return { rows, skippedKind, skippedUnregistered, removed };
}

/** A configuration-change row of the decode pass (`decoded/config-changes.jsonl`). */
export type LendingConfigChange = {
  s: string;
  slot: number;
  time: string;
  program: string;
  ix: string;
  target: string;
  param: string;
  old: string | null;
  new: string;
};

/** Configuration changes as event rows (`kind` config_change), keyed `config:<target>:<param>:<n>` with n counting
 *  repeats of the same parameter in one transaction. The target is a reserve, a market, a Jupiter Lend vault, or
 *  `<curated vault>:<reserve>` for an allocation; targets outside the registry keep `pool` null. */
export function lendingConfigRows(
  changes: readonly LendingConfigChange[],
  ctx: LendingEventContext,
): LendingEventRow[] {
  const seen = new Map<string, number>();
  const markets = new Set(ctx.marketOf.values());
  return changes.map((c) => {
    const base = `${c.s}|config:${c.target}:${c.param}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    // a curated vault's allocation change targets `<vault>:<reserve>`
    const pool =
      ctx.poolOf.get(c.target) ?? ctx.poolOf.get(c.target.split(':')[0] as string) ?? null;
    return {
      signature: c.s,
      eventKey: `config:${c.target}:${c.param}:${n}`,
      slot: c.slot,
      blockTime: new Date(c.time),
      venue: lendingVenueOfProgram(c.program),
      program: c.program,
      // a market-level change (`updateLendingMarket`) has no registry row of its own, only its market
      market: pool ? (ctx.marketOf.get(pool) ?? null) : markets.has(c.target) ? c.target : null,
      pool,
      kind: 'config_change',
      ix: c.ix,
      caller: null,
      flows: [],
      detail: { target: c.target, param: c.param, old: c.old, new: c.new },
    };
  });
}

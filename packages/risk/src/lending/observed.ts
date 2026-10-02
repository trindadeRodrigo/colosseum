// PLAN-ANALYTICS item 9 — the liquidation routes actually taken, from the liquidation events already decoded (no new
// fetch). Pure functions; the lending report (scripts/risk/lending-report.ts, section 8) feeds them its rows.
//
//   Followed      a liquidation whose transaction also sells the seized collateral in a registry pool. The others are
//                 `not_followed` until item 13 traces the stock after the transaction; those whose transaction called
//                 an aggregator are counted apart (the sale may have gone through a pool outside the registry).
//   Realised      the sale's dollar price per unit against the program's own collateral price (the oracle) and
//                 against the sale pool's hourly mid (Step 5b), units-weighted over the sales of one liquidation.
//   Margin        observed: (1 + implied bonus) × realised ÷ oracle − 1 on the units sold, the observed side of §5's
//                 liquidator margin (the sale cost and the oracle gap in one number).
//   Simulated     where the caller has both, the routed sale's recovered value at the sold size in the liquidation's
//                 regime against the observed one, on the same reference mid.
// Wallets (liquidators, positions) never enter: rows carry pools and programs only (DA4).

import { quantileOf } from '../curves';
import type { Regime } from '../time';

/** One same-transaction swap of the seized collateral. */
export type ObservedSale = {
  pool: string;
  dex: string;
  /** What the sale received: a dollar stablecoin, SOL, or another token. */
  quote: 'usd' | 'sol' | 'other';
  unitsIn: number;
  /** Dollars per unit sold; null unless the quote is a dollar stablecoin. */
  realisedUsd: number | null;
  /** The sale pool's hourly mid in USD at the hour (Step 5b), when the hour is covered. */
  poolMidUsd: number | null;
};

export type ObservedLiquidation = {
  venue: string;
  /** Kamino market or Jupiter Lend vault (`jupiter_lend:<id>`), when the event names it. */
  market?: string;
  asset: string;
  regime: Regime;
  at: string;
  seizedUnits: number | null;
  /** USD at the program's collateral price (debt-token prices at par, as section 3). */
  seizedUsd: number | null;
  /** The program's collateral price, per unit, in USD or the debt token. */
  oraclePrice: number | null;
  impliedBonus: number | null;
  sales: ObservedSale[];
  /** The transaction called an aggregator (Jupiter) besides the lending program. */
  aggregator: boolean;
  /** Simulated against observed on one reference mid, or why there is none. */
  simulated?: { simulatedRecovered: number; observedRecovered: number } | { reason: string };
};

/** The decoded liquidation detail fields this module reads (risk_lending_events.detail.liquidation). */
export type LiquidationEventDetail = {
  collateralMint: string;
  collateralSeized: string;
  collateralPrice: number | null;
  priceUnit: string;
  debtMint: string;
  impliedBonus: number | null;
  market?: string;
  otherPrograms?: string[];
  sales: Array<{
    pool: string;
    venue: string;
    mintIn: string;
    mintOut: string;
    amountIn: string;
    realisedPrice?: number;
  }>;
};

export type ObservedContext = {
  decimalsOf: (mint: string) => number | null;
  symbolOf: (mint: string) => string | null;
  dollarMints: ReadonlySet<string>;
  solMint: string;
  aggregators: ReadonlySet<string>;
  regimeOf: (at: Date) => Regime;
  /** The sale pool's hourly mid in USD (Step 5b), or null. */
  poolMid: (pool: string, hourIso: string) => number | null;
};

/** One decoded liquidation event as an observed row. USD follows section 3's rule: the program's price, a
 *  debt-token price only when the debt is a dollar token. Wallet fields of the event are not read. */
export function observedLiquidation(
  e: { blockTime: string; venue: string; liq: LiquidationEventDetail },
  ctx: ObservedContext,
): ObservedLiquidation {
  const l = e.liq;
  const at = new Date(e.blockTime);
  const dec = ctx.decimalsOf(l.collateralMint);
  const units = (raw: string) => (dec === null ? Number.NaN : Number(raw) / 10 ** dec);
  const hour = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
  const debtIsUsd = ctx.symbolOf(l.debtMint) === 'USDC' || ctx.dollarMints.has(l.debtMint);
  const sales: ObservedSale[] = l.sales
    .filter((s) => s.mintIn === l.collateralMint)
    .map((s) => {
      const quote = ctx.dollarMints.has(s.mintOut)
        ? ('usd' as const)
        : s.mintOut === ctx.solMint
          ? ('sol' as const)
          : ('other' as const);
      return {
        pool: s.pool,
        dex: s.venue,
        quote,
        unitsIn: units(s.amountIn),
        realisedUsd:
          quote === 'usd' && s.realisedPrice !== undefined && Number.isFinite(s.realisedPrice)
            ? s.realisedPrice
            : null,
        poolMidUsd: quote === 'usd' ? ctx.poolMid(s.pool, hour) : null,
      };
    });
  return {
    venue: e.venue,
    ...(l.market ? { market: l.market } : {}),
    asset: ctx.symbolOf(l.collateralMint) ?? l.collateralMint.slice(0, 6),
    regime: ctx.regimeOf(at),
    at: at.toISOString(),
    seizedUnits: dec === null ? null : units(l.collateralSeized),
    seizedUsd:
      dec !== null &&
      l.collateralPrice !== null &&
      (l.priceUnit === 'usd' || (l.priceUnit === 'debt_token' && debtIsUsd))
        ? units(l.collateralSeized) * l.collateralPrice
        : null,
    oraclePrice: l.collateralPrice,
    impliedBonus: l.impliedBonus,
    sales,
    aggregator: (l.otherPrograms ?? []).some((p) => ctx.aggregators.has(p)),
  };
}

/** Per liquidation: what was sold, at what price against the oracle and the pool mid, and the observed margin. */
export function observedSale(l: ObservedLiquidation) {
  const sold = l.sales.reduce((s, x) => s + x.unitsIn, 0);
  const dollar = l.sales.filter(
    (x) => x.quote === 'usd' && x.realisedUsd !== null && x.unitsIn > 0,
  );
  const dollarUnits = dollar.reduce((s, x) => s + x.unitsIn, 0);
  const realised =
    dollarUnits > 0
      ? dollar.reduce((s, x) => s + (x.realisedUsd as number) * x.unitsIn, 0) / dollarUnits
      : null;
  const withMid = dollar.filter((x) => x.poolMidUsd !== null);
  const midUnits = withMid.reduce((s, x) => s + x.unitsIn, 0);
  const saleVsMid =
    midUnits > 0
      ? withMid.reduce(
          (s, x) => s + ((x.realisedUsd as number) / (x.poolMidUsd as number)) * x.unitsIn,
          0,
        ) /
          midUnits -
        1
      : null;
  const saleVsOracle = realised !== null && l.oraclePrice ? realised / l.oraclePrice - 1 : null;
  return {
    followed: l.sales.length > 0,
    soldUnits: sold,
    /** Units sold in the same transaction over units seized; above 1 when the liquidator sold stock it held. */
    soldShare: l.seizedUnits ? sold / l.seizedUnits : null,
    realisedUsd: realised,
    saleVsOracle,
    saleVsMid,
    observedMargin:
      saleVsOracle !== null && l.impliedBonus !== null
        ? (1 + l.impliedBonus) * (1 + saleVsOracle) - 1
        : null,
  };
}

/** Size bucket of a seizure: `<1000`, `1000-10000`, …, `>=100000`, or `no_usd`. */
export function sizeBucket(usd: number | null, edges: readonly number[]) {
  if (usd === null) return 'no_usd';
  const i = edges.findIndex((e) => usd < e);
  if (i === 0) return `<${edges[0]}`;
  if (i === -1) return `>=${edges.at(-1)}`;
  return `${edges[i - 1]}-${edges[i]}`;
}

const stats = (xs: number[]) =>
  xs.length
    ? {
        n: xs.length,
        median: quantileOf(xs, 0.5),
        p05: quantileOf(xs, 0.05),
        p95: quantileOf(xs, 0.95),
      }
    : { n: 0, median: null, p05: null, p95: null };

/**
 * The observed routes by asset, regime and size bucket: how many liquidations were followed into a sale, through
 * which DEXes and pools (share of units sold), at what price against the oracle and the pool mid, the observed
 * margin, and the simulated route against the observed one where both exist. A group with no followed sale reports
 * `null` prices with reason `not_followed`, never zero.
 */
export function observedRoutes(rows: readonly ObservedLiquidation[], edges: readonly number[]) {
  const groups = new Map<string, ObservedLiquidation[]>();
  for (const l of rows) {
    const k = `${l.asset}|${l.regime}|${sizeBucket(l.seizedUsd, edges)}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups]
    .map(([k, list]) => {
      const [asset, regime, bucket] = k.split('|') as [string, Regime, string];
      const per = list.map((l) => ({ l, o: observedSale(l) }));
      const followed = per.filter((x) => x.o.followed);
      const notFollowed = per.filter((x) => !x.o.followed);
      const units = new Map<
        string,
        { pool: string; dex: string; quote: string; units: number; sales: number }
      >();
      for (const { l } of followed)
        for (const s of l.sales) {
          const u = units.get(s.pool) ?? {
            pool: s.pool,
            dex: s.dex,
            quote: s.quote,
            units: 0,
            sales: 0,
          };
          u.units += s.unitsIn;
          u.sales++;
          units.set(s.pool, u);
        }
      const soldTotal = [...units.values()].reduce((s, u) => s + u.units, 0);
      const share = (by: (u: { dex: string; quote: string }) => string) => {
        const m: Record<string, number> = {};
        for (const u of units.values()) m[by(u)] = (m[by(u)] ?? 0) + u.units / soldTotal;
        return m;
      };
      const sim = followed
        .map((x) => x.l.simulated)
        .filter(
          (s): s is { simulatedRecovered: number; observedRecovered: number } =>
            !!s && !('reason' in s),
        );
      const simReasons: Record<string, number> = {};
      for (const { l } of followed)
        if (l.simulated && 'reason' in l.simulated)
          simReasons[l.simulated.reason] = (simReasons[l.simulated.reason] ?? 0) + 1;
      const num = (f: (o: ReturnType<typeof observedSale>) => number | null) =>
        followed.map((x) => f(x.o)).filter((v): v is number => v !== null);
      const usd = list.map((l) => l.seizedUsd).filter((u): u is number => u !== null);
      return {
        asset,
        regime,
        bucket,
        liquidations: list.length,
        seizedUsd: usd.reduce((s, u) => s + u, 0),
        followed: followed.length,
        notFollowed: notFollowed.length,
        notFollowedWithAggregator: notFollowed.filter((x) => x.l.aggregator).length,
        soldShare: stats(num((o) => o.soldShare)),
        byDex: soldTotal > 0 ? share((u) => u.dex) : null,
        byQuote: soldTotal > 0 ? share((u) => u.quote) : null,
        pools: [...units.values()]
          .sort((a, b) => b.units - a.units)
          .map((u) => ({ ...u, share: soldTotal > 0 ? u.units / soldTotal : null })),
        saleVsOracle: stats(num((o) => o.saleVsOracle)),
        saleVsMid: stats(num((o) => o.saleVsMid)),
        observedMargin: stats(num((o) => o.observedMargin)),
        simulatedVsObserved: {
          ...stats(sim.map((s) => s.observedRecovered - s.simulatedRecovered)),
          reasons: simReasons,
        },
        reason: followed.length ? null : ('not_followed' as const),
      };
    })
    .sort(
      (a, b) =>
        a.asset.localeCompare(b.asset) ||
        a.regime.localeCompare(b.regime) ||
        a.bucket.localeCompare(b.bucket),
    );
}

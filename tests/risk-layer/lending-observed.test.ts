import { readFileSync } from 'node:fs';
import {
  defaultLendingReportParams,
  defaultRegimeParams,
  type LiquidationEventDetail,
  type ObservedLiquidation,
  observedLiquidation,
  observedRoutes,
  observedSale,
  regimeAt,
  sizeBucket,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// PLAN-ANALYTICS item 9 — the observed liquidation routes, on frozen mainnet rows:
// fixtures/risk/lending/liquidations.json (`pnpm risk:lending-freeze-liquidation-fixtures`): every decoded liquidation
// event with its same-transaction sales, wallets dropped. Expected values come from the events' own fields.
type Fx = {
  rows: Array<{ blockTime: string; venue: string; liq: LiquidationEventDetail }>;
  mints: Array<{ mint: string; symbol: string; decimals: number }>;
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/liquidations.json', 'utf8')) as Fx;
const P = defaultLendingReportParams();
const RP = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL = 'So11111111111111111111111111111111111111112';
const JUP6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const mint = new Map(fx.mints.map((m) => [m.mint, m]));
const ctx = {
  decimalsOf: (m: string) => mint.get(m)?.decimals ?? null,
  symbolOf: (m: string) => mint.get(m)?.symbol ?? null,
  dollarMints: new Set([USDC, USDT]),
  solMint: SOL,
  aggregators: new Set([JUP6]),
  regimeOf: (at: Date) => regimeAt(at, RP),
  poolMid: () => null,
};
const rows: ObservedLiquidation[] = fx.rows.map((e) => observedLiquidation(e, ctx));
const sellsCollateral = (l: LiquidationEventDetail) =>
  l.sales.some((s) => s.mintIn === l.collateralMint);

describe('observed liquidations', () => {
  it('the fixture holds no wallet field', () => {
    expect(fx.rows.length).toBeGreaterThan(400);
    for (const r of fx.rows) {
      expect(r.liq).not.toHaveProperty('liquidator');
      expect(r.liq).not.toHaveProperty('position');
    }
  });

  it('followed = the seized collateral sold in a registry pool in the same transaction; the rest not_followed', () => {
    const groups = observedRoutes(rows, P.sizeBucketsUsd);
    const followed = fx.rows.filter((r) => sellsCollateral(r.liq)).length;
    expect(followed).toBeGreaterThan(100);
    expect(groups.reduce((s, g) => s + g.followed, 0)).toBe(followed);
    expect(groups.reduce((s, g) => s + g.notFollowed, 0)).toBe(fx.rows.length - followed);
    expect(groups.reduce((s, g) => s + g.notFollowedWithAggregator, 0)).toBe(
      fx.rows.filter((r) => !sellsCollateral(r.liq) && (r.liq.otherPrograms ?? []).includes(JUP6))
        .length,
    );
  });

  it('realised against the oracle and the observed margin, by hand on one Kamino liquidation sold for USDC', () => {
    const i = fx.rows.findIndex(
      (r) =>
        r.venue === 'kamino' &&
        r.liq.priceUnit === 'usd' &&
        r.liq.impliedBonus !== null &&
        r.liq.sales.length === 1 &&
        r.liq.sales[0]?.mintIn === r.liq.collateralMint &&
        r.liq.sales[0]?.mintOut === USDC,
    );
    expect(i).toBeGreaterThanOrEqual(0);
    const e = fx.rows[i] as Fx['rows'][number];
    const s = e.liq.sales[0] as LiquidationEventDetail['sales'][number];
    const dec = mint.get(e.liq.collateralMint)?.decimals as number;
    const o = observedSale(rows[i] as ObservedLiquidation);
    const vsOracle = (s.realisedPrice as number) / (e.liq.collateralPrice as number) - 1;
    expect(o.saleVsOracle).toBeCloseTo(vsOracle, 12);
    expect(o.observedMargin).toBeCloseTo(
      (1 + (e.liq.impliedBonus as number)) * (1 + vsOracle) - 1,
      12,
    );
    expect(o.soldShare).toBeCloseTo(Number(s.amountIn) / Number(e.liq.collateralSeized), 12);
    expect(rows[i]?.seizedUsd).toBeCloseTo(
      (Number(e.liq.collateralSeized) / 10 ** dec) * (e.liq.collateralPrice as number),
      9,
    );
    // no pool mid in this fixture (poolMid returns null): not measured, not zero
    expect(o.saleVsMid).toBeNull();
  });

  it('a SOL-quoted sale is followed but has no dollar price against the oracle', () => {
    const i = fx.rows.findIndex(
      (r) =>
        r.liq.sales.length > 0 &&
        r.liq.sales.every((s) => s.mintIn === r.liq.collateralMint && s.mintOut === SOL),
    );
    expect(i).toBeGreaterThanOrEqual(0);
    const o = observedSale(rows[i] as ObservedLiquidation);
    expect(o.followed).toBe(true);
    expect(o.saleVsOracle).toBeNull();
    expect(o.observedMargin).toBeNull();
  });

  it('per group: pool and DEX shares of units sold sum to 1; a group with no sale is null with not_followed', () => {
    for (const g of observedRoutes(rows, P.sizeBucketsUsd)) {
      if (g.followed) {
        expect(g.pools.reduce((s, p) => s + (p.share as number), 0)).toBeCloseTo(1, 12);
        expect(Object.values(g.byDex ?? {}).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
        expect(g.reason).toBeNull();
      } else {
        expect(g.reason).toBe('not_followed');
        expect(g.byDex).toBeNull();
        expect(g.saleVsOracle).toMatchObject({ n: 0, median: null });
        expect(g.observedMargin.median).toBeNull();
      }
    }
  });

  it('simulated against observed is counted only where the caller gives both, and reasons are kept', () => {
    const base = rows.find((r) => r.sales.length) as ObservedLiquidation;
    const g = observedRoutes(
      [
        { ...base, simulated: { simulatedRecovered: 0.995, observedRecovered: 0.998 } },
        { ...base, simulated: { reason: 'before_routed_curves' } },
      ],
      P.sizeBucketsUsd,
    )[0];
    expect(g?.simulatedVsObserved.n).toBe(1);
    expect(g?.simulatedVsObserved.median).toBeCloseTo(0.003, 12);
    expect(g?.simulatedVsObserved.reasons).toEqual({ before_routed_curves: 1 });
  });

  it('size buckets', () => {
    const e = [1_000, 10_000, 100_000];
    expect(sizeBucket(null, e)).toBe('no_usd');
    expect(sizeBucket(999, e)).toBe('<1000');
    expect(sizeBucket(1_000, e)).toBe('1000-10000');
    expect(sizeBucket(99_999, e)).toBe('10000-100000');
    expect(sizeBucket(100_000, e)).toBe('>=100000');
  });
});

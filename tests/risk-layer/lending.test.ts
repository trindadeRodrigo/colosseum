import { readFileSync } from 'node:fs';
import {
  decodeJlChainlinkCache,
  decodeJlOracle,
  decodeJlPosition,
  decodeJlRateModel,
  decodeJlTokenReserve,
  decodeJlUserBorrowPosition,
  decodeJlUserSupplyPosition,
  decodeJlVaultConfig,
  decodeJlVaultState,
  decodeKaminoObligation,
  decodeKaminoReserve,
  decodeKvaultState,
  jlPositionAmounts,
  kaminoCurveRate,
  kaminoReserveState,
  scopePrice,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b — lending state readers on frozen mainnet bytes (fixtures/risk/lending/accounts.json, written by
// scripts/risk/lending-freeze-fixtures.ts). Expected values are the protocol SDKs' own decode of the same bytes:
// klend-sdk 12.0.1 for Kamino, the Anchor coders of @jup-ag/lend-read 0.0.14 for Jupiter Lend (D11).
type Acc = { address?: string; b64: string; sdk: Record<string, unknown> };
const fx = JSON.parse(readFileSync('fixtures/risk/lending/accounts.json', 'utf8')) as Record<
  string,
  unknown
> & {
  jupiterLend: Record<string, Acc> & {
    positions: Array<{ b64: string; sdkState: Record<string, string> }>;
  };
};
const bytes = (a: { b64: string }) => new Uint8Array(Buffer.from(a.b64, 'base64'));
/** BN fields arrive as hex (BN#toJSON); plain numbers and base58 keys as they are. */
const hex = (v: unknown) => BigInt(`0x${String(v)}`);

describe('Kamino readers (frozen bytes vs klend-sdk)', () => {
  for (const sym of ['SPYx', 'USDC']) {
    const a = fx[`reserve_${sym}`] as Acc;
    it(`Reserve ${sym}: every field the risk layer uses equals the SDK decode`, () => {
      const r = decodeKaminoReserve(bytes(a));
      const s = a.sdk;
      expect(r.lendingMarket).toBe(s.lendingMarket);
      expect(r.liquidityMint).toBe(s.liquidityMint);
      expect(r.liquiditySupplyVault).toBe(s.liquiditySupplyVault);
      expect(r.availableAmount.toString()).toBe(s.availableAmount);
      expect(r.borrowedAmountSf.toString()).toBe(s.borrowedAmountSf);
      expect(r.marketPriceSf.toString()).toBe(s.marketPriceSf);
      expect(String(r.mintDecimals)).toBe(s.mintDecimals);
      expect(r.collateralMint).toBe(s.collateralMint);
      expect(r.collateralMintTotalSupply.toString()).toBe(s.collateralMintTotalSupply);
      expect(r.collateralSupplyVault).toBe(s.collateralSupplyVault);
      expect(r.config.loanToValuePct).toBe(s.loanToValuePct);
      expect(r.config.liquidationThresholdPct).toBe(s.liquidationThresholdPct);
      expect(r.config.maxLiquidationBonusBps).toBe(s.maxLiquidationBonusBps);
      expect(r.config.interestRateBasis).toBe(s.interestRateBasis);
      expect(r.config.depositLimit.toString()).toBe(s.depositLimit);
      expect(r.config.borrowLimit.toString()).toBe(s.borrowLimit);
      expect(r.config.scopePriceFeed).toBe(s.scopePriceFeed);
      expect(r.config.scopePriceChain).toEqual(s.scopePriceChain);
      expect(r.config.borrowRateCurve).toEqual(s.borrowRateCurve);
    });
  }
  it('reserve state: supply = available + borrowed − fees; the curve is piecewise linear', () => {
    const r = decodeKaminoReserve(bytes(fx.reserve_USDC as Acc));
    const st = kaminoReserveState(r, { slotMs: 500 });
    expect(st.supplied).toBeGreaterThanOrEqual(st.available);
    expect(st.utilization).toBeGreaterThan(0);
    expect(st.utilization).toBeLessThanOrEqual(1);
    const c = r.config.borrowRateCurve;
    const [p0, p1] = c as [(typeof c)[number], (typeof c)[number]];
    expect(kaminoCurveRate(c, p0.utilizationBps / 10_000)).toBeCloseTo(
      p0.borrowRateBps / 10_000,
      12,
    );
    expect(kaminoCurveRate(c, p1.utilizationBps / 10_000)).toBeCloseTo(
      p1.borrowRateBps / 10_000,
      12,
    );
    // a Legacy-basis reserve's rate scales with 500 ms / measured slot time
    if (r.config.interestRateBasis === 0)
      expect(kaminoReserveState(r, { slotMs: 250 }).borrowApr).toBeCloseTo(2 * st.borrowApr, 12);
  });
  it('Scope price chain gives the price the reserve last refreshed from (same feed, same bytes era)', () => {
    const r = decodeKaminoReserve(bytes(fx.reserve_SPYx as Acc));
    const p = scopePrice(bytes(fx.scope as Acc), r.config.scopePriceChain);
    const reservePrice = kaminoReserveState(r).priceUsd;
    expect(p.price).toBeGreaterThan(0);
    // the reserve stores the Scope price at its last refresh; both were read in the same getMultipleAccounts
    expect(Math.abs(p.price / reservePrice - 1)).toBeLessThan(0.01);
  });
  it('Obligation: deposits, borrows and values equal the SDK decode', () => {
    const a = fx.obligation as Acc;
    const o = decodeKaminoObligation(bytes(a));
    expect(o.lendingMarket).toBe(a.sdk.lendingMarket);
    expect(
      o.deposits.map((d) => ({
        reserve: d.reserve,
        depositedAmount: d.depositedAmount.toString(),
      })),
    ).toEqual(a.sdk.deposits);
    expect(
      o.borrows.map((b) => ({
        reserve: b.reserve,
        borrowedAmountSf: b.borrowedAmountSf.toString(),
      })),
    ).toEqual(a.sdk.borrows);
    expect(o.depositedValueSf.toString()).toBe(a.sdk.depositedValueSf);
    expect(o.borrowedAssetsMarketValueSf.toString()).toBe(a.sdk.borrowedAssetsMarketValueSf);
  });
  it('curated vault (kvault) state and allocations equal the SDK decode', () => {
    const a = fx.kvault as Acc;
    const v = decodeKvaultState(bytes(a));
    expect(v.tokenMint).toBe(a.sdk.tokenMint);
    expect(v.tokenAvailable.toString()).toBe(a.sdk.tokenAvailable);
    expect(v.sharesIssued.toString()).toBe(a.sdk.sharesIssued);
    expect(v.name).toBe(a.sdk.name);
    expect(
      v.allocations.map((x) => ({
        reserve: x.reserve,
        ctokenAllocation: x.ctokenAllocation.toString(),
      })),
    ).toEqual(a.sdk.allocations);
  });
});

describe('Jupiter Lend readers (frozen bytes vs the read SDK Anchor coders)', () => {
  const j = fx.jupiterLend;
  /** Compare every scalar field of the hand decode with the SDK decode of the same bytes. */
  function same(hand: Record<string, unknown>, sdk: Record<string, unknown>) {
    let n = 0;
    for (const [k, v] of Object.entries(hand)) {
      if (!(k in sdk)) continue;
      const s = sdk[k];
      if (typeof v === 'bigint') expect([k, v]).toEqual([k, hex(s)]);
      else if (typeof s === 'boolean') expect([k, v]).toEqual([k, s ? 1 : 0]);
      else expect([k, v]).toEqual([k, s]);
      n++;
    }
    return n;
  }
  it('vault config', () =>
    expect(same(decodeJlVaultConfig(bytes(j.config as Acc)), (j.config as Acc).sdk)).toBe(16));
  it('vault state', () =>
    expect(same(decodeJlVaultState(bytes(j.state as Acc)), (j.state as Acc).sdk)).toBe(17));
  it('liquidity-layer token reserve', () =>
    expect(
      same(decodeJlTokenReserve(bytes(j.borrowReserve as Acc)), (j.borrowReserve as Acc).sdk),
    ).toBe(14));
  it('liquidity-layer supply and borrow positions of the vault', () => {
    expect(
      same(
        decodeJlUserSupplyPosition(bytes(j.supplyPosition as Acc)),
        (j.supplyPosition as Acc).sdk,
      ),
    ).toBe(12);
    expect(
      same(
        decodeJlUserBorrowPosition(bytes(j.borrowPosition as Acc)),
        (j.borrowPosition as Acc).sdk,
      ),
    ).toBe(11);
  });
  it('rate model', () =>
    expect(
      same(decodeJlRateModel(bytes(j.borrowRateModel as Acc)), (j.borrowRateModel as Acc).sdk),
    ).toBe(8));
  it('oracle and its Chainlink Data Streams cache', () => {
    const o = decodeJlOracle(bytes(j.oracle as Acc));
    const s = (j.oracle as Acc).sdk as {
      nonce: number;
      sources: Array<{ source: string; multiplier: string; divisor: string; invert: boolean }>;
    };
    expect(o.nonce).toBe(s.nonce);
    expect(o.sources.map((x) => [x.source, x.invert === 1, x.multiplier, x.divisor])).toEqual(
      s.sources.map((x) => [x.source, x.invert, hex(x.multiplier), hex(x.divisor)]),
    );
    const c = decodeJlChainlinkCache(bytes(j.cache as Acc));
    const cs = (j.cache as Acc).sdk as Record<string, unknown> & {
      feeds: unknown[];
      genericData: Record<string, unknown>;
    };
    expect(c.feeds).toBe(cs.feeds.length);
    expect(c.price).toBe(hex(cs.price));
    expect(c.lastUpdateTimestampPrice).toBe(hex(cs.lastUpdateTimestampPrice));
    expect(c.marketStatus).toBe(cs.genericData.marketStatus);
    expect(c.lastMultiplier).toBe(hex(cs.genericData.xstocksLastMultiplier));
  });
  it('position debt from its tick equals the SDK getCurrentPositionState', () => {
    const st = decodeJlVaultState(bytes(j.state as Acc));
    expect(j.positions.length).toBe(3);
    for (const p of j.positions) {
      const a = jlPositionAmounts(decodeJlPosition(bytes(p)), st.topmostTick);
      expect(a.liquidatedBranch).toBe(false);
      expect(a.colRaw).toBe(hex(p.sdkState.colRaw));
      expect(a.debtRaw).toBe(hex(p.sdkState.debtRaw));
      expect(a.dustDebtRaw).toBe(hex(p.sdkState.dustDebtRaw));
    }
  });
});

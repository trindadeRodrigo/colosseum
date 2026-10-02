import { readFileSync } from 'node:fs';
import {
  decodeKaminoReserve,
  decodeLendingTx,
  type ExchangeObs,
  exchangeAt,
  type KaminoReserveSim,
  kaminoAccrualConfig,
  kaminoAccrue,
  kaminoApplyStep,
  kaminoCompound,
  kaminoConfigFromBlob,
  kaminoReserveStep,
  kaminoViewAt,
  type LendingDecodeContext,
  ltvTable,
  type RpcTx,
  rollingMedianAt,
  type VaultRole,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b item 7 — reconstruction on frozen mainnet data (fixtures/risk/lending/reconstruct.json, written by
// scripts/risk/lending-freeze-reconstruct-fixtures.ts). Expected values never come from the code under test:
// reserve state from the reserve's own hourly raw bytes, the curve from the reserve's account today, Jupiter Lend
// totals from the API row.
type Tx = { s: string; sl: number; tx: RpcTx };
type Snap = { at: string; slot: number; b64: string };
const fx = JSON.parse(readFileSync('fixtures/risk/lending/reconstruct.json', 'utf8')) as {
  forward: {
    reserve: string;
    symbol: string;
    liquiditySupplyVault: string;
    collateralMint: string;
    vaultRoles: Record<string, VaultRole>;
    from: Snap;
    to: Snap;
    txs: Tx[];
  };
  blob: { reserve: string; hex: string; reserveB64: string };
  jl: {
    colMint: string;
    debtMint: string;
    ops: Array<{
      t: number;
      token: string;
      supplyAmount: string;
      borrowAmount: string;
      sEx: string;
      bEx: string;
    }>;
    around: Record<string, Array<{ t: number; sEx: string; bEx: string }>>;
    api: { fetchedAt: string; totalSupplyLiquidity: string; totalBorrowLiquidity: string };
  };
};
const SF = 2 ** 60;
const sf = (x: bigint) => Number(x) / SF;

describe('lending reconstruct — Kamino forward replay between two hourly snapshots', () => {
  const f = fx.forward;
  const a = decodeKaminoReserve(new Uint8Array(Buffer.from(f.from.b64, 'base64')));
  const b = decodeKaminoReserve(new Uint8Array(Buffer.from(f.to.b64, 'base64')));
  const ctx: LendingDecodeContext = { vaults: new Map(Object.entries(f.vaultRoles)) };
  const keys = {
    reserve: f.reserve,
    liquiditySupplyVault: f.liquiditySupplyVault,
    collateralMint: f.collateralMint,
  };
  const start = (): KaminoReserveSim => ({
    available: a.availableAmount,
    ctoken: a.collateralMintTotalSupply,
    borrowed: sf(a.borrowedAmountSf),
    fees: sf(a.accumulatedProtocolFeesSf),
    index: sf(a.cumulativeBorrowRateBsf),
    lastSlot: Number(a.lastUpdateSlot),
    lastTs: a.lastUpdateTimestamp,
    config: kaminoAccrualConfig(a),
  });
  const replay = (txs: Tx[]) => {
    const s = start();
    for (const t of txs) {
      const d = decodeLendingTx(t.tx, ctx);
      kaminoAccrue(s, t.sl, t.tx.blockTime as number);
      kaminoApplyStep(s, kaminoReserveStep(d.events, keys));
    }
    return kaminoViewAt(s, Number(b.lastUpdateSlot), b.lastUpdateTimestamp);
  };

  it('the fixture spans a borrow and a repay on a debt reserve', () => {
    const kinds = fx.forward.txs.flatMap((t) =>
      decodeLendingTx(t.tx, ctx)
        .events.filter(
          (e) => e.accounts.borrowReserve === f.reserve || e.accounts.repayReserve === f.reserve,
        )
        .map((e) => e.kind),
    );
    expect(kinds).toContain('borrow');
    expect(kinds).toContain('repay');
    expect(sf(b.borrowedAmountSf)).toBeGreaterThan(0);
  });

  it('available liquidity and cToken supply equal the later snapshot exactly', () => {
    const v = replay(f.txs);
    expect(v.available).toBe(b.availableAmount);
    expect(v.ctoken).toBe(b.collateralMintTotalSupply);
  });

  it('borrowed, borrow index and protocol fees are compounded as klend does (≤ 1e-9 relative)', () => {
    const v = replay(f.txs);
    expect(Math.abs(v.borrowed / sf(b.borrowedAmountSf) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(v.index / sf(b.cumulativeBorrowRateBsf) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(v.fees / sf(b.accumulatedProtocolFeesSf) - 1)).toBeLessThan(1e-9);
    expect(v.config).toEqual(kaminoAccrualConfig(b));
  });

  it('a missing transaction is visible', () => {
    const moving = f.txs.findIndex((t) => {
      const d = kaminoReserveStep(decodeLendingTx(t.tx, ctx).events, keys);
      return d.available !== 0n;
    });
    const v = replay(f.txs.filter((_, i) => i !== moving));
    expect(v.available).not.toBe(b.availableAmount);
  });
});

describe('lending reconstruct — configuration and accrual', () => {
  it("a whole-config blob decodes to the curve the reserve's account holds today", () => {
    const today = decodeKaminoReserve(new Uint8Array(Buffer.from(fx.blob.reserveB64, 'base64')));
    expect(kaminoConfigFromBlob(fx.blob.hex).borrowRateCurve).toEqual(today.config.borrowRateCurve);
  });

  it('compounding is exact up to 4 units and the third-order expansion beyond', () => {
    const r = 0.1;
    const y = 63_072_000;
    for (const n of [1, 2, 3, 4]) expect(kaminoCompound(r, n, y)).toBe((1 + r / y) ** n);
    const base = r / y;
    const n = 1_000_000;
    const expected =
      1 +
      base * n +
      (base * n * base * (n - 1)) / 2 +
      (base * n * base * (n - 1) * base * (n - 2)) / 6;
    expect(kaminoCompound(r, n, y)).toBeCloseTo(expected, 15);
    expect(kaminoCompound(r, 0, y)).toBe(1);
  });
});

describe('lending reconstruct — Jupiter Lend vault from the liquidity layer', () => {
  const j = fx.jl;
  const t = Date.parse(j.api.fetchedAt) / 1000;
  const obs = (token: string, k: 'sEx' | 'bEx'): ExchangeObs[] =>
    (j.around[token] ?? []).map((o) => ({ t: o.t, v: Number(o[k]) }));

  it("the vault's raw layer amounts at the observed exchange prices equal the API's layer totals", () => {
    let supplyRaw = 0;
    let borrowRaw = 0;
    for (const o of j.ops) {
      if (o.token === j.colMint) supplyRaw += (Number(o.supplyAmount) * 1e12) / Number(o.sEx);
      if (o.token === j.debtMint) borrowRaw += (Number(o.borrowAmount) * 1e12) / Number(o.bEx);
    }
    const se = exchangeAt(obs(j.colMint, 'sEx'), t);
    const be = exchangeAt(obs(j.debtMint, 'bEx'), t);
    expect(be?.method).toBe('interpolated');
    const col = (supplyRaw * (se?.v as number)) / 1e12;
    const debt = (borrowRaw * (be?.v as number)) / 1e12;
    expect(Math.abs(col / Number(j.api.totalSupplyLiquidity) - 1)).toBeLessThan(1e-6);
    expect(Math.abs(debt / Number(j.api.totalBorrowLiquidity) - 1)).toBeLessThan(1e-6);
  });

  it('exchange prices interpolate log-linearly and extend at the last rate', () => {
    const o = [
      { t: 0, v: 100 },
      { t: 10, v: 121 },
    ];
    expect(exchangeAt(o, 5)?.v).toBeCloseTo(110, 10);
    expect(exchangeAt(o, 20)?.v).toBeCloseTo(146.41, 8);
    expect(exchangeAt(o, 20)?.method).toBe('extended');
    expect(rollingMedianAt([...o, { t: 11, v: 5 }], 11, 3)).toBe(100);
  });
});

describe('lending reconstruct — LTV buckets', () => {
  it('buckets by collateral asset, LTV 0 without debt, null without a price', () => {
    const t = ltvTable(
      [
        { asset: 'SPYx', collateralUnits: 1, collateralUsd: 1000, debtUsd: 0 },
        { asset: 'SPYx', collateralUnits: 2, collateralUsd: 2000, debtUsd: 1500 },
        { asset: 'SPYx', collateralUnits: 3, collateralUsd: 3000, debtUsd: 3300 },
        { asset: 'cbBTC', collateralUnits: 1, collateralUsd: null, debtUsd: 10 },
        { asset: 'cbBTC', collateralUnits: 2, collateralUsd: null, debtUsd: 0 },
      ],
      [10, 50, 75, 100],
    );
    expect(Object.keys(t.SPYx?.buckets ?? {})).toEqual(['<=10', '<=75', '>100']);
    expect(t.SPYx?.buckets['<=75']).toEqual({
      positions: 1,
      collateralUnits: 2,
      collateralUsd: 2000,
      debtUsd: 1500,
    });
    expect(t.cbBTC?.ltvNull).toBe(1);
    expect(t.cbBTC?.buckets['<=10']?.positions).toBe(1);
  });
});

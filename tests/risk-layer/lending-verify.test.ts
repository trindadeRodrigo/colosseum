import { readFileSync } from 'node:fs';
import {
  apiResidual,
  balanceChain,
  decodeKaminoObligation,
  decodeKaminoReserve,
  decodeLendingTx,
  defaultLendingVerifyParams,
  type LendingDecodeContext,
  obligationCollateral,
  type ReserveSnapshot,
  type RpcTx,
  replayReserve,
  reserveDeltas,
  type VaultRole,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b item 6 — completeness checks on frozen mainnet data (fixtures/risk/lending/verify.json, written by
// scripts/risk/lending-freeze-verify-fixtures.ts). Expected values never come from the code under test: reserve
// state from the reserve's own hourly raw bytes, balances from the transactions' token-balance metadata, obligation
// collateral from the obligation's own bytes, API amounts from the API row.
type Tx = { s: string; sl: number; tx: RpcTx };
type Snap = { at: string; slot: number; b64: string };
const fx = JSON.parse(readFileSync('fixtures/risk/lending/verify.json', 'utf8')) as {
  cutSlot: number;
  vaultRoles: Record<string, VaultRole>;
  replay: {
    reserve: string;
    liquiditySupplyVault: string;
    collateralMint: string;
    from: Snap;
    to: Snap;
    txs: Tx[];
  };
  gap: { vault: string; txs: Tx[]; found: Tx };
  obligation: { address: string; b64: string; collateralVaults: string[]; txs: Tx[] };
  api: {
    apiAt: string;
    supplyDecimals: number;
    totalSupply: string;
    totalSupplyLiquidity: string;
    before: {
      fetchedAt: string;
      internalDecimals: number;
      collateralInternal: string;
      liquiditySupplied: string;
    };
    after: {
      fetchedAt: string;
      internalDecimals: number;
      collateralInternal: string;
      liquiditySupplied: string;
    };
  };
};
const P = defaultLendingVerifyParams();
const ctx: LendingDecodeContext = { vaults: new Map(Object.entries(fx.vaultRoles)) };
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const snap = (s: Snap): ReserveSnapshot => ({
  at: s.at,
  slot: s.slot,
  reserve: decodeKaminoReserve(bytes(s.b64)),
});
const decode = (t: Tx) => ({ ...t, d: decodeLendingTx(t.tx, ctx) });

describe('lending verify — vault-balance chain', () => {
  const r = fx.replay;
  const txs = r.txs.map(decode);
  const steps = txs.map((t) => ({
    sig: t.s,
    slot: t.sl,
    pre: t.d.vaults[r.liquiditySupplyVault]?.pre ?? null,
    post: t.d.vaults[r.liquiditySupplyVault]?.post ?? null,
  }));

  it('consecutive transactions of a vault chain exactly', () => {
    const c = balanceChain(steps);
    expect(c.checked).toBe(txs.length - 1);
    expect(c.breaks).toEqual([]);
  });

  it('the chain starts and ends at the reserve snapshots (available = liquidity vault balance)', () => {
    expect(steps[0]?.pre).toBe(snap(r.from).reserve.availableAmount.toString());
    expect(steps.at(-1)?.post).toBe(snap(r.to).reserve.availableAmount.toString());
  });

  it('a missing transaction breaks the chain at the next one', () => {
    const c = balanceChain([steps[0], steps[2]].filter((s) => s !== undefined));
    expect(c.breaks).toHaveLength(1);
    expect(c.breaks[0]?.sig).toBe(steps[2]?.sig);
  });

  it('the gap found in the history: 2.2003 NVDAx deposited between two indexed transactions', () => {
    const [a, b] = fx.gap.txs.map(decode);
    const step = (t: NonNullable<typeof a>) => ({
      sig: t.s,
      slot: t.sl,
      pre: t.d.vaults[fx.gap.vault]?.pre ?? null,
      post: t.d.vaults[fx.gap.vault]?.post ?? null,
    });
    const c = balanceChain([step(a as NonNullable<typeof a>), step(b as NonNullable<typeof b>)]);
    expect(c.breaks).toHaveLength(1);
    const brk = c.breaks[0] as NonNullable<(typeof c.breaks)[number]>;
    expect(BigInt(brk.got) - BigInt(brk.expected)).toBe(220_030_938n);
    expect(brk.slot).toBeGreaterThan(brk.prevSlot);
  });

  it('the transaction a getBlock scan found closes that gap exactly', () => {
    const [a, f, b] = [fx.gap.txs[0] as Tx, fx.gap.found, fx.gap.txs[1] as Tx].map(decode);
    const step = (t: NonNullable<typeof a>) => ({
      sig: t.s,
      slot: t.sl,
      pre: t.d.vaults[fx.gap.vault]?.pre ?? null,
      post: t.d.vaults[fx.gap.vault]?.post ?? null,
    });
    const steps = [a, f, b].map((t) => step(t as NonNullable<typeof t>));
    expect(balanceChain(steps).breaks).toEqual([]);
    const found = f as NonNullable<typeof f>;
    expect(found.sl).toBeGreaterThan(steps[0]?.slot as number);
    expect(found.sl).toBeLessThan(steps[2]?.slot as number);
    // a new obligation's first collateral deposit: its flow on the vault is the missing 220,030,938 raw NVDAx
    const kinds = found.d.events.map((e) => e.ix);
    expect(kinds).toContain('initObligation');
    const flow = found.d.events
      .flatMap((e) => e.flows)
      .filter((x) => x.account === fx.gap.vault)
      .reduce((s, x) => s + BigInt(x.delta), 0n);
    expect(flow).toBe(220_030_938n);
  });
});

describe('lending verify — backward replay of a Kamino reserve', () => {
  const r = fx.replay;
  const keys = {
    reserve: r.reserve,
    liquiditySupplyVault: r.liquiditySupplyVault,
    collateralMint: r.collateralMint,
  };
  const steps = r.txs
    .map(decode)
    .map((t) => ({ slot: t.sl, sig: t.s, ...reserveDeltas(t.d.events, keys) }));

  it('the hour has a borrow and a repay on this reserve', () => {
    expect(steps.some((s) => s.borrowed > 0n)).toBe(true);
    expect(steps.some((s) => s.borrowed < 0n)).toBe(true);
    expect(steps.every((s) => s.unsupported === 0)).toBe(true);
  });

  it('available liquidity and cToken supply match exactly; borrowed within borrowReplayTolBps', () => {
    const out = replayReserve(snap(r.to), snap(r.from), steps, P);
    expect(out.steps).toBe(steps.length);
    expect(out.indexGrowth).toBeGreaterThan(1);
    expect(out.available.ok).toBe(true);
    expect(out.ctoken.ok).toBe(true);
    expect(Math.abs(out.borrowed.errBps)).toBeLessThanOrEqual(P.borrowReplayTolBps);
  });

  it('leaving out the borrow is detected', () => {
    const out = replayReserve(
      snap(r.to),
      snap(r.from),
      steps.filter((s) => s.borrowed <= 0n),
      P,
    );
    expect(out.available.ok).toBe(false);
    expect(out.borrowed.ok).toBe(false);
  });
});

describe('lending verify — obligation collateral', () => {
  const o = fx.obligation;
  const ob = decodeKaminoObligation(bytes(o.b64));
  const vaults = new Set(o.collateralVaults);
  const reserveOfVault = new Map<string, string>();
  const txs = o.txs.map(decode);
  for (const t of txs)
    for (const e of t.d.events)
      for (const f of e.flows)
        if (vaults.has(f.account) && (e.accounts.reserve ?? e.accounts.withdrawReserve))
          reserveOfVault.set(
            f.account,
            (e.accounts.reserve ?? e.accounts.withdrawReserve) as string,
          );

  it('the obligation was initialised twice and has not changed since the window', () => {
    const inits = txs
      .flatMap((t) => t.d.events)
      .filter((e) => e.ix === 'initObligation' && e.accounts.obligation === o.address);
    expect(inits).toHaveLength(2);
    expect(ob.lastUpdateSlot).toBeLessThanOrEqual(BigInt(fx.cutSlot));
  });

  it('collateral events since the last initObligation equal the deposited cTokens exactly', () => {
    const sums =
      obligationCollateral(
        txs.flatMap((t) => t.d.events),
        vaults,
      ).get(o.address) ?? new Map();
    const byReserve = new Map<string, bigint>();
    for (const [v, d] of sums) byReserve.set(reserveOfVault.get(v) as string, d);
    for (const d of ob.deposits) expect(byReserve.get(d.reserve) ?? 0n).toBe(d.depositedAmount);
    for (const [reserve, d] of byReserve)
      expect(ob.deposits.find((x) => x.reserve === reserve)?.depositedAmount ?? 0n).toBe(d);
  });
});

describe('lending verify — on-chain rows against the API', () => {
  const a = fx.api;
  const coll = (r: typeof a.before) =>
    Number(r.collateralInternal) / 10 ** (r.internalDecimals - a.supplyDecimals);
  const dt = (r: typeof a.before) => (Date.parse(r.fetchedAt) - Date.parse(a.apiAt)) / 1000;

  it('the API read falls between two on-chain reads that differ', () => {
    expect(dt(a.before)).toBeLessThanOrEqual(0);
    expect(dt(a.after)).toBeGreaterThan(0);
    expect(a.before.collateralInternal).not.toBe(a.after.collateralInternal);
  });

  it('the API equals the read after it within apiMatchTolRel, and not the read before', () => {
    expect(
      Math.abs(apiResidual(coll(a.after), Number(a.totalSupply), 0, dt(a.after))),
    ).toBeLessThanOrEqual(P.apiMatchTolRel);
    expect(
      Math.abs(
        apiResidual(
          Number(a.after.liquiditySupplied),
          Number(a.totalSupplyLiquidity),
          0,
          dt(a.after),
        ),
      ),
    ).toBe(0);
    expect(
      Math.abs(apiResidual(coll(a.before), Number(a.totalSupply), 0, dt(a.before))),
    ).toBeGreaterThan(P.apiMatchTolRel);
  });

  it('interest accrual is applied before comparing', () => {
    expect(apiResidual(100 * (1 + (0.0525 * 600) / 31_536_000), 100, 0.0525, 600)).toBeCloseTo(
      0,
      15,
    );
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import {
  aggregateLendingPositions,
  collectAddresses,
  type DecodedLendingEvent,
  decodeLendingTx,
  defaultLendingReconstructParams,
  type JupiterLendPositionRow,
  jupiterLendPositionInput,
  type KaminoObligationRow,
  kaminoPositionInput,
  type LendingEventRow,
  type LendingPositionInput,
  lendingConfigRows,
  lendingEventRows,
  lendingPoolIndex,
  looksLikeAddress,
  type RpcTx,
  scrubLendingPayload,
  topShare,
  txAccountKeys,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b item 8 — what reaches the lending tables. Frozen mainnet data only:
//  - fixtures/risk/lending/import.json (`pnpm risk:lending-freeze-import-fixtures`): the lending and DEX registries
//    and one collector hour of positions (a Kamino market's obligations, a Jupiter Lend vault's positions);
//  - fixtures/risk/lending/txs (item 5): one real transaction per event type.
// Expected values come from the inputs' own fields (the collector's per-position USD, LTV and amounts; the decoder's
// flows), never from the functions under test. The property that matters: no owner, obligation, position, signer or
// liquidator address appears in any row.
type Fx = {
  hour: string;
  registry: Array<{
    account: string;
    market: string;
    role: string;
    venue: string;
    accounts: Record<string, unknown>;
  }>;
  dex: Array<{ address: string; assetMint: string; quoteMint: string }>;
  kamino: {
    file: string;
    rows: Array<KaminoObligationRow & { owner: string; obligation: string }>;
  };
  jl: {
    market: string;
    vaultRow: { symbol: string; debtSymbol: string; oraclePrice: number };
    rows: Array<JupiterLendPositionRow & { position: string; positionMint: string; nftId: number }>;
  };
};
const fx = JSON.parse(readFileSync('fixtures/risk/lending/import.json', 'utf8')) as Fx;
const EDGES = defaultLendingReconstructParams().ltvBucketsPct;
const { poolOf, marketOf } = lendingPoolIndex(fx.registry);
const allowed = collectAddresses([fx.registry, fx.dex], new Set(['manager']));
const ctx = { poolOf, marketOf, allowed };
const addressesIn = (v: unknown) => [...collectAddresses(v)];
const near = (a: number | null, b: number) =>
  expect(Math.abs((a as number) - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));

describe('lending positions → hourly aggregates (frozen collector hour)', () => {
  const rows = fx.kamino.rows;
  const inputs = rows.map(kaminoPositionInput).filter((x): x is LendingPositionInput => x !== null);
  const agg = aggregateLendingPositions(inputs, EDGES);
  const live = rows.filter(
    (r) => r.deposits.some((d) => d.amount > 0) || r.borrows.some((b) => b.amount > 0),
  );

  it('Kamino: positions, collateral and debt equal the obligations’ own totals', () => {
    expect(fx.kamino.rows.length).toBeGreaterThanOrEqual(10);
    expect(agg.reduce((s, a) => s + a.positions, 0)).toBe(live.length);
    near(
      agg.reduce((s, a) => s + (a.collateralUsd as number), 0),
      live.reduce((s, r) => s + (r.collateralUsd as number), 0),
    );
    near(
      agg.reduce((s, a) => s + (a.debtUsd as number), 0),
      live.reduce((s, r) => s + (r.debtUsd as number), 0),
    );
    const debt: Record<string, number> = {};
    for (const r of live)
      for (const b of r.borrows) debt[b.symbol] = (debt[b.symbol] ?? 0) + b.amount;
    const got: Record<string, number> = {};
    for (const a of agg)
      for (const [k, v] of Object.entries(a.debtByAsset)) got[k] = (got[k] ?? 0) + v;
    for (const k of Object.keys(debt)) near(got[k] as number, debt[k] as number);
    expect(agg.reduce((s, a) => s + a.positionsWithDebt, 0)).toBe(
      live.filter((r) => r.borrows.some((b) => b.amount > 0)).length,
    );
  });

  it('Kamino: every position lands in the bucket of its own LTV', () => {
    const want: Record<string, number> = {};
    for (const r of live) {
      const pct = r.borrows.some((b) => b.amount > 0) ? 100 * (r.ltv as number) : 0;
      const label = EDGES.find((e) => pct <= e);
      const k = label === undefined ? `>${EDGES.at(-1)}` : `<=${label}`;
      want[k] = (want[k] ?? 0) + 1;
    }
    const got: Record<string, number> = {};
    for (const a of agg)
      for (const [k, b] of Object.entries(a.buckets)) got[k] = (got[k] ?? 0) + b.positions;
    expect(got).toEqual(want);
    expect(agg.every((a) => a.ltvNull === 0)).toBe(true);
  });

  it('Kamino: top-N shares are the largest positions’ share of the asset’s collateral', () => {
    for (const a of agg) {
      const units = inputs
        .filter((p) => p.asset === a.collateralAsset)
        .map((p) => p.collateralUnits);
      const total = units.reduce((s, v) => s + v, 0);
      near(a.top1, Math.max(...units) / total);
      expect(a.top1 as number).toBeLessThanOrEqual(a.top3 as number);
      expect(a.top3 as number).toBeLessThanOrEqual(a.top10 as number);
      if (units.length <= 10) near(a.top10, 1);
    }
    expect(topShare([], 1)).toBeNull();
    expect(topShare([3, 1], 1)).toBe(0.75);
  });

  it('Jupiter Lend: USD from the run’s oracle price, liquidated-branch positions counted not valued', () => {
    const v = fx.jl.vaultRow;
    const usdc = v.debtSymbol === 'USDC';
    const inp = fx.jl.rows
      .map((r) =>
        jupiterLendPositionInput(r, {
          symbol: v.symbol,
          debtSymbol: v.debtSymbol,
          oraclePrice: v.oraclePrice,
          debtPriceUsd: usdc ? 1 : null,
        }),
      )
      .filter((x): x is LendingPositionInput => x !== null);
    const [a] = aggregateLendingPositions(inp, EDGES);
    const open = fx.jl.rows.filter((r) => r.collateral > 0 || r.debt > 0);
    const valued = open.filter((r) => !r.liquidatedBranch);
    expect(a?.positions).toBe(open.length);
    expect(a?.positionsStateUnknown).toBe(open.length - valued.length);
    near(
      a?.collateralUnits as number,
      valued.reduce((s, r) => s + r.collateral, 0),
    );
    near(
      a?.debtByAsset[v.debtSymbol] as number,
      valued.reduce((s, r) => s + r.debt, 0),
    );
    if (usdc)
      near(
        a?.collateralUsd as number,
        valued.reduce((s, r) => s + r.collateral * v.oraclePrice, 0),
      );
    else expect(a?.collateralUsd).toBeNull();
    const inBuckets = Object.values(a?.buckets ?? {}).reduce((s, b) => s + b.positions, 0);
    expect(inBuckets + (a?.ltvNull ?? 0)).toBe(valued.length);
  });

  it('no owner, obligation or position address reaches an aggregate', () => {
    const jlInp = fx.jl.rows
      .map((r) => jupiterLendPositionInput(r, { ...fx.jl.vaultRow, debtPriceUsd: null }))
      .filter((x): x is LendingPositionInput => x !== null);
    const out = [agg, aggregateLendingPositions(jlInp, EDGES)];
    expect(addressesIn(out)).toEqual([]);
    const text = JSON.stringify(out);
    for (const r of fx.kamino.rows) {
      expect(text).not.toContain(r.owner);
      expect(text).not.toContain(r.obligation);
    }
    for (const r of fx.jl.rows) expect(text).not.toContain(r.position);
  });
});

describe('lending events → rows (frozen mainnet txs)', () => {
  type TxFx = {
    name: string;
    signature: string;
    ctx: {
      reserveSymbols: Record<string, string>;
      pools: Record<string, { venue: string; mint0: string; mint1: string }>;
    };
    tx: RpcTx;
  };
  const DIR = 'fixtures/risk/lending/txs';
  const txs = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as TxFx);
  const decode = (t: TxFx) =>
    decodeLendingTx(t.tx, {
      reserveSymbols: new Map(Object.entries(t.ctx.reserveSymbols)),
      pools: new Map(Object.entries(t.ctx.pools)),
    });
  const rowsOf = (t: TxFx) => {
    const d = decode(t);
    const ev = d.events as unknown as DecodedLendingEvent[];
    return {
      d,
      ev,
      r: lendingEventRows({ s: t.signature, sl: t.tx.slot, t: t.tx.blockTime as number, ev }, ctx),
    };
  };

  for (const t of txs)
    it(`${t.name}: no signer or non-public address in a row; flows kept whole`, () => {
      const { ev, r } = rowsOf(t);
      const signers = txAccountKeys(t.tx).slice(0, t.tx.transaction.signatures.length);
      for (const row of r.rows) {
        const { signature: _s, caller: _c, detail, ...rest } = row;
        if (row.market) expect(row.market).toBe(marketOf.get(row.pool as string));
        const { liquidation, ...d } = detail as Record<string, unknown>;
        const liq = liquidation
          ? { ...(liquidation as Record<string, unknown>), otherPrograms: undefined }
          : {};
        const src0 = ev.find((e) => e.path === row.eventKey) as DecodedLendingEvent;
        const here = new Set([
          ...allowed,
          ...src0.flows.flatMap((f) => [f.account, f.mint ?? '']),
          ...((src0.supply as Array<{ mint: string }> | undefined) ?? []).map((m) => m.mint),
        ]);
        for (const a of addressesIn([rest, d, liq]))
          expect(here.has(a), `${a} in ${row.kind}`).toBe(true);
        const text = JSON.stringify({ ...row, signature: '' });
        for (const s of signers) expect(text).not.toContain(s);
        const src = ev.find((e) => e.path === row.eventKey) as DecodedLendingEvent;
        expect(row.flows).toEqual(src.flows);
      }
    });

  it('no fixture event is dropped as outside the registry (all fixtures are on registered pools)', () => {
    const dropped = txs
      .map((t) => [t.name, rowsOf(t).r.skippedUnregistered])
      .filter(([, n]) => n !== 0);
    expect(dropped).toEqual([]);
  });

  it('every event type in the fixtures yields a row on its registry pool', () => {
    const kinds = new Set<string>();
    for (const t of txs)
      for (const row of rowsOf(t).r.rows) {
        kinds.add(row.kind);
        expect(row.pool).not.toBeNull();
      }
    for (const k of [
      'lender_deposit',
      'lender_redeem',
      'collateral_deposit',
      'borrow',
      'repay',
      'liquidation',
      'flash_borrow',
      'operate',
      'vault_deposit',
      'vault_withdraw',
      'vault_invest',
    ])
      expect(kinds.has(k), k).toBe(true);
  });

  it('a Kamino liquidation keeps its amounts and sale, not the obligation or liquidator', () => {
    for (const name of ['kamino-liquidation', 'kamino-liquidation-dex-sale']) {
      const t = txs.find((x) => x.name === name) as TxFx;
      const { ev, r } = rowsOf(t);
      const src = ev.find((e) => e.kind === 'liquidation') as DecodedLendingEvent;
      const row = r.rows.find((x) => x.kind === 'liquidation') as LendingEventRow;
      const liq = (row.detail as { liquidation: Record<string, unknown> }).liquidation;
      expect(liq.debtRepaid).toBe(src.liquidation?.debtRepaid);
      expect(liq.collateralSeized).toBe(src.liquidation?.collateralSeized);
      expect(liq.position).toBeUndefined();
      expect(liq.liquidator).toBeUndefined();
      expect(liq.otherPrograms).toEqual(src.liquidation?.otherPrograms);
      const text = JSON.stringify(row);
      expect(text).not.toContain(src.liquidation?.position as string);
      expect(text).not.toContain(src.liquidation?.liquidator as string);
      if (name.endsWith('dex-sale')) expect((liq.sales as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('a Jupiter Lend liquidation keeps the vault as its position (a vault, not a wallet)', () => {
    const t = txs.find((x) => x.name === 'jl-liquidation') as TxFx;
    const { ev, r } = rowsOf(t);
    const src = ev.find((e) => e.kind === 'liquidation') as DecodedLendingEvent;
    const row = r.rows.find((x) => x.kind === 'liquidation') as LendingEventRow;
    const liq = (row.detail as { liquidation: Record<string, unknown> }).liquidation;
    expect(liq.position).toBe(src.liquidation?.position);
    // the decoder's position is the vault state, which belongs to the vault's registry row
    expect(row?.pool).toBe(poolOf.get(src.liquidation?.position as string));
    expect(fx.registry.some((g) => g.account === row?.pool && g.role === 'vault')).toBe(true);
    expect(liq.liquidator).toBeUndefined();
  });

  it('configuration instructions become change rows with stable keys; bookkeeping is not stored', () => {
    const t = txs.find((x) => x.name === 'kamino-config-ltv') as TxFx;
    const { ev, r } = rowsOf(t);
    expect(r.rows).toEqual([]);
    const changes = ev.flatMap((e) =>
      (
        (e as unknown as { config?: Array<{ param: string; value: string; old?: string | null }> })
          .config ?? []
      ).map((c) => ({
        s: t.signature,
        slot: t.tx.slot,
        time: new Date((t.tx.blockTime as number) * 1000).toISOString(),
        program: e.program,
        ix: e.ix,
        target: e.accounts.reserve as string,
        param: c.param,
        old: c.old ?? null,
        new: c.value,
      })),
    );
    expect(changes.length).toBeGreaterThan(0);
    const rows = lendingConfigRows([...changes, ...changes], ctx);
    expect(new Set(rows.map((x) => x.eventKey)).size).toBe(rows.length);
    expect(rows.every((x) => x.kind === 'config_change' && x.pool === changes[0]?.target)).toBe(
      true,
    );
  });

  it('a curated vault’s allocation change (`<vault>:<reserve>`, as the decode pass writes it) maps to the vault', () => {
    const t = txs.find((x) => x.name === 'kvault-allocation-config') as TxFx;
    const e = rowsOf(t).ev.find((x) => x.kind === 'vault_allocation_config') as DecodedLendingEvent;
    const vault = e.accounts.vaultState as string;
    const [row] = lendingConfigRows(
      [
        {
          s: t.signature,
          slot: t.tx.slot,
          time: new Date((t.tx.blockTime as number) * 1000).toISOString(),
          program: e.program,
          ix: e.ix,
          target: `${vault}:${e.accounts.reserve}`,
          param: 'allocation weight/cap',
          old: null,
          new: `${e.args?.weight}/${e.args?.cap}`,
        },
      ],
      ctx,
    );
    expect(fx.registry.some((g) => g.account === vault && g.role === 'curated_vault')).toBe(true);
    expect(row?.pool).toBe(vault);
    expect(row?.market).toBe(marketOf.get(vault));
    // a market-level change keeps its market and no pool; a target outside the registry keeps neither
    const kaminoMarket = fx.registry.find((g) => g.venue === 'kamino')?.market as string;
    const base = {
      s: 'x',
      slot: 1,
      time: '2026-10-01T00:00:00Z',
      program: 'klend',
      ix: 'updateLendingMarket',
      param: 'p',
      old: null,
      new: '1',
    };
    const [m, outside] = lendingConfigRows(
      [
        { ...base, target: kaminoMarket },
        { ...base, target: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' },
      ],
      ctx,
    );
    expect([m?.pool, m?.market]).toEqual([null, kaminoMarket]);
    expect([outside?.pool, outside?.market]).toEqual([null, null]);
  });
});

describe('payload scrub', () => {
  it('drops addresses off the list and position keys, keeps amounts and public accounts', () => {
    const reserve = fx.registry[0]?.account as string;
    const wallet = 'AEGjpyB3JEwDw3X63poRFBiyHfL1KFk8rFGuCK7mt2wD';
    const { value, removed } = scrubLendingPayload(
      {
        user: wallet,
        nftId: 2564,
        reserve,
        amount: '720019',
        tick: -5,
        to: [wallet],
        name: 'LogOperate',
      },
      allowed,
    );
    expect(value).toEqual({ reserve, amount: '720019', tick: -5, name: 'LogOperate' });
    expect(removed).toBe(3);
    expect(looksLikeAddress('1000000000000')).toBe(false);
    expect(allowed.has(wallet)).toBe(false);
  });
});

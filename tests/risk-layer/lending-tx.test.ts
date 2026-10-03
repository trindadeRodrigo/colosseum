import { readdirSync, readFileSync } from 'node:fs';
import {
  decodeLendingTx,
  discOf,
  EVENT_IX_TAG,
  flattenIxs,
  JL_FLASHLOAN_IX,
  JL_LENDING_IX,
  JL_LIQUIDITY_IX,
  JL_VAULTS_IX,
  KLEND_IX,
  KVAULT_IX,
  kvaultReallocation,
  LENDING_PROGRAMS,
  type LendingEvent,
  type RpcTx,
  subtreeFlows,
  vaultBalanceCheck,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 10b item 5 — lending transaction decoders on frozen mainnet transactions (fixtures/risk/lending/txs, written
// by scripts/risk/lending-freeze-tx-fixtures.ts from the fetched history). Expected values never come from the
// decoders themselves:
//  - token balances: every protocol vault's decoded flows equal its post − pre balance in the tx meta, exactly;
//  - names and arguments: the SDKs' own coders on the same bytes, recorded at freeze time (D11);
//  - amounts: the programs' own records — klend's `pnl:` log lines, Jupiter Lend's LogOperate / LogLiquidate
//    events, kvault's Deposit/WithdrawResultEvent.
type Fx = {
  name: string;
  signature: string;
  ctx: {
    reserveSymbols: Record<string, string>;
    pools: Record<string, { venue: string; mint0: string; mint1: string }>;
  };
  sdk: Array<{
    path: string;
    program: string;
    name: string | null;
    args: Record<string, unknown> | null;
  }>;
  tx: RpcTx;
};
const DIR = 'fixtures/risk/lending/txs';
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as Fx);
const decode = (fx: Fx) =>
  decodeLendingTx(fx.tx, {
    reserveSymbols: new Map(Object.entries(fx.ctx.reserveSymbols)),
    pools: new Map(Object.entries(fx.ctx.pools)),
  });
const byName = (n: string) => {
  const fx = fixtures.find((f) => f.name === n);
  if (!fx) throw new Error(`fixture ${n} missing`);
  return { fx, d: decode(fx) };
};
const TABLES: Record<string, Readonly<Record<string, readonly [string, readonly string[]]>>> = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: KLEND_IX,
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: KVAULT_IX,
  jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi: JL_VAULTS_IX,
  jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC: JL_LIQUIDITY_IX,
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: JL_LENDING_IX,
  jupgfSgfuAXv4B6R2Uxu85Z1qdzgju79s6MfZekN6XS: JL_FLASHLOAN_IX,
};
const norm = (s: string) => s.replace(/_/g, '').toLowerCase();
const sum = (xs: Array<{ delta: string }>) => xs.reduce((s, x) => s + BigInt(x.delta), 0n);
const role = (e: LendingEvent, r: string) => sum(e.flows.filter((f) => f.role === r));

describe('lending tx decoders: vault balances (frozen mainnet txs)', () => {
  it('has a fixture for every event type', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(21);
  });
  for (const fx of fixtures)
    it(`${fx.name}: decoded flows equal every protocol vault's balance change, nothing unknown`, () => {
      const d = decode(fx);
      const c = vaultBalanceCheck(d);
      expect(c.rows.filter((r) => !r.ok)).toEqual([]);
      expect(d.external).toEqual([]);
      expect(d.unknown).toEqual([]);
      expect(d.events.length).toBeGreaterThan(0);
    });
});

describe('lending tx decoders: names and arguments equal the SDK coders (D11)', () => {
  for (const fx of fixtures)
    it(`${fx.name}: every lending instruction`, () => {
      const flat = flattenIxs(fx.tx).filter(
        (ix) => LENDING_PROGRAMS.has(ix.program) && discOf(ix.data) !== EVENT_IX_TAG,
      );
      const d = decode(fx);
      for (const ix of flat) {
        const sdk = fx.sdk.find((x) => x.path === ix.path);
        const mine = TABLES[ix.program]?.[discOf(ix.data)]?.[0];
        expect(mine).toBeDefined();
        if (sdk?.name) expect(norm(mine as string)).toBe(norm(sdk.name));
        const e = d.events.find((x) => x.path === ix.path);
        const a = e?.args;
        const s = sdk?.args as Record<string, unknown> | null | undefined;
        if (!a || !s) continue;
        if (a.amount !== undefined)
          expect(String(a.amount)).toBe(
            String(
              s.liquidityAmount ??
                s.collateralAmount ??
                s.repayAmount ??
                s.maxAmount ??
                s.sharesAmount ??
                s.assets ??
                s.amount,
            ),
          );
        if (a.newCol !== undefined) expect(String(a.newCol)).toBe(String(s.newCol ?? s.new_col));
        if (a.supplyAmount !== undefined)
          expect(String(a.supplyAmount)).toBe(String(s.supplyAmount ?? s.supply_amount));
        if (a.weight !== undefined)
          expect([String(a.weight), String(a.cap)]).toEqual([String(s.weight), String(s.cap)]);
        if (e?.ix === 'updateReserveConfig') {
          const mode = Object.keys(s.mode as object)[0] as string;
          expect(norm(e.config?.[0]?.param ?? '')).toBe(norm(mode));
        }
      }
    });
});

/** klend's own `pnl:` lines, per instruction frame, in instruction order. */
const pnl = (tx: RpcTx) =>
  (tx.meta?.logMessages ?? []).filter((l) => l.startsWith('Program log: pnl:'));

describe('Kamino amounts equal the program log (pnl lines)', () => {
  it('liquidation: repaid, seized (to liquidator + fee) and protocol fee; stated bonus 500 bps = implied', () => {
    for (const n of ['kamino-liquidation', 'kamino-liquidation-dex-sale']) {
      const { fx, d } = byName(n);
      const m = pnl(fx.tx)
        .map((l) => /Liquidator repaid (\d+) and withdrew (\d+) collateral with fees (\d+)/.exec(l))
        .find(Boolean) as RegExpExecArray;
      const l = d.events.find((e) => e.liquidation)?.liquidation;
      expect(l?.venue).toBe('kamino');
      expect(l?.debtRepaid).toBe(m[1]);
      expect(BigInt(l?.collateralSeized ?? 0)).toBe(
        BigInt(m[2] as string) + BigInt(m[3] as string),
      );
      expect(l?.protocolFee).toBe(m[3]);
      expect(l?.statedBonusBps).toBe(500);
      expect(Math.abs((l?.impliedBonus ?? 0) - 0.05)).toBeLessThan(0.0005);
    }
  });
  it('liquidation followed by a DEX sale of the seized stock in the same tx', () => {
    const { d } = byName('kamino-liquidation-dex-sale');
    const l = d.events.find((e) => e.liquidation)?.liquidation;
    expect(l?.sales.length).toBeGreaterThan(0);
    const s = l?.sales[0];
    expect(s?.mintIn).toBe(l?.collateralMint);
    expect(BigInt(s?.amountIn ?? 0)).toBeGreaterThan(0n);
    expect(s?.realisedPrice).toBeGreaterThan(0);
  });
  it('collateral deposit, repay, borrow, lender deposit and redeem', () => {
    const dep = byName('kamino-collateral-deposit');
    const md = pnl(dep.fx.tx)
      .map((l) => /Deposit reserve liquidity (\d+) and obligation collateral (\d+)/.exec(l))
      .find(Boolean) as RegExpExecArray;
    const ed = dep.d.events.find((e) => e.kind === 'collateral_deposit') as LendingEvent;
    expect(role(ed, 'liquidity_supply').toString()).toBe(md[1]);
    expect(role(ed, 'collateral_supply').toString()).toBe(md[2]);

    const rp = byName('kamino-repay-withdraw');
    const mr = pnl(rp.fx.tx)
      .map((l) => /Repaying obligation liquidity (\d+) liquidity_amount (\d+)/.exec(l))
      .find(Boolean) as RegExpExecArray;
    const er = rp.d.events.find((e) => e.kind === 'repay') as LendingEvent;
    expect(role(er, 'liquidity_supply').toString()).toBe(mr[1]);
    // the request ("liquidity_amount") is larger than what was owed and repaid
    expect(er.args?.amount).toBe(mr[2]);

    const br = byName('kamino-borrow');
    const mb = pnl(br.fx.tx)
      .map((l) => /Borrow obligation liquidity (\d+) with origination_fee (\d+)/.exec(l))
      .find(Boolean);
    const eb = br.d.events.find((e) => e.kind === 'borrow') as LendingEvent;
    if (mb) expect((-role(eb, 'liquidity_supply')).toString()).toBe(mb[1]);
    expect(role(eb, 'liquidity_supply')).toBeLessThan(0n);

    const ld = byName('kamino-lender-deposit');
    const ml = pnl(ld.fx.tx)
      .map((l) => /Depositing in reserve \w+ liquidity (\d+)/.exec(l))
      .find(Boolean) as RegExpExecArray;
    expect(role(ld.d.events[0] as LendingEvent, 'liquidity_supply').toString()).toBe(ml[1]);

    const rd = byName('kamino-lender-redeem');
    const mx = pnl(rd.fx.tx)
      .map((l) => /Redeeming reserve collateral (\d+)/.exec(l))
      .find(Boolean) as RegExpExecArray;
    expect((-role(rd.d.events[0] as LendingEvent, 'liquidity_supply')).toString()).toBe(mx[1]);
  });
  it('flash loan: borrow and repay legs in one tx, repay ≥ borrow', () => {
    const { d } = byName('kamino-flash-loan');
    const b = d.events.find((e) => e.kind === 'flash_borrow') as LendingEvent;
    const r = d.events.find((e) => e.kind === 'flash_repay') as LendingEvent;
    expect(-role(b, 'liquidity_supply')).toBeGreaterThan(0n);
    expect(role(r, 'liquidity_supply') + role(r, 'fee_vault')).toBeGreaterThanOrEqual(
      -role(b, 'liquidity_supply'),
    );
    expect(r.args?.borrowInstructionIndex).toBe(Number(b.path));
  });
  it('combined repay-and-withdraw: both legs decoded with both requested amounts', () => {
    const { d } = byName('kamino-repay-and-withdraw-combined');
    const e = d.events.find((x) => x.kind === 'repay_and_withdraw') as LendingEvent;
    expect(e.args?.withdrawCollateralAmount).toBeDefined();
    expect(role(e, 'collateral_supply')).toBeLessThan(0n);
  });
  it('a klend call made by another program (router) is found, with its caller', () => {
    const { d } = byName('kamino-via-router');
    const e = d.events.find((x) => x.program === 'klend' && x.caller) as LendingEvent;
    expect(e).toBeDefined();
    expect(LENDING_PROGRAMS.has(e.caller as string)).toBe(false);
    expect(e.flows.length).toBeGreaterThan(0);
  });
  it('configuration changes: parameter and new value', () => {
    const ltv = byName('kamino-config-ltv').d.events.flatMap((e) => e.config ?? []);
    expect(ltv.find((c) => c.param === 'UpdateLoanToValuePct')?.value).toMatch(/^\d+$/);
    const basis = byName('kamino-config-interest-basis').d.events.flatMap((e) => e.config ?? []);
    expect(basis.find((c) => c.param === 'UpdateInterestRateBasis')?.value).toMatch(/^[01]$/);
  });
});

describe('Jupiter Lend amounts equal the program events', () => {
  for (const n of [
    'jl-operate-deposit-borrow',
    'jl-operate-payback-withdraw',
    'jl-flashloan',
    'jl-liquidation',
  ])
    it(`${n}: Σ liquidity-layer LogOperate (supply − borrow) per token = Σ liquidity-vault flows per mint`, () => {
      const { d } = byName(n);
      const fromEvents = new Map<string, bigint>();
      for (const e of d.events)
        for (const x of e.events ?? [])
          if (x.name === 'LogOperate' && x.fields.token !== undefined) {
            const t = String(x.fields.token);
            fromEvents.set(
              t,
              (fromEvents.get(t) ?? 0n) +
                BigInt(String(x.fields.supplyAmount)) -
                BigInt(String(x.fields.borrowAmount)),
            );
          }
      const fromFlows = new Map<string, bigint>();
      for (const f of d.events.flatMap((e) => e.flows))
        if (f.role === 'jl_liquidity_vault' && f.mint)
          fromFlows.set(f.mint, (fromFlows.get(f.mint) ?? 0n) + BigInt(f.delta));
      expect(fromEvents.size).toBeGreaterThan(0);
      for (const [t, v] of fromEvents) expect(fromFlows.get(t) ?? 0n).toBe(v);
    });
  it('liquidation: LogLiquidate amounts = flows; oracle-implied bonus = the 3% penalty', () => {
    const { d } = byName('jl-liquidation');
    const e = d.events.find((x) => x.kind === 'liquidation') as LendingEvent;
    const log = e.events?.find((x) => x.name === 'LogLiquidate')?.fields;
    const l = e.liquidation;
    expect(l?.debtRepaid).toBe(String(log?.debtAmount));
    expect(l?.collateralSeized).toBe(String(log?.colAmount));
    expect(l?.priceUnit).toBe('debt_token');
    expect(Math.abs((l?.impliedBonus ?? 0) - 0.03)).toBeLessThan(0.0005);
    expect(l?.sales.length).toBeGreaterThan(0);
  });
  it('max sentinel (i128::MIN = withdraw/pay back all) is kept as the request; amounts come from flows', () => {
    const { d } = byName('jl-operate-payback-withdraw');
    const e = d.events.find(
      (x) => x.program === 'jl_vaults' && x.kind === 'operate',
    ) as LendingEvent;
    expect(BigInt(String(e.args?.newCol))).toBe(-(2n ** 127n));
    expect(subtreeFlows(d.events, e.path).length).toBeGreaterThan(0);
  });
  it('configuration events', () => {
    const c = byName('jl-config').d.events.flatMap((e) => e.config ?? []);
    expect(c.length).toBeGreaterThan(0);
  });
});

describe('Curated vaults', () => {
  it('deposit: DepositResultEvent tokenToDeposit + crank funds = token-vault flow', () => {
    const { d } = byName('kvault-deposit');
    const e = d.events.find((x) => x.kind === 'vault_deposit') as LendingEvent;
    const r = e.events?.find((x) => x.name === 'DepositResultEvent')?.fields;
    expect(role(e, 'kvault_token')).toBe(
      BigInt(String(r?.tokenToDeposit)) + BigInt(String(r?.crankFundsToDeposit)),
    );
  });
  it('withdraw with disinvest: WithdrawResultEvent amounts = flows (vault idle + redeemed from the reserve)', () => {
    const { d } = byName('kvault-withdraw-disinvest');
    const e = d.events.find((x) => x.kind === 'vault_withdraw') as LendingEvent;
    const r = e.events?.find((x) => x.name === 'WithdrawResultEvent')?.fields;
    expect(-role(e, 'kvault_token')).toBe(
      BigInt(String(r?.availableToSendToUser)) + BigInt(String(r?.investedLiquidityToSendToUser)),
    );
    const redeem = d.events.find(
      (x) => x.parentPath === e.path && x.kind === 'lender_redeem',
    ) as LendingEvent;
    expect(-role(redeem, 'kvault_ctoken')).toBe(BigInt(String(r?.investedToDisinvestCtokens)));
  });
  it('reallocation: from one reserve to another, legs = the klend redeem and deposit it made', () => {
    const { d } = byName('kvault-reallocation');
    const re = kvaultReallocation(d);
    expect(re?.from).toBeTruthy();
    expect(re?.to).toBeTruthy();
    expect(re?.from).not.toBe(re?.to);
    const legs = sum(re?.legs ?? []);
    const kids = d.events.filter((e) => e.program === 'klend' && e.parentPath);
    expect(legs).toBe(kids.reduce((s, e) => s + role(e, 'liquidity_supply'), 0n));
  });
  it('allocation config: weight and cap', () => {
    const { d } = byName('kvault-allocation-config');
    const e = d.events.find((x) => x.kind === 'vault_allocation_config') as LendingEvent;
    expect(e.args?.weight).toMatch(/^\d+$/);
    expect(e.args?.cap).toMatch(/^\d+$/);
  });
});

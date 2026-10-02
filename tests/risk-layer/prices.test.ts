import { readdirSync, readFileSync } from 'node:fs';
import {
  buildPriceIndex,
  buildSessionClock,
  decodeLendingTx,
  defaultLivenessParams,
  defaultPriceParams,
  defaultRegimeParams,
  hourlyReferencePrices,
  loggedOraclePrices,
  markLiveness,
  openSecondsBetween,
  type PriceContext,
  type PriceObservation,
  type RpcTx,
  referencePrice,
  resolvePrice,
  sessionStartsBetween,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 11 — the oracle standard, on frozen mainnet data (fixtures/risk/prices, written by
// scripts/risk/prices/freeze-fixtures.ts; transactions from fixtures/risk/lending/txs). Expected values never come
// from the code under test: logged prices are read off the transaction's own log lines and checked against the
// reserve names frozen with each transaction; resolved prices are found by scanning the frozen observations here.
const ctxFx = JSON.parse(readFileSync('fixtures/risk/prices/context.json', 'utf8')) as {
  kaminoReserves: Record<string, { symbol: string; mint: string; market: string }>;
  continuousMints: string[];
  usdStableMints: string[];
  usdc: string;
};
const obsFx = (
  JSON.parse(readFileSync('fixtures/risk/prices/observations.json', 'utf8')) as {
    observations: PriceObservation[];
  }
).observations;
const calendar = JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')) as {
  closed: string[];
  earlyClose13ET: string[];
};
const RP = defaultRegimeParams(calendar);
const unix = (iso: string) => Date.parse(iso) / 1000;
const kaminoReserves = new Map(Object.entries(ctxFx.kaminoReserves));
const mintOf = (symbol: string) =>
  [...kaminoReserves.values()].find((r) => r.symbol === symbol)?.mint as string;
const SPY = mintOf('SPYx');
const META = mintOf('METAx');
const USDG = mintOf('USDG');
const params = defaultPriceParams({
  parMints: [ctxFx.usdc],
  continuousMints: ctxFx.continuousMints,
  usdStableMints: ctxFx.usdStableMints,
});
const clock = buildSessionClock(unix('2026-02-01T00:00:00Z'), unix('2026-10-01T00:00:00Z'), RP);
const weekdays = buildSessionClock(
  unix('2026-02-01T00:00:00Z'),
  unix('2026-10-01T00:00:00Z'),
  RP,
  'us_weekdays',
);
const ctx: PriceContext = {
  params,
  regime: RP,
  clocks: { us_market_hours: clock, us_weekdays: weekdays },
};
/** The frozen observations with the liveness flags set, as the scripts' loader does. */
const flagged = () => {
  const all = obsFx.map((o) => ({ ...o }));
  const meta = all.filter((o) => o.mint === META && o.priceSource === 'kamino_scope');
  markLiveness(meta, RP, defaultLivenessParams()).live.forEach((v, i) => {
    if (!v) (meta[i] as PriceObservation).live = false;
  });
  return all;
};
/** The latest frozen observation at or before `t`, found by a plain scan. */
const lastBefore = (rows: PriceObservation[], t: number) =>
  rows.filter((o) => o.t <= t).sort((a, b) => b.t - a.t || (b.slot ?? 0) - (a.slot ?? 0))[0];
const spyPool = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'pool_mid');
const spyKamino = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'kamino_scope');
const spyJl = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'jupiter_lend_oracle');
const sat = unix('2026-09-26T12:00:00Z');
const friClose = unix('2026-09-25T20:00:00Z');
const monOpen = unix('2026-09-28T13:30:00Z');

describe('logged oracle prices (item 1)', () => {
  type Fx = { name: string; ctx?: { reserveSymbols: Record<string, string> }; tx: RpcTx };
  const DIR = 'fixtures/risk/lending/txs';
  const txs = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as Fx);

  it('every klend price line of a registered reserve is returned once, on the reserve that logged it', () => {
    let lines = 0;
    for (const { tx, ctx: frozen } of txs) {
      const d = loggedOraclePrices(tx, { kaminoReserves });
      expect(d.aligned).toBe(true);
      // the transaction's own log: "Token: <name> Price: <usd>", distinct
      const logged = new Set(
        (tx.meta?.logMessages ?? [])
          .map((l) => /Token: (.+) Price: ([\d.]+)/.exec(l))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => `${m[1]}|${Number(m[2])}`),
      );
      const got = d.prices.filter((p) => p.priceSource === 'kamino_scope');
      // once each: the list is as long as the set of distinct lines
      expect(got.length).toBe(logged.size);
      // the reserve is one the transaction touches, and the name frozen with the transaction (from the SDK at
      // freeze time) is the name on the line
      const keys = new Set([
        ...tx.transaction.message.accountKeys,
        ...(tx.meta?.loadedAddresses?.writable ?? []),
        ...(tx.meta?.loadedAddresses?.readonly ?? []),
      ]);
      for (const p of got) {
        expect(keys.has(p.ref)).toBe(true);
        expect(logged.has(`${frozen?.reserveSymbols[p.ref]}|${p.price}`)).toBe(true);
        expect(p.quote).toBe('usd');
        expect(p.failedChecks).toBeUndefined();
      }
      expect(d.outside).toBe(0);
      expect(d.ambiguous).toBe(0);
      lines += logged.size;
    }
    expect(lines).toBeGreaterThan(10);
  });

  it('a Jupiter Lend return is the rate in the log, in the vault debt token', () => {
    let seen = 0;
    for (const { tx } of txs) {
      // every distinct return of the oracle program: first u128, little endian
      const rates = new Set(
        (tx.meta?.logMessages ?? [])
          .filter((l) =>
            l.startsWith('Program return: jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc '),
          )
          .map((l) => Buffer.from(l.slice(l.lastIndexOf(' ') + 1), 'base64'))
          .map((b) => (b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n)).toString()),
      );
      const got = loggedOraclePrices(tx, { kaminoReserves }).prices.filter(
        (p) => p.priceSource === 'jupiter_lend_oracle',
      );
      expect(got.length).toBe(rates.size);
      for (const p of got) {
        expect([...rates].some((r) => Math.abs(Number(r) / 1e15 - p.price) < 1e-9)).toBe(true);
        expect(p.quote).not.toBe('usd');
        expect(p.market).toBe(p.ref);
        seen++;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('the unit is per whole token: seized × price over repaid is the 3% liquidation penalty', () => {
    const fx = txs.find((t) => t.name === 'jl-liquidation') as Fx;
    const l = decodeLendingTx(fx.tx).events.find((e) => e.liquidation)?.liquidation;
    const got = loggedOraclePrices(fx.tx, { kaminoReserves }).prices[0];
    expect(got?.mint).toBe(l?.collateralMint);
    expect(got?.quote).toBe(l?.debtMint);
    // amounts are the token balance changes of the liquidation, whole tokens: TSLAx has 8 decimals, the debt 6
    const seized = Number(l?.collateralSeized) / 1e8;
    const repaid = Number(l?.debtRepaid) / 1e6;
    expect((seized * (got?.price as number)) / repaid - 1).toBeCloseTo(0.03, 3);
  });

  it('a price that failed klend’s own checks comes back with the checks it failed', () => {
    const fx = JSON.parse(
      readFileSync('fixtures/risk/prices/txs/kamino-failed-price-check.json', 'utf8'),
    ) as Fx;
    const logs = fx.tx.meta?.logMessages ?? [];
    expect(logs.some((l) => l.includes('Price twap check failed token=[AAPLx]'))).toBe(true);
    expect(logs.some((l) => l.includes('Price heuristic check failed token=[AAPLx]'))).toBe(true);
    const d = loggedOraclePrices(fx.tx, { kaminoReserves });
    const aapl = d.prices.filter((p) => p.mint === mintOf('AAPLx'));
    expect(aapl.length).toBe(1);
    expect(aapl[0]?.failedChecks).toEqual(['heuristic', 'twap']);
    const line = logs.find((l) => l.includes('Token: AAPLx Price: ')) as string;
    expect(aapl[0]?.price).toBe(Number(line.slice(line.lastIndexOf(' ') + 1)));
    // the other tokens of the same transaction passed
    expect(d.prices.filter((p) => p.mint !== mintOf('AAPLx')).every((p) => !p.failedChecks)).toBe(
      true,
    );
  });

  it('a failed transaction or a cut log gives no price', () => {
    const fx = txs.find((t) => t.name === 'kamino-borrow') as Fx;
    const failed = { ...fx.tx, meta: { ...fx.tx.meta, err: { InstructionError: [0, 'Custom'] } } };
    expect(loggedOraclePrices(failed as RpcTx, { kaminoReserves }).prices).toEqual([]);
    const cut = {
      ...fx.tx,
      meta: { ...fx.tx.meta, logMessages: [...(fx.tx.meta?.logMessages ?? []), 'Log truncated'] },
    };
    const d = loggedOraclePrices(cut as RpcTx, { kaminoReserves });
    expect(d.aligned).toBe(false);
    expect(d.prices).toEqual([]);
  });
});

describe('session clock', () => {
  it('counts US market hours only: Friday 15:00 ET to Monday 10:30 ET is two hours', () => {
    const a = unix('2026-09-25T19:00:00Z');
    const b = unix('2026-09-28T14:30:00Z');
    expect(openSecondsBetween(clock, a, b)).toBe(2 * 3600);
    expect(
      openSecondsBetween(clock, unix('2026-09-26T00:00:00Z'), unix('2026-09-27T23:00:00Z')),
    ).toBe(0);
    expect(openSecondsBetween(clock, a, a)).toBe(0);
  });

  it('a closed date has no market hours, an early close ends at 13:00 ET', () => {
    // Labor Day 2026-09-07; the day after Thanksgiving 2026-11-27 closes at 13:00 ET (18:00Z)
    const c = buildSessionClock(unix('2026-09-01T00:00:00Z'), unix('2026-12-01T00:00:00Z'), RP);
    expect(openSecondsBetween(c, unix('2026-09-07T00:00:00Z'), unix('2026-09-08T00:00:00Z'))).toBe(
      0,
    );
    expect(openSecondsBetween(c, unix('2026-11-27T00:00:00Z'), unix('2026-11-28T00:00:00Z'))).toBe(
      3.5 * 3600,
    );
  });

  it('the weekday session runs from Sunday 20:00 ET to Friday 20:00 ET and skips closed dates', () => {
    // Friday 2026-09-25 12:00Z to Monday 2026-09-28 16:00Z: open until Sat 00:00Z, and from Mon 00:00Z
    expect(
      openSecondsBetween(weekdays, unix('2026-09-25T12:00:00Z'), unix('2026-09-28T16:00:00Z')),
    ).toBe((12 + 16) * 3600);
    const c = buildSessionClock(
      unix('2026-09-01T00:00:00Z'),
      unix('2026-09-15T00:00:00Z'),
      RP,
      'us_weekdays',
    );
    // Labor Day, Monday 2026-09-07 (ET date): no session
    expect(openSecondsBetween(c, unix('2026-09-07T04:00:00Z'), unix('2026-09-08T04:00:00Z'))).toBe(
      0,
    );
  });

  it('knows whether the session opened in between', () => {
    expect(sessionStartsBetween(clock, friClose, monOpen - 1)).toBe(false);
    expect(sessionStartsBetween(clock, friClose, monOpen)).toBe(true);
    // inside one session: no open in between
    expect(sessionStartsBetween(clock, monOpen, monOpen + 3600)).toBe(false);
    expect(sessionStartsBetween(clock, monOpen - 1, monOpen + 3600)).toBe(true);
  });

  it('refuses a time outside its range', () => {
    expect(() =>
      openSecondsBetween(clock, unix('2025-01-01T00:00:00Z'), unix('2026-03-01T00:00:00Z')),
    ).toThrow();
  });
});

describe('liveness: a placeholder oracle price is not a valuation', () => {
  const meta = obsFx.filter((o) => o.mint === META && o.priceSource === 'kamino_scope');
  const L = markLiveness(meta, RP, defaultLivenessParams());
  const LP = defaultLivenessParams();
  /** A copy of a real observation at another time and a price scaled from the real one. */
  const base = spyKamino[0] as PriceObservation;
  const at = (iso: string, scale = 1): PriceObservation => ({
    ...base,
    t: unix(iso),
    slot: null,
    price: base.price * scale,
  });

  it('METAx: the trading days before the feed went live are frozen at one price', () => {
    expect(L.frozenDays).toEqual(['2026-02-09', '2026-02-10', '2026-02-11']);
    const notLive = meta.filter((_, i) => !L.live[i]);
    expect(new Set(notLive.map((o) => o.price)).size).toBe(1);
    expect(notLive.length).toBeGreaterThan(50);
  });

  it('it turns live on 2026-02-12, from the first change of price, and stays live', () => {
    const first = L.live.indexOf(true);
    expect(new Date((L.liveFrom as number) * 1000).toISOString().slice(0, 10)).toBe('2026-02-12');
    expect((meta[first] as PriceObservation).price).not.toBe(
      (meta[first - 1] as PriceObservation).price,
    );
    expect(L.live.slice(first).every(Boolean)).toBe(true);
  });

  it('SPYx over a weekend stays live: closed days carry the last trading day', () => {
    const s = markLiveness(spyKamino, RP, LP);
    expect(s.frozenDays).toEqual([]);
    const from = spyKamino.findIndex((o) => o.t >= unix('2026-09-26T04:00:00Z'));
    expect(s.live.slice(from).every(Boolean)).toBe(true);
  });

  it('a thin series turns live when its price differs from the day before', () => {
    // one observation per trading day, in US market hours, each at another price
    const thin = [
      at('2026-09-21T15:00:00Z', 1),
      at('2026-09-22T15:00:00Z', 1.01),
      at('2026-09-23T15:00:00Z', 1.02),
    ];
    const s = markLiveness(thin, RP, LP);
    expect(s.live).toEqual([false, true, true]);
    expect(s.frozenDays).toEqual([]);
    // the same days at one price: never live, and too few observations to call any day frozen
    const flat = thin.map((o) => ({ ...o, price: base.price }));
    const f = markLiveness(flat, RP, LP);
    expect(f.live).toEqual([false, false, false]);
    expect(f.frozenDays).toEqual([]);
  });

  it('a day is judged frozen only on enough observations over enough of the session', () => {
    const live = [at('2026-09-21T15:00:00Z', 1), at('2026-09-21T16:00:00Z', 1.01)];
    // Tuesday: six equal observations in the first half hour of the session (13:30Z–13:55Z)
    const early = [30, 35, 40, 45, 50, 55].map((m) => at(`2026-09-22T13:${m}:00Z`, 1.01));
    const a = markLiveness([...live, ...early], RP, LP);
    expect(a.frozenDays).toEqual([]);
    expect(a.live.slice(2).every(Boolean)).toBe(true);
    // the same price held from 13:30Z to 19:30Z: frozen
    const all = [14, 15, 16, 17, 18, 19].map((h) => at(`2026-09-22T${h}:30:00Z`, 1.01));
    const b = markLiveness([...live, at('2026-09-22T13:30:00Z', 1.01), ...all], RP, LP);
    expect(b.frozenDays).toEqual(['2026-09-22']);
    expect(b.live.slice(2).some(Boolean)).toBe(false);
    // one observation fewer than `minFrozenObs` over the same span: not judged
    const few = markLiveness(
      [...live, ...all.slice(0, LP.minFrozenObs - 2), at('2026-09-22T19:30:00Z', 1.01)],
      RP,
      LP,
    );
    expect(few.frozenDays).toEqual([]);
  });
});

describe('resolver (item 3)', () => {
  const ix = buildPriceIndex(flagged());
  const noPool = buildPriceIndex(obsFx.filter((o) => o.priceSource !== 'pool_mid'));
  const usdcQuoted = spyJl.filter((o) => o.quote === ctxFx.usdc);
  const otherQuoted = spyJl.filter((o) => o.quote !== ctxFx.usdc);

  it('valuation takes the pool mid where one exists and keeps the oracle beside it', () => {
    const r = resolvePrice(ix, { mint: SPY, t: sat, purpose: 'valuation' }, ctx);
    const pool = lastBefore(spyPool, sat) as PriceObservation;
    const oracle = lastBefore(spyKamino, sat) as PriceObservation;
    expect(r.priceSource).toBe('pool_mid');
    expect(r.priceUsd).toBe(pool.price);
    expect(r.ref).toBe(pool.ref);
    expect(r.ageSec).toBe(sat - pool.t);
    expect(r.quality).toBe('traded');
    expect(r.regime).toBe('weekend');
    expect(r.nullReason).toBeNull();
    const other = r.others.find((c) => c.priceSource === 'kamino_scope');
    expect(other?.priceUsd).toBe(oracle.price);
    expect(other?.gapToAnswer).toBeCloseTo(oracle.price / pool.price - 1, 12);
    expect(other?.stale).toBe(false);
  });

  it('without a pool mid the lending oracle answers, labelled by the session', () => {
    const closed = resolvePrice(noPool, { mint: SPY, t: sat, purpose: 'valuation' }, ctx);
    expect(closed.priceSource).toBe('kamino_scope');
    expect(closed.priceUsd).toBe((lastBefore(spyKamino, sat) as PriceObservation).price);
    expect(closed.quality).toBe('oracle_closed');
    const open = unix('2026-09-25T18:00:00Z');
    const r = resolvePrice(noPool, { mint: SPY, t: open, purpose: 'valuation' }, ctx);
    expect(r.quality).toBe('oracle_open');
    expect(r.regime).toBe('us_market_hours');
    expect(r.priceUsd).toBe((lastBefore(spyKamino, open) as PriceObservation).price);
  });

  it('a moving oracle goes before a held one: Jupiter Lend on a weekday night, Kamino in US market hours', () => {
    // Monday 2026-09-28 before the open (00:00Z–13:30Z is Sunday 20:00 ET to Monday 09:30 ET)
    const night = usdcQuoted.find(
      (o) => o.t >= unix('2026-09-28T00:10:00Z') && o.t < unix('2026-09-28T13:00:00Z'),
    ) as PriceObservation;
    const r = resolvePrice(noPool, { mint: SPY, t: night.t, purpose: 'valuation' }, ctx);
    expect(r.regime).toBe('us_offhours_weekday');
    expect(r.priceSource).toBe('jupiter_lend_oracle');
    expect(r.priceUsd).toBe(night.price);
    expect(r.quality).toBe('oracle_open');
    const held = r.others.find((c) => c.priceSource === 'kamino_scope');
    expect(held?.sessionOpen).toBe(false);
    expect(held?.stale).toBe(false);
    // in US market hours both are moving and the order decides
    const day = usdcQuoted.find(
      (o) => o.t >= unix('2026-09-25T14:00:00Z') && o.t < unix('2026-09-25T19:30:00Z'),
    ) as PriceObservation;
    const d = resolvePrice(noPool, { mint: SPY, t: day.t, purpose: 'valuation' }, ctx);
    expect(d.priceSource).toBe('kamino_scope');
    expect(d.others.find((c) => c.priceSource === 'jupiter_lend_oracle')?.sessionOpen).toBe(true);
  });

  it('a held price is good until the session opens again, never after', () => {
    const upToClose = spyKamino.filter((o) => o.t <= friClose);
    const last = lastBefore(upToClose, friClose) as PriceObservation;
    const only = buildPriceIndex(upToClose);
    const at = (t: number) => resolvePrice(only, { mint: SPY, t, purpose: 'valuation' }, ctx);
    const sun = at(unix('2026-09-27T12:00:00Z'));
    expect(sun.priceUsd).toBe(last.price);
    expect(sun.quality).toBe('oracle_closed');
    // one second before Monday's open it is still the oracle's price
    expect(at(monOpen - 1).priceUsd).toBe(last.price);
    // at the open the oracle moves on: Friday's close is not Monday's price, however little session time passed
    const open = at(monOpen);
    expect(open.priceUsd).toBeNull();
    expect(open.nullReason).toBe('stale');
    expect(open.others[0]?.stale).toBe(true);
    expect(open.others[0]?.openAgeSec).toBeLessThan(params.maxOpenAgeSec);
    expect(at(monOpen + 1800).priceUsd).toBeNull();
  });

  it('inside a session a price is good for `maxOpenAgeSec` of session time', () => {
    // observations up to Friday 11:00 ET, asked later the same session
    const cut = unix('2026-09-25T15:00:00Z');
    const early = spyKamino.filter((o) => o.t <= cut);
    const last = lastBefore(early, cut) as PriceObservation;
    const only = buildPriceIndex(early);
    const at = (t: number) => resolvePrice(only, { mint: SPY, t, purpose: 'valuation' }, ctx);
    expect(at(last.t + params.maxOpenAgeSec).priceUsd).toBe(last.price);
    expect(at(last.t + params.maxOpenAgeSec).quality).toBe('oracle_open');
    const late = at(last.t + params.maxOpenAgeSec + 1);
    expect(late.priceUsd).toBeNull();
    expect(late.nullReason).toBe('stale');
  });

  it('across a closure a held price is good for `maxClosedAgeSec` at most', () => {
    const upToClose = spyKamino.filter((o) => o.t <= friClose);
    const last = lastBefore(upToClose, friClose) as PriceObservation;
    const only = buildPriceIndex(upToClose);
    const short = { ...ctx, params: { ...params, maxClosedAgeSec: 86400 } };
    const q = { mint: SPY, purpose: 'valuation' as const };
    expect(resolvePrice(only, { ...q, t: last.t + 86400 }, short).priceUsd).toBe(last.price);
    expect(resolvePrice(only, { ...q, t: last.t + 86401 }, short).nullReason).toBe('stale');
  });

  it('a placeholder is no valuation, and still the price the venue acts on', () => {
    const t = unix('2026-02-11T15:00:00Z');
    const metaObs = obsFx.filter((o) => o.mint === META);
    const market = (metaObs[0] as PriceObservation).market as string;
    const v = resolvePrice(ix, { mint: META, t, purpose: 'valuation' }, ctx);
    expect(v.priceUsd).toBeNull();
    expect(v.nullReason).toBe('oracle_not_live');
    const l = resolvePrice(
      ix,
      { mint: META, t, purpose: 'liquidation', priceSource: 'kamino_scope', market },
      ctx,
    );
    const placeholder = lastBefore(metaObs, t) as PriceObservation;
    expect(l.priceUsd).toBe(placeholder.price);
    expect(l.live).toBe(false);
    expect(l.marketMatched).toBe(true);
    const after = unix('2026-02-12T20:00:00Z');
    const live = resolvePrice(ix, { mint: META, t: after, purpose: 'valuation' }, ctx);
    expect(live.priceUsd).toBe((lastBefore(metaObs, after) as PriceObservation).price);
    expect(live.priceUsd).not.toBe(placeholder.price);
    expect(live.quality).toBe('oracle_open');
  });

  it('a price that failed the venue’s checks is passed over for a valuation and kept for a liquidation', () => {
    // Friday 14:00 ET: mark the latest Kamino observation as having failed klend's checks
    const t = unix('2026-09-25T18:00:00Z');
    const rows = spyKamino.filter((o) => o.t <= t).map((o) => ({ ...o }));
    const bad = lastBefore(rows, t) as PriceObservation;
    bad.failedChecks = ['heuristic', 'twap'];
    const good = lastBefore(
      rows.filter((o) => o !== bad),
      t,
    ) as PriceObservation;
    const only = buildPriceIndex(rows);
    const v = resolvePrice(only, { mint: SPY, t, purpose: 'valuation' }, ctx);
    expect(v.priceUsd).toBe(good.price);
    expect(v.obsT).toBe(good.t);
    const l = resolvePrice(
      only,
      { mint: SPY, t, purpose: 'liquidation', priceSource: 'kamino_scope' },
      ctx,
    );
    expect(l.obsT).toBe(bad.t);
    expect(l.failedChecks).toEqual(['heuristic', 'twap']);
    // a failed heuristic check alone does not disqualify: klend's fixed bounds lag the market
    const heuristic = buildPriceIndex(
      rows.map((o) => (o === bad ? { ...o, failedChecks: ['heuristic'] } : o)),
    );
    expect(resolvePrice(heuristic, { mint: SPY, t, purpose: 'valuation' }, ctx).obsT).toBe(bad.t);
    // when no observation passed, there is no valuation and the reason says so
    const allBad = buildPriceIndex(rows.map((o) => ({ ...o, failedChecks: ['twap'] })));
    const none = resolvePrice(allBad, { mint: SPY, t, purpose: 'valuation' }, ctx);
    expect(none.priceUsd).toBeNull();
    expect(none.nullReason).toBe('oracle_check_failed');
  });

  it('liquidation uses only the venue oracle, in its own quote; USDC converts at par, JupUSD has no price', () => {
    const a0 = usdcQuoted[0] as PriceObservation;
    const b0 = otherQuoted[0] as PriceObservation;
    const liq = (o: PriceObservation) =>
      resolvePrice(
        ix,
        {
          mint: SPY,
          t: o.t,
          purpose: 'liquidation',
          priceSource: 'jupiter_lend_oracle',
          market: o.market as string,
        },
        ctx,
      );
    const a = liq(a0);
    expect(a.priceSource).toBe('jupiter_lend_oracle');
    expect(a.price).toBe(a0.price);
    expect(a.quote).toBe(ctxFx.usdc);
    expect(a.priceUsd).toBe(a0.price);
    expect(a.marketMatched).toBe(true);
    const b = liq(b0);
    expect(b.price).toBe(b0.price);
    expect(b.quote).toBe(b0.quote);
    expect(b.priceUsd).toBeNull();
    expect(b.nullReason).toBe('no_quote_price');
    // the pool mid is listed beside it, never used, and cannot be asked for
    expect(a.others.some((c) => c.priceSource === 'pool_mid')).toBe(true);
    expect(() => resolvePrice(ix, { mint: SPY, t: sat, purpose: 'liquidation' }, ctx)).toThrow();
    expect(() =>
      resolvePrice(ix, { mint: SPY, t: sat, purpose: 'liquidation', priceSource: 'pool_mid' }, ctx),
    ).toThrow();
  });

  it('liquidation falls back to another market of the same oracle only when its own has nothing recent', () => {
    const markets = [...new Set(spyKamino.map((o) => o.market as string))];
    const t = unix('2026-09-25T18:00:00Z');
    // one market's observations cut off a day earlier, so its own latest is out of date at t
    const quiet = markets[0] as string;
    const rows = spyKamino.filter((o) => o.market !== quiet || o.t <= t - 86400);
    const only = buildPriceIndex(rows);
    const q = {
      mint: SPY,
      t,
      purpose: 'liquidation' as const,
      priceSource: 'kamino_scope' as const,
    };
    const r = resolvePrice(only, { ...q, market: quiet }, ctx);
    const freshest = lastBefore(
      rows.filter((o) => o.market !== quiet),
      t,
    ) as PriceObservation;
    expect(r.marketMatched).toBe(false);
    expect(r.priceUsd).toBe(freshest.price);
    // a market with a recent observation of its own uses it
    const own = resolvePrice(only, { ...q, market: freshest.market as string }, ctx);
    expect(own.marketMatched).toBe(true);
    expect(own.ref).toBe(freshest.ref);
    // nothing recent anywhere: no price, never an old one
    const none = resolvePrice(
      buildPriceIndex(spyKamino.filter((o) => o.t <= friClose)),
      { ...q, t: monOpen + 3600, market: quiet },
      ctx,
    );
    expect(none.priceUsd).toBeNull();
    expect(none.nullReason).toBe('stale');
  });

  it('a source quoting in two tokens: a recent observation first, then one with a USD price', () => {
    const only = buildPriceIndex(spyJl);
    // a JupUSD-quoted observation that comes after a USDC-quoted one on the same weekday session
    const other = otherQuoted.find((o) =>
      usdcQuoted.some((u) => u.t < o.t && o.t - u.t < params.maxOpenAgeSec),
    ) as PriceObservation;
    const r = resolvePrice(only, { mint: SPY, t: other.t, purpose: 'valuation' }, ctx);
    expect(r.priceSource).toBe('jupiter_lend_oracle');
    expect(r.quote).toBe(ctxFx.usdc);
    expect(r.priceUsd).toBe((lastBefore(usdcQuoted, other.t) as PriceObservation).price);
    // the USDC vault two days behind: the venue's recent price is the JupUSD one, and it has no USD value
    const lagging = buildPriceIndex([
      ...otherQuoted,
      ...usdcQuoted.filter((o) => o.t <= other.t - 2 * 86400),
    ]);
    const l = resolvePrice(
      lagging,
      { mint: SPY, t: other.t, purpose: 'liquidation', priceSource: 'jupiter_lend_oracle' },
      ctx,
    );
    expect(l.price).toBe(other.price);
    expect(l.quote).toBe(other.quote);
    const v = resolvePrice(lagging, { mint: SPY, t: other.t, purpose: 'valuation' }, ctx);
    expect(v.priceUsd).toBeNull();
    expect(v.nullReason).toBe('no_quote_price');
  });

  it('the reference price keeps the other sources beside the answer, in the stored shape', () => {
    const r = referencePrice(ix, ctx, SPY, sat);
    expect(r.priceUsd).toBe((lastBefore(spyPool, sat) as PriceObservation).price);
    expect(r.priceSource).toBe('pool_mid');
    expect(r.quality).toBe('traded');
    expect(r.others.map((o) => o.priceSource).sort()).toEqual([
      'jupiter_lend_oracle',
      'kamino_scope',
    ]);
    const k = r.others.find((o) => o.priceSource === 'kamino_scope');
    expect(k?.priceUsd).toBe((lastBefore(spyKamino, sat) as PriceObservation).price);
    expect(k && 'quote' in k).toBe(false);
    const hours = [...hourlyReferencePrices(ix, ctx, SPY, sat - 1, sat + 7200)];
    expect(hours.map((h) => h.t)).toEqual([sat, sat + 3600, sat + 7200]);
  });

  it('assets priced around the clock: USDC at par, USDG from its oracle on wall clock', () => {
    const usdc = resolvePrice(ix, { mint: ctxFx.usdc, t: sat, purpose: 'valuation' }, ctx);
    expect(usdc.priceUsd).toBe(1);
    expect(usdc.quality).toBe('par');
    const usdgObs = obsFx.filter((o) => o.mint === USDG);
    const g = resolvePrice(ix, { mint: USDG, t: sat, purpose: 'valuation' }, ctx);
    expect(g.priceUsd).toBe((lastBefore(usdgObs, sat) as PriceObservation).price);
    expect(g.quality).toBe('oracle_continuous');
    // past the stablecoin limit the price is not carried forward
    const end = Math.max(...usdgObs.map((o) => o.t));
    const limit = params.maxAgeSecByMint[USDG] as number;
    expect(
      resolvePrice(ix, { mint: USDG, t: end + limit, purpose: 'valuation' }, ctx).priceUsd,
    ).not.toBeNull();
    const gone = resolvePrice(ix, { mint: USDG, t: end + limit + 1, purpose: 'valuation' }, ctx);
    expect(gone.priceUsd).toBeNull();
    expect(gone.nullReason).toBe('stale');
  });

  it('the stablecoin limit is for its oracle: a pool mid is never good for longer than its own limit', () => {
    const usdgObs = obsFx.filter((o) => o.mint === USDG);
    const first = usdgObs[0] as PriceObservation;
    // a pool mid for USDG five hours before an oracle observation
    const pool: PriceObservation = {
      ...(spyPool[0] as PriceObservation),
      mint: USDG,
      t: first.t - 5 * 3600,
      price: first.price,
    };
    const r = resolvePrice(
      buildPriceIndex([pool, ...usdgObs]),
      { mint: USDG, t: first.t, purpose: 'valuation' },
      ctx,
    );
    expect(r.priceSource).toBe('kamino_scope');
    expect(r.others.find((c) => c.priceSource === 'pool_mid')?.stale).toBe(true);
  });

  it('an asset with no observation has no price', () => {
    const r = resolvePrice(ix, { mint: mintOf('TSLAx'), t: sat, purpose: 'valuation' }, ctx);
    expect(r.priceUsd).toBeNull();
    expect(r.nullReason).toBe('no_observation');
  });

  it('an external source plugs in as observations and one entry in the order (D19)', () => {
    // Friday 14:00 ET, US market hours: Kamino is moving, so only the order decides between it and the new source
    const t = unix('2026-09-25T18:00:00Z');
    const pool = lastBefore(spyPool, t) as PriceObservation;
    const external: PriceObservation = {
      ...pool,
      priceSource: 'external:test',
      ref: 'test-feed',
      method: 'test_adapter',
    };
    const q = { mint: SPY, t, purpose: 'valuation' as const };
    const withOrder = (valuationOrder: PriceContext['params']['valuationOrder']) => ({
      ...ctx,
      params: { ...params, valuationOrder },
    });
    const all = buildPriceIndex([...obsFx, external]);
    // ahead of the pool mid it answers, and the pool mid is kept beside it
    const first = resolvePrice(all, q, withOrder(['external:test', 'pool_mid', 'kamino_scope']));
    expect(first.priceSource).toBe('external:test');
    expect(first.quality).toBe('external');
    expect(first.others.find((c) => c.priceSource === 'pool_mid')?.gapToAnswer).toBe(0);
    // behind the pool mid it does not
    expect(
      resolvePrice(all, q, withOrder(['pool_mid', 'external:test', 'kamino_scope'])).priceSource,
    ).toBe('pool_mid');
    // with no pool mid, its place against the oracle is its place in the order
    const noPoolExt = buildPriceIndex([
      ...obsFx.filter((o) => o.priceSource !== 'pool_mid'),
      external,
    ]);
    expect(
      resolvePrice(noPoolExt, q, withOrder(['pool_mid', 'external:test', 'kamino_scope']))
        .priceSource,
    ).toBe('external:test');
    expect(
      resolvePrice(noPoolExt, q, withOrder(['pool_mid', 'kamino_scope', 'external:test']))
        .priceSource,
    ).toBe('kamino_scope');
    // not in the order: never used, still listed
    const unlisted = resolvePrice(noPoolExt, q, ctx);
    expect(unlisted.priceSource).toBe('kamino_scope');
    expect(unlisted.others.some((c) => c.priceSource === 'external:test')).toBe(true);
  });

  it('is independent of the order observations arrive in', () => {
    const q = { mint: SPY, t: sat, purpose: 'valuation' as const };
    const reversed = buildPriceIndex([...flagged()].reverse());
    expect(JSON.stringify(resolvePrice(reversed, q, ctx))).toBe(
      JSON.stringify(resolvePrice(ix, q, ctx)),
    );
  });
});

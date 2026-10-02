import { readdirSync, readFileSync } from 'node:fs';
import {
  buildPriceIndex,
  buildSessionClock,
  decodeLendingTx,
  defaultLivenessParams,
  defaultPriceParams,
  defaultRegimeParams,
  loggedOraclePrices,
  markLiveness,
  openSecondsBetween,
  type PriceContext,
  type PriceObservation,
  type RpcTx,
  resolvePrice,
} from '@colosseum/risk';
import { describe, expect, it } from 'vitest';

// Step 11 — the oracle standard, on frozen mainnet data (fixtures/risk/prices, written by
// scripts/risk/prices/freeze-fixtures.ts; transactions from fixtures/risk/lending/txs). Expected values never come
// from the code under test: logged prices are read off the transaction's own log lines, and resolved prices are
// found by scanning the frozen observations here.
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

describe('logged oracle prices (item 1)', () => {
  const DIR = 'fixtures/risk/lending/txs';
  const txs = readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')) as { name: string; tx: RpcTx });

  it('every klend price line of a registered reserve is returned once, with its reserve, mint and market', () => {
    let lines = 0;
    for (const { tx } of txs) {
      const d = loggedOraclePrices(tx, { kaminoReserves });
      expect(d.aligned).toBe(true);
      // the transaction's own log: "Token: <name> Price: <usd>", distinct
      const logged = new Set(
        (tx.meta?.logMessages ?? [])
          .map((l) => /^Program log: Token: (.+) Price: ([\d.]+)$/.exec(l))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => `${m[1]}|${Number(m[2])}`),
      );
      const got = d.prices.filter((p) => p.priceSource === 'kamino_scope');
      expect(new Set(got.map((p) => `${kaminoReserves.get(p.ref)?.symbol}|${p.price}`))).toEqual(
        logged,
      );
      expect(d.outside).toBe(0);
      expect(d.ambiguous).toBe(0);
      for (const p of got) {
        const r = kaminoReserves.get(p.ref);
        expect(p.mint).toBe(r?.mint);
        expect(p.market).toBe(r?.market);
        expect(p.quote).toBe('usd');
      }
      lines += logged.size;
    }
    expect(lines).toBeGreaterThan(10);
  });

  it('a Jupiter Lend return is the rate in the log, per whole token, in the vault debt token', () => {
    let seen = 0;
    for (const { tx } of txs) {
      const returns = (tx.meta?.logMessages ?? [])
        .filter((l) => l.startsWith('Program return: jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc '))
        .map((l) => Buffer.from(l.slice(l.lastIndexOf(' ') + 1), 'base64'));
      const got = loggedOraclePrices(tx, { kaminoReserves }).prices.filter(
        (p) => p.priceSource === 'jupiter_lend_oracle',
      );
      expect(got.length).toBe(new Set(returns.map((b) => b.toString('hex'))).size);
      for (const p of got) {
        // first u128 of the return data, little endian, over 1e15
        const b = returns[0] as Buffer;
        const rate = b.readBigUInt64LE(0) + (b.readBigUInt64LE(8) << 64n);
        expect(p.price).toBeCloseTo(Number(rate) / 1e15, 9);
        expect(p.quote).not.toBe('usd');
        expect(p.market).toBe(p.ref);
        seen++;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('the liquidation return equals the price the liquidation decoder used', () => {
    const fx = txs.find((t) => t.name === 'jl-liquidation') as { tx: RpcTx };
    const used = decodeLendingTx(fx.tx).events.find((e) => e.liquidation)?.liquidation;
    const got = loggedOraclePrices(fx.tx, { kaminoReserves }).prices[0];
    expect(got?.price).toBe(used?.collateralPrice);
    expect(got?.mint).toBe(used?.collateralMint);
    expect(got?.quote).toBe(used?.debtMint);
  });

  it('a failed transaction or a cut log gives no price', () => {
    const fx = txs.find((t) => t.name === 'kamino-borrow') as { tx: RpcTx };
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

  it('refuses a time outside its range', () => {
    expect(() =>
      openSecondsBetween(clock, unix('2025-01-01T00:00:00Z'), unix('2026-03-01T00:00:00Z')),
    ).toThrow();
  });
});

describe('liveness: a placeholder oracle price is not a valuation', () => {
  const meta = obsFx.filter((o) => o.mint === META && o.priceSource === 'kamino_scope');
  const L = markLiveness(meta, RP, defaultLivenessParams());

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
    const spy = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'kamino_scope');
    const s = markLiveness(spy, RP, defaultLivenessParams());
    expect(s.frozenDays).toEqual([]);
    const sat = spy.findIndex((o) => o.t >= unix('2026-09-26T04:00:00Z'));
    expect(s.live.slice(sat).every(Boolean)).toBe(true);
  });
});

describe('resolver (item 3)', () => {
  const ix = buildPriceIndex(flagged());
  const spyPool = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'pool_mid');
  const spyKamino = obsFx.filter((o) => o.mint === SPY && o.priceSource === 'kamino_scope');
  const sat = unix('2026-09-26T12:00:00Z');

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
    const only = buildPriceIndex(obsFx.filter((o) => o.priceSource !== 'pool_mid'));
    const closed = resolvePrice(only, { mint: SPY, t: sat, purpose: 'valuation' }, ctx);
    expect(closed.priceSource).toBe('kamino_scope');
    expect(closed.priceUsd).toBe((lastBefore(spyKamino, sat) as PriceObservation).price);
    expect(closed.quality).toBe('oracle_closed');
    const open = unix('2026-09-25T18:00:00Z');
    const r = resolvePrice(only, { mint: SPY, t: open, purpose: 'valuation' }, ctx);
    expect(r.quality).toBe('oracle_open');
    expect(r.regime).toBe('us_market_hours');
    expect(r.priceUsd).toBe((lastBefore(spyKamino, open) as PriceObservation).price);
  });

  it('a moving oracle goes before a held one: Jupiter Lend on a weekday night, Kamino in US market hours', () => {
    const only = buildPriceIndex(obsFx.filter((o) => o.priceSource !== 'pool_mid'));
    const jl = obsFx.filter(
      (o) => o.priceSource === 'jupiter_lend_oracle' && o.quote === ctxFx.usdc,
    );
    // Monday 2026-09-28 before the open (00:00Z–13:30Z is Sunday 20:00 ET to Monday 09:30 ET)
    const night = jl.find(
      (o) => o.t >= unix('2026-09-28T00:10:00Z') && o.t < unix('2026-09-28T13:00:00Z'),
    ) as PriceObservation;
    const r = resolvePrice(only, { mint: SPY, t: night.t, purpose: 'valuation' }, ctx);
    expect(r.regime).toBe('us_offhours_weekday');
    expect(r.priceSource).toBe('jupiter_lend_oracle');
    expect(r.priceUsd).toBe(night.price);
    expect(r.quality).toBe('oracle_open');
    const held = r.others.find((c) => c.priceSource === 'kamino_scope');
    expect(held?.sessionOpen).toBe(false);
    expect(held?.stale).toBe(false);
    // in US market hours both are moving and the order decides
    const day = jl.find(
      (o) => o.t >= unix('2026-09-25T14:00:00Z') && o.t < unix('2026-09-25T19:30:00Z'),
    ) as PriceObservation;
    const d = resolvePrice(only, { mint: SPY, t: day.t, purpose: 'valuation' }, ctx);
    expect(d.priceSource).toBe('kamino_scope');
    expect(d.others.find((c) => c.priceSource === 'jupiter_lend_oracle')?.sessionOpen).toBe(true);
  });

  it('a stock oracle is judged on market time: good across the weekend, stale two hours into Monday', () => {
    const close = unix('2026-09-25T20:00:00Z');
    const monOpen = unix('2026-09-28T13:30:00Z');
    const upToClose = spyKamino.filter((o) => o.t <= close);
    const last = lastBefore(upToClose, close) as PriceObservation;
    const only = buildPriceIndex(upToClose);
    const at = (t: number) => resolvePrice(only, { mint: SPY, t, purpose: 'valuation' }, ctx);
    const sun = at(unix('2026-09-27T12:00:00Z'));
    expect(sun.priceUsd).toBe(last.price);
    expect(sun.quality).toBe('oracle_closed');
    // usable while (close − observation) + (t − Monday's open) ≤ maxOpenAgeSec
    const room = params.maxOpenAgeSec - (close - last.t);
    expect(room).toBeGreaterThan(0);
    expect(at(monOpen + room).priceUsd).toBe(last.price);
    const late = at(monOpen + room + 300);
    expect(late.priceUsd).toBeNull();
    expect(late.nullReason).toBe('stale');
    // the stale observation is still listed, marked, with its age in market time
    expect(late.others[0]?.stale).toBe(true);
    expect(late.others[0]?.openAgeSec).toBe(params.maxOpenAgeSec + 300);
  });

  it('a placeholder is no valuation, and still the price the venue acts on', () => {
    const t = unix('2026-02-11T15:00:00Z');
    const market = (obsFx.find((o) => o.mint === META) as PriceObservation).market as string;
    const v = resolvePrice(ix, { mint: META, t, purpose: 'valuation' }, ctx);
    expect(v.priceUsd).toBeNull();
    expect(v.nullReason).toBe('oracle_not_live');
    const l = resolvePrice(
      ix,
      { mint: META, t, purpose: 'liquidation', priceSource: 'kamino_scope', market },
      ctx,
    );
    const placeholder = lastBefore(
      obsFx.filter((o) => o.mint === META),
      t,
    ) as PriceObservation;
    expect(l.priceUsd).toBe(placeholder.price);
    expect(l.live).toBe(false);
    expect(l.marketMatched).toBe(true);
    const after = unix('2026-02-12T20:00:00Z');
    const live = resolvePrice(ix, { mint: META, t: after, purpose: 'valuation' }, ctx);
    expect(live.priceUsd).toBe(
      (
        lastBefore(
          obsFx.filter((o) => o.mint === META),
          after,
        ) as PriceObservation
      ).price,
    );
    expect(live.priceUsd).not.toBe(placeholder.price);
    expect(live.quality).toBe('oracle_open');
  });

  it('liquidation uses only the venue oracle, in its own quote; USDC converts at par, JupUSD has no price', () => {
    const jl = obsFx.filter((o) => o.priceSource === 'jupiter_lend_oracle');
    const usdcVault = jl.find((o) => o.quote === ctxFx.usdc) as PriceObservation;
    const otherVault = jl.find((o) => o.quote !== ctxFx.usdc) as PriceObservation;
    const a = resolvePrice(
      ix,
      {
        mint: SPY,
        t: usdcVault.t,
        purpose: 'liquidation',
        priceSource: 'jupiter_lend_oracle',
        market: usdcVault.market as string,
      },
      ctx,
    );
    expect(a.priceSource).toBe('jupiter_lend_oracle');
    expect(a.price).toBe(usdcVault.price);
    expect(a.quote).toBe(ctxFx.usdc);
    expect(a.priceUsd).toBe(usdcVault.price);
    expect(a.marketMatched).toBe(true);
    const b = resolvePrice(
      ix,
      {
        mint: SPY,
        t: otherVault.t,
        purpose: 'liquidation',
        priceSource: 'jupiter_lend_oracle',
        market: otherVault.market as string,
      },
      ctx,
    );
    expect(b.price).toBe(otherVault.price);
    expect(b.quote).toBe(otherVault.quote);
    expect(b.priceUsd).toBeNull();
    expect(b.nullReason).toBe('no_quote_price');
    // the pool mid is listed beside it, never used
    expect(a.others.some((c) => c.priceSource === 'pool_mid')).toBe(true);
    expect(() => resolvePrice(ix, { mint: SPY, t: sat, purpose: 'liquidation' }, ctx)).toThrow();
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

  it('an asset with no observation has no price', () => {
    const r = resolvePrice(ix, { mint: mintOf('TSLAx'), t: sat, purpose: 'valuation' }, ctx);
    expect(r.priceUsd).toBeNull();
    expect(r.nullReason).toBe('no_observation');
  });

  it('an external source plugs in as observations and one entry in the order (D19)', () => {
    const pool = lastBefore(spyPool, sat) as PriceObservation;
    const external: PriceObservation = {
      ...pool,
      priceSource: 'external:test',
      ref: 'test-feed',
      method: 'test_adapter',
    };
    const withExternal = buildPriceIndex([...obsFx, external]);
    const order = {
      ...params,
      valuationOrder: ['pool_mid', 'external:test', 'kamino_scope'] as const,
    };
    const first = resolvePrice(
      withExternal,
      { mint: SPY, t: sat, purpose: 'valuation' },
      { ...ctx, params: { ...order, valuationOrder: ['external:test', 'pool_mid'] } },
    );
    expect(first.priceSource).toBe('external:test');
    expect(first.quality).toBe('external');
    expect(first.others.find((c) => c.priceSource === 'pool_mid')?.gapToAnswer).toBe(0);
    // behind the pool mid it fills in where the pool has nothing: an hour after the pool history ends
    const noPool = buildPriceIndex([
      ...obsFx.filter((o) => o.priceSource !== 'pool_mid'),
      external,
    ]);
    const second = resolvePrice(
      noPool,
      { mint: SPY, t: sat, purpose: 'valuation' },
      { ...ctx, params: { ...order, valuationOrder: [...order.valuationOrder] } },
    );
    expect(second.priceSource).toBe('external:test');
  });

  it('is deterministic and independent of the order observations arrive in', () => {
    const q = { mint: SPY, t: sat, purpose: 'valuation' as const };
    const reversed = buildPriceIndex([...flagged()].reverse());
    expect(JSON.stringify(resolvePrice(reversed, q, ctx))).toBe(
      JSON.stringify(resolvePrice(ix, q, ctx)),
    );
    expect(JSON.stringify(resolvePrice(ix, q, ctx))).toBe(JSON.stringify(resolvePrice(ix, q, ctx)));
  });
});

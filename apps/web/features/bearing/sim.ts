import type { Res } from './data';
import { type Fact, mk, none } from './fact';
import { num, pct, type Regime, RW, reasonW, usd } from './format';
import { etParts, nextOpen, wait } from './time';
import type { Exit, RecovBody, SheetBody } from './types';

// The simulation page (analytics2.js, simRun): the ways to sell a position now, each priced from the
// API's fitted cost at its exact size, and the best of the measured ones. Issuer redemption rests on
// the issuer's published terms, a scenario input: it is shown, labelled an assumption, and never
// chosen over a measured route.

export type PathKey = 'now' | 'open' | 'split' | 'issuer';
export type SimPath = {
  key: PathKey;
  name: string;
  how: string;
  when: string;
  total: Fact;
  loss: Fact;
  ex: Exit | null;
  waits?: boolean;
  assumption?: boolean;
  capF?: Fact;
};

/** How many hourly sales within the capacity a sale needs; 0 when one sale fits or it would take over two days. */
export function chunksFor(n: number, cap: Fact): number {
  const split = cap.value && cap.value > 0 && n > cap.value ? Math.ceil(n / cap.value) : 0;
  return split > 48 ? 0 : split;
}

const costIn = (sheet: SheetBody, r: string) =>
  sheet.costs.find((x) => x.regime === r)?.exit ?? null;

export function simPaths(o: {
  id: string;
  n: number;
  at: Date;
  r: Regime;
  sheet: SheetBody;
  chunks: number;
  chunkSheet: Res<SheetBody> | null;
  recov: Res<RecovBody>;
}) {
  const { id, n, at, r, sheet, chunks } = o;
  const miss = none('no_samples_in_regime');
  const paths: SimPath[] = [];
  const now = costIn(sheet, r);
  paths.push({
    key: 'now',
    name: 'Sell now across the pools',
    how: 'one routed sale, split across the asset’s dollar pools',
    when: `now · ${RW[r]}`,
    total: now ? now.total : miss,
    loss: now ? now.lossUsd : miss,
    ex: now,
  });
  if (r !== 'us_market_hours') {
    const mh = costIn(sheet, 'us_market_hours');
    const op = nextOpen(at);
    paths.push({
      key: 'open',
      name: 'Wait for market hours',
      how: 'the same routed sale at the next US open; the price can move while you wait',
      when: op
        ? `in ${wait(op.getTime() - at.getTime())} · ${etParts(op).label}`
        : 'next open not found',
      total: mh ? mh.total : miss,
      loss: mh ? mh.lossUsd : miss,
      ex: mh,
      waits: true,
    });
  }
  if (chunks && o.chunkSheet?.ok) {
    const ce = costIn(o.chunkSheet.body, r);
    const dr = (sheet.liquidityStability.depthRecovery ?? []).find((x) => x.regime === r);
    const h90 = dr?.hoursTo90?.value ?? null;
    const per = n / chunks;
    const lossS: Fact =
      ce && ce.lossUsd.value != null
        ? mk(ce.lossUsd.value * chunks, {
            quality: ce.lossUsd.quality,
            source: ce.lossUsd.source,
            fetchedAt: ce.lossUsd.fetchedAt,
            regime: r,
            sizeUsd: per,
            method: `${chunks} × the loss of one sale of ${usd(per)} (exit.lossUsd at that size), assuming the pools refill between sales`,
            methodVersion: ce.lossUsd.methodVersion,
            provenance: ce.lossUsd.provenance,
          })
        : miss;
    paths.push({
      key: 'split',
      name: `Split into ${chunks} hourly sales`,
      how: `${chunks} sales of ${usd(per)}, each within the 1% capacity, one an hour; it assumes the pools refill between sales${
        h90 != null
          ? ` (after large trades they recovered 90% of depth in a median ${num(h90 * 60, 0)} min)`
          : ''
      }`,
      when: `over ${chunks} h · ${RW[r]}`,
      total: ce ? ce.total : miss,
      loss: lossS,
      ex: ce,
      waits: true,
    });
  }
  const pr = o.recov.ok ? o.recov.body.primary : null;
  if (pr && o.recov.ok)
    paths.push({
      key: 'issuer',
      name: 'Redeem with the issuer',
      how: `${pr.issuer || 'the issuer'}: ${String(pr.status || 'status not given').replace(/_/g, ' ')}; ${
        pr.settlementHours != null
          ? `settles in ${num(pr.settlementHours / 24, 0)} days`
          : 'settlement time not given'
      }; needs KYC with the issuer`,
      when: pr.openHoursInHorizon
        ? `${pr.openHoursInHorizon} open hours in the next 7 days`
        : 'no open window in the next 7 days',
      total: none('not_applicable'),
      loss: none('not_applicable'),
      ex: null,
      assumption: true,
      capF: mk(pr.capacityUsd, {
        quality: 'assumption',
        source: pr.source,
        fetchedAt: o.recov.body.at,
        method:
          'issuer model: redemption capacity in the open hours of the next 7 days (GET /risk/recoverable)',
        methodVersion: o.recov.body.methodVersion,
      }),
    });
  const measured = paths.filter((p) => !p.assumption && p.loss.value != null);
  const best =
    measured
      .slice()
      .sort(
        (x, y) =>
          (x.loss.value as number) - (y.loss.value as number) ||
          (x.waits ? 1 : 0) - (y.waits ? 1 : 0),
      )[0] ?? null;
  const first = paths[0] as SimPath;
  const verdict = !best
    ? `No measured route prices ${usd(n)} of ${id} right now: ${reasonW(first.total.reason)}. The simulation never extends a curve past what was measured.`
    : `Best path for ${usd(n)} of ${id} now: ${best.name.toLowerCase()}. It loses ${
        best.loss.quality === 'lower_bound' ? 'at least ' : ''
      }${usd(best.loss.value as number)} (${pct((best.loss.value as number) / n)})${
        best.key === 'now'
          ? '.'
          : first.loss.value != null
            ? `, against ${usd(first.loss.value)} selling all of it now.`
            : '.'
      }${best.waits ? ' Waiting carries price risk this loss does not count.' : ''}`;
  return { paths, best, verdict };
}

/** "250k", "$1,000,000", "2.5m": an amount in dollars, or null when it is not one. */
export function parseAmount(raw: string): number | null {
  const s = String(raw)
    .trim()
    .replace(/[$,\s]/g, '');
  const mult = /k$/i.test(s) ? 1e3 : /m$/i.test(s) ? 1e6 : 1;
  const v = Number.parseFloat(s.replace(/[km]$/i, '')) * mult;
  return v >= 100 && v <= 1e9 ? Math.round(v) : null;
}

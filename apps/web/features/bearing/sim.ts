import { type Dictionary, dictionary } from '../../i18n';
import type { Res } from './data';
import { type Fact, mk, none } from './fact';
import { EN_FMT, type Fmt, type Regime, usd } from './format';
import { etLabel, nextOpen, wait } from './time';
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
  /** The page's words, in the person's language. English when not given. */
  words?: Dictionary['bearing'];
  /** The figures in the person's locale; en-US when not given. */
  fmt?: Fmt;
}) {
  const { id, n, at, r, sheet, chunks } = o;
  const b = o.words ?? dictionary('en').bearing;
  const fm = o.fmt ?? EN_FMT;
  const w = b.sim.paths;
  const rw = b.regimes[r];
  const miss = none('no_samples_in_regime');
  const paths: SimPath[] = [];
  const now = costIn(sheet, r);
  paths.push({
    key: 'now',
    name: w.now.name,
    how: w.now.how,
    when: w.now.when(rw),
    total: now ? now.total : miss,
    loss: now ? now.lossUsd : miss,
    ex: now,
  });
  if (r !== 'us_market_hours') {
    const mh = costIn(sheet, 'us_market_hours');
    const op = nextOpen(at);
    paths.push({
      key: 'open',
      name: w.open.name,
      how: w.open.how,
      when: op
        ? w.open.when(
            wait(op.getTime() - at.getTime(), b.sim.wait, (v) => fm.num(v, 1)),
            etLabel(op, b.heat.days),
          )
        : w.open.notFound,
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
      name: w.split.name(chunks),
      how: w.split.how(chunks, fm.usd(per), h90 != null ? fm.num(h90 * 60, 0) : null),
      when: w.split.when(chunks, rw),
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
      name: w.issuer.name,
      how: w.issuer.how(
        pr.issuer || w.issuer.theIssuer,
        pr.status ? String(pr.status).replace(/_/g, ' ') : w.issuer.noStatus,
        pr.settlementHours != null
          ? w.issuer.settles(fm.num(pr.settlementHours / 24, 0))
          : w.issuer.noSettle,
      ),
      when: pr.openHoursInHorizon ? w.issuer.when(pr.openHoursInHorizon) : w.issuer.never,
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
  const v = b.sim.verdict;
  const verdict = !best
    ? v.none(
        fm.usd(n),
        id,
        b.reasons[(first.total.reason ?? 'not_served') as keyof typeof b.reasons] ??
          String(first.total.reason),
      )
    : `${v.best(
        fm.usd(n),
        id,
        best.name.toLowerCase(),
        best.loss.quality === 'lower_bound',
        fm.usd(best.loss.value as number),
        fm.pct((best.loss.value as number) / n),
      )}${best.key === 'now' || first.loss.value == null ? v.end : v.against(fm.usd(first.loss.value))}${
        best.waits ? v.waits : ''
      }`;
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

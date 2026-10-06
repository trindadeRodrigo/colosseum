import { DISCLAIMER_SHORT } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { MockPlate } from '../../components/ui/MockPlate';
import { PinGlyph, ProvenancePin } from '../../components/ui/ProvenancePin';
import { dictionary, type Lang, LOCALE } from '../../i18n';
import { PlanDrawing } from './PlanDrawing';
import { GrowthChart, TripChart } from './ShowcaseChart';
import { GROWTH, SAMPLE, type SampleLeg, TICKERS, TRIP } from './sample';

// "Same pieces. Different people. Different fit." (goal-showcase-case.md): two sample people, each
// with the goal in their own words under their plan drawn as a joint, and the plan cut for it beside them: the limits
// as chips, four figures, the chart, the parts and the exit plan. Everything in a case is MOCK, and
// says so with the plate in its head and the hatched pin on every figure that stands on a rate. The
// full disclaimer sits once under the section.

const whole = (lang: Lang, usd: number) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(usd);

const monthYear = (lang: Lang, ym: string) =>
  new Intl.DateTimeFormat(LOCALE[lang], {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${ym}-01T00:00:00Z`));

/** The swatch of a part: the plan-leg colour of its place (STYLE.md, plan leg). */
const SWATCH = { 1: 'bg-leg-1', 2: 'bg-leg-2', 3: 'bg-leg-3', 4: 'bg-leg-4' } as const;

type Kpi = { label: string; value: ReactNode; unit?: string };

function Kpis({ items }: { items: Kpi[] }) {
  return (
    <dl className="grid grid-cols-2 rounded-md border border-border min-[620px]:grid-cols-4">
      {items.map((kpi, i) => (
        <div
          key={kpi.label}
          className={[
            '@container min-w-0 px-3 py-2.5',
            // hairlines between the cells: four in a row, or two by two on a phone
            i % 2 === 0
              ? 'border-r border-border'
              : 'min-[620px]:border-r min-[620px]:border-border',
            i === 3 ? 'border-r-0 min-[620px]:border-r-0' : '',
            i < 2 ? 'max-[619px]:border-b max-[619px]:border-border' : '',
          ].join(' ')}
        >
          <dt className="font-mono text-[11px]/4 text-muted-foreground">{kpi.label}</dt>
          {/* A figure with its pin and MOCK plate is one unbreakable line (ProvenancePin). In a cell
              narrower than 12rem (all four, at every width this page has today) the plate goes
              under the figure; the figure and its pin stay together. */}
          <dd className="mt-0.5 text-[1.125rem]/7 font-medium tabular-nums @max-[12rem]:[&_[data-ui=figure]_[data-ui=mock-plate]]:ml-0 @max-[12rem]:[&_[data-ui=figure]_[data-ui=mock-plate]]:flex @max-[12rem]:[&_[data-ui=figure]_[data-ui=mock-plate]]:w-fit">
            {kpi.value}
            {kpi.unit && (
              <small className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">
                {kpi.unit}
              </small>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Legs({
  legs,
  names,
  label,
}: {
  legs: readonly SampleLeg[];
  names: { name: string; why: string }[];
  label: string;
}) {
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-1.5"
    >
      {legs.map((leg, i) => {
        const name = names[i];
        if (!name) return null;
        return (
          <li
            key={leg.chart}
            className="grid grid-cols-[10px_1fr_auto] items-baseline gap-x-2 text-[13px]/5"
          >
            <span aria-hidden="true" className={`size-2.5 translate-y-px ${SWATCH[leg.chart]}`} />
            <span>{name.name}</span>
            <span className="font-mono text-[12px] font-medium tabular-nums">
              {leg.weightBps / 100}%
            </span>
            <span className="col-start-2 col-end-4 -mt-0.5 text-[12px]/4 text-muted-foreground">
              {name.why}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Case({
  lang,
  words,
  chips,
  kpis,
  chart,
  legs,
  names,
  exit,
  exitNote,
  foot,
}: {
  lang: Lang;
  words: { label: string; alt: string; who: string; quote: string; title: string; sub: string };
  chips: readonly string[];
  kpis: Kpi[];
  chart: ReactNode;
  legs: readonly SampleLeg[];
  names: { name: string; why: string }[];
  exit: string;
  exitNote: string;
  foot?: string;
}) {
  const t = dictionary(lang).landing.show;
  const mockAnnounce = dictionary(lang).shell.mockAnnounce;
  return (
    <article
      aria-label={words.label}
      data-ui="showcase-case"
      className="grid overflow-hidden rounded-md border border-border bg-card min-[980px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
    >
      <div className="flex flex-col border-border max-[979px]:border-b min-[980px]:border-r">
        {/* The plan as a joint: its parts are the legend's, read from the same case data. */}
        <PlanDrawing
          parts={legs.map((leg, i) => ({ leg, name: names[i]?.name ?? '' }))}
          label={words.alt}
          className="aspect-[6/5] w-full min-[980px]:aspect-auto min-[980px]:min-h-[300px] min-[980px]:flex-1"
        />
        {/* The goal in the person's own words, on a solid plate under the drawing, never on it. */}
        <div className="flex flex-col gap-2 px-5 pt-3 pb-5">
          <p className="font-mono text-[12px] text-primary">{words.who}</p>
          <blockquote className="m-0 font-display text-[clamp(1.15rem,1rem+0.6vw,1.45rem)]/[1.35] font-normal">
            “{words.quote}”
          </blockquote>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4 px-6 pt-5.5 pb-4.5">
        <div data-ui="case-head" className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[1.125rem]/[1.3] font-medium">{words.title}</h3>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{words.sub}</p>
          </div>
          <MockPlate labels={{ announce: mockAnnounce }} />
        </div>
        <ul aria-label={t.chips} className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li
              key={chip}
              className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[12px]"
            >
              {chip}
            </li>
          ))}
        </ul>
        <Kpis items={kpis} />
        {chart}
        <Legs legs={legs} names={names} label={t.legs} />
        <p className="border-l-2 border-primary py-0.5 pl-2.5 text-[13px]/5">
          {t.exitPlan}: {exit} <span className="text-muted-foreground">{exitNote}</span>
        </p>
        <div className="flex flex-wrap justify-between gap-3 border-t border-border pt-2.5 font-mono text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {t.sample} <PinGlyph state="mock" />
          </span>
          <span>{foot ? `${foot} ${DISCLAIMER_SHORT}` : DISCLAIMER_SHORT}</span>
        </div>
      </div>
    </article>
  );
}

export function Showcase({ lang }: { lang: Lang }) {
  const d = dictionary(lang);
  const t = d.landing.show;
  const money = (usd: number) => whole(lang, usd);
  const pin = (usd: number) => <ProvenancePin value={money(usd)} obs={SAMPLE} labels={d.pin} />;
  const chartLabels = { table: t.chartTable, month: t.month, balance: t.balance };
  return (
    <section
      id="showcase"
      aria-label={t.label}
      className="relative z-[2] scroll-mt-22 bg-background pt-[clamp(72px,10vw,140px)] pb-10"
    >
      <div className="mx-auto w-full max-w-page px-[clamp(16px,4vw,56px)]">
        <div className="mb-12 max-w-[720px]">
          <p className="font-mono text-[12px] font-medium tracking-[0.06em] text-primary">
            {t.eyebrow}
          </p>
          <h2 className="mt-2.5 mb-3 font-display [text-wrap:wrap] text-[clamp(2rem,1.4rem+2vw,3.2rem)]/[1.15] font-normal tracking-[-0.01em]">
            {t.title}
          </h2>
          <p className="max-w-[56ch] text-muted-foreground">{t.lead}</p>
        </div>
        <div className="flex flex-col gap-8">
          <Case
            lang={lang}
            words={{ ...t.trip, who: t.trip.who(TICKERS.cash) }}
            chips={t.trip.chips}
            kpis={[
              { label: t.trip.kpis.save, value: pin(TRIP.saveUsd), unit: t.perMonth },
              { label: t.trip.kpis.for, value: t.trip.months(TRIP.months) },
              { label: t.trip.kpis.earned, value: pin(TRIP.earnedUsd), unit: t.sampleUnit },
              { label: t.trip.kpis.odds, value: `${TRIP.oddsPct}%`, unit: t.estimate },
            ]}
            chart={
              <TripChart
                lang={lang}
                labels={{ ...chartLabels, chart: t.trip.chart }}
                payout={t.trip.payout}
                parts={t.trip.legs.map((leg) => leg.name(TICKERS.cash))}
              />
            }
            legs={TRIP.legs}
            names={t.trip.legs.map((leg) => ({ name: leg.name(TICKERS.cash), why: leg.why }))}
            exit={t.trip.exit}
            exitNote={t.trip.exitNote}
          />
          <Case
            lang={lang}
            words={t.growth}
            chips={t.growth.chips}
            kpis={[
              { label: t.growth.kpis.add, value: money(GROWTH.addUsd), unit: t.perMonth },
              {
                label: t.growth.kpis.base,
                value: pin(GROWTH.baseUsd),
                unit: monthYear(lang, GROWTH.baseWhen),
              },
              { label: t.growth.kpis.odds, value: `${GROWTH.oddsPct}%`, unit: t.estimate },
              {
                label: t.growth.kpis.drop,
                value: `−${GROWTH.dropPct}%`,
                unit: t.growth.maxUnit,
              },
            ]}
            chart={
              <GrowthChart
                lang={lang}
                labels={{ ...chartLabels, chart: t.growth.chart }}
                goal={t.growth.goalLine}
                weak={t.growth.weak}
              />
            }
            legs={GROWTH.legs}
            names={t.growth.legs.map((leg) => ({ name: leg.name(TICKERS.stocks), why: leg.why }))}
            exit={t.growth.exit}
            exitNote={t.growth.exitNote}
            foot={t.growth.oddsNote}
          />
        </div>
        <Disclaimer lang={lang} label={d.shell.disclaimer} className="mt-10" />
      </div>
    </section>
  );
}

'use client';
import type { PersonWithdrawal, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { Hint } from '../../components/ui/Hint';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { SkeletonChart } from '../../components/ui/Skeleton';
import { Status } from '../../components/ui/StatusMark';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { dollars } from '../portfolio/figures';
import { readPersonWithdrawals } from '../portfolio/server-withdrawals';
import {
  type HistoryAnswer,
  type Plan,
  type PlansAnswer,
  type PlansChain,
  readHistory,
} from './api';
import { OverviewChart } from './OverviewChart';
import {
  chainsOf,
  DEFAULT_PERIOD,
  type Flow,
  flowsOf,
  PERIODS,
  type PeriodId,
  periodOf,
  periodQuery,
  provenanceOf,
  shareOf,
  stacks,
  totalLine,
  type VaultPeriod,
  vaultPeriods,
} from './overview-series';
import { type Reading, usePortfolioSection, useSectionRead } from './PortfolioProvider';
import { ChainsOut, ReadAgain, Say, SectionGate, sampleLine, useChainName } from './parts';
import { addDecimals, putInPin, snapshotPin, sumPin } from './pins';
import { sameVault } from './plan-blocks';
import { sayStatus } from './status';
import { vaultTitle } from './vault-title';
import { useWords } from './words';

// The overview (/portfolio), as a board: on the left what the person's vaults are worth together, how
// many there are, what went into them and what they made or lost, all time and over the chosen
// period; on the right the chart of that value over the period, as a line (green above what was put
// in, red below) or as daily stacks by vault or by asset. Under it, one row a vault, which opens the
// vault's own page, where its chat and its plan are (VaultScreen).
//
// The figures are added from the answers (overview-series.ts) and nothing is estimated. Figures of two
// kinds are never added: the sums hold the most live kind the person has, and the page says what it
// leaves out. A vault that was never read is a row with no value, never a zero. Nothing here signs.

type Mode = 'line' | 'byVault' | 'byAsset';
const UP = 'text-success';
const DOWN = 'text-destructive';

export function OverviewPage() {
  const w = useWords();
  const { plans } = usePortfolioSection();
  return (
    <div data-ui="portfolio-overview" className="flex flex-col gap-8">
      <h1 className={`${PAGE_TITLE} sr-only`}>{w.overview.title}</h1>
      <SectionGate read={plans}>{(answer) => <Board answer={answer} />}</SectionGate>
    </div>
  );
}

/** The vault's own page: its chat beside its plan. */
export const vaultHref = (chain: string, address: string) =>
  `/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;

/** What went into a vault, all time: its deposits less its withdrawals. */
const netOf = (flows: readonly Flow[], chain: string, address: string): number =>
  flows
    .filter((flow) => flow.chain === chain && sameVault(flow.address, address))
    .reduce((sum, flow) => sum + flow.usd, 0);

function signed(lang: Lang, usd: number): string {
  const figure = new Intl.NumberFormat(LOCALE[lang], {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(usd));
  return `${usd >= 0 ? '+' : '−'}${figure}`;
}

function percent(lang: Lang, share: number | null): string | null {
  if (share === null) return null;
  return `${share >= 0 ? '+' : '−'}${new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(share))}`;
}

function Board({ answer }: { answer: PlansAnswer }) {
  const w = useWords();
  const [period, setPeriod] = useState<PeriodId>(DEFAULT_PERIOD);
  const [mode, setMode] = useState<Mode>('line');

  const withdrawals = useSectionRead<PersonWithdrawal[]>('overview:withdrawals', async (api) => ({
    kind: 'read',
    answer: await readPersonWithdrawals(api),
  }));
  const taken = withdrawals.reading.kind === 'read' ? withdrawals.reading.answer : [];
  const { flows, unvalued } = flowsOf(answer, taken);
  const provenance = provenanceOf(answer);
  const chains = chainsOf(answer, provenance);
  const first = flows.length > 0 ? Math.min(...flows.map((flow) => flow.at)) : null;

  // The line's window carries the board's figures whatever the chart shows; the bars ask their own.
  const lineAsked = periodQuery(period, 'line', Date.now(), first);
  const line = useSectionRead<HistoryAnswer>(
    lineAsked && chains.size > 0 ? `overview:history:line:${period}` : null,
    async (api) => (lineAsked ? readHistory(api, lineAsked) : { kind: 'refused' as const }),
  );
  const barsAsked = periodQuery(period, 'bars', Date.now(), first);
  const bars = useSectionRead<HistoryAnswer>(
    barsAsked && chains.size > 0 && mode !== 'line' ? `overview:history:bars:${period}` : null,
    async (api) => (barsAsked ? readHistory(api, barsAsked) : { kind: 'refused' as const }),
  );
  const periods: VaultPeriod[] =
    line.reading.kind === 'read' ? vaultPeriods(line.reading.answer, flows, chains) : [];
  const count = answer.chains.reduce((n, entry) => n + entry.plans.length, 0);
  const periodWord = w.overview.board.chart.periods[period];

  if (count === 0)
    return (
      <>
        <ChainsOut unavailable={answer.unavailable} />
        {answer.unavailable.length === 0 && (
          <Say
            sentence={w.shell.empty}
            action={
              <Link href="/goal" className="text-body-sm underline">
                {w.shell.startGoal}
              </Link>
            }
          />
        )}
      </>
    );

  const words = w.overview.board.chart;
  return (
    <>
      <ChainsOut unavailable={answer.unavailable} />
      {/* No hatch down the edge here (Rodrigo, Oct 8): a board that is not live says so in words,
          in the plate at its top, and every figure on it keeps its hatched pin. */}
      <section
        aria-label={w.overview.board.total}
        data-ui="overview-board"
        data-provenance={provenance ?? undefined}
        className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
      >
        <div className="grid min-w-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,9fr)]">
          <Figures
            answer={answer}
            chains={chains}
            provenance={provenance}
            flows={flows}
            unvalued={unvalued}
            periods={periods}
            periodWord={periodWord}
            reading={line.reading.kind === 'reading' || line.reading.kind === 'idle'}
          />
          <div className="flex min-w-0 flex-col gap-4 border-t border-border p-5 lg:border-t-0 lg:border-l">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Modes
                label={words.label}
                value={mode}
                onChange={setMode}
                options={[
                  { id: 'line', label: words.line, icon: <LineIcon /> },
                  { id: 'byVault', label: words.byVault, icon: <BarsIcon /> },
                  { id: 'byAsset', label: words.byAsset, icon: <LayersIcon /> },
                ]}
              />
              <PeriodSelect
                label={words.period}
                value={period}
                onChange={setPeriod}
                options={PERIODS.map((p) => ({ id: p.id, label: words.periods[p.id] }))}
              />
            </div>
            <Chart
              reading={mode === 'line' ? line.reading : bars.reading}
              mode={mode}
              answer={answer}
              flows={flows}
              chains={chains}
            />
          </div>
        </div>
      </section>
      <Vaults
        answer={answer}
        flows={flows}
        periods={periods}
        periodWord={periodWord}
        chains={chains}
      />
    </>
  );
}

const ICON = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
const LineIcon = () => (
  <svg aria-hidden="true" {...ICON}>
    <path d="M2 2v12h12" />
    <path d="M4.5 10.5 7.5 7l2 2 4-4.5" />
  </svg>
);
const BarsIcon = () => (
  <svg aria-hidden="true" {...ICON}>
    <path d="M2 14h12" />
    <path d="M4 11.5V7M8 11.5V3.5M12 11.5V8.5" />
  </svg>
);
const LayersIcon = () => (
  <svg aria-hidden="true" {...ICON}>
    <path d="M8 2.5 14 5.5 8 8.5 2 5.5Z" />
    <path d="M2 8.5 8 11.5 14 8.5" />
    <path d="M2 11.5 8 14.5 14 11.5" />
  </svg>
);
const ClockIcon = () => (
  <svg aria-hidden="true" {...ICON}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </svg>
);
const ChevronIcon = () => (
  <svg aria-hidden="true" {...ICON}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);
const VaultIcon = () => (
  <svg aria-hidden="true" {...ICON} width={18} height={18}>
    <rect x="2" y="3" width="12" height="10" />
    <circle cx="8" cy="8" r="2" />
    <path d="M8 6V5M8 11v-1M10 8h1M5 8h1" />
  </svg>
);

const RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/**
 * What the chart shows: the one chosen is a pill with its icon and its word, the others a circle with
 * their icon alone, named for a screen reader and on hover.
 */
function Modes({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: Mode;
  onChange: (mode: Mode) => void;
  options: { id: Mode; label: string; icon: ReactNode }[];
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons
    <div role="group" aria-label={label} data-ui="chart-modes" className="flex items-center gap-2">
      {options.map((o) => {
        const on = o.id === value;
        const button = (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            aria-label={o.label}
            onClick={() => onChange(o.id)}
            className={cn(
              'inline-flex h-9 cursor-pointer items-center justify-center rounded-full text-body-sm font-medium transition-colors',
              on
                ? 'gap-2 bg-honey-tint px-4 text-foreground'
                : 'w-9 border border-border text-muted-foreground hover:border-input hover:text-foreground',
              RING,
            )}
          >
            {o.icon}
            {on && <span aria-hidden="true">{o.label}</span>}
          </button>
        );
        // The chosen mode shows its word; the others are an icon, whose word is one hover or focus away.
        return on ? (
          button
        ) : (
          <Hint key={o.id} tip={o.label}>
            {button}
          </Hint>
        );
      })}
    </div>
  );
}

/** The period, as a rounded drop-down: the browser's own list, so it works by keyboard and touch. */
function PeriodSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: PeriodId;
  onChange: (period: PeriodId) => void;
  options: { id: PeriodId; label: string }[];
}) {
  return (
    <label className="relative inline-flex h-9 items-center gap-2 rounded-full border border-border pr-2 pl-3 text-body-sm font-medium text-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring hover:border-input">
      <ClockIcon />
      <span className="sr-only">{label}</span>
      <select
        data-ui="period"
        value={value}
        onChange={(event) => onChange(periodOf(event.target.value)?.id ?? DEFAULT_PERIOD)}
        className="cursor-pointer appearance-none bg-transparent pr-6 outline-none"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-3 text-muted-foreground">
        <ChevronIcon />
      </span>
    </label>
  );
}

/** A figure of the board, with its label over it. */
function Figure({ label, children, ui }: { label: string; children: ReactNode; ui: string }) {
  return (
    <div data-ui={ui} className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="m-0 text-body font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * What the vaults of the kind the sums hold are worth together, how many there are, what went into
 * them and the difference, each with its stamp: the board and the vaults' card say the same figures.
 */
function useSums(answer: PlansAnswer, chains: Set<string>, flows: readonly Flow[]) {
  const w = useWords();
  const nameOf = useChainName();
  const words = w.overview.board;
  const counted = answer.chains.filter((entry) => chains.has(entry.chain));
  const read = counted.flatMap((entry) =>
    entry.plans.flatMap((plan) =>
      plan.newest
        ? [
            {
              entry,
              plan,
              valueUsd: plan.newest.valueUsd,
              obs: snapshotPin(plan.newest, entry.provenance, plan.provenance),
            },
          ]
        : [],
    ),
  );
  const vaults = counted.reduce((n, entry) => n + entry.plans.length, 0);
  const total = read.length
    ? {
        usd: addDecimals(read.map((part) => part.valueUsd)),
        obs: sumPin(
          read.map((part) => part.obs),
          w.overview.chain.method(read.length, counted.map((e) => nameOf(e.chain)).join(', ')),
        ),
      }
    : null;
  // What went into the vaults that were read: deposits less withdrawals, all time.
  const netIn = read.reduce(
    (sum, part) => sum + netOf(flows, part.entry.chain, part.plan.address),
    0,
  );
  const netObs: PinSource | null = total ? { ...total.obs, method: words.netInMethod } : null;
  const allTime = total ? Number(total.usd) - netIn : null;
  return { counted, vaults, total, netIn, netObs, allTime };
}

/** The value, the count, what went in and what was made, all time and over the period. */
function Figures({
  answer,
  chains,
  provenance,
  flows,
  unvalued,
  periods,
  periodWord,
  reading,
}: {
  answer: PlansAnswer;
  chains: Set<string>;
  provenance: Provenance | null;
  flows: readonly Flow[];
  unvalued: number;
  periods: readonly VaultPeriod[];
  periodWord: string;
  reading: boolean;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const words = w.overview.board;
  const { counted, vaults, total, netIn, netObs, allTime } = useSums(answer, chains, flows);
  const pnl = periods.reduce((sum, v) => sum + v.pnlUsd, 0);
  const share = shareOf(
    pnl,
    periods.reduce((sum, v) => sum + v.baseUsd, 0),
  );
  const gaining = periods.filter((v) => v.pnlUsd >= 0).length;
  const best = [...periods].sort((a, b) => b.pnlUsd - a.pnlUsd)[0];
  const bestPlan = best
    ? counted
        .find((entry) => entry.chain === best.chain)
        ?.plans.find((plan) => sameVault(plan.address, best.address))
    : undefined;
  const bestName = bestPlan
    ? vaultTitle(bestPlan, { t, words: w.overview.card, lang, chainName: nameOf(bestPlan.chain) })
        .sentence
    : null;
  // Kinds of figure the sums leave out, each said once.
  const others = [
    ...new Set(
      answer.chains
        .filter((entry) => entry.plans.length > 0 && entry.provenance !== provenance)
        .map((entry) => entry.provenance),
    ),
  ];

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-body-sm text-muted-foreground">{words.total}</p>
            {provenance && provenance !== 'live' && (
              // the board's figures are not live: said in words, as the hatch band would have
              <span
                data-ui="board-plate"
                className="rounded-full border border-primary/60 bg-honey-tint px-2.5 py-0.5 text-caption font-medium text-foreground"
              >
                {sampleLine(t.shell, provenance)}
              </span>
            )}
          </div>
          <p
            data-ui="board-total"
            className="font-display text-[2rem]/10 font-semibold tracking-[-0.02em] tabular-nums"
          >
            {total ? (
              <ProvenancePin value={dollars(lang, total.usd)} obs={total.obs} labels={t.pin} />
            ) : (
              w.overview.table.neverRead
            )}
          </p>
        </div>
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-4">
          <Figure ui="board-vaults" label={words.vaults}>
            {vaults}
          </Figure>
          <Figure ui="board-net-in" label={words.netIn}>
            {netObs ? (
              <ProvenancePin value={dollars(lang, netIn.toFixed(2))} obs={netObs} labels={t.pin} />
            ) : (
              '—'
            )}
          </Figure>
          <Figure ui="board-all-time" label={words.allTime}>
            {allTime === null ? (
              '—'
            ) : (
              <ProvenancePin
                value={signed(lang, allTime)}
                obs={total ? { ...total.obs, method: words.allTimeMethod } : null}
                labels={t.pin}
                className={allTime >= 0 ? UP : DOWN}
              />
            )}
          </Figure>
        </dl>
        {others.map((kind) => (
          <p key={kind} className="text-caption text-muted-foreground">
            {words.leftOut(words.kinds[kind])}
          </p>
        ))}
        {unvalued > 0 && (
          <p className="text-caption text-muted-foreground">{words.unvalued(unvalued)}</p>
        )}
      </div>
      <div className="flex flex-col gap-4 border-t border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-body-sm text-muted-foreground">{words.pnl}</p>
          <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-caption">
            {periodWord}
          </span>
        </div>
        {periods.length === 0 ? (
          <p data-ui="board-pnl-none" className="text-body-sm text-muted-foreground">
            {reading ? words.chart.reading : words.noPnl}
          </p>
        ) : (
          <>
            <p data-ui="board-pnl" className="flex flex-wrap items-baseline gap-3">
              <ProvenancePin
                value={signed(lang, pnl)}
                obs={total ? { ...total.obs, method: words.periodMethod } : null}
                labels={t.pin}
                className={cn(
                  'font-display text-[1.75rem]/9 font-semibold tracking-[-0.02em] tabular-nums',
                  pnl >= 0 ? UP : DOWN,
                )}
              />
              {percent(lang, share) && (
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-body-sm tabular-nums',
                    pnl >= 0 ? 'bg-leaf-tint text-success' : 'bg-madder-tint text-destructive',
                  )}
                >
                  {percent(lang, share)}
                </span>
              )}
            </p>
            <dl className="m-0 grid grid-cols-2 gap-4">
              <Figure ui="board-gaining" label={words.gaining}>
                {gaining} / {periods.length}
              </Figure>
              {best && bestName && (
                <Figure ui="board-best" label={words.best}>
                  <Hint
                    tip={bestName}
                    className="flex min-w-0"
                    // 24px tall: a target on a line of its own (WCAG 2.5.8)
                    triggerClassName="min-h-6 truncate text-body-sm font-normal"
                  >
                    {bestName}
                  </Hint>
                  <ProvenancePin
                    value={signed(lang, best.pnlUsd)}
                    obs={total ? { ...total.obs, method: words.periodMethod } : null}
                    labels={t.pin}
                    className={best.pnlUsd >= 0 ? UP : DOWN}
                  />
                </Figure>
              )}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

function Chart({
  reading,
  mode,
  answer,
  flows,
  chains,
}: {
  reading: Reading<HistoryAnswer>;
  mode: Mode;
  answer: PlansAnswer;
  flows: readonly Flow[];
  chains: Set<string>;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOfChain = useChainName();
  if (reading.kind === 'idle' || reading.kind === 'reading')
    return (
      <div role="status" aria-label={w.overview.board.chart.reading}>
        <SkeletonChart />
      </div>
    );
  if (reading.kind !== 'read')
    return <Say sentence={w.shell.failure.unreachable} action={<ReadAgain />} />;
  const history = reading.answer;
  // The chart's figures stand on the snapshots of the vaults it adds up.
  const counted = history.chains.filter((entry) => chains.has(entry.chain));
  const obs = (at: number): PinSource => ({
    source:
      [...new Set(counted.flatMap((entry) => entry.vaults.map((series) => series.source)))].join(
        ' + ',
      ) || 'snapshots',
    fetchedAt: new Date(at).toISOString(),
    method: w.overview.board.chartMethod,
    provenance: counted[0]?.provenance ?? 'mock',
  });
  if (mode === 'line') {
    const points = totalLine(history, flows, chains);
    if (points.length === 0) return <Say sentence={w.overview.board.chart.empty} />;
    return (
      <OverviewChart kind="line" line={points} obs={obs} from={history.from} to={history.to} />
    );
  }
  const by = mode === 'byAsset' ? 'asset' : 'vault';
  const rows = stacks(history, by, chains);
  if (rows.length === 0) return <Say sentence={w.overview.board.chart.empty} />;
  const plans = answer.chains.flatMap((entry) => entry.plans);
  const nameOf = (key: string): string => {
    if (by === 'asset')
      return key === 'cash' ? w.overview.board.chart.cash : displayName(key, t.plan);
    const [chain, ...rest] = key.split(':');
    const address = rest.join(':');
    const plan = plans.find((p) => p.chain === chain && sameVault(p.address, address));
    return plan
      ? vaultTitle(plan, { t, words: w.overview.card, lang, chainName: nameOfChain(plan.chain) })
          .sentence
      : `${address.slice(0, 4)}…${address.slice(-4)}`;
  };
  return (
    <OverviewChart
      kind="bars"
      stacks={rows}
      nameOf={nameOf}
      obs={obs}
      from={history.from}
      to={history.to}
    />
  );
}

/** One row a vault: what it is, its chain, value, what went in, what it made, where it stands. */
function Vaults({
  answer,
  flows,
  periods,
  periodWord,
  chains,
}: {
  answer: PlansAnswer;
  flows: readonly Flow[];
  periods: readonly VaultPeriod[];
  periodWord: string;
  chains: Set<string>;
}) {
  const w = useWords();
  const words = w.overview.table;
  const rows = answer.chains.flatMap((entry) => entry.plans.map((plan) => ({ entry, plan })));
  const t = useT();
  const lang = useLang();
  const board = w.overview.board;
  const { vaults, total, netIn, netObs, allTime } = useSums(answer, chains, flows);
  const head = 'px-5 py-3 font-medium';
  const stat = 'flex items-baseline gap-2 text-body-sm';
  return (
    <section
      aria-labelledby="overview-vaults"
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
    >
      {/* The card's head, as a portfolio board has it: what it lists and its figures in one line. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-5 py-4">
        <h2
          id="overview-vaults"
          className="flex items-center gap-2.5 text-body-lg font-semibold whitespace-nowrap"
        >
          <span className="inline-flex size-8 items-center justify-center rounded-lg bg-honey-tint text-foreground">
            <VaultIcon />
          </span>
          {words.heading}
        </h2>
        {allTime !== null && total && (
          <p data-ui="vaults-pnl" className={stat}>
            <span className="text-muted-foreground">{board.allTime}</span>
            <ProvenancePin
              value={signed(lang, allTime)}
              obs={{ ...total.obs, method: board.allTimeMethod }}
              labels={t.pin}
              className={cn('font-medium', allTime >= 0 ? UP : DOWN)}
            />
          </p>
        )}
        {netObs && (
          <p data-ui="vaults-net-in" className={stat}>
            <span className="text-muted-foreground">{board.netIn}</span>
            <ProvenancePin
              value={dollars(lang, netIn.toFixed(2))}
              obs={netObs}
              labels={t.pin}
              className="font-medium"
            />
          </p>
        )}
        <p data-ui="vaults-count" className={stat}>
          <span className="text-muted-foreground">{board.vaults}</span>
          <span className="font-medium">{vaults}</span>
        </p>
        <div className="ml-auto flex items-center gap-2">
          <ReadAgain className="h-9 rounded-full px-4" />
          {/* Honey, so the way to a new plan stands out on the page: a honey edge on its tint, ink text (IDENTITY-2). */}
          <Link
            data-ui="new-plan"
            href="/goal"
            className="inline-flex h-9 items-center justify-center rounded-full border border-primary bg-honey-tint px-4 text-body-sm font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {words.newPlan}
          </Link>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table
          data-ui="overview-vaults"
          className="w-full min-w-[760px] border-collapse text-body-sm"
        >
          <thead className="text-left text-caption text-muted-foreground">
            <tr>
              <th scope="col" className={head}>
                {words.vault}
              </th>
              <th scope="col" className={head}>
                {words.chain}
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                {words.value}
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                {words.netIn}
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                {words.allTime}
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                {words.period(periodWord)}
              </th>
              <th scope="col" className={head}>
                {words.status}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, plan }) => (
              <VaultRow
                key={`${entry.chain}:${plan.address}`}
                entry={entry}
                plan={plan}
                netIn={
                  plan.putIn ||
                  flows.some((f) => f.chain === entry.chain && sameVault(f.address, plan.address))
                    ? netOf(flows, entry.chain, plan.address)
                    : null
                }
                period={
                  chains.has(entry.chain)
                    ? periods.find(
                        (v) => v.chain === entry.chain && sameVault(v.address, plan.address),
                      )
                    : undefined
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VaultRow({
  entry,
  plan,
  netIn,
  period,
}: {
  entry: PlansChain;
  plan: Plan;
  netIn: number | null;
  period: VaultPeriod | undefined;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const words = w.overview.table;
  const title = vaultTitle(plan, {
    t,
    words: w.overview.card,
    lang,
    chainName: nameOf(plan.chain),
  });
  const said = sayStatus(plan.status, lang, w.status, (asset) => displayName(asset, t.plan));
  const { newest } = plan;
  const allTime = newest && netIn !== null ? Number(newest.valueUsd) - netIn : null;
  const share = period ? shareOf(period.pnlUsd, period.baseUsd) : null;
  const cell = 'px-5 py-4';
  // A pinned cell sits over the row's link, so its pin opens rather than the vault.
  const pinned = 'relative z-10 text-right tabular-nums';
  const valuePin = newest ? snapshotPin(newest, entry.provenance, plan.provenance) : null;
  const netPin: PinSource | null = plan.putIn
    ? {
        ...putInPin(plan.putIn, entry.provenance, plan.provenance),
        method: w.overview.board.netInMethod,
      }
    : null;
  const allTimePin =
    valuePin && netPin ? sumPin([valuePin, netPin], w.overview.board.allTimeMethod) : null;
  return (
    <tr
      data-ui="overview-vault"
      data-chain={entry.chain}
      data-address={plan.address}
      className="relative border-t border-border focus-within:bg-muted/60 hover:bg-muted/60"
    >
      <td className={cn(cell, 'max-w-[22rem]')}>
        {/* The whole row opens the vault: the link's box covers it. */}
        <Link
          href={vaultHref(entry.chain, plan.address)}
          data-ui="vault-sentence"
          aria-label={words.open(title.sentence)}
          className="font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {title.sentence}
        </Link>
        {title.notes.map((note) => (
          <span key={note} data-ui="plan-note" className="block text-caption text-muted-foreground">
            {note}
          </span>
        ))}
      </td>
      <td className={cell}>
        <ChainBadge chain={entry.chain} />
      </td>
      <td className={cn(cell, pinned)}>
        {newest ? (
          <ProvenancePin
            value={dollars(lang, newest.valueUsd)}
            obs={snapshotPin(newest, entry.provenance, plan.provenance)}
            labels={t.pin}
          />
        ) : (
          <span className="text-muted-foreground">{words.neverRead}</span>
        )}
      </td>
      <td data-ui="vault-net-in" className={cn(cell, pinned)}>
        {netIn === null || !netPin ? (
          '—'
        ) : (
          <ProvenancePin value={dollars(lang, netIn.toFixed(2))} obs={netPin} labels={t.pin} />
        )}
      </td>
      <td data-ui="vault-all-time" className={cn(cell, pinned)}>
        {allTime === null || !allTimePin ? (
          '—'
        ) : (
          <ProvenancePin
            value={signed(lang, allTime)}
            obs={allTimePin}
            labels={t.pin}
            className={allTime >= 0 ? UP : DOWN}
          />
        )}
      </td>
      <td data-ui="vault-period" className={cn(cell, pinned)}>
        {period && valuePin ? (
          <>
            <ProvenancePin
              value={signed(lang, period.pnlUsd)}
              obs={{ ...valuePin, method: w.overview.board.periodMethod }}
              labels={t.pin}
              className={period.pnlUsd >= 0 ? UP : DOWN}
            />
            {percent(lang, share) && (
              <span className={cn('block text-caption', period.pnlUsd >= 0 ? UP : DOWN)}>
                {percent(lang, share)}
              </span>
            )}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className={cell}>
        {said.kind ? (
          <Status status={said.kind} className="whitespace-nowrap">
            {said.word}
          </Status>
        ) : (
          <span className="text-caption text-muted-foreground">{said.word}</span>
        )}
      </td>
    </tr>
  );
}

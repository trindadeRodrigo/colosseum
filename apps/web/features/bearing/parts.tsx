'use client';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Wait } from '../../components/shell/Wait';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Skeleton, SkeletonChart, SkeletonRows } from '../../components/ui/Skeleton';
import { type BearingDictionary, bearingDictionary } from '../../i18n/bearing';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useBearing } from './BearingProvider';
import type { BearingChain } from './chain';
import { cleanSource, type Fact, factDetail, partial, pinSource } from './fact';
import { EN_FMT, type Fmt, fmtFor, iso, reasonW } from './format';

// The pieces every Bearing page is built from (Rodrigo's Analytics 2.0): a figure with its pin, the
// reason in place of a missing one, the row of counters, the asset and pool filters, the pie of value
// by pool, and the source line under a chart. Counts and the person's own input carry no pin: they
// are not yields, prices or FX figures (class a2-count in the prototype).

/** Why a figure is missing, in words. */
/** The page's words, in the person's language. */
export function useWords(): BearingDictionary {
  return bearingDictionary(useLang());
}

/** The page's figures and dates in the reader's language: as Rodrigo wrote them in English. */
export function useFmt(): Fmt {
  const lang = useLang();
  return lang === 'en' ? EN_FMT : fmtFor(lang);
}

/**
 * A reason code in the person's language; one the dictionary does not know, as the API wrote it. It
 * names no chain: the page's switch says which chain is read (gate CHAIN-EVERYWHERE, as amended).
 */
export function useReason() {
  const t = useWords();
  return (code?: string | null) =>
    t.reasons[(code ?? 'not_served') as keyof typeof t.reasons] ?? reasonW(code);
}

/** A page Bearing does not measure on the chain the person reads: said, with nothing in its place. */
export function NotOnChain() {
  const { chain } = useBearing();
  const t = useWords();
  return (
    <p
      role="status"
      data-ui="bearing-not-on-chain"
      className="mt-6 max-w-[72ch] border border-l-2 border-border border-l-primary px-3 py-2"
    >
      {t.chain.pageNotCollected(CHAIN_NAMES[chain])}
    </p>
  );
}

export function Reason({ code, detail }: { code?: string | null; detail?: string }) {
  const say = useReason();
  return (
    <span
      data-ui="bearing-reason"
      title={detail}
      className="font-sans text-caption font-normal whitespace-nowrap text-muted-foreground"
    >
      {say(code)}
    </span>
  );
}

/** A figure with its provenance pin; "≥" before a lower bound, "assumption" after an assumption. */
export function Fig({
  f,
  fmt,
  className,
  chain: own,
}: {
  f: Fact | null | undefined;
  fmt: (v: number) => string;
  className?: string;
  /** The chain the figure is of, where it is not the page's (the chains side by side). */
  chain?: BearingChain;
}) {
  const { clock, chain: page } = useBearing();
  const chain = own ?? page;
  const all = useT();
  const words = useWords();
  if (!f) return <Reason code="not_served" />;
  if (f.value == null) return <Reason code={f.reason} detail={f.detail} />;
  if (!f.source && !f.method) return <Reason code="not_served" />;
  const shown = `${f.quality === 'lower_bound' ? '≥ ' : ''}${fmt(f.value)}`;
  return (
    <span
      data-ui="bearing-fig"
      data-chain={chain}
      className={cn(
        'inline-flex max-w-full flex-wrap items-baseline gap-x-1 whitespace-normal [&_.tf-figure]:whitespace-nowrap [&_[data-ui=figure]]:max-w-full [&_[data-ui=figure]]:whitespace-normal [&_[data-ui=stale-tag]]:inline-block',
        className,
      )}
    >
      <ProvenancePin
        value={shown}
        obs={pinSource(f, clock)}
        detail={[CHAIN_NAMES[chain], factDetail(f)].filter(Boolean).join(' · ')}
        labels={all.pin}
        className="font-mono font-medium"
      />
      {partial(f) && (
        <span
          data-ui="bearing-partial"
          className="font-sans text-caption font-normal whitespace-normal text-muted-foreground"
        >
          {words.partial(f.measured)}
        </span>
      )}
      {f.quality === 'assumption' && (
        <span className="font-sans text-caption font-normal whitespace-normal text-muted-foreground">
          {words.flow.assumption}
        </span>
      )}
    </span>
  );
}

/** A count or the person's own input: no pin, by design. */
export const Count = ({ children }: { children: ReactNode }) => (
  <span data-ui="bearing-count" className="font-mono font-medium">
    {children}
  </span>
);

/**
 * The row of counters under the filters, hairlines between them. A counter is never narrower than its
 * figure and its stale tag. Cell sizing comes from the same responsive basis before and after the
 * data arrives, with room for wrapping qualifiers and notes; the last cells wrap to another row.
 */
export function Kpis({ children }: { children: ReactNode }) {
  return (
    <div data-ui="bearing-kpis" className="flex flex-wrap gap-px border border-border bg-border">
      {children}
    </div>
  );
}

export function Kpi({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div data-ui="bearing-kpi" className="min-w-0 flex-[1_1_15rem] bg-card px-4 py-3">
      <div className="min-h-5 w-0 min-w-full font-condensed text-caption font-medium text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 min-h-14 font-mono text-[1.3125rem]/7 font-medium whitespace-normal max-[480px]:text-[1.125rem] [&_[data-ui=bearing-reason]]:block [&_[data-ui=bearing-reason]]:font-sans [&_[data-ui=bearing-reason]]:whitespace-normal">
        {children}
      </div>
      <div
        aria-hidden={note == null || note === '' ? true : undefined}
        className="mt-0.5 min-h-12 w-0 min-w-full text-b-meta text-muted-foreground"
      >
        {note ?? '\u00a0'}
      </div>
    </div>
  );
}

export type Option = { id: string; label: string; sub?: string };

/** A multi-select as a disclosure with checkboxes; null means all. It stays open while it is used. */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly Option[];
  value: readonly string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLButtonElement>(null);
  const pop = useId();
  const t = useWords().filter;
  const n = value ? value.length : options.length;
  const said =
    value == null
      ? t.all(options.length)
      : n === 0
        ? t.none
        : n === 1
          ? (options.find((o) => o.id === value[0])?.label ?? value[0])
          : t.some(n, options.length);
  const picked = (id: string) => !value || value.includes(id);
  const apply = (ids: string[]) => onChange(ids.length === options.length ? null : ids);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={root} data-ui="bearing-multi" className="relative">
      <button
        ref={summary}
        type="button"
        aria-expanded={open}
        aria-controls={pop}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-muted px-2.5 py-1 text-[0.8125rem]"
      >
        <span className="text-muted-foreground">{label}</span>{' '}
        <b className="font-semibold">{said}</b>
        <span
          aria-hidden="true"
          className={cn(
            'ml-1 inline-block size-1.5 border-r-[1.5px] border-b-[1.5px] border-current',
            open ? '-mb-1 rotate-[-135deg]' : '-mt-1 rotate-45',
          )}
        />
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: a group of checkboxes under its button, as a disclosure
        <div
          id={pop}
          role="group"
          aria-label={label}
          className="absolute top-[calc(100%+4px)] left-0 z-30 grid max-h-80 w-max max-w-[min(420px,calc(100vw-32px))] min-w-60 gap-0.5 overflow-auto border border-border bg-card p-2"
        >
          <div className="mb-1 flex gap-1.5 border-b border-border pb-1.5">
            <button
              type="button"
              onClick={() => apply(options.map((o) => o.id))}
              className={SMALL_BTN}
            >
              {t.selectAll}
            </button>
            <button type="button" onClick={() => apply([])} className={SMALL_BTN}>
              {t.selectNone}
            </button>
          </div>
          {options.map((o) => (
            <label
              key={o.id}
              className="grid min-h-7 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-1.5 py-0.5 text-[0.8125rem] hover:bg-muted"
            >
              <input
                type="checkbox"
                value={o.id}
                checked={picked(o.id)}
                onChange={(e) => {
                  const now = options
                    .map((x) => x.id)
                    .filter((id) => (id === o.id ? e.target.checked : picked(id)));
                  apply(now);
                }}
                className="m-0 size-4 accent-primary"
              />
              <span>{o.label}</span>
              {o.sub && (
                <span className="font-mono text-b-meta text-muted-foreground">{o.sub}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export const SMALL_BTN =
  'min-h-7 cursor-pointer rounded-md border border-input px-2.5 py-1 text-[0.8125rem] font-medium hover:border-primary hover:text-honey-text';

/** The line under a chart: where its headline figure came from, when, with the pin. */
/** A chart's pin from its source fact, for the figures its readout names; none for no fact. */
export function useChartPin(): (f: Fact | null | undefined) => {
  pin?: ReturnType<typeof pinSource>;
  pinLabels?: ReturnType<typeof useT>['pin'];
} {
  const { clock } = useBearing();
  const all = useT();
  return (f) => (f && f.value != null ? { pin: pinSource(f, clock), pinLabels: all.pin } : {});
}

export function SrcLine({ f, what }: { f: Fact | null | undefined; what: string }) {
  const { clock } = useBearing();
  const all = useT();
  const words = useWords();
  if (!f || f.value == null) return null;
  return (
    <p
      data-ui="bearing-src"
      className="mt-1.5 max-w-[88ch] font-mono text-b-meta text-muted-foreground"
    >
      {cleanSource(f.source ?? '')} · {iso(f.fetchedAt)}{' '}
      <ProvenancePin
        value={words.chart.sourceOf(what)}
        obs={pinSource(f, clock)}
        detail={factDetail(f)}
        labels={all.pin}
        className="font-sans [&_.tf-figure]:sr-only"
      />
    </p>
  );
}

/** A chart card with no chart: its title and why. */
export function EmptyChart({
  title,
  children,
  tools,
}: {
  title: string;
  children: ReactNode;
  tools?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <div className="font-condensed text-caption font-medium text-muted-foreground">{title}</div>
        <div className="max-w-[72ch] text-caption text-foreground">{children}</div>
      </div>
      {tools}
    </div>
  );
}

export function Card({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div
      id={id}
      data-ui="bearing-card"
      className={cn('min-w-0 border border-border bg-card px-4 pt-4 pb-3', className)}
    >
      {children}
    </div>
  );
}

/** A part of a page waiting for its data: the frame of the chart or table to come, and what it waits for. */
export function Loading({ children }: { children: string }) {
  const { retry } = useBearing();
  return <Wait label={children} onRetry={retry} skeleton={<SkeletonChart />} />;
}

/**
 * A page waiting for its data, in the page's own boxes: its filters, its row of figures with their
 * labels (already known, so they are written), the two chart cards and the table. Nothing moves when
 * the data comes: the boxes are where the page puts its own.
 */
export function PageWait({
  label,
  kpis,
  filters = 2,
}: {
  label: string;
  /**
   * The page's figures, in order: each label, and its note as the page will write it (the words are
   * known before the data; a count or a time in them is a stand-in). The note is laid out unseen
   * under its bar, so it wraps where the real one will and the row keeps its height. It names no
   * time read from a clock: the server and the browser would write different words.
   */
  kpis: readonly { label: string; note?: string }[];
  /** How many selectors the page has above its figures. */
  filters?: number;
}) {
  const { retry } = useBearing();
  return (
    <Wait
      label={label}
      onRetry={retry}
      className="mt-6"
      skeleton={
        <div data-ui="bearing-skeleton">
          <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            {Array.from({ length: filters }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: still boxes with no identity of their own
              <Skeleton key={i} className="h-8 w-36" />
            ))}
            <Skeleton className="h-3 w-48" />
          </div>
          <Kpis>
            {kpis.map(({ label, note }, i) => (
              <Kpi
                // biome-ignore lint/suspicious/noArrayIndexKey: the figures to come, in the page's order
                key={i}
                label={label}
                note={
                  note ? (
                    <span aria-hidden="true" className="relative block">
                      <span className="invisible">{note}</span>
                      <Skeleton className="absolute inset-x-0 top-1 h-2.5 w-3/4" />
                    </span>
                  ) : undefined
                }
              >
                <Skeleton className="inline-block h-5 w-28 align-middle" />
              </Kpi>
            ))}
          </Kpis>
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)] items-stretch gap-4 min-[1100px]:grid-cols-[minmax(260px,1fr)_minmax(0,2.6fr)]">
            <Card>
              <SkeletonChart />
            </Card>
            <Card>
              <SkeletonChart />
            </Card>
          </div>
          <div className="mt-8">
            <SkeletonRows rows={5} columns={5} />
          </div>
        </div>
      }
    />
  );
}

const SLICE = [
  'var(--tf-bearing-p1)',
  'var(--tf-bearing-p2)',
  'var(--tf-bearing-p3)',
  'var(--tf-bearing-p4)',
];
const OTHER = 'var(--tf-bearing-po)';

/** Donut of value by pool: the four largest and the rest as one slice, 2px gaps, a legend with shares. */
export function Pie({
  title,
  slices: given,
  total,
  totalHtml,
  note,
}: {
  title: string;
  /** A pool with no figure has a null value: it is not drawn, and the pie says how many are not. */
  slices: ReadonlyArray<{ label: string; value: number | null }>;
  /** Null when the total itself has no figure: the shares are then of the pools drawn. */
  total: number | null;
  totalHtml: ReactNode;
  note?: string;
}) {
  const fm = useFmt();
  const [on, setOn] = useState<number | null>(null);
  const t = useWords().pie;
  const slices = given
    .filter((s): s is { label: string; value: number } => s.value != null && s.value > 0)
    .sort((a, b) => b.value - a.value);
  const unmeasured = given.filter((s) => s.value == null).length;
  /** What a share is of: the total where there is one, else the pools drawn. */
  const whole = total && total > 0 ? total : slices.reduce((s, x) => s + x.value, 0);
  const top: Array<{ label: string; value: number; other?: boolean }> = slices.slice(0, 4);
  const rest = slices.slice(4);
  if (rest.length)
    top.push({
      label: t.others(rest.length),
      value: rest.reduce((s, x) => s + x.value, 0),
      other: true,
    });
  const R = 64;
  const r = 40;
  const c = 72;
  const pt = (rad: number, a: number) =>
    `${(c + rad * Math.cos(a)).toFixed(2)},${(c + rad * Math.sin(a)).toFixed(2)}`;
  let a0 = -Math.PI / 2;
  const paths = top.map((s, i) => {
    const sw = (s.value / (whole || 1)) * Math.PI * 2;
    const a1 = a0 + sw;
    const big = sw > Math.PI ? 1 : 0;
    const color = s.other ? OTHER : (SLICE[i] as string);
    const d = `M${pt(R, a0)} A${R},${R} 0 ${big} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${big} 0 ${pt(r, a0)} Z`;
    const full = sw >= Math.PI * 2 - 1e-6;
    a0 = a1;
    return { s, i, color, d, full };
  });
  const share = (v: number) => fm.pct(v / whole);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
    <div data-ui="bearing-pie" onMouseLeave={() => setOn(null)}>
      <div className="mb-2">
        <div className="font-condensed text-caption font-medium text-muted-foreground">{title}</div>
        <div className="mt-0.5 font-display text-b-kpi font-semibold tabular-nums">{totalHtml}</div>
        {note && top.length > 0 && <div className="text-caption text-muted-foreground">{note}</div>}
      </div>
      {
        top.length ? (
          <div className="mt-2 grid justify-items-start gap-3 max-[1100px]:min-[481px]:grid-cols-[144px_minmax(0,1fr)] max-[1100px]:min-[481px]:items-start">
            <svg
              width={144}
              height={144}
              viewBox="0 0 144 144"
              role="img"
              aria-label={`${title}: ${top.map((s) => `${s.label} ${share(s.value)}`).join(', ')}`}
              className="block"
            >
              {paths.map(({ s, i, color, d, full }) =>
                full ? (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
                  <circle
                    key={s.label}
                    cx={c}
                    cy={c}
                    r={(R + r) / 2}
                    fill="none"
                    stroke={color}
                    strokeWidth={R - r}
                    opacity={on != null && on !== i ? 0.35 : 1}
                    onMouseEnter={() => setOn(i)}
                  >
                    <title>{`${s.label} · ${fm.usd1(s.value)} · ${share(s.value)}`}</title>
                  </circle>
                ) : (
                  // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
                  <path
                    key={s.label}
                    d={d}
                    fill={color}
                    stroke={on === i ? 'var(--foreground)' : 'var(--card)'}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    opacity={on != null && on !== i ? 0.35 : 1}
                    onMouseEnter={() => setOn(i)}
                  >
                    <title>{`${s.label} · ${fm.usd1(s.value)} · ${share(s.value)}`}</title>
                  </path>
                ),
              )}
              <text
                x={72}
                y={70}
                textAnchor="middle"
                className="fill-foreground font-mono text-[13px] font-medium"
              >
                {on != null && top[on] ? fm.usd1(top[on].value) : ''}
              </text>
              <text
                x={72}
                y={86}
                textAnchor="middle"
                className="fill-muted-foreground font-mono text-[11px]"
              >
                {on != null && top[on] ? share(top[on].value) : ''}
              </text>
            </svg>
            <ul className="m-0 grid w-full list-none gap-1 p-0">
              {paths.map(({ s, i, color }) => (
                <li
                  key={s.label}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a row of the legend can be focused to read its slice
                  tabIndex={0}
                  onMouseEnter={() => setOn(i)}
                  onFocus={() => setOn(i)}
                  onBlur={() => setOn(null)}
                  className={cn(
                    'grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-2 px-0.5 py-px text-caption',
                    on === i && 'bg-muted',
                  )}
                >
                  <i
                    aria-hidden="true"
                    className="block size-2.5 self-center"
                    style={{ background: color }}
                  />
                  <span className="[overflow-wrap:anywhere]">{s.label}</span>
                  <span className="font-mono">{share(s.value)}</span>
                </li>
              ))}
            </ul>
            {unmeasured > 0 && (
              <p
                data-ui="bearing-pie-missing"
                className="text-caption text-muted-foreground max-[1100px]:col-span-full"
              >
                {t.missing(unmeasured)}
              </p>
            )}
            <p className="font-mono text-b-meta text-muted-foreground max-[1100px]:col-span-full">
              {t.point}
            </p>
          </div>
        ) : total != null && total > 0 ? (
          <p className="py-6 text-muted-foreground">
            <Reason code="not_collected" />
          </p>
        ) : null /* no total either: its place above already says why, once */
      }
    </div>
  );
}

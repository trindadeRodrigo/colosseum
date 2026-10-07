'use client';
import type { AssetId, ChainId, Provenance } from '@colosseum/schemas';
import { type ReactNode, useId, useState } from 'react';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from './amounts';
import { displayName } from './plain';

// A plan, showing how, whatever it is a plan of (gate INVEST-TWO-PANE): the shape the Invest screen's
// pane, a plan's own page and the product pages share. It knows nothing of where the plan came from:
// `PlanPane` hands it a goal's plan (features/order/PlanPane.tsx), a product page a shared portfolio.
//
// It is a picture first (Thom, Oct 7: "the plan on the side panel could be more visual"). The answer
// in one line. The allocation as one thick bar in the brand's wood ramp, each part with its mark and,
// under it, its name and share; a row per holding in one line (mark, name, share bar, dollars, and
// the yield with its pin where the holding has one), with the reason behind a fold. The caller's
// chart. The way out as a meter per tier, with the cost and its pin, and "not measured yet" said once.
// Then the caller's details and its invest step. Nothing here is worked out: every figure is handed
// in. Anything not live is hatched and says so once. Motion is one short settle, and none where the
// person asks for less.

export type PlanViewHolding = {
  /** Where two rows may name the same asset; left out, the asset is the key. */
  key?: string;
  asset: AssetId;
  shareBps: number;
  /** Null where no amount is set yet (a product page before the person types one). */
  amountUsd: number | null;
  /** Null where the holding has no yield to show: the row shows none, never 0%. */
  yield: { lowPct: number; highPct: number; obs: PinSource | null } | null;
  /** One sentence: the reason that decided this holding. */
  why: string;
  /** Every reason, the deciding one first: said behind the fold only where `why` is empty. */
  reasons?: readonly string[];
};

export type PlanViewExitTier = {
  /** What this tier is of, where the way out is told per holding. */
  name?: string;
  /** How fast and how much, in a sentence. */
  text: string;
  /** What leaving costs, as shown ("≤ 0.30%"), with its pin. Left out where it is not measured. */
  cost?: { figure: string; obs: PinSource | null };
  /**
   * How full the tier's meter is, 0 to 1: a figure the caller was given (the share of the plan whose
   * way out is measured, the cost against the limit a plan may cost). Null draws an empty meter.
   */
  meter?: number | null;
  /** What a full meter stands for, in a sentence, under it. */
  scale?: string;
};

export type PlanViewExit = {
  tiers: PlanViewExitTier[];
  /** Said once where a cost is not measured: "Not measured yet, so no cost is shown." Never a zero. */
  caveat?: string;
};

export type PlanViewProps = {
  title: string;
  /** Under the title, muted: "Low risk · on Solana · nothing bought yet". */
  sub?: string;
  /** The heading level of the title: 2 on a page, 3 inside another section. */
  level?: 2 | 3;
  /** The answer in one line. A figure in it carries its own pin. */
  answer: ReactNode;
  chain: ChainId;
  /** How the figures are run: anything but `live` hatches the card and says so in one quiet line. */
  provenance: Provenance;
  /** An income plan may hold no stock. Kept for the callers that say it; nothing is drawn from it. */
  profile?: 'income';
  holdings: readonly PlanViewHolding[];
  exit: PlanViewExit;
  /** Under the answer: the ways to close a gap, a meter, or the version and who published. */
  aside?: ReactNode;
  /** Between the answer and the holdings: a meter of the answer, or a small figure beside it. */
  under?: ReactNode;
  /** After the holdings: the caller's one chart. */
  figures?: ReactNode;
  /** Under the card: what is behind a fold. */
  details?: ReactNode;
  /** The invest step, or the one button that leads to it. */
  invest?: ReactNode;
};

/** The wood ramp, in the order the holdings come. A fifth holding takes the first again. */
const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;
const fillOf = (i: number) => FILL[i % FILL.length] as string;

const percent = (value: number, lang: Lang) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);

/**
 * An asset's mark: a round coin with the first letters of its ticker, as the landing's closing draws
 * its coins. No logo is used: a token's name is its own, and its issuer's mark is not ours to show.
 */
export function AssetMark({ asset, className }: { asset: string; className?: string }) {
  const letters = tokenName(asset)
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 3);
  return (
    <span
      aria-hidden="true"
      data-ui="asset-mark"
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center rounded-full border border-foreground/40 bg-card font-mono text-[9px]/none font-medium text-foreground',
        className,
      )}
    >
      {letters}
    </span>
  );
}

/** A meter: a hairline track with what is handed in, filled. Empty where there is nothing measured. */
export function Meter({
  value,
  className,
}: {
  /** 0 to 1, or null for an empty meter. */
  value: number | null;
  className?: string;
}) {
  const filled = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <span
      aria-hidden="true"
      data-ui="meter"
      data-empty={value === null || undefined}
      className={cn('block h-2 w-full border border-border bg-muted', className)}
    >
      <span
        className="block h-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
        style={{ width: `${filled * 100}%` }}
      />
    </span>
  );
}

export function PlanView({
  title,
  sub,
  level = 2,
  answer,
  provenance,
  holdings,
  exit,
  aside,
  under,
  figures,
  details,
  invest,
}: PlanViewProps) {
  const t = useT();
  const lang = useLang();
  const paneId = useId();
  const Title = `h${level}` as 'h2' | 'h3';
  const [lit, setLit] = useState<string | null>(null);
  const share = (bps: number) => formatBps(bps, LOCALE[lang]);
  const name = (assetId: string) => displayName(assetId, t.plan);
  const keyOf = (h: PlanViewHolding) => h.key ?? h.asset;
  const range = (y: NonNullable<PlanViewHolding['yield']>) =>
    y.lowPct === y.highPct
      ? percent(y.lowPct, lang)
      : t.plan.projectedValue(percent(y.lowPct, lang), percent(y.highPct, lang));
  const shown = holdings.filter((h) => h.shareBps > 0);
  const columns = shown.map((h) => `${Math.max(h.shareBps, 1)}fr`).join(' ');
  return (
    <div data-ui="plan-pane" className="flex flex-col gap-6">
      <Card
        as="section"
        aria-labelledby={paneId}
        mock={provenance !== 'live'}
        mockLabels={{
          announce: provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        {/* The head, then the rest; a sample card says so once at its foot. */}
        <div className="px-6 pt-6">
          <Title id={paneId} className="text-[1.125rem]/7 font-medium">
            {title}
          </Title>
          {sub && <p className="mt-1 text-body-sm text-muted-foreground">{sub}</p>}
        </div>
        <div className="clear-both flex flex-col gap-6 px-6 pt-5 pb-6">
          {/* The answer first, in one line. */}
          <div data-ui="plan-verdict" className="flex max-w-(--tf-measure-body) flex-col gap-3">
            <p data-ui="plan-answer" className="text-h4 font-semibold text-balance">
              {answer}
            </p>
            {aside}
          </div>
          {under}

          {/* The allocation is the picture: one thick bar, a part per holding by its share, each
              with its mark; under it the same parts by name. Pointing at a part, or tapping it,
              lights its row. */}
          <div data-ui="plan-legs" className="flex flex-col gap-4">
            <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.holds}</h3>
            {shown.length > 0 && (
              <div data-ui="plan-bar" className="flex flex-col gap-1.5">
                <div className="grid h-11 gap-0.5" style={{ gridTemplateColumns: columns }}>
                  {shown.map((h, i) => (
                    <button
                      key={keyOf(h)}
                      type="button"
                      data-part={keyOf(h)}
                      data-lit={lit === keyOf(h) || undefined}
                      aria-label={`${name(h.asset)}, ${share(h.shareBps)}`}
                      aria-pressed={lit === keyOf(h)}
                      onMouseEnter={() => setLit(keyOf(h))}
                      onMouseLeave={() => setLit(null)}
                      onFocus={() => setLit(keyOf(h))}
                      onBlur={() => setLit(null)}
                      onClick={() => setLit((now) => (now === keyOf(h) ? null : keyOf(h)))}
                      className={cn(
                        'motion-safe:animate-seat flex min-w-0 items-center justify-center overflow-hidden outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        fillOf(i),
                        lit !== null && lit !== keyOf(h) && 'opacity-40',
                      )}
                    >
                      {h.shareBps >= 800 && <AssetMark asset={h.asset} />}
                    </button>
                  ))}
                </div>
                <div
                  aria-hidden="true"
                  className="grid gap-0.5 text-caption"
                  style={{ gridTemplateColumns: columns }}
                >
                  {shown.map((h) => (
                    <span key={keyOf(h)} className="min-w-0 truncate">
                      {h.shareBps >= 1500 && (
                        <>
                          <span className="font-medium">{tokenName(h.asset)}</span>{' '}
                          <span className="tabular-nums text-muted-foreground">
                            {share(h.shareBps)}
                          </span>
                        </>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <ul
              data-ui="plan-rows"
              className="flex flex-col divide-y divide-border border-y border-border"
            >
              {holdings.map((h, i) => {
                const reasons = h.why ? [h.why] : (h.reasons ?? []);
                return (
                  <li
                    key={keyOf(h)}
                    data-row={keyOf(h)}
                    data-lit={lit === keyOf(h) || undefined}
                    className={cn('flex flex-col gap-1 py-2.5', lit === keyOf(h) && 'bg-muted')}
                  >
                    {/* One line: the mark, the name, the share as a bar and a figure, the dollars. */}
                    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,11rem)_minmax(3rem,1fr)_auto_auto]">
                      <AssetMark asset={h.asset} />
                      <span className="min-w-0 truncate text-body font-medium">
                        {name(h.asset)}
                      </span>
                      <span aria-hidden="true" className="hidden h-2 bg-muted sm:block">
                        <span
                          className={cn(
                            'block h-full',
                            fillOf(shown.indexOf(h) < 0 ? i : shown.indexOf(h)),
                          )}
                          style={{ width: `${h.shareBps / 100}%` }}
                        />
                      </span>
                      <span className="text-right text-body tabular-nums">{share(h.shareBps)}</span>
                      {h.amountUsd !== null && (
                        <span className="col-start-3 text-right text-body tabular-nums text-muted-foreground sm:col-start-auto">
                          {dollars(h.amountUsd, lang)}
                        </span>
                      )}
                    </div>
                    {/* The yield, only where this holding has one, with its pin. */}
                    {h.yield && (
                      <p data-ui="row-yield" className="pl-9 text-body-sm text-muted-foreground">
                        <ProvenancePin value={range(h.yield)} obs={h.yield.obs} labels={t.pin} />{' '}
                        {t.plan.legs.afterHaircut}
                      </p>
                    )}
                    {reasons.length > 0 && (
                      <details data-ui="row-why" className="pl-9">
                        <summary className="w-fit cursor-pointer text-caption text-muted-foreground underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                          {t.plan.whyShare}
                        </summary>
                        <ul className="mt-1.5 flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
                          {reasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {figures}

          {/* The way out: a meter per tier, with what leaving costs and its pin. What is not
              measured is an empty meter, said once. */}
          <div data-ui="exit-plan-line" className="flex flex-col gap-3">
            <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.exitPlan}</h3>
            <ul className="flex flex-col gap-3">
              {exit.tiers.map((tier) => (
                <li
                  key={`${tier.name ?? ''}:${tier.text}`}
                  data-ui="exit-tier"
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1"
                >
                  <span className="min-w-0 text-body-sm">
                    {tier.name && <span className="font-medium">{tier.name}: </span>}
                    {tier.text}
                  </span>
                  <span className="text-right text-body-sm tabular-nums">
                    {tier.cost ? (
                      <>
                        <span className="text-muted-foreground">{t.plan.costPrefix} </span>
                        <ProvenancePin
                          value={tier.cost.figure}
                          obs={tier.cost.obs}
                          labels={t.pin}
                        />
                      </>
                    ) : null}
                  </span>
                  <Meter value={tier.meter ?? null} className="col-span-2" />
                  {tier.cost && tier.scale && (
                    <span className="col-span-2 text-caption text-muted-foreground">
                      {tier.scale}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {exit.caveat && (
              <p data-ui="exit-caveat" className="text-body-sm text-muted-foreground">
                {exit.caveat}
              </p>
            )}
            <p className="text-body-sm text-muted-foreground">{t.plan.inKind}</p>
          </div>
        </div>
      </Card>
      {details}
      {invest}
    </div>
  );
}

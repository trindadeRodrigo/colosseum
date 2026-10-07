'use client';
import type { ChainId, Provenance } from '@colosseum/schemas';
import { type ReactNode, useId } from 'react';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { ExitGlyph } from '../../components/ui/ExitPlanLine';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { formatBps } from '../order/amounts';

// The plan pane as a product's page fills it (gate PRODUCTS-PLAN-PANE): the answer in one line, one
// row per holding (its share, its dollars once an amount is known, its yield with its pin, one line of
// why), the exit plan as its own block, then what comes under (the version and the publisher) and the
// invest step. This file is the product pages' stand-in for the plan pane the Invest screen is being
// built with (`PlanPane`, branch web/invest-two-pane): the props below are the ones agreed for it, and
// the pages swap to that component when it lands. Nothing here works a figure out.

export type PlanPaneHolding = {
  /** The row's key: the asset's id. */
  asset: string;
  name: string;
  shareBps: number;
  /** Null where no amount is set yet: a product's page before the person types one. */
  amountUsd: number | null;
  /** Null where the holding pays no yield, or none was read: the row shows a dash, never 0%. */
  yield: { text: string; obs: PinSource | null } | null;
  /** One sentence. */
  why: string;
};

export type PlanPaneProps = {
  /** The answer in one line: the pane's heading. */
  answer: string;
  chain: ChainId;
  /** The label of what is shown: anything but `live` hatches the card and says so once. */
  provenance: Provenance;
  /** After the heading: the version. */
  meta?: ReactNode;
  holdings: PlanPaneHolding[];
  /**
   * The exit plan, a line a holding: the figure it stands on with its pin, then the rest of the
   * sentence. A line with no figure (nothing measured) is the sentence alone.
   */
  exit: { key: string; figure?: { text: string; obs: PinSource | null }; text: string }[];
  /** Under the holdings and the exit plan: the version that waits, the publisher, the checks. */
  aside?: ReactNode;
  /** The invest step, or nothing. */
  invest?: ReactNode;
};

const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;
/** The fill of the nth holding: the four leg colours in turn. */
export const fillOf = (index: number) => FILL[index % FILL.length] as string;

/** One bar of what a portfolio holds: a segment per holding by its share. Never the only place a share is said. */
export function HoldingsBar({
  shares,
  className,
}: {
  shares: readonly { key: string; shareBps: number }[];
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-ui="holdings-bar"
      className={`flex h-3 gap-0.5 ${className ?? ''}`}
    >
      {shares.map((s, i) => (
        <span
          key={s.key}
          className={`min-w-0.5 ${fillOf(i)}`}
          style={{ width: `${s.shareBps / 100}%` }}
        />
      ))}
    </div>
  );
}

export function PlanPane({
  answer,
  chain,
  provenance,
  meta,
  holdings,
  exit,
  aside,
  invest,
}: PlanPaneProps) {
  const t = useT();
  const lang = useLang();
  const words = t.shared.product;
  const heading = useId();
  const locale = LOCALE[lang];
  const amounts = holdings.some((h) => h.amountUsd !== null);
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      mock={provenance !== 'live'}
      mockLabels={{
        announce: provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
    >
      <div data-ui="plan-pane">
        <CardHeader
          title={answer}
          level={2}
          id={heading}
          meta={
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              {meta}
              <ChainBadge chain={chain} />
            </span>
          }
        />
        <CardBody className="flex flex-col gap-6">
          <section aria-label={words.holdings} className="flex flex-col gap-3">
            <HoldingsBar shares={holdings.map((h) => ({ key: h.asset, shareBps: h.shareBps }))} />
            <ol data-ui="plan-pane-holdings" className="flex flex-col divide-y divide-border">
              {holdings.map((h, i) => (
                <li
                  key={h.asset}
                  data-ui="plan-pane-holding"
                  className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0"
                >
                  <span aria-hidden="true" className={`size-2.5 translate-y-px ${fillOf(i)}`} />
                  <span className="min-w-0 font-mono text-body [overflow-wrap:anywhere]">
                    {h.name}
                  </span>
                  <span className="font-mono text-body font-medium tabular-nums">
                    <span className="sr-only">{words.columns.share}: </span>
                    {formatBps(h.shareBps, locale)}
                  </span>
                  <span className="col-start-2 col-end-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-body-sm">
                    {amounts && h.amountUsd !== null && (
                      <span className="font-mono tabular-nums">
                        <span className="sr-only">{words.columns.amount}: </span>
                        {dollars(h.amountUsd, lang)}
                      </span>
                    )}
                    <span data-ui="plan-pane-yield">
                      <span className="text-muted-foreground">{words.yield}: </span>
                      {h.yield ? (
                        <ProvenancePin value={h.yield.text} obs={h.yield.obs} labels={t.pin} />
                      ) : (
                        <>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">{words.noYield}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="col-start-2 col-end-4 max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
                    {h.why}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section
            data-ui="plan-pane-exit"
            aria-labelledby={`${heading}-exit`}
            className="flex flex-col gap-2 border-t border-border pt-5"
          >
            <h3 id={`${heading}-exit`} className="flex items-center gap-2 text-h4 font-semibold">
              <ExitGlyph />
              {words.exit.title}
            </h3>
            <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
              {words.exit.lead}
            </p>
            <ul className="flex flex-col gap-1.5">
              {exit.map((line) => (
                <li key={line.key} className="max-w-(--tf-measure-body) text-body-sm">
                  {line.figure && (
                    <>
                      <ProvenancePin
                        value={line.figure.text}
                        obs={line.figure.obs}
                        labels={t.pin}
                      />{' '}
                    </>
                  )}
                  {line.text}
                </li>
              ))}
            </ul>
          </section>

          {aside && <div className="flex flex-col gap-4 border-t border-border pt-5">{aside}</div>}
          {invest && (
            <div
              data-ui="plan-pane-invest"
              className="flex flex-col items-start gap-2 border-t border-border pt-5"
            >
              {invest}
            </div>
          )}
        </CardBody>
      </div>
    </Card>
  );
}

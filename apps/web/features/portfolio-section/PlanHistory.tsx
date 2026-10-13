'use client';
import type { PlanNewest } from '@colosseum/schemas';
import { useState } from 'react';
import { Card, CardBody } from '../../components/ui/Card';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Segmented } from '../../components/ui/TimeChart';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, utc } from '../portfolio/figures';
import { type HistoryAnswer, type Plan, type PlansChain, readHistory } from './api';
import { type ChartPoint, DepositTag, PlanValueChart } from './PlanValueChart';
import { ValueChartWait } from './PlanWait';
import { useSectionRead } from './PortfolioProvider';
import { ChainsOut, Say, sampleLine } from './parts';
import { leastLive, pointPin, putInPin } from './pins';
import { Block, BlockRead, sameVault } from './plan-blocks';
import {
  DEFAULT_WINDOW,
  served,
  WINDOWS,
  type WindowId,
  windowOf,
  windowQuery,
} from './plan-window';
import { useWords } from './words';

// A plan's value over time: the block of its page that reads GET /v1/portfolio/history for its vault.
// The person chooses how far back to look; each choice is a window the route serves (plan-window.ts),
// and one it would refuse is not asked. The window ends at the moment it is asked for, so "Read again"
// asks for a fresh one. What the answer holds is drawn as it came: two points or more are the figure
// (PlanValueChart.tsx), with the person's deposits marked at their times and listed under it, each
// amount on the pin of what was put in; one point, or none, is a sentence with what there is, never an
// empty frame.

export function PlanHistory({
  chain,
  plan,
  newest,
}: {
  chain: PlansChain;
  plan: Plan;
  /** The vault's newest snapshot: a vault that was never read has no history to ask for. */
  newest: PlanNewest;
}) {
  const w = useWords();
  const words = w.plan.history;
  const [choice, setChoice] = useState<WindowId>(DEFAULT_WINDOW);
  const chosen = windowOf(choice);
  const { reading } = useSectionRead<HistoryAnswer>(
    chosen && served(chosen) ? `history:${plan.chain}:${plan.address}:${chosen.id}` : null,
    async (apiFetch) => {
      // the window's two ends, from the clock of the moment it is asked for
      const query = chosen && windowQuery(chosen, Date.now());
      return query
        ? readHistory(apiFetch, { chain: plan.chain, address: plan.address, ...query })
        : { kind: 'refused' as const };
    },
  );

  return (
    <Block
      ui="plan-history"
      heading={words.heading}
      lead={words.lead}
      tools={
        <Segmented
          label={words.window.label}
          options={WINDOWS.map((option) => ({ id: option.id, label: words.window[option.id] }))}
          value={choice}
          onChange={(id) => setChoice(windowOf(id)?.id ?? DEFAULT_WINDOW)}
        />
      }
    >
      {chosen && served(chosen) ? (
        <BlockRead read={reading} label={words.reading} skeleton={<ValueChartWait />}>
          {(answer) => <Read answer={answer} chain={chain} plan={plan} newest={newest} />}
        </BlockRead>
      ) : (
        <Say sentence={w.shell.failure.refused} />
      )}
    </Block>
  );
}

function Read({
  answer,
  chain,
  plan,
  newest,
}: {
  answer: HistoryAnswer;
  chain: PlansChain;
  plan: Plan;
  newest: PlanNewest;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.plan.history;

  const out = answer.unavailable.find((u) => u.chain === plan.chain);
  if (out) return <ChainsOut unavailable={[out]} />;

  const entry = answer.chains.find((c) => c.chain === plan.chain);
  const series = entry?.vaults.find((v) => sameVault(v.address, plan.address));
  const { putIn } = plan;
  // Nothing under it is more live than the vault's chain, in either answer.
  const label = leastLive(
    chain.provenance,
    plan.provenance,
    ...(entry ? [entry.provenance] : []),
    ...(putIn ? [putIn.provenance] : []),
  );
  const points: ChartPoint[] =
    series && entry
      ? series.points.map((point) => ({
          at: point.observedAt,
          valueUsd: point.valueUsd,
          obs: pointPin(
            series,
            point,
            leastLive(entry.provenance, chain.provenance, plan.provenance),
          ),
        }))
      : [];

  // The deposits are numbered over all of them, oldest first, so a number names the same deposit in
  // every window.
  const first = points[0];
  const last = points[points.length - 1];
  const from = Math.min(Date.parse(answer.from), first ? Date.parse(first.at) : Infinity);
  const to = Math.max(Date.parse(answer.to), last ? Date.parse(last.at) : -Infinity);
  const deposits = (putIn?.deposits ?? []).map((deposit, i) => ({ ...deposit, n: i + 1 }));
  const inside = deposits.filter((deposit) => {
    const at = Date.parse(deposit.at);
    return at >= from && at <= to;
  });
  const outside = deposits.length - inside.length;

  // No point in the window: a sentence, and no card, since there is no figure to mark as sample.
  if (!first)
    return (
      <p data-ui="history-none" className="text-body-sm text-foreground">
        {words.none(utc(lang, newest.observedAt))}
      </p>
    );

  return (
    <Card mock={label !== 'live'} mockLabels={{ announce: sampleLine(t.shell, label) }}>
      <CardBody className="flex flex-col gap-4">
        {points.length >= 2 ? (
          <PlanValueChart points={points} deposits={inside} from={answer.from} to={answer.to} />
        ) : (
          // one point: a sentence and that one figure, never a frame with nothing drawn in it
          <div data-ui="history-one" className="flex flex-col gap-2">
            <p className="text-body-sm text-foreground">{words.one}</p>
            <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm">
              <span className="text-muted-foreground">{words.oneAt(utc(lang, first.at))}</span>
              <ProvenancePin value={dollars(lang, first.valueUsd)} obs={first.obs} labels={t.pin} />
            </p>
          </div>
        )}
        {putIn && inside.length > 0 && points.length >= 2 && (
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <ol
              aria-label={words.deposits.label}
              data-ui="history-deposits"
              className="flex list-none flex-col gap-1 p-0 text-body-sm"
            >
              {inside.map((deposit) => (
                <li
                  key={deposit.orderId}
                  data-n={deposit.n}
                  data-at={deposit.at}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                >
                  <DepositTag n={deposit.n} />
                  <span>{words.deposits.name(deposit.n)}</span>
                  <ProvenancePin
                    value={dollars(lang, deposit.usd)}
                    obs={putInPin(putIn, chain.provenance, plan.provenance)}
                    labels={t.pin}
                  />
                  <span className="text-muted-foreground">
                    {words.deposits.recorded(utc(lang, deposit.at))}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-caption text-muted-foreground">{words.deposits.note}</p>
          </div>
        )}
        {outside > 0 && points.length >= 2 && (
          <p data-ui="history-deposits-outside" className="text-caption text-muted-foreground">
            {words.deposits.outside(outside)}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

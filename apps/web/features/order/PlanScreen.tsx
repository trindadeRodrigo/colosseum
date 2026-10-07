'use client';
import type { BasketLine, ObservationRef, RiskRollUp } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { DataTable } from '../../components/ui/DataTable';
import { ExitPlanLine } from '../../components/ui/ExitPlanLine';
import { PAGE_TITLE } from '../../components/ui/heading';
import { MAX_LEGS, PlanLegs } from '../../components/ui/PlanLegs';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { GOAL_DRAFT } from '../goal/draft';
import { dollars, goalFromSheet } from '../goal/sheet';
import { formatBps } from './amounts';
import { PlanChart } from './PlanChart';
import { PlanGate } from './PlanGate';
import {
  displayName,
  flagSentences,
  goalLine,
  kindLabel,
  leftOut,
  planSummary,
  reasonsOf,
} from './plain';
import { usePlan } from './use-plan';

// The plan a goal built, before anything is bought: the goal first, then what the plan holds and why,
// the projected range with its source, the exit plan, and the risk as the API rolled it up. The
// disclaimer from the one constant is the foot of every product page (components/shell/AppShell.tsx),
// so it is on this one once. A plan built on anything that is not live is hatched and says so in
// one line, with "test network" on a test network. "Buy this plan" leads to the buy screen; on a chain with no
// deployment committed for its network it is off, and says why.

/** The first observation of a kind, as a pin takes it. Null when the plan names none: the pin shows a dash. */
const observed = (observations: readonly ObservationRef[], kind: ObservationRef['kind']) => {
  const o = observations.find((x) => x.kind === kind);
  return o
    ? { source: o.source, fetchedAt: o.fetchedAt, method: o.method, provenance: o.provenance }
    : null;
};

const percent = (value: number, lang: Lang) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);

export function PlanScreen({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const state = usePlan(id);
  const headingId = useId();
  const paneId = useId();
  const reasonId = useId();
  const here = `/plan/${encodeURIComponent(id)}`;
  if (state.kind !== 'ready') return <PlanGate state={state} next={here} />;

  const { plan, chain } = state;
  const { proposal } = plan;
  const { sheet, card } = proposal;
  const chainName = t.chain.names[chain];
  const label = planProvenance(proposal);
  const notLive = label !== 'live';
  const yieldObs: PinSource | null = observed(proposal.observations, 'yield');
  const exitObs: PinSource | null = observed(proposal.observations, 'liquidity');
  const locale = LOCALE[lang];
  const blocked = state.off
    ? t.plan.chainOff(chainName)
    : state.buyable
      ? null
      : t.plan.chainNotReady(chainName);
  const share = (bps: number) => formatBps(bps, locale);

  const tableOnly = proposal.lines.length > MAX_LEGS;
  const goal = goalLine(sheet, t, dollars(sheet.amountUsd, lang), (usd) => dollars(usd, lang));
  // What the range a year comes to a month, for a plan whose goal is income: the same share of the
  // amount the chart draws, over twelve months. Shown only where the range has a source.
  const ranged =
    yieldObs !== null &&
    !proposal.flags.includes('yield_not_read') &&
    card.expectedReturn.highPct > 0;
  const aMonth = (pct: number) => dollars(Math.round((sheet.amountUsd * pct) / 1200), lang);
  /** "Change my limits": the sheet this plan was built from, handed to the goal screen. */
  function keepLimits() {
    try {
      window.sessionStorage.setItem(GOAL_DRAFT, JSON.stringify(goalFromSheet(sheet, goal)));
    } catch {
      // No storage in this browser: the goal screen opens empty.
    }
  }

  const name = (assetId: string) => displayName(assetId, t.plan);
  // The plan in one sentence: what goes where, largest first, then the largest holding's own reason.
  const summary = planSummary(proposal, t, lang, chainName);
  // Money that could not be placed is said by the cash line's own reason, where it gives one, in
  // place of the general note.
  const unplaced = proposal.lines
    .flatMap((l) => l.reasons)
    .find((r) => r.rule === 'UNPLACED' || r.rule === 'NO_DOLLAR_YIELD')?.text;
  const flags = [...proposal.flags, ...(plan.rollUp?.flags ?? [])];
  const notes = [
    ...new Set([
      ...(unplaced ? [unplaced] : []),
      ...flagSentences(
        unplaced ? flags.filter((f) => f !== 'unplaced' && f !== 'no_dollar_yield') : flags,
        t.plan,
        name,
      ),
    ]),
  ];
  const out = leftOut(proposal);

  return (
    <div data-ui="plan-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 id={headingId} className={PAGE_TITLE}>
          {goal}
        </h1>
        <p data-ui="plan-summary" className="max-w-(--tf-measure-body) text-body-lg">
          {summary}
        </p>
        <p className="max-w-(--tf-measure-body) text-body">{t.plan.lead(chainName)}</p>
        {plan.fromLink && (
          <p
            data-ui="plan-from-link"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
          >
            <StatusMark status="watch" className="mt-1.5" />
            <span>{t.plan.fromLink}</span>
          </p>
        )}
      </header>

      {/* The plan pane of the showcase case (goal-showcase-case.md): head, the figures as stat cells,
          the legs with their reasons and the exit line. The limits are the page's heading, so they
          are not said again as chips (the flow audit, finding 12). */}
      <Card
        as="section"
        aria-labelledby={paneId}
        mock={notLive}
        mockLabels={{
          announce: label === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        {/* The head, then the rest; a sample card says so once at its foot. */}
        <div className="px-6 pt-6">
          <h2 id={paneId} className="text-[1.125rem]/7 font-medium">
            {t.plan.title}
          </h2>
          <p className="mt-1 text-body-sm text-muted-foreground">
            {t.plan.sub(t.plan.riskWord[sheet.risk], chainName)}
          </p>
        </div>
        <div className="clear-both flex flex-col gap-5 px-6 pt-5 pb-6">
          <StatRow>
            <Stat label={t.plan.kpi.amount}>{dollars(sheet.amountUsd, lang)}</Stat>
            <Stat label={t.plan.kpi.horizon}>{t.goal.card.months(sheet.horizonMonths)}</Stat>
            {/* On a phone the last two take a row each: a range with its pin is the widest figure. */}
            <Stat
              label={t.plan.kpi.projected}
              className="max-[620px]:col-span-2 max-[620px]:border-l-0"
            >
              <ProvenancePin
                value={t.plan.projectedValue(
                  percent(card.expectedReturn.lowPct, lang),
                  percent(card.expectedReturn.highPct, lang),
                )}
                obs={yieldObs}
                labels={t.pin}
              />
            </Stat>
          </StatRow>
          <p data-ui="plan-bad-fall" className="text-body">
            {card.expectedReturn.lossInFallUsd > 0
              ? t.plan.badFall.some(dollars(card.expectedReturn.lossInFallUsd, lang))
              : t.plan.badFall.none}
          </p>
          {sheet.goal === 'income' && ranged && (
            <p data-ui="plan-monthly" className="text-body">
              {t.plan.monthly(
                aMonth(card.expectedReturn.lowPct),
                aMonth(card.expectedReturn.highPct),
              )}
            </p>
          )}
          {/* The chart of his case: drawn only from a range that has a source. */}
          {ranged && <PlanChart amountUsd={sheet.amountUsd} card={card} yieldObs={yieldObs} />}
          <div className="flex flex-col gap-3">
            <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.holds}</h3>
            {tableOnly ? (
              <DataTable<BasketLine>
                caption={t.plan.holds}
                captionHidden
                rows={proposal.lines}
                rowKey={(line) => `${line.assetId}:${line.viaIndex ?? ''}`}
                columns={[
                  {
                    key: 'asset',
                    header: t.plan.columns.asset,
                    rowHeader: true,
                    cell: (l) => name(l.assetId),
                  },
                  {
                    key: 'share',
                    header: t.plan.columns.share,
                    numeric: true,
                    cell: (l) => share(l.weightBps),
                  },
                  {
                    key: 'amount',
                    header: t.plan.columns.amount,
                    numeric: true,
                    cell: (l) => dollars(l.amountUsd, lang),
                  },
                  {
                    key: 'why',
                    header: t.plan.columns.why,
                    cell: (l) => reasonsOf(l).join(' ') || t.plan.noReason,
                  },
                ]}
              />
            ) : (
              <PlanLegs
                profile={sheet.goal === 'income' ? 'income' : undefined}
                legs={proposal.lines.map((line) => ({
                  id: line.assetId,
                  name: name(line.assetId),
                  weight: line.weightBps / 10_000,
                  weightLabel: `${share(line.weightBps)} · ${dollars(line.amountUsd, lang)}`,
                  rate: null,
                  // the reason that decided the line, not the share it only started from
                  why: reasonsOf(line)[0],
                  // The pane carries the plate for the whole plan, as the showcase case does.
                  mock: false,
                }))}
                labels={{ afterHaircut: t.plan.legs.afterHaircut, quoted: t.plan.legs.quoted }}
                pinLabels={t.pin}
              />
            )}
          </div>
          <ExitPlanLine
            tiers={[
              {
                text: card.exit.text,
                ...(card.exit.costBps === null
                  ? {}
                  : {
                      cost: {
                        figure: t.plan.exitCost(share(Math.max(0, card.exit.costBps))),
                        obs: exitObs,
                      },
                    }),
              },
            ]}
            caveat={card.exit.costBps === null ? t.plan.exitUnmeasured : undefined}
            inKind={t.plan.inKind}
            labels={{ exitPlan: t.plan.exitPlan, costPrefix: t.plan.costPrefix }}
            pinLabels={t.pin}
          />
          {proposal.verdict && (
            <div data-ui="plan-verdict" className="flex max-w-(--tf-measure-body) flex-col gap-2">
              <p className="text-body">
                {proposal.verdict.met
                  ? t.plan.verdict.met
                  : t.plan.verdict.gap(dollars(proposal.verdict.gapUsdMonthly, lang))}
              </p>
              {/* The ways the engine found to close the gap, each its own sentence, and the one
                  thing to do about them: change the limits and build again. */}
              {!proposal.verdict.met && (
                <>
                  {proposal.verdict.ways.length > 0 && (
                    <>
                      <p className="text-body-sm">{t.plan.verdict.ways}</p>
                      <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm">
                        {proposal.verdict.ways.map((way) => (
                          <li key={way.change}>{way.change}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div>
                    <Link
                      href="/goal#limits"
                      onClick={keepLimits}
                      className={buttonClass({ variant: 'secondary' })}
                    >
                      {t.plan.verdict.change}
                    </Link>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* What the engine noted and how the plan is spread, closed until asked for: every code of the
          engine said in a sentence (features/order/plain.ts), none shown as it is written. */}
      {(notes.length > 0 || out.length > 0 || plan.rollUp || card.expectedReturn.basis) && (
        <details data-ui="plan-details" className="border border-border px-6 py-4">
          <summary className="cursor-pointer text-body font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {t.plan.details}
          </summary>
          <div className="mt-4 flex flex-col gap-6">
            <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
              {t.plan.basis(card.expectedReturn.basis)}
            </p>
            {notes.length > 0 && (
              <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1 pl-5 text-body-sm">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {out.length > 0 && (
              <div data-ui="plan-left-out" className="flex flex-col gap-1">
                <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.leftOut}</h3>
                <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1 pl-5 text-body-sm">
                  {out.map((sentence) => (
                    <li key={sentence}>{sentence}</li>
                  ))}
                </ul>
              </div>
            )}
            {plan.rollUp && (
              <RiskPanel
                rollUp={plan.rollUp}
                t={t}
                share={share}
                notLive={notLive}
                sandbox={label === 'sandbox'}
              />
            )}
          </div>
        </details>
      )}

      <div className="flex flex-col items-start gap-2">
        {blocked ? (
          <>
            <Button variant="primary" disabled aria-describedby={reasonId}>
              {t.plan.buy}
            </Button>
            <p id={reasonId} className="max-w-(--tf-measure-body) text-body-sm">
              {blocked}
            </p>
          </>
        ) : (
          <Link href={`${here}/buy`} className={buttonClass({ variant: 'primary' })}>
            {t.plan.buy}
          </Link>
        )}
      </div>
    </div>
  );
}

/** The risk roll-up as the API sent it with the plan. Nothing here is worked out on the page. */
function RiskPanel({
  rollUp,
  t,
  share,
  notLive,
  sandbox,
}: {
  rollUp: RiskRollUp;
  t: Dictionary;
  share: (bps: number) => string;
  notLive: boolean;
  sandbox: boolean;
}) {
  const shares = (caption: string, rows: RiskRollUp['byClass']) =>
    rows.length > 0 && (
      <DataTable<RiskRollUp['byClass'][number]>
        caption={caption}
        rows={rows}
        rowKey={(r) => r.key}
        columns={[
          {
            key: 'name',
            header: t.plan.risk.name,
            rowHeader: true,
            cell: (r) => (caption === t.plan.risk.byClass ? kindLabel(r.key, t.plan.kinds) : r.key),
          },
          { key: 'share', header: t.plan.risk.share, numeric: true, cell: (r) => share(r.bps) },
        ]}
      />
    );
  const bps = (value: number | null) => (value === null ? t.plan.risk.notMeasured : share(value));
  return (
    <Card
      as="section"
      aria-label={t.plan.risk.title}
      mock={notLive}
      mockLabels={{
        announce: sandbox ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
    >
      <CardHeader title={t.plan.risk.title} level={2} />
      <CardBody className="flex flex-col gap-6">
        {
          <>
            {shares(t.plan.risk.byClass, rollUp.byClass)}
            {shares(t.plan.risk.byIssuer, rollUp.byIssuer)}
            <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">{t.plan.risk.exitQuoted}</dt>
              <dd className="tabular-nums">{bps(rollUp.exit.quotedBps)}</dd>
              <dt className="text-muted-foreground">{t.plan.risk.exitMeasured}</dt>
              <dd className="tabular-nums">{bps(rollUp.exit.measuredWorstBps)}</dd>
              <dt className="text-muted-foreground">{t.plan.risk.measuredShare}</dt>
              <dd className="tabular-nums">{share(rollUp.exit.measuredShareBps)}</dd>
            </dl>
          </>
        }
      </CardBody>
    </Card>
  );
}

'use client';
import { type BasketLine, DISCLAIMER_SHORT, type RiskRollUp } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ExitPlanLine } from '../../components/ui/ExitPlanLine';
import { MAX_LEGS, PlanLegs } from '../../components/ui/PlanLegs';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { StatusMark } from '../../components/ui/StatusMark';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { formatBps } from './amounts';
import { ChoiceView } from './ChoiceView';
import { observed } from './observed';
import { PlanChart } from './PlanChart';
import { PlanGate } from './PlanGate';
import { bySize, displayName, flagSentences, isCashId, kindLabel } from './plain';
import { usePlan } from './use-plan';

// The plan a goal built, before anything is bought: the goal first, then what the plan holds and why,
// the projected range with its source, the exit plan, and the risk as the API rolled it up. The
// disclaimer from the one constant is the foot of every product page (components/shell/AppShell.tsx),
// so it is on this one once. A plan built on anything that is not live carries the MOCK plate,
// with "test network" on a test network. "Buy this plan" leads to the buy screen; on a chain with no
// deployment committed for its network it is off, and says why.

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
  // The candidates of one goal, side by side, for the person to pick from (gate THREE-PLANS).
  if (state.choice)
    return (
      <ChoiceView
        plans={state.choice.plans}
        notShown={state.choice.notShown}
        chain={state.chain}
        blocked={
          state.off
            ? t.plan.chainOff(t.chain.names[state.chain])
            : state.buyable
              ? null
              : t.plan.chainNotReady(t.chain.names[state.chain])
        }
      />
    );

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
  const foot =
    label === 'sandbox' ? t.plan.foot.sandbox : label === 'mock' ? t.plan.foot.mock : null;
  const chips: [string, string][] = [
    [t.plan.chips.goal, t.goal.options.goal[sheet.goal].toLowerCase()],
    [t.plan.chips.amount, dollars(sheet.amountUsd, lang)],
    [t.plan.chips.horizon, t.goal.card.months(sheet.horizonMonths)],
    [t.plan.chips.risk, t.goal.options.risk[sheet.risk].toLowerCase()],
    [t.plan.chips.chain, chainName],
  ];

  const name = (assetId: string) => displayName(assetId, t.plan);
  // The plan in one sentence: what goes where, largest first, then the largest holding's own reason.
  const lines = bySize(proposal.lines.filter((l) => l.amountUsd > 0));
  const isCash = (l: BasketLine) => isCashId(l.assetId);
  const parts = lines
    .slice(0, 3)
    .map((l) =>
      (isCash(l) ? t.plan.summary.stays : t.plan.summary.goes)(
        dollars(l.amountUsd, lang),
        name(l.assetId),
      ),
    );
  if (lines.length > 3) parts.push(t.plan.summary.more(lines.length - 3));
  const why = lines.find((l) => !isCash(l))?.reasons[0]?.text;
  const summary = [
    `${t.plan.summary.head(
      dollars(sheet.amountUsd, lang),
      t.goal.card.months(sheet.horizonMonths),
      t.plan.riskWord[sheet.risk].toLowerCase(),
      chainName,
    )} ${new Intl.ListFormat(locale, { type: 'conjunction' }).format(parts)}.`,
    why,
  ]
    .filter(Boolean)
    .join(' ');
  const notes = flagSentences([...proposal.flags, ...(plan.rollUp?.flags ?? [])], t.plan, name);

  return (
    <div data-ui="plan-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1
          id={headingId}
          className="max-w-(--tf-measure-display) font-display text-h1 font-normal"
        >
          {t.goal.card.sentence[sheet.goal](
            dollars(sheet.amountUsd, lang),
            t.goal.card.months(sheet.horizonMonths),
          )}
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

      {/* The plan pane of the showcase case (goal-showcase-case.md): head, the limits as chips, the
          figures as stat cells, the legs with their reasons, the exit line, and a foot. */}
      <Card
        as="section"
        aria-labelledby={paneId}
        mock={notLive}
        mockLabels={{
          announce: t.shell.mockAnnounce,
          note: label === 'sandbox' ? t.shell.testNetwork : undefined,
        }}
      >
        {/* The head flows beside the MOCK plate the card floats right; the rest clears it. */}
        <div className="px-6 pt-6">
          <h2 id={paneId} className="text-[1.125rem]/7 font-medium">
            {t.plan.title}
          </h2>
          <p className="mt-1 text-body-sm text-muted-foreground">
            {t.plan.sub(t.plan.riskWord[sheet.risk], chainName)}
          </p>
        </div>
        <div className="clear-both flex flex-col gap-5 px-6 pt-5 pb-6">
          <ul aria-label={t.plan.chips.label} className="flex flex-wrap gap-2">
            {chips.map(([key, value]) => (
              <li
                key={key}
                className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-source"
              >
                {key}: {value}
              </li>
            ))}
          </ul>
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
          <p className="text-body-sm text-muted-foreground">
            {t.plan.basis(card.expectedReturn.basis)}
          </p>
          {/* The chart of his case: drawn only from a range that has a source. */}
          {yieldObs !== null &&
            !proposal.flags.includes('yield_not_read') &&
            card.expectedReturn.highPct > 0 && (
              <PlanChart amountUsd={sheet.amountUsd} card={card} yieldObs={yieldObs} />
            )}
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
                    cell: (l) => l.reasons.map((r) => r.text).join(' ') || t.plan.noReason,
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
                  why: line.reasons[0]?.text,
                  // The pane carries the plate for the whole plan, as the showcase case does.
                  mock: false,
                }))}
                labels={{ afterHaircut: t.plan.legs.afterHaircut, quoted: t.plan.legs.quoted }}
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
          />
          {proposal.verdict && (
            <p className="max-w-(--tf-measure-body) text-body">
              {proposal.verdict.met
                ? t.plan.verdict.met
                : t.plan.verdict.gap(dollars(proposal.verdict.gapUsdMonthly, lang))}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-border px-6 py-3 font-mono text-source text-muted-foreground">
          <span>{foot}</span>
          <span>{DISCLAIMER_SHORT}</span>
        </div>
      </Card>

      {/* What the engine noted and how the plan is spread, closed until asked for: every code of the
          engine said in a sentence (features/order/plain.ts), none shown as it is written. */}
      {(notes.length > 0 || plan.rollUp) && (
        <details data-ui="plan-details" className="border border-border px-6 py-4">
          <summary className="cursor-pointer text-body font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {t.plan.details}
          </summary>
          <div className="mt-4 flex flex-col gap-6">
            {notes.length > 0 && (
              <ul className="flex max-w-(--tf-measure-body) list-disc flex-col gap-1 pl-5 text-body-sm">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
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
        announce: t.shell.mockAnnounce,
        note: sandbox ? t.shell.testNetwork : undefined,
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

'use client';
import type { BasketLine, ObservationRef, RiskRollUp } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { ExitPlanLine } from '../../components/ui/ExitPlanLine';
import { MAX_LEGS, PlanLegs } from '../../components/ui/PlanLegs';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { formatBps } from './amounts';
import { PlanGate } from './PlanGate';
import { usePlan } from './use-plan';

// The plan a goal built, before anything is bought: the goal first, then what the plan holds and why,
// the projected range with its source, the exit plan, the risk as the API rolled it up, and the
// disclaimer from the one constant. A plan built on anything that is not live carries the MOCK plate,
// with "test network" on a test network. "Buy this plan" leads to the buy screen; on a chain with no
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
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.plan.lead(chainName)}</p>
      </header>

      <Card
        as="section"
        aria-label={t.plan.holds}
        mock={notLive}
        mockLabels={{
          announce: t.shell.mockAnnounce,
          note: label === 'sandbox' ? t.shell.testNetwork : undefined,
        }}
      >
        <CardHeader title={t.plan.holds} level={2} />
        <CardBody className="flex flex-col gap-6">
          {proposal.lines.length <= MAX_LEGS && (
            <PlanLegs
              profile={sheet.goal === 'income' ? 'income' : undefined}
              legs={proposal.lines.map((line) => ({
                id: line.assetId,
                name: line.assetId,
                weight: line.weightBps / 10_000,
                weightLabel: share(line.weightBps),
                rate: null,
                why: line.reasons[0]?.text,
                mock: notLive,
              }))}
            />
          )}
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
                cell: (l) => l.assetId,
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
          <dl className="flex flex-col gap-1">
            <dt className="text-caption text-muted-foreground">{t.plan.projected}</dt>
            <dd className="text-body tabular-nums">
              <ProvenancePin
                value={t.plan.projectedValue(
                  percent(card.expectedReturn.lowPct, lang),
                  percent(card.expectedReturn.highPct, lang),
                )}
                obs={yieldObs}
                labels={t.pin}
              />
            </dd>
            <dd className="text-body-sm text-muted-foreground">
              {t.plan.basis(card.expectedReturn.basis)}
            </dd>
            {card.expectedReturn.lossInFallUsd > 0 && (
              <dd className="text-body-sm">
                {t.plan.lossInFall(dollars(card.expectedReturn.lossInFallUsd, lang))}
              </dd>
            )}
          </dl>
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
                mock: notLive,
              },
            ]}
            caveat={card.exit.costBps === null ? t.plan.exitUnmeasured : undefined}
            inKind={t.plan.inKind}
          />
          {proposal.verdict && (
            <p className="max-w-(--tf-measure-body) text-body">
              {proposal.verdict.met
                ? t.plan.verdict.met
                : t.plan.verdict.gap(dollars(proposal.verdict.gapUsdMonthly, lang))}
            </p>
          )}
          {proposal.flags.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-caption text-muted-foreground">{t.plan.flags}</h3>
              <ul className="flex flex-wrap gap-x-4 font-mono text-source">
                {proposal.flags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <RiskPanel
        rollUp={plan.rollUp}
        t={t}
        share={share}
        notLive={notLive}
        sandbox={label === 'sandbox'}
      />

      <Disclaimer lang={lang} heading={t.shell.disclaimer} label={t.shell.disclaimer} />

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
  rollUp: RiskRollUp | null;
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
          { key: 'name', header: t.plan.risk.name, rowHeader: true, cell: (r) => r.key },
          { key: 'share', header: t.plan.risk.share, numeric: true, cell: (r) => share(r.bps) },
        ]}
      />
    );
  const bps = (value: number | null) => (value === null ? t.plan.risk.notMeasured : share(value));
  return (
    <Card
      as="section"
      aria-label={t.plan.risk.title}
      mock={rollUp !== null && notLive}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: sandbox ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader title={t.plan.risk.title} level={2} />
      <CardBody className="flex flex-col gap-6">
        {rollUp === null ? (
          <p className="max-w-(--tf-measure-body) text-body-sm">{t.plan.risk.none}</p>
        ) : (
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
            {rollUp.flags.length > 0 && (
              <ul className="flex flex-wrap gap-x-4 font-mono text-source">
                {rollUp.flags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

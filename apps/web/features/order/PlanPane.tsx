'use client';
import type { ChainId, ObservationRef, RiskRollUp } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { formatBps } from './amounts';
import { PlanChart } from './PlanChart';
import { PlanView } from './PlanView';
import { displayName, flagSentences, kindLabel, leftOut, reasonsOf } from './plain';
import type { StoredPlan } from './plan-store';

// The plan, showing how (gate INVEST-TWO-PANE): one block that the Invest screen's right pane, the
// plan's own page (/plan/{id}) and the product pages all draw. The answer first, in one line: whether
// the plan reaches the income asked of it, or the gap in dollars, or the range it projects. Then the
// ways to close a gap, as buttons; one row per holding with its share, its dollars and the one reason
// that decided it (the rest are under "Details"); the exit plan as its own block; the figures and the
// chart; and one button, "Invest $X". A plan carries no yield and no exit figure per holding
// (`BasketLine` has neither), so the range and the exit cost are the plan's, each with its pin, said
// once. A plan built on anything that is not live is hatched and says so in one line.

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

export type PlanPaneProps = {
  /** The plan, with the risk roll-up where the API sent one. `userId` is not read here. */
  plan: Pick<StoredPlan, 'proposal' | 'rollUp' | 'readBack'>;
  chain: ChainId;
  /** Why the plan cannot be invested in here yet, in a sentence: the button is off and says so. */
  blocked?: string | null;
  /**
   * A way to close the gap was pressed. Left out, the ways are sentences. The engine writes each way
   * as a sentence with its own figures: the button says it as it is.
   */
  onWay?: (way: string) => void;
  /** The one button: a link to follow, or an action. Left out: no button (the pane hosts the step). */
  invest?: { href: string; onFollow?: () => void } | { onPress: () => void; busy?: boolean };
  /** The heading level of the block's own title: 2 on a page, 3 inside the Invest screen's pane. */
  level?: 2 | 3;
};

export function PlanPane({ plan, chain, blocked = null, onWay, invest, level = 2 }: PlanPaneProps) {
  const t = useT();
  const lang = useLang();
  const reasonId = useId();
  const { proposal } = plan;
  const { sheet, card } = proposal;
  const chainName = t.chain.names[chain];
  const label = planProvenance(proposal);
  const notLive = label !== 'live';
  const yieldObs: PinSource | null = observed(proposal.observations, 'yield');
  const exitObs: PinSource | null = observed(proposal.observations, 'liquidity');
  const locale = LOCALE[lang];
  const share = (bps: number) => formatBps(bps, locale);

  // What the range a year comes to a month, for a plan whose goal is income: the same share of the
  // amount the chart draws, over twelve months. Shown only where the range has a source.
  const ranged =
    yieldObs !== null &&
    !proposal.flags.includes('yield_not_read') &&
    card.expectedReturn.highPct > 0;
  const aMonth = (pct: number) => dollars(Math.round((sheet.amountUsd * pct) / 1200), lang);
  const name = (assetId: string) => displayName(assetId, t.plan);
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

  const verdict = proposal.verdict;
  const amount = dollars(sheet.amountUsd, lang);

  return (
    <PlanView
      title={t.plan.title}
      sub={t.plan.sub(t.plan.riskWord[sheet.risk], chainName)}
      level={level}
      chain={chain}
      provenance={label}
      profile={sheet.goal === 'income' ? 'income' : undefined}
      answer={
        verdict ? (
          verdict.met ? (
            t.plan.verdict.met
          ) : (
            t.plan.verdict.gap(dollars(verdict.gapUsdMonthly, lang))
          )
        ) : ranged ? (
          <>
            <ProvenancePin
              value={t.plan.answer.range(
                percent(card.expectedReturn.lowPct, lang),
                percent(card.expectedReturn.highPct, lang),
              )}
              obs={yieldObs}
              labels={t.pin}
            />{' '}
            {t.plan.answer.rangeAfter}
          </>
        ) : (
          t.plan.answer.none
        )
      }
      aside={
        <>
          {/* The ways the engine found to close the gap. Each is the engine's own sentence, with
                its own figures; pressed, it is a turn of the conversation and the plan is redrawn. */}
          {verdict && !verdict.met && verdict.ways.length > 0 && (
            <div data-ui="plan-ways" className="flex flex-col items-start gap-2">
              <p className="text-body-sm">{t.plan.verdict.ways}</p>
              {onWay ? (
                <div className="flex flex-wrap gap-2">
                  {verdict.ways.map((way) => (
                    <Button
                      key={way.change}
                      variant="secondary"
                      className="h-auto! min-h-10 py-2 text-left whitespace-normal"
                      onClick={() => onWay(way.change)}
                    >
                      {way.change}
                    </Button>
                  ))}
                </div>
              ) : (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm">
                  {verdict.ways.map((way) => (
                    <li key={way.change}>{way.change}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      }
      holdings={proposal.lines.map((line) => ({
        key: `${line.assetId}:${line.viaIndex ?? ''}`,
        asset: line.assetId,
        shareBps: line.weightBps,
        amountUsd: line.amountUsd,
        // a plan's lines carry no yield of their own: the range is the plan's, in the answer
        yield: null,
        // the reason that decided the line, not the share it only started from
        why: reasonsOf(line)[0] ?? '',
        reasons: reasonsOf(line),
      }))}
      exit={{
        tiers: [
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
        ],
        caveat: card.exit.costBps === null ? t.plan.exitUnmeasured : undefined,
      }}
      figures={
        <>
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
            // A figure worked from the yield range: it carries that range's pin (STYLE.md rule 1),
            // and is said as an estimate, never as what the plan pays.
            <p data-ui="plan-monthly" className="text-body">
              <ProvenancePin
                value={t.plan.monthly.figure(
                  aMonth(card.expectedReturn.lowPct),
                  aMonth(card.expectedReturn.highPct),
                )}
                obs={yieldObs}
                labels={t.pin}
              />{' '}
              {t.plan.monthly.after}
            </p>
          )}
          {/* The chart of his case: drawn only from a range that has a source. */}
          {ranged && <PlanChart amountUsd={sheet.amountUsd} card={card} yieldObs={yieldObs} />}
        </>
      }
      details={
        <>
          {/* What the engine noted and how the plan is spread, closed until asked for: every code of the
          engine said in a sentence (features/order/plain.ts), none shown as it is written. */}
          {(notes.length > 0 ||
            out.length > 0 ||
            plan.rollUp ||
            plan.readBack ||
            card.expectedReturn.basis) && (
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
                {/* Read back from the server, which keeps the plan and not its risk summary: said, not
                left out in silence. */}
                {!plan.rollUp && plan.readBack && (
                  <p
                    data-ui="plan-risk-not-kept"
                    className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
                  >
                    {t.plan.risk.notKept}
                  </p>
                )}
              </div>
            </details>
          )}
        </>
      }
      invest={
        invest && (
          <div data-ui="plan-invest" className="flex flex-col items-start gap-2">
            {blocked ? (
              <>
                <Button variant="primary" disabled aria-describedby={reasonId}>
                  {t.plan.invest(amount)}
                </Button>
                <p id={reasonId} className="max-w-(--tf-measure-body) text-body-sm">
                  {blocked}
                </p>
              </>
            ) : 'href' in invest ? (
              <Link
                href={invest.href}
                onClick={invest.onFollow}
                className={buttonClass({ variant: 'primary' })}
              >
                {t.plan.invest(amount)}
              </Link>
            ) : (
              <Button
                variant="primary"
                busy={invest.busy}
                busyLabel={t.plan.investing}
                onClick={invest.onPress}
              >
                {t.plan.invest(amount)}
              </Button>
            )}
          </div>
        )
      }
    />
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

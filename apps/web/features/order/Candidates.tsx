'use client';
import {
  type ChainId,
  currencyOf,
  type PlanCandidate,
  type PlanCandidateNotShown,
  type PlanScorecard,
  type PlanStatus,
} from '@colosseum/schemas';
import { type ReactNode, useId } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from './amounts';
import { displayName, kindLabel } from './plain';

// The plans one goal built, side by side (gate THREE-PLANS; DESIGN-VAULT section 7): always in the
// order Cover, Spread, Carry, none picked and none marked (a default or a badge is read as advice).
// Each shows its headline, what it holds as one bar, and what it is compared on, every figure of a
// yield or a selling cost on its pin; with withdrawals to come, whether it pays them and the ways to
// close a gap, which are the engine's own, per candidate. The ones the engine left out are named with
// its reason. The person picks one, here or by saying its name; nothing is invested in until then.
// Nothing here is worked out: every figure is the plan's or its scorecard's.

type Words = Dictionary['plan']['choice'];

/** The wood ramp, in the order the holdings come. A fifth holding takes the first again. */
const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;

/** The first observation of a kind, as a pin takes it. Null when the plan names none. */
const observed = (
  plan: PlanCandidate['proposal'],
  kind: 'yield' | 'liquidity',
): PinSource | null => {
  const o = plan.observations.find((x) => x.kind === kind);
  return o
    ? { source: o.source, fetchedAt: o.fetchedAt, method: o.method, provenance: o.provenance }
    : null;
};

export function Candidates({
  candidates,
  notShown,
  chain,
  onPick,
  onWay,
  disabled = false,
}: {
  /** In the fixed order. None is picked here: picking one is the caller's next state. */
  candidates: readonly PlanCandidate[];
  notShown: readonly PlanCandidateNotShown[];
  chain: ChainId;
  onPick: (candidate: PlanCandidate['candidate']) => void;
  /** A way to close a gap was pressed. Left out, the ways are sentences. */
  onWay?: (way: string) => void;
  /** The plans are from before a change: none can be picked. */
  disabled?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.plan.choice;
  const headingId = useId();
  return (
    <section data-ui="plan-candidates" aria-labelledby={headingId} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-[1.125rem]/7 font-medium">
          {words.title}
        </h2>
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {words.lead(candidates.length, t.chain.names[chain])}
        </p>
      </div>
      <div
        className={cn(
          'grid items-start gap-4',
          candidates.length === 3 && '2xl:grid-cols-3',
          candidates.length === 2 && 'xl:grid-cols-2',
        )}
      >
        {candidates.map((candidate) => (
          <Candidate
            key={candidate.id}
            plan={candidate}
            words={words}
            lang={lang}
            onPick={disabled ? null : () => onPick(candidate.candidate)}
            onWay={disabled ? undefined : onWay}
          />
        ))}
      </div>
      {notShown.length > 0 && (
        <div data-ui="candidates-not-shown" className="flex flex-col gap-1">
          <h3 className="text-[0.8125rem]/5 font-medium">{words.notShown.title}</h3>
          <p className="text-caption text-muted-foreground">{words.notShown.lead}</p>
          <ul className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
            {notShown.map((n) => (
              <li key={n.candidate} data-candidate={n.candidate}>
                <span className="font-medium">{words.names[n.candidate]}</span>: {n.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Candidate({
  plan,
  words,
  lang,
  onPick,
  onWay,
}: {
  plan: PlanCandidate;
  words: Words;
  lang: Lang;
  onPick: (() => void) | null;
  onWay?: (way: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const { proposal, scorecard, status } = plan;
  const name = words.names[plan.candidate];
  const locale = LOCALE[lang];
  const share = (bps: number) => formatBps(bps, locale);
  const label = planProvenance(proposal);
  const yieldObs = observed(proposal, 'yield');
  const exitObs = observed(proposal, 'liquidity');
  const currency = currencyOf(proposal.sheet);
  const held = proposal.lines.filter((l) => l.weightBps > 0);
  const nameOf = (assetId: string) => displayName(assetId, t.plan);
  // The headline: with withdrawals, the months paid and the stress that pays the fewest; with none,
  // what most of the plan is in and what a bad fall would cost. The engine's figures, as they are.
  const all = scorecard.base?.monthsWithWithdrawal ?? 0;
  const worst = [...scorecard.stresses].sort((a, b) => a.monthsPaid - b.monthsPaid)[0];
  const top = [...scorecard.concentration.byClass].sort((a, b) => b.bps - a.bps)[0];
  const fall = proposal.card.expectedReturn.lossInFallUsd;
  const h = words.headline;
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      data-candidate={plan.candidate}
      mock={label !== 'live'}
      mockLabels={{
        announce: label === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
    >
      <CardHeader title={name} level={3} id={titleId} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-body-sm text-muted-foreground">{words.aims[plan.candidate]}</p>
        <p data-ui="candidate-headline" className="text-body font-semibold text-balance">
          {scorecard.base ? (
            <>
              <ProvenancePin
                value={h.paidOf(scorecard.base.monthsPaid, all)}
                obs={yieldObs}
                labels={t.pin}
              />
              {worst &&
                ` ${h.worstMonths(
                  stressWords(worst.id, status, words, currency, share),
                  worst.monthsPaid,
                  all,
                )}`}
            </>
          ) : top ? (
            fall > 0 ? (
              t.plan.answer.inFall(
                share(top.bps),
                kindLabel(top.key, t.plan.kinds).toLocaleLowerCase(locale),
                dollars(fall, lang),
              )
            ) : (
              t.plan.answer.inNoFall(
                share(top.bps),
                kindLabel(top.key, t.plan.kinds).toLocaleLowerCase(locale),
              )
            )
          ) : fall > 0 ? (
            h.fall(dollars(fall, lang))
          ) : (
            h.noFall
          )}
        </p>
        {/* What it holds, as one bar: a picture, said once in words, with the largest parts named. */}
        <div data-ui="candidate-bar" className="flex flex-col gap-1.5">
          <div
            role="img"
            aria-label={held.map((l) => `${nameOf(l.assetId)}, ${share(l.weightBps)}`).join('; ')}
            className="grid h-6 gap-0.5"
            style={{ gridTemplateColumns: held.map((l) => `${l.weightBps}fr`).join(' ') }}
          >
            {held.map((l, i) => (
              <span
                key={`${l.assetId}:${l.viaIndex ?? ''}`}
                className={cn('motion-safe:animate-seat min-w-0', FILL[i % FILL.length])}
              />
            ))}
          </div>
          <ul aria-hidden="true" className="flex flex-wrap gap-x-3 gap-y-0.5 text-caption">
            {held.slice(0, 4).map((l, i) => (
              <li key={`${l.assetId}:${l.viaIndex ?? ''}`} className="flex items-center gap-1">
                <span className={cn('size-2.5 shrink-0', FILL[i % FILL.length])} />
                <span className="font-medium">{tokenName(l.assetId)}</span>
                <span className="tabular-nums text-muted-foreground">{share(l.weightBps)}</span>
              </li>
            ))}
            {held.length > 4 && (
              <li className="text-muted-foreground">{t.plan.summary.more(held.length - 4)}</li>
            )}
          </ul>
        </div>
        <Score
          scorecard={scorecard}
          status={status}
          words={words}
          lang={lang}
          currency={currency}
          share={share}
          yieldObs={yieldObs}
          exitObs={exitObs}
          pinLabels={t.pin}
        />
        {status && (
          <Withdrawals
            status={status}
            words={words}
            lang={lang}
            currency={currency}
            share={share}
            onWay={onWay}
          />
        )}
        <div data-ui="candidate-pick">
          <Button variant="secondary" disabled={onPick === null} onClick={() => onPick?.()}>
            {words.picker.buy(name)}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

const money = (amount: number, currency: string, lang: Lang) =>
  currency === 'USD'
    ? dollars(amount, lang)
    : new Intl.NumberFormat(LOCALE[lang], { style: 'currency', currency }).format(amount);

/** A stress in words, with its sizes from the status where it carries them. */
function stressWords(
  id: string,
  status: PlanStatus | undefined,
  words: Words,
  currency: string,
  share: (bps: number) => string,
): string {
  const p = status?.stresses.find((s) => s.id === id)?.params ?? {};
  const s = words.stress;
  if (id === 'yields_fall' && p.fallBps !== undefined) return s.yields_fall(share(p.fallBps));
  if (id === 'credit_gate' && p.months !== undefined) return s.credit_gate(p.months);
  if (id === 'equity_fall' && p.fallBps !== undefined) return s.equity_fall(share(p.fallBps));
  if ((id === 'fx_goal_up' || id === 'fx_goal_down') && p.moveBps !== undefined && p.months)
    return s[id](currency, share(p.moveBps), p.months);
  return s.other;
}

function Withdrawals({
  status,
  words,
  lang,
  currency,
  share,
  onWay,
}: {
  status: PlanStatus;
  words: Words;
  lang: Lang;
  currency: string;
  share: (bps: number) => string;
  onWay?: (way: string) => void;
}) {
  const w = words.status;
  const observedCarry = share(status.carryObservedBps);
  const date = status.observedOn
    ? new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium', timeZone: 'UTC' }).format(
        new Date(status.observedOn),
      )
    : null;
  return (
    <div data-ui="candidate-status" className="flex flex-col gap-2">
      <h4 className="text-[0.8125rem]/5 font-medium">{w.title}</h4>
      <p className="text-body">{status.met ? w.met : w.notMet}</p>
      <p className="text-body-sm">
        {status.carryNeededBps === null
          ? w.neededOut(observedCarry)
          : status.carryNeededBps === 0
            ? w.neededNone(observedCarry)
            : w.needed(share(status.carryNeededBps), observedCarry)}{' '}
        {date && w.observedOn(date)}
      </p>
      {!status.met && (status.ways.length > 0 || status.noAmountCloses) && (
        <div className="flex flex-col gap-1">
          <p className="text-caption text-muted-foreground">{w.ways}</p>
          {/* Each way is the engine's own sentence, with its own figures. Pressed, it is a turn of
              the conversation and the plans are made again. */}
          <ul data-ui="candidate-ways" className="flex flex-col items-start gap-1.5 text-body-sm">
            {status.ways.map((way) => (
              <li key={way.change}>
                {onWay ? (
                  <Button
                    variant="secondary"
                    className="h-auto! min-h-8 py-1.5 text-left whitespace-normal"
                    onClick={() => onWay(way.change)}
                  >
                    {way.change}
                  </Button>
                ) : (
                  way.change
                )}
              </li>
            ))}
            {status.noAmountCloses && <li>{status.noAmountCloses}</li>}
          </ul>
        </div>
      )}
      {/* the shortfall is in the goal's currency */}
      {status.base.shortfall > 0 && (
        <p className="text-body-sm text-muted-foreground">
          {words.score.short(money(status.base.shortfall, currency, lang))}
        </p>
      )}
    </div>
  );
}

function Score({
  scorecard,
  status,
  words,
  lang,
  currency,
  share,
  yieldObs,
  exitObs,
  pinLabels,
}: {
  scorecard: PlanScorecard;
  status: PlanStatus | undefined;
  words: Words;
  lang: Lang;
  currency: string;
  share: (bps: number) => string;
  yieldObs: PinSource | null;
  exitObs: PinSource | null;
  pinLabels: Dictionary['pin'];
}) {
  const s = words.score;
  const all = scorecard.base?.monthsWithWithdrawal ?? 0;
  const pinned = (value: string, obs: PinSource | null) => (
    <ProvenancePin value={value} obs={obs} labels={pinLabels} />
  );
  const rows: [string, ReactNode][] = [];
  if (scorecard.monthsCovered !== null)
    rows.push([s.covered, pinned(String(scorecard.monthsCovered), yieldObs)]);
  if (scorecard.base) {
    rows.push([s.paidNow, pinned(s.of(scorecard.base.monthsPaid, all), yieldObs)]);
    for (const stress of scorecard.stresses)
      rows.push([
        s.paidUnder(stressWords(stress.id, status, words, currency, share)),
        pinned(s.of(stress.monthsPaid, all), yieldObs),
      ]);
  }
  rows.push([s.carry, pinned(share(scorecard.carryObservedBps), yieldObs)]);
  rows.push([
    s.exit,
    <span key="exit" className="flex flex-col items-end">
      {scorecard.exit.costBps === null
        ? s.exitNone
        : pinned(share(Math.max(0, scorecard.exit.costBps)), exitObs)}
      <span className="text-caption text-muted-foreground">
        {s.measured(share(scorecard.exit.measuredShareBps))}
      </span>
    </span>,
  ]);
  rows.push([
    s.issuer,
    <span key="issuer" className="flex flex-col items-end">
      {share(scorecard.concentration.largestIssuerBps)}
      <span className="text-caption text-muted-foreground">
        {s.issuers(scorecard.concentration.issuers)}
      </span>
    </span>,
  ]);
  rows.push([s.credit, share(scorecard.creditBasisBps)]);
  if (scorecard.openFxUsd !== undefined) rows.push([s.fx, dollars(scorecard.openFxUsd, lang)]);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[0.8125rem]/5 font-medium">{s.title}</h4>
      <dl data-ui="candidate-score" className="flex flex-col text-body-sm">
        {rows.map(([term, value]) => (
          <div
            key={term}
            className="flex items-start justify-between gap-4 border-b border-border py-1.5 last:border-b-0"
          >
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

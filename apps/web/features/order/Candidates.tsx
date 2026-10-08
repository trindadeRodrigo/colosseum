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
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { formatBps, tokenName } from './amounts';
import { displayName } from './plain';

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
  kind: 'yield' | 'liquidity' | 'fx',
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
    <section
      data-ui="plan-candidates"
      aria-labelledby={headingId}
      className="@container flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-[1.125rem]/7 font-medium">
          {words.title}
        </h2>
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {words.lead(candidates.length, t.chain.names[chain])}
        </p>
      </div>
      {/* One candidate a row, full width. Side by side only where this block itself is wide (a
          page's full width), never squeezed into a pane. */}
      <div
        className={cn(
          'grid items-start gap-3',
          candidates.length === 3 && '@[56rem]:grid-cols-3',
          candidates.length === 2 && '@[56rem]:grid-cols-2',
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
  // A yielding holding with no reading is in the carry at nothing (the engine flags it): the sum is
  // then not a figure that was observed, and it and what stands on it are shown as not read.
  const yieldObs = proposal.flags.includes('yield_not_read') ? null : observed(proposal, 'yield');
  const exitObs = observed(proposal, 'liquidity');
  const currency = currencyOf(proposal.sheet);
  const held = proposal.lines.filter((l) => l.weightBps > 0);
  const nameOf = (assetId: string) => displayName(assetId, t.plan);
  const all = scorecard.base?.monthsWithWithdrawal ?? 0;
  const fall = proposal.card.expectedReturn.lossInFallUsd;
  const f = words.figures;
  // The figures a candidate leads with, each the engine's own: the yield observed and the cost to
  // sell on their pins, what a bad fall would cost, and with withdrawals the months they are paid.
  const figures: [string, string, ReactNode][] = [
    [
      'yield',
      f.yield,
      <ProvenancePin
        key="yield"
        value={share(scorecard.carryObservedBps)}
        obs={yieldObs}
        labels={t.pin}
      />,
    ],
    [
      'exit',
      f.exit,
      scorecard.exit.costBps === null ? (
        words.score.exitNone
      ) : (
        <ProvenancePin
          key="exit"
          value={share(Math.max(0, scorecard.exit.costBps))}
          obs={exitObs}
          labels={t.pin}
        />
      ),
    ],
    ['fall', f.fall, fall > 0 ? f.lost(dollars(fall, lang)) : f.noLoss],
    ...(scorecard.base
      ? ([
          [
            'paid',
            words.headline.paid,
            <ProvenancePin
              key="paid"
              value={words.score.of(scorecard.base.monthsPaid, all)}
              obs={yieldObs}
              labels={t.pin}
            />,
          ],
        ] as [string, string, ReactNode][])
      : []),
  ];
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
      <div className="flex flex-col gap-3 px-5 py-4">
        {/* One row: the name and what it aims at, and the one thing to press at the right. */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
            <h3 id={titleId} className="text-[1.0625rem]/6 font-medium">
              {name}
            </h3>
            <p className="text-body-sm text-muted-foreground">{words.aims[plan.candidate]}</p>
          </div>
          <div data-ui="candidate-pick" className="shrink-0">
            <Button variant="secondary" disabled={onPick === null} onClick={() => onPick?.()}>
              {words.picker.buy(name)}
            </Button>
          </div>
        </div>
        {/* What it holds, as one bar across: a picture, said once in words, its legend on a line. */}
        <div data-ui="candidate-bar" className="flex flex-col gap-1.5">
          <div
            role="img"
            aria-label={held.map((l) => `${nameOf(l.assetId)}, ${share(l.weightBps)}`).join('; ')}
            className="grid h-5 gap-0.5"
            style={{ gridTemplateColumns: held.map((l) => `${l.weightBps}fr`).join(' ') }}
          >
            {held.map((l, i) => (
              <span
                key={`${l.assetId}:${l.viaIndex ?? ''}`}
                className={cn('motion-safe:animate-seat min-w-0', FILL[i % FILL.length])}
              />
            ))}
          </div>
          <ul
            aria-hidden="true"
            className="flex gap-x-3 overflow-hidden text-caption whitespace-nowrap"
          >
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
        {/* Its figures in a row, each with its label over it. */}
        <dl
          data-ui="candidate-figures"
          className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-2"
        >
          {figures.map(([key, term, value]) => (
            <div key={key} data-figure={key} className="flex flex-col gap-0.5">
              <dt className="text-caption text-muted-foreground">{term}</dt>
              <dd className="text-body font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {/* Everything else it is compared on, and with withdrawals whether it pays them and the
            ways to close a gap: closed until asked for, open where there is a gap to close. */}
        <details
          data-ui="candidate-details"
          open={status ? !status.met : undefined}
          className="border-t border-border pt-2"
        >
          <summary className="w-fit cursor-pointer text-caption text-muted-foreground underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {words.score.title}
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {status && (
              <Withdrawals
                status={status}
                words={words}
                lang={lang}
                currency={currency}
                share={share}
                yieldObs={yieldObs}
                pinLabels={t.pin}
                onWay={onWay}
              />
            )}
            <Score
              scorecard={scorecard}
              status={status}
              words={words}
              lang={lang}
              currency={currency}
              share={share}
              yieldObs={yieldObs}
              exitObs={exitObs}
              fxObs={observed(proposal, 'fx')}
              pinLabels={t.pin}
            />
          </div>
        </details>
      </div>
    </Card>
  );
}

/** A sentence of the dictionary with one figure in it, the figure on its pin where the words put it. */
const SLOT = '\u0000';
function withFigure(write: (figure: string) => string, figure: ReactNode): ReactNode {
  const [before, after = ''] = write(SLOT).split(SLOT);
  return (
    <>
      {before}
      {figure}
      {after}
    </>
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
  yieldObs,
  pinLabels,
  onWay,
}: {
  status: PlanStatus;
  words: Words;
  lang: Lang;
  currency: string;
  share: (bps: number) => string;
  yieldObs: PinSource | null;
  pinLabels: Dictionary['pin'];
  onWay?: (way: string) => void;
}) {
  const w = words.status;
  // the yield observed is a figure like any other: on its pin, inside the sentence that says it
  const observedCarry = (
    <ProvenancePin value={share(status.carryObservedBps)} obs={yieldObs} labels={pinLabels} />
  );
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
          ? withFigure(w.neededOut, observedCarry)
          : status.carryNeededBps === 0
            ? withFigure(w.neededNone, observedCarry)
            : withFigure(
                (observed) => w.needed(share(status.carryNeededBps as number), observed),
                observedCarry,
              )}{' '}
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
  fxObs,
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
  fxObs: PinSource | null;
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
  // a share of the plan's own weights, as the issuer's above: no reading of a market is in it
  rows.push([s.credit, share(scorecard.creditBasisBps)]);
  // what is owed in another currency, in dollars at the rate the plan read
  if (scorecard.openFxUsd !== undefined)
    rows.push([s.fx, pinned(dollars(scorecard.openFxUsd, lang), fxObs)]);
  return (
    <div className="flex flex-col gap-2">
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

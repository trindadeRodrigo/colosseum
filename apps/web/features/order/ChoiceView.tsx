'use client';
import {
  type ChainId,
  currencyOf,
  type PlanCandidateNotShown,
  type PlanScorecard,
  type PlanStatus,
} from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import type { PinSource } from '../../components/ui/provenance';
import { type Dictionary, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { planProvenance } from '../goal/build-plan';
import { dollars } from '../goal/sheet';
import { assetName, formatBps } from './amounts';
import { observed } from './observed';
import type { StoredPlan } from './plan-store';

// The plans one goal built, side by side (gate THREE-PLANS; DESIGN-VAULT section 7): always in the
// order Cover, Spread, Carry, none picked and none marked (section 2.4 of the method note: a default
// or a badge is read as advice). Each shows what it holds, what it is compared on, and with
// withdrawals to come whether it pays them, the carry they need beside the carry observed, and the
// ways to close a gap. The ones the engine left out are listed with why. The person picks one; the buy
// names that candidate's own stored id. On a phone the plans stack and the picker stays in reach.

type Words = Dictionary['plan']['choice'];

export function ChoiceView({
  plans,
  notShown,
  chain,
  blocked,
}: {
  /** Every one a candidate, in the fixed order. */
  plans: StoredPlan[];
  notShown: PlanCandidateNotShown[];
  chain: ChainId;
  /** Why nothing can be bought on this chain now, or null. */
  blocked: string | null;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.plan.choice;
  const headingId = useId();
  const pickerId = useId();
  const reasonId = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = plans.find((p) => p.id === picked) ?? null;
  const nameOf = (p: StoredPlan) => (p.candidate ? words.names[p.candidate.name] : t.plan.title);
  const columns =
    plans.length === 3 ? 'lg:grid-cols-3' : plans.length === 2 ? 'md:grid-cols-2' : '';

  return (
    <div data-ui="plan-choice" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1
          id={headingId}
          className="max-w-(--tf-measure-display) font-display text-h1 font-normal"
        >
          {words.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">
          {words.lead(plans.length, t.chain.names[chain])}
        </p>
      </header>

      <div className={`grid items-start gap-6 ${columns}`}>
        {plans.map((plan) => (
          <Candidate key={plan.id} plan={plan} name={nameOf(plan)} words={words} lang={lang} />
        ))}
      </div>

      {notShown.length > 0 && (
        <section aria-labelledby={`${headingId}-not-shown`} className="flex flex-col gap-2">
          <h2 id={`${headingId}-not-shown`} className="text-[1.125rem]/7 font-medium">
            {words.notShown.title}
          </h2>
          <p className="text-body-sm text-muted-foreground">{words.notShown.lead}</p>
          <ul className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body">
            {notShown.map((n) => (
              <li key={n.candidate} data-candidate={n.candidate}>
                <span className="font-medium">{words.names[n.candidate]}</span>: {n.why}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* One picker for every width: under the plans on a wide screen, held at the foot of the view
          on a phone, where the plans stack and scroll past. */}
      <form
        aria-labelledby={pickerId}
        data-ui="plan-picker"
        className="flex flex-col gap-3 border-t border-border bg-background py-4 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:px-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <fieldset className="flex flex-col gap-2">
          <legend id={pickerId} className="mb-2 text-[0.8125rem]/5 font-medium">
            {words.picker.legend}
          </legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {plans.map((plan) => (
              <label key={plan.id} className="inline-flex min-h-6 items-center gap-2 text-body">
                <input
                  type="radio"
                  name={pickerId}
                  value={plan.id}
                  checked={picked === plan.id}
                  onChange={() => setPicked(plan.id)}
                  className="size-4 accent-primary"
                />
                {nameOf(plan)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col items-start gap-2">
          {chosen && !blocked ? (
            <Link
              href={`/plan/${encodeURIComponent(chosen.id)}/buy`}
              className={buttonClass({ variant: 'primary' })}
            >
              {words.picker.buy(nameOf(chosen))}
            </Link>
          ) : (
            <>
              <Button variant="primary" disabled aria-describedby={reasonId}>
                {chosen ? words.picker.buy(nameOf(chosen)) : t.plan.buy}
              </Button>
              <p id={reasonId} className="max-w-(--tf-measure-body) text-body-sm">
                {blocked ?? words.picker.none}
              </p>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function Candidate({
  plan,
  name,
  words,
  lang,
}: {
  plan: StoredPlan;
  name: string;
  words: Words;
  lang: Lang;
}) {
  const t = useT();
  const titleId = useId();
  const { proposal, candidate } = plan;
  const locale = LOCALE[lang];
  const share = (bps: number) => formatBps(bps, locale);
  const label = planProvenance(proposal);
  const yieldObs = observed(proposal.observations, 'yield');
  const exitObs = observed(proposal.observations, 'liquidity');
  if (!candidate) return null;
  const { scorecard, status } = candidate;
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      data-candidate={candidate.name}
      mock={label !== 'live'}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: label === 'sandbox' ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader title={name} level={2} id={titleId} />
      <CardBody className="clear-both flex flex-col gap-5">
        <p className="text-body-sm text-muted-foreground">{words.aims[candidate.name]}</p>
        {status && (
          <Withdrawals
            status={status}
            words={words}
            lang={lang}
            currency={currencyOf(proposal.sheet)}
            share={share}
          />
        )}
        <Score
          scorecard={scorecard}
          status={status}
          words={words}
          lang={lang}
          currency={currencyOf(proposal.sheet)}
          share={share}
          yieldObs={yieldObs}
          exitObs={exitObs}
          pinLabels={t.pin}
        />
        <div className="flex flex-col gap-2">
          <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.holds}</h3>
          <ul className="flex flex-col text-body-sm">
            {proposal.lines.map((line) => (
              <li
                key={`${line.assetId}:${line.viaIndex ?? ''}`}
                className="flex justify-between gap-4 border-b border-border py-1.5 last:border-b-0"
              >
                <span className="min-w-0 break-words">{assetName(line.assetId)}</span>
                <span className="tabular-nums">
                  {share(line.weightBps)} · {dollars(line.amountUsd, lang)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Link
          href={`/plan/${encodeURIComponent(plan.id)}`}
          className={buttonClass({ variant: 'link' })}
        >
          {words.see(name)}
        </Link>
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
}: {
  status: PlanStatus;
  words: Words;
  lang: Lang;
  currency: string;
  share: (bps: number) => string;
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
      <h3 className="text-[0.8125rem]/5 font-medium">{w.title}</h3>
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
          <h4 className="text-caption text-muted-foreground">{w.ways}</h4>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body-sm">
            {status.ways.map((way) => (
              <li key={way.change}>{way.change}</li>
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
      <h3 className="text-[0.8125rem]/5 font-medium">{s.title}</h3>
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

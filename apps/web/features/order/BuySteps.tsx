'use client';
import type { ChainId } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { Field, Input } from '../../components/ui/Field';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type Funding, FundingStep } from './FundingStep';
import { type BuyOf, fundMock, requestTestFunds, type TestFundsOutcome } from './order-api';
import { gasUnitsFor } from './readiness';
import { TrustNotice } from './TrustNotice';
import { unitsFor } from './units';

// A buy as four steps on one card, one open at a time (Thom, Oct 6): the amount, the funds the wallet
// needs on the plan's chain, what the person trusts, and the review that leads to signing. Above them,
// where the person is: each step's number and name, filled once it is done. Every step can be opened
// again from its heading; "Continue" opens the next one and moves the focus to it. Figures that are not
// live are said once per card, never with a plate on a figure: on the mock the card's hatch band and
// its "Sample figures" line (MOCK-QUIET), on a test network one line at the top (gate BUY-STEPS). The plan's buy and a shared
// portfolio's share it, and so does adding money to a vault; what is checked before an order is made
// stays theirs (`order.blocked`).

export const MIN_USD = 10;
export const MAX_USD = 1_000_000;

export type StepId = 'amount' | 'funds' | 'trust' | 'review';
const STEPS: readonly StepId[] = ['amount', 'funds', 'trust', 'review'];

export type BuyStepsProps = {
  chain: ChainId;
  chainName: string;
  /** The chain runs on the mock. */
  mock: boolean;
  amount: {
    text: string;
    onText: (text: string) => void;
    hint: string;
    /** The amount in dollars, or null while the text is not one from $10 to $1,000,000. */
    value: number | null;
  };
  funding: Funding;
  owner: string | null;
  /** The buy the funding is read for: what POST /v1/testnet/fund is asked about. */
  buyOf: BuyOf;
  /** Read the wallet again. */
  onReadAgain: () => void;
  trust: { accepted: boolean; checked: boolean; onCheck: (yes: boolean) => void };
  order: {
    /** Names the action and the amount. */
    label: string;
    busy: boolean;
    busyLabel: string;
    /** Why the order cannot be made yet, from every step. */
    blocked: string[];
    failure: string | null;
    onReview: () => void;
    /** The sentence over the button, where the buy is not of a plan (an add to a vault). */
    lead?: string;
  };
};

export function BuySteps({
  chain,
  chainName,
  mock,
  amount,
  funding,
  owner,
  buyOf,
  onReadAgain,
  trust,
  order,
}: BuyStepsProps) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const ids = useId();
  const reasonId = useId();
  const [open, setOpen] = useState<StepId>('amount');
  const [confirmed, setConfirmed] = useState(false);
  const [mockBusy, setMockBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestFundsOutcome | null>(null);
  const heads = useRef<Partial<Record<StepId, HTMLButtonElement | null>>>({});
  const moved = useRef(false);

  const read = funding.kind === 'read' ? funding.funding : null;
  const done: Record<StepId, boolean> = {
    amount: confirmed && amount.value !== null,
    funds: read?.ok === true,
    trust: trust.accepted || trust.checked,
    review: false,
  };
  // The label of the whole card: the chain's as it runs now, and what the funding read said.
  const provenance = read?.provenance ?? (mock ? 'mock' : port.network(chain)?.provenance);

  // Opening a step moves the focus to its heading, once a person has moved at all.
  useEffect(() => {
    if (moved.current) heads.current[open]?.focus();
  }, [open]);

  function go(step: StepId) {
    if (open === 'amount' && amount.value !== null) setConfirmed(true);
    moved.current = true;
    setOpen(step);
  }
  const next = (step: StepId) => STEPS[STEPS.indexOf(step) + 1] ?? step;

  async function addMock() {
    setMockBusy(true);
    await fundMock(apiFetch, { chain, cashUsd: Math.max(amount.value ?? 0, MIN_USD) * 2 });
    setMockBusy(false);
    onReadAgain();
  }

  async function askTestFunds() {
    if (!owner || amount.value === null) return;
    setTestBusy(true);
    setTestOutcome(null);
    const outcome = await requestTestFunds(apiFetch, {
      ...buyOf,
      amountUsd: amount.value,
      wallet: owner,
    });
    setTestBusy(false);
    setTestOutcome(outcome);
    // What arrived, read from the chain: the funding line and the table follow it.
    onReadAgain();
  }

  const summary: Record<StepId, string | null> = {
    amount: amount.value === null ? null : dollars(amount.value, lang),
    funds: read
      ? read.ok
        ? t.buy.steps.funds.ready
        : t.buy.steps.funds.short
      : funding.kind === 'reading'
        ? t.buy.steps.funds.reading
        : null,
    trust: done.trust ? t.buy.steps.trust.accepted : t.buy.steps.trust.open,
    review: null,
  };

  const continueButton = (step: StepId, kind: 'button' | 'submit' = 'button') => (
    <Button
      variant="primary"
      type={kind}
      disabled={step === 'amount' ? amount.value === null : !done[step]}
      onClick={kind === 'button' ? () => go(next(step)) : undefined}
    >
      {t.buy.steps.next}
    </Button>
  );

  const panels: Record<StepId, ReactNode> = {
    amount: (
      <form
        className="flex flex-col items-start gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount.value !== null) go('funds');
        }}
      >
        <Field
          label={t.buy.amount.label}
          hint={amount.hint}
          error={amount.text.trim() && amount.value === null ? t.buy.blocked.amount : undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              width="14ch"
              value={amount.text}
              onChange={(e) => amount.onText(e.currentTarget.value)}
            />
          )}
        </Field>
        {continueButton('amount', 'submit')}
      </form>
    ),
    funds: (
      <div className="flex flex-col items-start gap-4">
        <FundingStep
          funding={funding}
          chainName={chainName}
          owner={owner}
          mock={mock}
          units={unitsFor(chain, mock)}
          gasUnits={gasUnitsFor(chain)}
          mockBusy={mockBusy}
          onReadAgain={onReadAgain}
          onMock={addMock}
          testFunds={{ busy: testBusy, outcome: testOutcome, onAsk: askTestFunds }}
        />
        {continueButton('funds')}
      </div>
    ),
    trust: (
      <div className="flex flex-col items-start gap-4">
        <TrustNotice
          chain={chain}
          accepted={trust.accepted}
          checked={trust.checked}
          onCheck={trust.onCheck}
        />
        {continueButton('trust')}
      </div>
    ),
    review: (
      <div className="flex flex-col items-start gap-3">
        <p className="max-w-(--tf-measure-body) text-body">
          {order.lead ??
            t.buy.steps.reviewLead(
              amount.value === null ? '' : dollars(amount.value, lang),
              chainName,
            )}
        </p>
        <Button
          variant="primary"
          busy={order.busy}
          busyLabel={order.busyLabel}
          disabled={order.blocked.length > 0}
          aria-describedby={order.blocked.length > 0 ? reasonId : undefined}
          onClick={order.onReview}
        >
          {order.label}
        </Button>
        {order.blocked.length > 0 && (
          <ul id={reasonId} className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
            {order.blocked.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {order.failure && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{order.failure}</span>
          </p>
        )}
      </div>
    ),
  };

  return (
    <Card
      as="section"
      aria-label={t.buy.steps.label}
      // On the mock: the hatch band and its one quiet line at the card's foot (MOCK-QUIET).
      mock={provenance === 'mock'}
      mockLabels={{ announce: t.shell.mockAnnounce }}
      className="max-w-3xl"
    >
      <div data-ui="buy-steps">
        {provenance === 'sandbox' && (
          // A test network's figures are real reads, not samples: one quiet line says where they
          // are from, never a plate on a figure (gate BUY-STEPS).
          <p
            data-ui="data-note"
            className="px-6 pt-5 text-caption text-muted-foreground [overflow-wrap:anywhere]"
          >
            {t.buy.steps.note.testNetwork(chainName)}
          </p>
        )}
        <ol
          data-ui="buy-progress"
          aria-label={t.buy.steps.label}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 p-6 text-body-sm sm:gap-x-5"
        >
          {STEPS.map((step, i) => (
            <li
              key={step}
              data-step={step}
              data-done={done[step]}
              aria-current={open === step ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-2',
                open === step ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              <StepNumber n={i + 1} done={done[step]} current={open === step} />
              {/* On a phone the open step alone is named; the others keep their name for a reader. */}
              <span className={cn(open !== step && 'max-sm:sr-only')}>
                {t.buy.steps.names[step]}
              </span>
              {done[step] && <span className="sr-only">, {t.buy.steps.done}</span>}
            </li>
          ))}
        </ol>
        {STEPS.map((step, i) => {
          const head = `${ids}-${step}-head`;
          const panel = `${ids}-${step}-panel`;
          const isOpen = open === step;
          return (
            <section
              key={step}
              data-ui="buy-step"
              data-step={step}
              data-open={isOpen}
              data-done={done[step]}
              aria-labelledby={head}
              className="border-t border-border"
            >
              <h2 className="text-h4 font-semibold">
                <button
                  ref={(el) => {
                    heads.current[step] = el;
                  }}
                  id={head}
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={panel}
                  onClick={() => go(step)}
                  className="flex w-full items-center gap-3 px-6 py-4 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <StepNumber n={i + 1} done={done[step]} current={isOpen} />
                  <span className="min-w-0 flex-1">
                    {t.buy.steps.names[step]}
                    {done[step] && <span className="sr-only">, {t.buy.steps.done}</span>}
                  </span>
                  {!isOpen && summary[step] && (
                    <span className="min-w-0 text-right text-body-sm font-normal text-muted-foreground [overflow-wrap:anywhere]">
                      {summary[step]}
                    </span>
                  )}
                </button>
              </h2>
              <div id={panel} hidden={!isOpen} className="px-6 pb-6">
                {panels[step]}
              </div>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

/** A step's number in a square: outlined until it is done, filled in the wood once it is. */
function StepNumber({ n, done, current }: { n: number; done: boolean; current: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid size-6 shrink-0 place-items-center rounded-sm border font-mono text-caption font-medium',
        done
          ? 'border-primary bg-primary text-primary-foreground'
          : current
            ? 'border-foreground text-foreground'
            : 'border-input text-muted-foreground',
      )}
    >
      {n}
    </span>
  );
}

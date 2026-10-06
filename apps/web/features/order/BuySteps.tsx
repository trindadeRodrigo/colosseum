'use client';
import type { ChainId } from '@colosseum/schemas';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type Funding, FundingStep } from './FundingStep';
import { fundMock, requestTestFunds, type TestFundsOutcome } from './order-api';
import { gasUnitsFor } from './readiness';
import { StepCard } from './StepCard';
import { TrustNotice } from './TrustNotice';
import { unitsFor } from './units';

// A buy as four steps on one card, one open at a time (Thom, Oct 6): the amount, the funds the wallet
// needs on the plan's chain, what the person trusts, and the review that leads to signing. Above them,
// where the person is: each step's number and name, filled once it is done. Every step can be opened
// again from its heading; "Continue" opens the next one and moves the focus to it. Figures that are not
// live are said once per card, never with a plate on a figure: on the mock the card's hatch band and
// its "Sample figures" line (MOCK-QUIET), on a test network one line at the top (gate BUY-STEPS). The plan's buy and a shared
// portfolio's share it; what is checked before an order is made stays theirs (`order.blocked`).

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
  buyOf: { proposalId: string } | { family: string };
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
  const reasonId = useId();
  const [open, setOpen] = useState<StepId>('amount');
  const [confirmed, setConfirmed] = useState(false);
  const [mockBusy, setMockBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestFundsOutcome | null>(null);

  const read = funding.kind === 'read' ? funding.funding : null;
  const done: Record<StepId, boolean> = {
    amount: confirmed && amount.value !== null,
    funds: read?.ok === true,
    trust: trust.accepted || trust.checked,
    review: false,
  };
  // The label of the whole card: the chain's as it runs now, and what the funding read said.
  const provenance = read?.provenance ?? (mock ? 'mock' : port.network(chain)?.provenance);

  function go(step: StepId) {
    if (open === 'amount' && amount.value !== null) setConfirmed(true);
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
          {t.buy.steps.reviewLead(
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
    <StepCard
      ui="buy"
      label={t.buy.steps.label}
      doneWord={t.buy.steps.done}
      steps={STEPS.map((id) => ({
        id,
        name: t.buy.steps.names[id],
        done: done[id],
        summary: summary[id],
        panel: panels[id],
      }))}
      open={open}
      onOpen={go}
      // On the mock: the hatch band and its one quiet line at the card's foot (MOCK-QUIET). A test
      // network's figures are real reads, not samples: one quiet line says where they are from.
      mock={provenance === 'mock'}
      mockAnnounce={t.shell.mockAnnounce}
      note={provenance === 'sandbox' ? t.buy.steps.note.testNetwork(chainName) : null}
    />
  );
}

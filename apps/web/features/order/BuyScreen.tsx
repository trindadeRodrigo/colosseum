'use client';
import { chainFamily, TRUST_STATUS } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { PAGE_TITLE } from '../../components/ui/heading';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { BuySteps, MAX_USD, MIN_USD } from './BuySteps';
import type { Funding } from './FundingStep';
import { type OrderOutcome, placeOrder, readFunding } from './order-api';
import { acceptTrust, keepOrder, trustAccepted } from './order-record';
import { PlanGate } from './PlanGate';
import { usePlan } from './use-plan';

// Buying a plan, in four steps (BuySteps): the amount, the plan's own to start with; what the wallet is
// missing for it on the plan's chain (GET /v1/funding, cash and network fees); the trust notice
// accepted once before the first deposit; and one primary button that names the action and the
// amount. It makes the order (POST /v1/orders) and leads to the order screen, where every step is
// reviewed before anything is signed. Nothing is signed here.

export type { Funding };
export { MAX_USD, MIN_USD };

/** The amount a buy starts at: the one the plan was built for. */
export const startingAmount = (plan: { proposal: { sheet: { amountUsd: number } } }) =>
  String(plan.proposal.sheet.amountUsd);

export function BuyScreen({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const state = usePlan(id);
  const [text, setText] = useState<string | null>(null);
  const [funding, setFunding] = useState<Funding>({ kind: 'idle' });
  const [round, setRound] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<OrderOutcome['kind'] | 'noStore' | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const asked = useRef(0);

  const ready = state.kind === 'ready' ? state : null;
  const plan = ready?.plan ?? null;
  const chain = ready?.chain ?? null;
  const owner = chain ? (port.active(chainFamily(chain))?.address ?? null) : null;
  const typed = text ?? (plan ? startingAmount(plan) : '');
  const parsed = parseNumber(typed, lang);
  const amount =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;

  // What the wallet is missing for this amount, read again a moment after the amount stops changing.
  // Only the latest read is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the wallet again
  useEffect(() => {
    if (!plan || !owner || amount === null) {
      setFunding({ kind: 'idle' });
      return;
    }
    asked.current += 1;
    const mine = asked.current;
    setFunding({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFunding(apiFetch, {
        proposalId: plan.id,
        amountUsd: amount,
        wallet: owner,
      });
      if (asked.current === mine) setFunding(read);
    }, 300);
    return () => clearTimeout(timer);
  }, [plan, owner, amount, apiFetch, round]);

  if (!ready || !plan || !chain) {
    const gate = state.kind === 'ready' ? { kind: 'loading' as const } : state;
    return <PlanGate state={gate} next={`/plan/${encodeURIComponent(id)}/buy`} />;
  }

  const chainName = t.chain.names[chain];
  // A plan's own vault follows nothing, so the keeper's limits are not among its short points.
  const accepted = trustAccepted(port.userId, TRUST_STATUS.textVersion, false);
  const read = funding.kind === 'read' ? funding.funding : null;
  const blocked = [
    ...(!ready.buyable ? [t.plan.chainNotReady(chainName)] : []),
    ...(ready.off ? [t.plan.chainOff(chainName)] : []),
    ...(!owner ? [t.buy.blocked.wallet] : []),
    ...(amount === null ? [t.buy.blocked.amount] : []),
    ...(amount !== null && owner && !read?.ok ? [t.buy.blocked.funding] : []),
    ...(!accepted && !ticked ? [t.buy.blocked.trust] : []),
  ];

  async function review() {
    if (!plan || !chain || !owner || amount === null) return;
    setPlacing(true);
    setFailure(null);
    setFailureCode(null);
    const outcome = await placeOrder(apiFetch, {
      proposalId: plan.id,
      amountUsd: amount,
      chain,
      owner,
    });
    if (outcome.kind !== 'placed') {
      setPlacing(false);
      setFailure(outcome.kind);
      if (outcome.kind === 'code') setFailureCode(outcome.code);
      return;
    }
    if (!accepted && port.userId) acceptTrust(port.userId, TRUST_STATUS.textVersion, false);
    const kept = keepOrder({
      orderId: outcome.order.id,
      userId: port.userId ?? '',
      proposalId: plan.id,
      chain,
      amountUsd: amount,
      lines: plan.proposal.lines,
      approved: null,
      ...(plan.fromLink ? { linked: true as const } : {}),
      goal: {
        sheet: plan.proposal.sheet,
        card: plan.proposal.card,
        verdict: plan.proposal.verdict ?? null,
        placedAt: new Date().toISOString(),
      },
    });
    if (!kept) {
      setPlacing(false);
      setFailure('noStore');
      return;
    }
    router.push(`/orders/${encodeURIComponent(outcome.order.id)}`);
  }

  const failureSentence =
    failure === null
      ? null
      : failure === 'code' && failureCode
        ? t.buy.failure[failureCode as keyof typeof t.buy.failure]
        : failure === 'signed-out'
          ? t.buy.failure.signedOut
          : failure === 'no-chain'
            ? t.buy.failure.noChain
            : failure === 'no-plan'
              ? t.buy.failure.noPlan
              : failure === 'busy'
                ? t.shell.slowDown
                : failure === 'noStore'
                  ? t.buy.failure.noStore
                  : failure === 'unreadable'
                    ? t.buy.failure.unreadable
                    : failure === 'refused'
                      ? t.buy.failure.refused
                      : t.buy.failure.unreachable;

  return (
    <div data-ui="buy-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 className={PAGE_TITLE}>{t.buy.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.buy.lead(chainName)}</p>
      </header>
      <BuySteps
        chain={chain}
        chainName={chainName}
        mock={ready.mock}
        amount={{
          text: typed,
          onText: setText,
          // The plan's limits are in dollars at its own amount: another amount is said plainly.
          hint: (amount !== null && amount !== plan.proposal.sheet.amountUsd
            ? t.buy.amount.other
            : t.buy.amount.hint)(dollars(plan.proposal.sheet.amountUsd, lang)),
          value: amount,
        }}
        funding={funding}
        owner={owner}
        buyOf={{ proposalId: plan.id }}
        onReadAgain={() => setRound((n) => n + 1)}
        // A plan's vault follows nothing: the keeper does not trade it, so its limits are not
        // among the short points (they stay in the full list).
        trust={{ accepted, checked: ticked, onCheck: setTicked, keeper: false }}
        order={{
          label: t.buy.review(
            amount === null ? dollars(plan.proposal.sheet.amountUsd, lang) : dollars(amount, lang),
          ),
          busy: placing,
          busyLabel: t.buy.reviewing,
          blocked,
          failure: failureSentence,
          onReview: review,
        }}
      />
    </div>
  );
}

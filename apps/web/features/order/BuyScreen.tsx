'use client';
import { chainFamily } from '@colosseum/schemas';
import { useState } from 'react';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { PAGE_TITLE } from '../../components/ui/heading';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import type { Funding } from './FundingStep';
import {
  AmountField,
  InvestCard,
  type InvestEmbedded,
  type InvestPlaced,
  MAX_USD,
  MIN_USD,
} from './InvestCard';
import { placeOrder } from './order-api';
import { keepOrder } from './order-record';
import { PlanGate } from './PlanGate';
import { targetsOfPlan } from './plan-terms';
import { basketOfPlan, deploymentsFor } from './readiness';
import { usePlan } from './use-plan';
import { BuyScreenWait } from './waits';

// Buying a plan, on one card with one press (InvestCard, gate INVEST-ONE-PRESS): the amount, the plan's
// own to start with, then the card, which shows what the wallet is missing only when it is short, the
// trust notice the first time, and the order as our server made it (POST /v1/orders) with the button
// that names the action and the amount. The press approves that order as shown and runs its steps;
// the order's own page (/orders/{id}) stays where a stopped order is picked up again. With
// `embedded`, another screen gives the amount and mounts the card alone.

export type { Funding };
export { MAX_USD, MIN_USD };

/** The amount a buy starts at: the one the plan was built for. */
export const startingAmount = (plan: { proposal: { sheet: { amountUsd: number } } }) =>
  String(plan.proposal.sheet.amountUsd);

export function BuyScreen({ id, embedded }: { id: string; embedded?: InvestEmbedded }) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const state = usePlan(id);
  const [text, setText] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const ready = state.kind === 'ready' ? state : null;
  const plan = ready?.plan ?? null;
  const chain = ready?.chain ?? null;
  const owner = chain ? (port.active(chainFamily(chain))?.address ?? null) : null;
  const typed = text ?? (plan ? startingAmount(plan) : '');
  const parsed = parseNumber(typed, lang);
  const own =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;
  const amount = embedded ? embedded.amount : own;

  if (!ready || !plan || !chain) {
    const gate = state.kind === 'ready' ? { kind: 'loading' as const } : state;
    // On its own page the wait is the page in outline; inside another screen, that screen's own.
    if (gate.kind === 'loading' && !embedded) return <BuyScreenWait />;
    return <PlanGate state={gate} next={`/plan/${encodeURIComponent(id)}/buy`} />;
  }

  const chainName = t.chain.names[chain];
  const blocked = [
    ...(!ready.buyable ? [t.plan.chainNotReady(chainName)] : []),
    ...(ready.off ? [t.plan.chainOff(chainName)] : []),
  ];

  /** Makes the order for this amount and keeps the plan with it, as the plan screen showed it. */
  async function place(amountUsd: number): Promise<InvestPlaced> {
    if (!plan || !chain || !owner) return { failure: t.buy.blocked.wallet };
    const outcome = await placeOrder(apiFetch, {
      proposalId: plan.id,
      amountUsd,
      chain,
      owner,
    });
    if (outcome.kind !== 'placed')
      return {
        failure:
          outcome.kind === 'code'
            ? (t.buy.failure[outcome.code as keyof typeof t.buy.failure] ?? t.buy.failure.refused)
            : outcome.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : outcome.kind === 'no-chain'
                ? t.buy.failure.noChain
                : outcome.kind === 'no-plan'
                  ? t.buy.failure.noPlan
                  : outcome.kind === 'busy'
                    ? t.shell.slowDown
                    : outcome.kind === 'unreadable'
                      ? t.buy.failure.unreadable
                      : outcome.kind === 'refused'
                        ? t.buy.failure.refused
                        : t.buy.failure.unreachable,
      };
    const kept = keepOrder({
      orderId: outcome.order.id,
      userId: port.userId ?? '',
      proposalId: plan.id,
      chain,
      amountUsd,
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
    if (!kept) return { failure: t.buy.failure.noStore };
    return {
      orderId: outcome.order.id,
      expiresAt: outcome.order.expiresAt,
      // The vault's number, to find the vault once the buy is done: the order's, or the plan's
      // own for an order that states none (the buyer's own for a plan made from a link).
      basketId: outcome.order.basketId ?? basketOfPlan(plan.id, plan.fromLink ? port.userId : null),
    };
  }

  // What the amount is split into: the plan's own weights on its chain, cash left out.
  const cash = deploymentsFor(chain, ready.mock)?.[chain]?.cash;
  const card = (
    <InvestCard
      chain={chain}
      chainName={chainName}
      mock={ready.mock}
      amount={amount}
      owner={owner}
      userId={port.userId}
      buyOf={{ proposalId: plan.id }}
      holdings={cash ? targetsOfPlan(plan.proposal.lines, chain, cash) : null}
      // A plan's vault follows nothing: the keeper does not trade it, so its limits are not
      // among the short points (they stay in the full list).
      keeper={false}
      blocked={blocked}
      place={place}
      onProgress={(progress) => {
        setLocked(true);
        embedded?.onProgress?.(progress);
      }}
      onDone={embedded?.onDone}
      onStopped={embedded?.onStopped}
      // On its own page the amount is the field's; inside another screen it is the goal's, and that
      // screen changes it (and the plan built for it).
      onAmount={embedded ? embedded.onAmount : (next) => setText(String(next))}
      amountFrom={embedded ? 'goal' : 'field'}
    />
  );
  if (embedded) return card;

  return (
    <div data-ui="buy-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 className={PAGE_TITLE}>{t.buy.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.buy.lead(chainName)}</p>
      </header>
      <AmountField
        text={typed}
        onText={setText}
        // The plan's limits are in dollars at its own amount: another amount is said plainly.
        hint={(own !== null && own !== plan.proposal.sheet.amountUsd
          ? t.buy.amount.other
          : t.buy.amount.hint)(dollars(plan.proposal.sheet.amountUsd, lang))}
        value={own}
        disabled={locked}
      />
      {card}
    </div>
  );
}

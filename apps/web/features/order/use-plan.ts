'use client';
import type { ChainId, PlanCandidateNotShown } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import {
  readLinkedPlan,
  recallChoice,
  recallPlan,
  rememberPlan,
  type StoredPlan,
} from './plan-store';
import { chainReady, onMock } from './readiness';

// What the plan screen and the buy screen stand on: the person, their chain, and the plan with this id
// as this tab kept it, or, for a plan made from a link (an agent's, AGT-2), as the API reads it back.
// A plan lives on one chain (gate ONE-CHAIN): one made for another chain than the person's is not
// offered for buying. The id may also name the candidates one goal built (gate THREE-PLANS): then
// `choice` holds them all, in their fixed order, and `plan` is the first of them.

export type PlanState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** The person's chain is not known, or not chosen: the account says why. */
  | { kind: 'no-chain' }
  | { kind: 'missing' }
  | { kind: 'other-chain'; planChain: ChainId; chain: ChainId }
  | {
      kind: 'ready';
      plan: StoredPlan;
      /** The candidates this id names, when it names a choice rather than one plan. */
      choice: { plans: StoredPlan[]; notShown: PlanCandidateNotShown[] } | null;
      chain: ChainId;
      /** The chain runs on the mock. */
      mock: boolean;
      /** A deployment is committed for the chain's network: an order there can be signed. */
      buyable: boolean;
      /** Our server has the chain switched off. */
      off: boolean;
    };

export function usePlan(id: string): PlanState {
  const port = useWalletPort();
  const { account } = useAccount();
  const [plan, setPlan] = useState<StoredPlan | null | undefined>(undefined);
  const [choice, setChoice] = useState<{
    plans: StoredPlan[];
    notShown: PlanCandidateNotShown[];
  } | null>(null);
  const apiFetch = useApiFetch();
  const userId = port.userId;
  useEffect(() => {
    const chosen = recallChoice(id, userId);
    setChoice(chosen);
    if (chosen) return setPlan(chosen.plans[0] ?? null);
    const kept = recallPlan(id, userId);
    if (kept || !userId) return setPlan(kept);
    // Not built in this tab: it may be a plan made from a link, which the API reads back by its id.
    let mine = true;
    setPlan(undefined);
    void readLinkedPlan(apiFetch, id).then((proposal) => {
      if (!mine) return;
      if (!proposal) return setPlan(null);
      const linked: StoredPlan = { id, userId, proposal, rollUp: null, fromLink: true };
      rememberPlan(linked);
      setPlan(linked);
    });
    return () => {
      mine = false;
    };
  }, [id, userId, apiFetch]);

  if (port.status === 'loading' || account.status === 'loading' || plan === undefined)
    return { kind: 'loading' };
  if (port.status === 'signed-out' || account.status === 'signed-out')
    return { kind: 'signed-out' };
  if (!plan) return { kind: 'missing' };
  if (account.status !== 'ready') return { kind: 'no-chain' };
  const chain = account.chain;
  const planChain = plan.proposal.sheet.chains[0] ?? plan.proposal.recipes[0]?.chain;
  const elsewhere = (p: StoredPlan) =>
    (p.proposal.sheet.chains[0] ?? p.proposal.recipes[0]?.chain) !== chain ||
    p.proposal.recipes.some((r) => r.chain !== chain) ||
    p.proposal.lines.some((l) => l.chain !== chain);
  if (planChain !== chain || (choice?.plans ?? [plan]).some(elsewhere))
    return { kind: 'other-chain', planChain: planChain ?? chain, chain };
  const mock = onMock(port, chain);
  return {
    kind: 'ready',
    plan,
    choice,
    chain,
    mock,
    buyable: chainReady(chain, mock),
    off: port.network(chain)?.on === false,
  };
}

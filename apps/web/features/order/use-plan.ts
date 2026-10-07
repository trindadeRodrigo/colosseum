'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { readStoredPlan, recallPlan, rememberPlan, type StoredPlan } from './plan-store';
import { chainReady, onMock } from './readiness';

// What the plan screen and the buy screen stand on: the person, the plan with this id as this tab kept
// it, or as the API reads it back (the person's own in a tab that did not build it, or one made from a
// link, an agent's, AGT-2), and the plan's chain. A plan lives on one chain (gate ONE-CHAIN) and is bought there, whatever the person's current
// chain is (CHAIN-SWITCH). One on a chain no wallet of theirs signs on is not offered for buying.

export type PlanState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** The person's chain is not known, or not chosen: the account says why. */
  | { kind: 'no-chain' }
  | { kind: 'missing' }
  /** On a chain no wallet of the person's signs on. */
  | { kind: 'unsignable'; planChain: ChainId }
  /** Spread over more than one chain: made before a plan lived on one. */
  | { kind: 'split' }
  | {
      kind: 'ready';
      plan: StoredPlan;
      /** The plan's chain. */
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
  const apiFetch = useApiFetch();
  const userId = port.userId;
  useEffect(() => {
    const kept = recallPlan(id, userId);
    if (kept || !userId) return setPlan(kept);
    // Not built in this tab: the API reads it back by its id, the person's own or one made from a link.
    let mine = true;
    setPlan(undefined);
    void readStoredPlan(apiFetch, id).then((read) => {
      if (!mine) return;
      if (!read) return setPlan(null);
      // The risk roll-up is not stored with a plan: the plan screen shows none for one read back.
      const stored: StoredPlan = {
        id,
        userId,
        proposal: read.proposal,
        rollUp: null,
        readBack: true,
        ...(read.fromLink ? { fromLink: true as const } : {}),
      };
      rememberPlan(stored);
      setPlan(stored);
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
  const chain = plan.proposal.sheet.chains[0] ?? plan.proposal.recipes[0]?.chain ?? account.chain;
  if (
    plan.proposal.sheet.chains.length > 1 ||
    plan.proposal.recipes.some((r) => r.chain !== chain) ||
    plan.proposal.lines.some((l) => l.chain !== chain)
  )
    return { kind: 'split' };
  if (!account.options.includes(chain)) return { kind: 'unsignable', planChain: chain };
  const mock = onMock(port, chain);
  return {
    kind: 'ready',
    plan,
    chain,
    mock,
    buyable: chainReady(chain, mock),
    off: port.network(chain)?.on === false,
  };
}

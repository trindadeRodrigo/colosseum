'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import {
  forgetPlan,
  readStoredPlan,
  recallPlan,
  rememberPlan,
  type StoredPlan,
} from './plan-store';
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
    // One read path: the browser's copy first, so the screen opens at once with its risk roll-up,
    // then the server's (`readStoredPlan`), which is the last word. A plan it says is gone, or
    // another person's, is dropped and not shown; when it does not answer, the copy stands.
    const kept = recallPlan(id, userId);
    if (!userId) return setPlan(kept);
    let mine = true;
    setPlan(kept ?? undefined);
    // The route reads a sign-in and needs none, so tokens gone stale are answered as nobody is: a
    // person's own plan then reads as gone. Asked once more with fresh tokens before that is
    // believed, and before the copy kept here is dropped.
    const read = async () => {
      const first = await readStoredPlan(apiFetch, id);
      return first === 'gone' ? readStoredPlan(apiFetch, id, true) : first;
    };
    void read().then((read) => {
      if (!mine) return;
      if (read === 'gone') {
        forgetPlan(id);
        return setPlan(null);
      }
      // the copy kept here stands while the server has the plan, or says nothing
      if (kept) return;
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

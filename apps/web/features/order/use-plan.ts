'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { recallPlan, type StoredPlan } from './plan-store';
import { chainReady, onMock } from './readiness';

// What the plan screen and the buy screen stand on: the person, their chain, and the plan with this id
// as this tab kept it. A plan lives on one chain (gate ONE-CHAIN): one made for another chain than the
// person's is not offered for buying.

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
  const userId = port.userId;
  useEffect(() => {
    setPlan(recallPlan(id, userId));
  }, [id, userId]);

  if (port.status === 'loading' || account.status === 'loading' || plan === undefined)
    return { kind: 'loading' };
  if (port.status === 'signed-out' || account.status === 'signed-out')
    return { kind: 'signed-out' };
  if (!plan) return { kind: 'missing' };
  if (account.status !== 'ready') return { kind: 'no-chain' };
  const chain = account.chain;
  const planChain = plan.proposal.sheet.chains[0] ?? plan.proposal.recipes[0]?.chain;
  if (
    planChain !== chain ||
    plan.proposal.recipes.some((r) => r.chain !== chain) ||
    plan.proposal.lines.some((l) => l.chain !== chain)
  )
    return { kind: 'other-chain', planChain: planChain ?? chain, chain };
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

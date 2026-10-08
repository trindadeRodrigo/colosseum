'use client';
import { useAccount } from '../account/AccountProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { GoalConversation } from './GoalConversation';

/** `/goal` is the strategy conversation, keyed to the person, their chain and its network. */
export function GoalEntry() {
  const { account, chain } = useAccount();
  const port = useWalletPort();
  const network = chain ? port.network(chain) : null;
  return (
    <GoalConversation
      key={`${port.userId}:${chain}:${network?.provenance}`}
      userId={port.userId}
      chain={chain}
      provenance={network?.provenance ?? null}
      ready={port.status === 'ready' && account.status === 'ready' && network?.on === true}
    />
  );
}

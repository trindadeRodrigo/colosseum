'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useAccount } from '../account/AccountProvider';
import { chainReady, deploymentsFor, onMock, publishableOn } from '../order/readiness';
import { useWalletPort } from '../wallet/WalletProvider';

// Who is looking at a shared-portfolio screen, and on which chain (gate ONE-CHAIN): a signed-in person
// is shown, offered and asked about their own chain only. Someone signed out sees every chain and is
// offered nothing.

export type SharedPerson =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** Signed in, with no chain known or chosen yet. */
  | { kind: 'no-chain' }
  | {
      kind: 'ready';
      chain: ChainId;
      /** The wallet of that chain's family, which owns every order made here. */
      owner: string | null;
      userId: string | null;
      mock: boolean;
      /** A deployment is committed for the chain's network: an order there can be signed. */
      signable: boolean;
      /** Our server has the chain switched off. */
      off: boolean;
      /** A portfolio can be published from here: on EVM, only where the deployment names its registry. */
      publishable: boolean;
    };

export function useSharedPerson(): SharedPerson {
  const port = useWalletPort();
  const { account } = useAccount();
  if (port.status === 'loading' || account.status === 'loading') return { kind: 'loading' };
  if (port.status === 'signed-out' || account.status === 'signed-out')
    return { kind: 'signed-out' };
  if (account.status !== 'ready') return { kind: 'no-chain' };
  const chain = account.chain;
  const mock = onMock(port, chain);
  return {
    kind: 'ready',
    chain,
    owner: port.active(chainFamily(chain))?.address ?? null,
    userId: port.userId,
    mock,
    signable: chainReady(chain, mock),
    off: port.network(chain)?.on === false,
    publishable: publishableOn(deploymentsFor(chain, mock)?.[chain]),
  };
}

/** An address cut to its ends for a line of text; the whole one stays in the title and the copy. */
export const shortAddress = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useAccount } from '../account/AccountProvider';
import { chainReady, deploymentsFor, onMock, publishableOn } from '../order/readiness';
import { useWalletPort } from '../wallet/WalletProvider';

// Who is looking at a shared-portfolio screen, and on which chain. A thing that lives on one chain (a
// recipe, a vault, a buy: gate ONE-CHAIN) is asked about on its own chain, with the person's wallet
// there (`useSharedPerson(chain)`, gate CHAIN-AT-THE-PLAN); with no chain named it is the chain the
// person's new plans start on. Someone signed out sees every chain and is offered nothing.

export type SharedPerson =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  /** Signed in, with no chain known or chosen yet. */
  | { kind: 'no-chain' }
  /** Signed in, and no wallet of theirs signs on the chain asked about. */
  | { kind: 'no-wallet'; chain: ChainId }
  | {
      kind: 'ready';
      chain: ChainId;
      /** The chains a wallet of theirs signs on: what they can buy, follow and withdraw on. */
      held: readonly ChainId[];
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

/** `on`: the chain of the thing on the screen. Left out, the chain the person's new plans start on. */
export function useSharedPerson(on?: ChainId | null): SharedPerson {
  const port = useWalletPort();
  const { account } = useAccount();
  if (port.status === 'loading' || account.status === 'loading') return { kind: 'loading' };
  if (port.status === 'signed-out' || account.status === 'signed-out')
    return { kind: 'signed-out' };
  if (account.status !== 'ready') return { kind: 'no-chain' };
  const chain = on ?? account.chain;
  // Asked about a chain: one no wallet of theirs signs on is said so, never offered.
  if (on && !account.options.includes(on)) return { kind: 'no-wallet', chain: on };
  const mock = onMock(port, chain);
  return {
    kind: 'ready',
    chain,
    held: account.options,
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

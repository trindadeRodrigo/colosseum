'use client';
import type { ChainId } from '@colosseum/schemas';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { fetchPerson, localPerson, type Person, PersonError, storeChain } from './person';

// The signed-in person and the one chain their plan lives on, for every product screen. The chain is
// the API's to say (GET /v1/me): the chain of the outside wallet a person connected, or the one they
// chose when they made a wallet here. It is asked for once per person, and read again on every
// device, so a second device lands on the same chain without asking.

export type Account =
  /** The wallet is loading, or the API is being asked. */
  | { status: 'loading' }
  | { status: 'signed-out' }
  /** The API did not say. Nothing is assumed in its place. */
  | { status: 'unknown' }
  /** Signed in, with no wallet linked to the sign-in: there is no chain to have. */
  | { status: 'no-wallet' }
  /** A wallet made here, and no chain chosen yet: the one time it is asked. */
  | { status: 'needs-chain'; options: ChainId[] }
  | { status: 'ready'; chain: ChainId; source: 'picked' | 'wallet' };

export type AccountValue = {
  account: Account;
  /**
   * The person is the throwaway wallet of development: the API has no account for them, so their
   * chain is worked out here and kept only while the page is open. Shown with the MOCK plate.
   */
  mock: boolean;
  /** Stores the choice. Throws a `PersonError` whose kind says why it was not stored. */
  pick(chain: ChainId): Promise<void>;
  /** Asks the API again, after it did not answer. */
  retry(): void;
};

const AccountContext = createContext<AccountValue | null>(null);

type Read = { key: string; person: Person | null };

export function AccountProvider({ children }: { children: ReactNode }) {
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const [read, setRead] = useState<Read | null>(null);
  const [round, setRound] = useState(0);
  const latest = useRef({ port, apiFetch });
  latest.current = { port, apiFetch };

  // Who is signed in, with which wallets. A new person or a new wallet is read again; the same ones
  // are not, however often the port is rebuilt.
  const key =
    port.status === 'ready'
      ? [port.userId, ...port.accounts.map((a) => `${a.family}:${a.address}:${a.kind}`)].join('|')
      : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks again; the port and the fetch are read as they are when the effect runs
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const { port: now, apiFetch: call } = latest.current;
    const done = (person: Person | null) => {
      if (live) setRead({ key, person });
    };
    if (now.test) done(localPerson(now.userId ?? 'test', now.accounts, null));
    else fetchPerson(call).then(done, () => done(null));
    return () => {
      live = false;
    };
  }, [key, round]);

  const pick = useCallback(
    async (chain: ChainId) => {
      const { port: now, apiFetch: call } = latest.current;
      if (key === null) throw new PersonError('signed_out');
      if (now.test) {
        setRead({ key, person: localPerson(now.userId ?? 'test', now.accounts, chain) });
        return;
      }
      try {
        setRead({ key, person: await storeChain(call, chain) });
      } catch (e) {
        // Chosen before, on another device or in another tab: read where the plan does live.
        if (e instanceof PersonError && e.kind === 'taken') setRound((n) => n + 1);
        throw e;
      }
    },
    [key],
  );
  const retry = useCallback(() => {
    setRead(null);
    setRound((n) => n + 1);
  }, []);

  const account = useMemo((): Account => {
    if (port.status === 'loading') return { status: 'loading' };
    if (port.status === 'signed-out' || key === null) return { status: 'signed-out' };
    if (!read || read.key !== key) return { status: 'loading' };
    const person = read.person;
    if (!person) return { status: 'unknown' };
    if (person.chain)
      return { status: 'ready', chain: person.chain, source: person.chainSource ?? 'picked' };
    if (person.chainOptions.length === 0) return { status: 'no-wallet' };
    return { status: 'needs-chain', options: person.chainOptions };
  }, [port.status, key, read]);

  const value = useMemo(
    () => ({ account, mock: port.test, pick, retry }),
    [account, port.test, pick, retry],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount() needs <AccountProvider> above it');
  return value;
}

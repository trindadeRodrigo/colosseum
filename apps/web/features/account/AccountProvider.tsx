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
import { forgetGoalDraft } from '../goal/draft';
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
  /**
   * The API did not say. Nothing is assumed in its place. `why` is for the sentence: it did not
   * answer, it does not know this sign-in any more (401), it was sent no identity token (401), or it
   * asked for fewer requests (429).
   */
  | { status: 'unknown'; why: Unknown }
  /**
   * Signed in, with no wallet to have a chain: one a passkey sign-in owes the person could not be
   * made, or none is linked to the sign-in.
   */
  | { status: 'no-wallet' }
  /** A wallet made here, and no chain chosen yet: the one time it is asked. */
  | { status: 'needs-chain'; options: ChainId[] }
  | { status: 'ready'; chain: ChainId; source: 'picked' | 'wallet' };

export type Unknown = 'unreachable' | 'signed_out' | 'no_identity' | 'busy';

export type AccountValue = {
  account: Account;
  /**
   * The person is the throwaway wallet of development: the API has no account for them, so their
   * chain is worked out here and kept only while the page is open. Shown with the MOCK plate.
   */
  mock: boolean;
  /** Stores the choice. Throws a `PersonError` whose kind says why it was not stored. */
  pick(chain: ChainId): Promise<void>;
  /**
   * The chain this person tried to choose when another had been stored before, on another device or
   * in another tab. The account then says where the plan does live, and the screen says why the
   * choice was not kept. Null otherwise.
   */
  overruled: ChainId | null;
  /** Asks the API again, after it did not answer. */
  retry(): void;
};

const AccountContext = createContext<AccountValue | null>(null);

type Read = { key: string; person: Person | null; why?: Unknown };

/** Why the API did not say who is signed in, as far as a person can do something about it. */
const whyNot = (e: unknown): Unknown =>
  e instanceof PersonError &&
  (e.kind === 'signed_out' || e.kind === 'no_identity' || e.kind === 'busy')
    ? e.kind
    : 'unreachable';

export function AccountProvider({ children }: { children: ReactNode }) {
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const [read, setRead] = useState<Read | null>(null);
  const [round, setRound] = useState(0);
  const [refused, setRefused] = useState<{ key: string; tried: ChainId } | null>(null);

  // Who is signed in, with which wallets. A new person or a new wallet is read again; the same ones
  // are not, however often the port is rebuilt.
  const key =
    port.status === 'ready'
      ? [port.userId, ...port.accounts.map((a) => `${a.family}:${a.address}:${a.kind}`)].join('|')
      : null;
  const latest = useRef({ port, apiFetch, key });
  latest.current = { port, apiFetch, key };

  // What a person typed is theirs: when they sign out, or another person signs in, the draft kept in
  // the tab is forgotten. A person who was signed out and signs in keeps what they typed.
  const who = port.userId;
  const before = useRef(who);
  useEffect(() => {
    if (before.current !== null && before.current !== who) forgetGoalDraft();
    before.current = who;
  }, [who]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks again; the port and the fetch are read as they are when the effect runs
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const { port: now, apiFetch: call } = latest.current;
    const done = (person: Person | null, why?: Unknown) => {
      if (live) setRead({ key, person, why });
    };
    if (now.test) done(localPerson(now.userId ?? 'test', now.accounts, null));
    else fetchPerson(call).then(done, (e: unknown) => done(null, whyNot(e)));
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
      // An answer is this person's only while they are still the one signed in.
      const mine = () => latest.current.key === key;
      try {
        const person = await storeChain(call, chain);
        if (mine()) setRead({ key, person });
      } catch (e) {
        // Chosen before, on another device or in another tab: read where the plan does live, so the
        // screen can name that chain and not the one just tried.
        if (e instanceof PersonError && e.kind === 'taken') {
          let why: Unknown | undefined;
          const person = await fetchPerson(call).catch((again: unknown) => {
            why = whyNot(again);
            return null;
          });
          if (mine()) {
            setRefused({ key, tried: chain });
            setRead({ key, person, why });
          }
        }
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
    // A wallet that could not be made: signed in, and nothing to ask the API about yet. It is never
    // asked while a wallet is owed: with one wallet it would offer one chain.
    if (port.walletsOwed === 'failed') return { status: 'no-wallet' };
    if (port.status === 'loading') return { status: 'loading' };
    if (port.status === 'signed-out' || key === null) return { status: 'signed-out' };
    if (!read || read.key !== key) return { status: 'loading' };
    const person = read.person;
    if (!person) return { status: 'unknown', why: read.why ?? 'unreachable' };
    if (person.chain)
      return { status: 'ready', chain: person.chain, source: person.chainSource ?? 'picked' };
    if (person.chainOptions.length === 0) return { status: 'no-wallet' };
    return { status: 'needs-chain', options: person.chainOptions };
  }, [port.status, port.walletsOwed, key, read]);

  const overruled = refused !== null && refused.key === key ? refused.tried : null;
  const value = useMemo(
    () => ({ account, mock: port.test, pick, retry, overruled }),
    [account, port.test, pick, retry, overruled],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount() needs <AccountProvider> above it');
  return value;
}

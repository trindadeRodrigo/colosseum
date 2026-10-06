'use client';
import { ChainId } from '@colosseum/schemas';
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
import { remember } from '../../components/shell/remember';
import { SIGNED_IN_COOKIE } from '../../i18n';
import { forgetGoalDraft } from '../goal/draft';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { chainInAddress, FIRST_CHAIN, recallChain, rememberChain } from './chain-choice';
import {
  fetchPerson,
  HOME_CHAIN,
  localPerson,
  type Person,
  PersonError,
  storeChain,
} from './person';

// The signed-in person and their current chain, for every product screen (gate CHAIN-SWITCH). The
// current chain is where a new plan is made; a plan already made stays on its own. It is the API's to
// say (GET /v1/me): the chain of the outside wallet a person connected, or the one they chose. A person
// who made their wallets here is not asked: they start on the chain they were looking at, and switch
// from the bar. Someone signed out has a chain too, the one they are looking at, kept in this browser.

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
  /**
   * The current chain, and the chains a wallet of the person's signs on, which they may switch to: an
   * EVM wallet alone signs on Robinhood Chain only.
   */
  | { status: 'ready'; chain: ChainId; source: 'picked' | 'wallet'; options: ChainId[] };

/** `off`: every chain a wallet of theirs signs on is switched off on our server, so none can be started on. */
export type Unknown = 'unreachable' | 'signed_out' | 'no_identity' | 'busy' | 'off';

export type AccountValue = {
  account: Account;
  /**
   * The person is the throwaway wallet of development: the API has no account for them, so their
   * chain is worked out here and kept only while the page is open. Shown with the MOCK plate.
   */
  mock: boolean;
  /**
   * The chain a screen shows and builds on: the current chain of someone signed in, the chain someone
   * signed out is looking at. Null while the person is signed in and their chain is not known.
   */
  chain: ChainId | null;
  /**
   * Switches it. Signed in, the API stores it, and a `PersonError` says why it was not stored;
   * signed out, this browser keeps it.
   */
  choose(chain: ChainId): Promise<void>;
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
  // The chain someone signed out is looking at: the address's, else this browser's, else the first.
  // Read as the provider is made, before any screen reads it or writes the address. Nothing shows it
  // while the wallet loads, so the server's page and the browser's first one are the same.
  const [browsing, setBrowsing] = useState<ChainId>(() =>
    typeof window === 'undefined'
      ? FIRST_CHAIN
      : (chainInAddress(window.location.search) ?? recallChain() ?? FIRST_CHAIN),
  );
  const looking = useRef(browsing);
  looking.current = browsing;
  // The throwaway wallet's chain, chosen in this tab: it has no account on the API to keep it.
  const testPick = useRef<ChainId | null>(null);
  // A chain the address named is the one this browser is on now.
  useEffect(() => {
    const named = chainInAddress(window.location.search);
    if (named) rememberChain(named);
  }, []);

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

  // The landing page sends a person signed in here to their goal, from this hint. Only a settled port
  // changes it: while it loads, nothing is known.
  const status = port.status;
  useEffect(() => {
    if (status === 'ready') remember(SIGNED_IN_COOKIE, '1');
    else if (status === 'signed-out') remember(SIGNED_IN_COOKIE, null);
  }, [status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` asks again; the port and the fetch are read as they are when the effect runs
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const { port: now, apiFetch: call } = latest.current;
    const done = (person: Person | null, why?: Unknown) => {
      if (live) setRead({ key, person, why });
    };
    if (now.test) done(localPerson(now.userId ?? 'test', now.accounts, testPick.current));
    else fetchPerson(call).then(done, (e: unknown) => done(null, whyNot(e)));
    return () => {
      live = false;
    };
  }, [key, round]);

  const choose = useCallback(
    async (chain: ChainId) => {
      if (key === null) {
        rememberChain(chain);
        setBrowsing(chain);
        return;
      }
      const { port: now, apiFetch: call } = latest.current;
      if (now.test) {
        testPick.current = chain;
        setRead({ key, person: localPerson(now.userId ?? 'test', now.accounts, chain) });
        return;
      }
      const person = await storeChain(call, chain);
      // An answer is this person's only while they are still the one signed in.
      if (latest.current.key === key) setRead({ key, person });
    },
    [key],
  );

  // A person with wallets and no chain yet (they made their wallets here, or connected wallets of
  // both families) starts on the chain they were looking at, where a wallet of theirs signs and our
  // server runs. Not asked: they switch from the bar. When it cannot be stored, the account says why.
  const person = read?.key === key ? read.person : null;
  useEffect(() => {
    if (!person || person.chain || person.chainOptions.length === 0 || key === null) return;
    const on = person.chainOptions.filter((c) => latest.current.port.network(c)?.on !== false);
    const start = on.includes(looking.current) ? looking.current : on[0];
    if (!start) {
      setRead({ key, person: null, why: 'off' });
      return;
    }
    choose(start).catch((e: unknown) => {
      if (latest.current.key === key) setRead({ key, person: null, why: whyNot(e) });
    });
  }, [person, key, choose]);

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
    if (person.chain) {
      // The chains a wallet of theirs signs on, from the wallets the API read, as the API works them
      // out: an API from before CHAIN-SWITCH lists none once there is a chain.
      const held = new Set(person.wallets.map((w) => HOME_CHAIN[w.family]));
      return {
        status: 'ready',
        chain: person.chain,
        source: person.chainSource ?? 'picked',
        options: ChainId.options.filter((c) => held.has(c)),
      };
    }
    if (person.chainOptions.length === 0) return { status: 'no-wallet' };
    // The chain they start on is being stored.
    return { status: 'loading' };
  }, [port.status, port.walletsOwed, key, read]);

  // Signed out later, the person goes on looking at the chain they were on.
  const current = account.status === 'ready' ? account.chain : null;
  useEffect(() => {
    if (!current) return;
    rememberChain(current);
    setBrowsing(current);
  }, [current]);

  const chain = current ?? (account.status === 'signed-out' ? browsing : null);
  const value = useMemo(
    () => ({ account, mock: port.test, chain, choose, retry }),
    [account, port.test, chain, choose, retry],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount() needs <AccountProvider> above it');
  return value;
}

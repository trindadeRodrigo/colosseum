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
import { forgetEveryOrder, forgetOrders } from '../order/order-record';
import { forgetPlans } from '../order/plan-store';
import { useApiFetch, useWalletPort, useWalletRestart } from '../wallet/WalletProvider';
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

/**
 * `off`: every chain a wallet of theirs signs on is switched off on our server, so none can be started
 * on. `refused`: the server would not start them on the chain asked for (409 `NO_WALLET_FOR_CHAIN`,
 * 422): it does not take that chain for these wallets.
 */
export type Unknown = 'unreachable' | 'signed_out' | 'no_identity' | 'busy' | 'off' | 'refused';

/**
 * Someone signed in has waited this long and is not ready: they are told, and not left looking at
 * "Reading…". Nothing is asked again by itself: a sign-in service that answered 429 is left alone
 * until the person presses "Try again", and each press waits twice as long as the one before.
 */
export const SLOW_MS = 15_000;
/**
 * How long the bar waits for the sign-in service before it offers "Sign in" anyway to someone nobody
 * knows to be signed in. A service that never loads (a blocker, a network that drops it) must not
 * leave the bar with no way in.
 */
export const WAY_IN_MS = 4_000;
const SLOWEST_MS = 120_000;

/**
 * Which side has not answered: `wallets`, the sign-in service has not handed over the session's
 * wallets; `server`, ours has not said who this is (GET /v1/me, or the chain being stored).
 */
export type Slow = {
  /**
   * `service`: nobody is known to be signed in, because the sign-in service has not loaded at all.
   */
  side: 'wallets' | 'server' | 'service';
  trying: boolean;
  /** "Try again" was not done: a step of an order is being signed, and is finished or cancelled first. */
  held: boolean;
};

export type AccountValue = {
  account: Account;
  /**
   * Set while someone signed in is still not ready after `SLOW_MS`. `trying`: they pressed "Try
   * again" and its wait is not over.
   */
  slow: Slow | null;
  /** Reads the wallets and the person again, with no reload of the page. */
  again(): void;
  /**
   * Signs out as far as this browser can when the sign-in service names nobody and cannot be asked:
   * forgets the signed-in hint and what was kept for the person, and shows the visitor's way in.
   * The service is asked to sign them out as soon as it loads (`ousting`).
   */
  leave(): void;
  /**
   * The service has loaded and names someone who signed out here while it could not be reached: they
   * are being signed out there, and nothing of theirs is shown meanwhile.
   */
  ousting: boolean;
  /**
   * The sign-in service has not loaded after `WAY_IN_MS`, and nobody is known to be signed in: the
   * bar offers "Sign in" as to a visitor, and the sign-in screen says the service has not answered.
   */
  stalled: boolean;
  /**
   * The person is the throwaway wallet of development: the API has no account for them, so their
   * chain is worked out here and kept only while the page is open. Shown with the sample glyph.
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

/** Kept from "Sign out" pressed without the sign-in service until that service says nobody is in. */
const LEFT_HERE = 'tf-left';
function leftHere(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(LEFT_HERE) === '1';
  } catch {
    return false;
  }
}
function markLeft(): void {
  try {
    window.localStorage.setItem(LEFT_HERE, '1');
  } catch {
    // No storage: the mark lasts as long as the page.
  }
}
function forgetLeft(): void {
  try {
    window.localStorage.removeItem(LEFT_HERE);
  } catch {
    // As above.
  }
}

/** The hint says someone was signed in here when the page was last open. False on the server. */
function signedInHint(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((pair) => pair.trim() === `${SIGNED_IN_COOKIE}=1`);
}

type Read = { key: string; person: Person | null; why?: Unknown };

/** Why the API did not say who is signed in, as far as a person can do something about it. */
const whyNot = (e: unknown): Unknown => {
  if (!(e instanceof PersonError)) return 'unreachable';
  if (e.kind === 'signed_out' || e.kind === 'no_identity' || e.kind === 'busy') return e.kind;
  return e.kind === 'no_wallet' || e.kind === 'not_offered' ? 'refused' : 'unreachable';
};

export function AccountProvider({ children }: { children: ReactNode }) {
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const restart = useWalletRestart();
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
  // "Sign out" pressed while the sign-in service could not be reached (`leave`): this browser was told
  // the person is out, and that is finished when the service loads. If it then names a person, they
  // are signed out there at once, and until it says so nothing of theirs is asked for or drawn: no
  // account, no address, no figure. The mark goes when the service says nobody is signed in.
  const [marked, setMarked] = useState(leftHere);
  const ousting = marked && port.userId !== null;
  const ousted = useRef(false);
  const signedOutNow = port.status === 'signed-out';
  useEffect(() => {
    if (signedOutNow) {
      if (marked) {
        forgetLeft();
        setMarked(false);
      }
      ousted.current = false;
      return;
    }
    if (!ousting || ousted.current) return;
    ousted.current = true;
    // A sign-out the service refuses leaves the mark, and is tried again the next time the service
    // reports anything (a new port), and when the page next loads: never in a loop of its own.
    void port.signOut().catch(() => {
      ousted.current = false;
    });
  }, [ousting, marked, signedOutNow, port]);

  const key =
    port.status === 'ready' && !ousting
      ? [port.userId, ...port.accounts.map((a) => `${a.family}:${a.address}:${a.kind}`)].join('|')
      : null;
  const latest = useRef({ port, apiFetch, key });
  latest.current = { port, apiFetch, key };

  // What a person typed is theirs: when they sign out, or another person signs in, the draft kept in
  // the tab is forgotten. A person who was signed out and signs in keeps what they typed, and so does
  // one whose wallet provider is loading again ("Try again"): nobody is known then, and nobody left.
  const who = port.userId;
  const out = port.status === 'signed-out';
  const before = useRef(who);
  useEffect(() => {
    // Loading again and naming nobody: nothing of the person's is forgotten, their order's record
    // least of all ("Try again" pressed on an order's page).
    if (who === null && !out) return;
    if (before.current !== null && before.current !== who) {
      forgetGoalDraft();
      // and the plans and order records this browser kept for them: the server has them, for when
      // they sign in again. The trust acceptance stays: it holds no figure (order-record.ts).
      forgetPlans();
      forgetOrders(before.current);
    }
    before.current = who;
  }, [who, out]);

  // The landing page sends a person signed in here to their goal, from this hint. Only a settled port
  // changes it: while it loads, nothing is known.
  const status = port.status;
  useEffect(() => {
    if (status === 'ready' && !ousting) remember(SIGNED_IN_COOKIE, '1');
    else if (status === 'signed-out') remember(SIGNED_IN_COOKIE, null);
  }, [status, ousting]);

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
      // The chains a wallet of theirs signs on, as the API says (`chainOptions`); worked out from the
      // wallets it read when it lists none, as an API from before CHAIN-SWITCH does once there is a chain.
      const held = new Set(person.wallets.map((w) => HOME_CHAIN[w.family]));
      return {
        status: 'ready',
        chain: person.chain,
        source: person.chainSource ?? 'picked',
        options: person.chainOptions.length
          ? person.chainOptions
          : ChainId.options.filter((c) => held.has(c)),
      };
    }
    if (person.chainOptions.length === 0) return { status: 'no-wallet' };
    // The chain they start on is being stored.
    return { status: 'loading' };
  }, [port.status, port.walletsOwed, key, read]);

  // Signed in and not ready: the wallets are loading, or our server has not answered. Once someone was
  // seen signed in, a wallet provider that loads again still counts, until it says they are out.
  // Someone who reloads is known before the provider says so, by the hint this app keeps while a
  // person is signed in (`SIGNED_IN_COOKIE`): they are never shown "Sign in" while it loads.
  const seen = useRef<boolean | null>(null);
  if (seen.current === null) seen.current = signedInHint();
  if (port.userId !== null && !ousting) seen.current = true;
  else if (port.status === 'signed-out') seen.current = false;
  // And nobody known at all: the sign-in service has not loaded, so it has not said who is here.
  const nobody = port.status === 'loading' && port.userId === null && !seen.current;
  const waiting = account.status === 'loading';
  const side = port.status === 'ready' ? 'server' : nobody ? 'service' : 'wallets';
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!nobody) return setStalled(false);
    const timer = setTimeout(() => setStalled(true), WAY_IN_MS);
    return () => clearTimeout(timer);
  }, [nobody]);
  // The way out for someone the hint says was signed in, when the sign-in service cannot be reached
  // to sign them out: the hint and what this browser kept for them go, and they are a visitor, with
  // the visitor's way in at once. What the service holds of their session is its own to end.
  const [, setLeft] = useState(0);
  const leave = useCallback(() => {
    remember(SIGNED_IN_COOKIE, null);
    markLeft();
    setMarked(true);
    forgetGoalDraft();
    forgetPlans();
    // nobody is known, so every record goes, whoever it was kept for
    forgetEveryOrder();
    before.current = null;
    seen.current = false;
    setStalled(true);
    setLeft((n) => n + 1);
  }, []);
  const [tries, setTries] = useState(0);
  const [late, setLate] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setTries(0);
      setLate(false);
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), Math.min(SLOW_MS * 2 ** tries, SLOWEST_MS));
    return () => clearTimeout(timer);
  }, [waiting, tries]);
  const slow = useMemo(
    (): Slow | null => (waiting && (late || tries > 0) ? { side, trying: !late, held } : null),
    [waiting, late, tries, side, held],
  );
  // The wallets are read again by mounting their provider again; the person, by asking our server
  // again. A second press does both: the token our server is waiting for comes from that provider,
  // and our server is asked only once the new one has its wallets and tokens (there is no person to
  // ask about while it loads). Not while an order is being run: the press is refused, and says so.
  const again = useCallback(() => {
    if ((side !== 'server' || tries > 0) && !restart()) {
      setHeld(true);
      return;
    }
    setHeld(false);
    if (side === 'server') retry();
    setLate(false);
    setTries((n) => n + 1);
  }, [side, tries, restart, retry]);

  // Signed out later, the person goes on looking at the chain they were on.
  const current = account.status === 'ready' ? account.chain : null;
  useEffect(() => {
    if (!current) return;
    rememberChain(current);
    setBrowsing(current);
  }, [current]);

  // A visitor the sign-in service never answered for browses as one signed out: the chain is theirs
  // to look at and to switch.
  const chain = current ?? (account.status === 'signed-out' || stalled ? browsing : null);
  const value = useMemo(
    () => ({
      account,
      slow,
      again,
      leave,
      ousting,
      stalled,
      mock: port.test,
      chain,
      choose,
      retry,
    }),
    [account, slow, again, leave, ousting, stalled, port.test, chain, choose, retry],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error('useAccount() needs <AccountProvider> above it');
  return value;
}

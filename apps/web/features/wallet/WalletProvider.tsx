'use client';
import dynamic from 'next/dynamic';
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
import { API } from '../../lib/api';
import { apiUrl } from './api-url';
import { WALLET_MARKER } from './marker';
import { type ScreenPort, screenPort, type WebWalletPort } from './port';

// This file is in the bundle of every page, so it imports nothing heavy: the port, the chain table and
// the wallet provider all arrive with the bridge, when something first asks for the wallet.

/** What a bridge is: it mounts a wallet provider, and reports a new port whenever its state changes. */
export type BridgeProps = {
  onPort: (port: WebWalletPort) => void;
  /**
   * What outlives a bridge when it is mounted again (`restart`): the calls that make wallets, so the
   * next bridge waits for one still open and never asks for the same wallet beside it.
   */
  carry?: { making: Promise<void> };
};

// Client only, and only once something asks for the wallet: a page that never calls useWalletPort()
// loads none of the provider's code.
const PrivyBridge = dynamic(() => import('./privy-bridge'), { ssr: false });

// The throwaway wallet. Next writes NODE_ENV into the bundle, so in a production build this is `null`
// and the import is never emitted; scripts/check-build.mjs fails the build if that stops being true.
const TestBridge =
  process.env.NODE_ENV !== 'production'
    ? dynamic(() => import('./test/test-bridge'), { ssr: false })
    : null;
const testWalletOn =
  process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_WALLET_DRIVER === 'test';

/**
 * `port` is the whole wallet, signing included: only signing.ts reads it. `screen` is the same wallet
 * with no signing member, which is what every screen gets.
 */
type Value = {
  leaveHere: () => void;
  port: WebWalletPort;
  screen: ScreenPort;
  activate: () => void;
  restart: () => boolean;
  hold: () => () => void;
};
export const WalletContext = createContext<Value | null>(null);
WalletContext.displayName = WALLET_MARKER;

const notYet = async (): Promise<never> => {
  const { fail } = await import('./errors');
  throw fail('not_connected', 'the wallet is still loading');
};

/** The port before the provider has loaded. It renders the same on the server and in the browser. */
const LOADING: WebWalletPort = {
  status: 'loading',
  userId: null,
  accounts: [],
  problem: null,
  problemKind: null,
  test: false,
  found: [],
  walletsOwed: null,
  active: () => null,
  caps: () => ({ silent: false, batchSign: 1, signOnly: false }),
  network: () => null,
  signIn: notYet,
  signOut: () => Promise.resolve(),
  ensureWallets: notYet,
  sign: notYet,
  send: notYet,
  exportKey: notYet,
  signMessage: notYet,
  authHeaders: () => Promise.resolve({}),
};

// "Sign out" pressed while the sign-in service could not be reached leaves a mark in this browser
// (`useLeaveHere`): the person was told they are out. From then until the service itself says nobody
// is signed in, no consumer is handed a port that names a person, signs, or carries their tokens:
// while the mark is set, a port of the service that names someone is kept back, every screen and the
// signing port see the wallet still loading, and the service is asked to sign that person out (again
// after a refusal, each wait twice the one before). The mark goes when the service says they are out.
const LEFT_HERE = 'tf-left';
/** The waits between tries of a sign-out the service refused: 2 s, doubling, a minute at most. */
export const SIGN_OUT_RETRY_MS = 2_000;
const SIGN_OUT_RETRY_MAX_MS = 60_000;

function leftHere(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(LEFT_HERE) === '1';
  } catch {
    return false;
  }
}
function keepLeft(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(LEFT_HERE, '1');
    else window.localStorage.removeItem(LEFT_HERE);
  } catch {
    // No storage: the mark lasts as long as the page.
  }
}

/**
 * Holds the one WalletPort of the app. It adds nothing to the page: the wallet provider is mounted
 * beside the children, not around them, so they render on the server as before.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  // What the bridge last reported. It is what every consumer gets, except while the mark is set.
  const [reported, setPort] = useState<WebWalletPort>(LOADING);
  const [marked, setMarked] = useState(leftHere);
  const leaveHere = useCallback(() => {
    keepLeft(true);
    setMarked(true);
  }, []);
  const namesSomeone = reported.status !== 'signed-out' && reported.userId !== null;
  const keptBack = marked && namesSomeone;
  const port = keptBack ? LOADING : reported;
  // The sign-out the mark stands for, at the service: once it names someone, and again after a
  // refusal when its wait is over or the service reports anything new, whichever is later.
  const signingOut = useRef(false);
  const refusals = useRef(0);
  const notBefore = useRef(0);
  const [again, setAgain] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is the end of a wait after a refusal
  useEffect(() => {
    if (!marked) return;
    if (reported.status === 'signed-out') {
      keepLeft(false);
      setMarked(false);
      refusals.current = 0;
      notBefore.current = 0;
      return;
    }
    if (!namesSomeone || signingOut.current) return;
    const wait = notBefore.current - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setAgain((n) => n + 1), wait);
      return () => clearTimeout(timer);
    }
    signingOut.current = true;
    reported.signOut().then(
      () => {
        signingOut.current = false;
      },
      () => {
        signingOut.current = false;
        refusals.current += 1;
        notBefore.current =
          Date.now() +
          Math.min(SIGN_OUT_RETRY_MS * 2 ** (refusals.current - 1), SIGN_OUT_RETRY_MAX_MS);
        setAgain((n) => n + 1);
      },
    );
  }, [marked, reported, namesSomeone, again]);
  const [active, setActive] = useState(false);
  const activate = useCallback(() => setActive(true), []);
  // The wallet provider mounted again, for a sign-in that never finished loading: it reads the
  // session and the wallets from the start. The page is not loaded again, so what was typed stays.
  // The port of the provider that is gone goes with it: until the new one reports, the wallet is
  // loading for the same person, and nothing can be signed with hooks that are no longer mounted.
  // Refused (false) while an order is being run: its step is signed with the port it started on.
  const [turn, setTurn] = useState(0);
  const [carry] = useState(() => ({ making: Promise.resolve() }));
  const held = useRef(0);
  const hold = useCallback(() => {
    held.current += 1;
    let open = true;
    return () => {
      if (open) held.current -= 1;
      open = false;
    };
  }, []);
  const restart = useCallback(() => {
    if (held.current > 0) return false;
    setPort((last) => ({ ...LOADING, userId: last.userId }));
    setTurn((n) => n + 1);
    return true;
  }, []);
  const value = useMemo(
    () => ({ port, screen: screenPort(port), activate, restart, hold, leaveHere }),
    [port, activate, restart, hold, leaveHere],
  );
  const Bridge = testWalletOn && TestBridge ? TestBridge : PrivyBridge;
  return (
    <WalletContext.Provider value={value}>
      {children}
      {active ? <Bridge key={turn} onPort={setPort} carry={carry} /> : null}
    </WalletContext.Provider>
  );
}

/**
 * The wallet as a screen has it: who is signed in, with which wallets, on which chains, and the ways
 * to sign in and out. It has no member that signs, sends or shows a key, so no screen can reach one:
 * the object does not carry them. The first component to call this loads the wallet provider.
 */
export function useWalletPort(): ScreenPort {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWalletPort() needs <WalletProvider> above it');
  const { activate } = value;
  useEffect(activate, [activate]);
  return value.screen;
}

/**
 * Mounts the wallet provider again (`restart` above). Only the account's "Try again" calls it. False
 * when it was not done: an order is being run.
 */
export function useWalletRestart(): () => boolean {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWalletRestart() needs <WalletProvider> above it');
  return value.restart;
}

/**
 * Marks this browser as signed out though the sign-in service could not be asked (see `LEFT_HERE`
 * above). Only the account's "Sign out" for a service that names nobody calls it.
 */
export function useLeaveHere(): () => void {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useLeaveHere() needs <WalletProvider> above it');
  return value.leaveHere;
}

/**
 * The one way the app calls the API as the signed-in person: fetch with the sign-in headers the API's
 * auth expects (the Privy access token as a Bearer token, and the identity token when there is one).
 * Signed out, the call goes out without them. `path` is the part after the API's address and starts
 * with one `/` ('/v1/config'); anything that would lead to another host is refused before the token
 * is asked for, and a redirect is an error, so the token is never carried to where one points.
 * A call the API refuses with 401 while someone is signed in is sent once more, with fresh tokens;
 * its second answer is the one returned. A caller may ask for fresh tokens from the start
 * (`freshSignIn`): a route that reads a sign-in without needing one answers a stale token as it
 * answers nobody, with no 401 to say so.
 */
export type ApiInit = RequestInit & { freshSignIn?: boolean };
export function useApiFetch(): (path: string, init?: ApiInit) => Promise<Response> {
  const port = useWalletPort();
  return useCallback(
    async (path, asked) => {
      const { freshSignIn, ...init } = asked ?? {};
      const url = apiUrl(API, path);
      const send = async (fresh: boolean) => {
        const signIn = await port.authHeaders(fresh ? { fresh } : undefined);
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(signIn)) headers.set(name, value);
        const res = await fetch(url, { cache: 'no-store', ...init, headers, redirect: 'error' });
        return { res, signedIn: 'authorization' in signIn };
      };
      const first = await send(freshSignIn === true);
      if (first.res.status !== 401 || !first.signedIn) return first.res;
      return (await send(true)).res;
    },
    [port],
  );
}

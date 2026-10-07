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

/**
 * Holds the one WalletPort of the app. It adds nothing to the page: the wallet provider is mounted
 * beside the children, not around them, so they render on the server as before.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [port, setPort] = useState<WebWalletPort>(LOADING);
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
    () => ({ port, screen: screenPort(port), activate, restart, hold }),
    [port, activate, restart, hold],
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

'use client';
import dynamic from 'next/dynamic';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { API } from '@/lib/api';
import { WALLET_MARKER } from './marker';
import type { WebWalletPort } from './port';

// This file is in the bundle of every page, so it imports nothing heavy: the port, the chain table and
// the wallet provider all arrive with the bridge, when something first asks for the wallet.

/** What a bridge is: it mounts a wallet provider, and reports a new port whenever its state changes. */
export type BridgeProps = { onPort: (port: WebWalletPort) => void };

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

type Value = { port: WebWalletPort; activate: () => void };
const WalletContext = createContext<Value | null>(null);
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
  test: false,
  active: () => null,
  caps: () => ({ silent: false, batchSign: 1, signOnly: false }),
  signIn: notYet,
  signOut: () => Promise.resolve(),
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
  const value = useMemo(() => ({ port, activate }), [port, activate]);
  const Bridge = testWalletOn && TestBridge ? TestBridge : PrivyBridge;
  return (
    <WalletContext.Provider value={value}>
      {children}
      {active ? <Bridge onPort={setPort} /> : null}
    </WalletContext.Provider>
  );
}

/** The wallet, behind WalletPort. The first component to call this loads the wallet provider. */
export function useWalletPort(): WebWalletPort {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWalletPort() needs <WalletProvider> above it');
  const { activate } = value;
  useEffect(activate, [activate]);
  return value.port;
}

/**
 * The one way the app calls the API as the signed-in person: fetch with the sign-in headers the API's
 * auth expects (the Privy access token as a Bearer token, and the identity token when there is one).
 * Signed out, the call goes out without them. `path` is relative to the API ('/v1/config').
 */
export function useApiFetch(): (path: string, init?: RequestInit) => Promise<Response> {
  const port = useWalletPort();
  return useCallback(
    async (path, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(await port.authHeaders()))
        headers.set(name, value);
      return fetch(`${API}${path}`, { cache: 'no-store', ...init, headers });
    },
    [port],
  );
}

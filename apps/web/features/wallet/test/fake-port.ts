import type { ChainId, Provenance, WalletAccount } from '@colosseum/schemas';
import { fail } from '../errors';
import type { ChainNetwork, WebWalletPort } from '../port';

// A wallet port for the tests of the screens: what a screen is handed, with nothing behind it. A test
// changes it the way the provider does in the app, by putting a new one in the store, and the
// components that read it draw again.

export const SOLANA = 'So11111111111111111111111111111111111111112';
export const EVM = '0x204faca1764b154221e35c0d20abb3c525710498';

export const EMBEDDED: WalletAccount[] = [
  { family: 'solana', address: SOLANA, kind: 'embedded' },
  { family: 'evm', address: EVM, kind: 'embedded' },
];
export const PHANTOM: WalletAccount[] = [{ family: 'solana', address: SOLANA, kind: 'external' }];
export const METAMASK: WalletAccount[] = [{ family: 'evm', address: EVM, kind: 'external' }];

const NAMES: Record<ChainId, [string, string]> = {
  solana: ['Solana', 'devnet'],
  robinhood: ['Robinhood Chain', 'Robinhood Chain testnet'],
  base: ['Base', 'Base Sepolia'],
};

const never = () => Promise.reject(fail('not_connected', 'not signed in'));

/** A port, signed out and set up, with whatever a test replaces. `provenance` is how every chain is run. */
export function fakePort(
  over: Partial<WebWalletPort> = {},
  provenance: Provenance = 'sandbox',
): WebWalletPort {
  const accounts = over.accounts ?? [];
  return {
    status: 'signed-out',
    userId: null,
    accounts,
    problem: null,
    problemKind: null,
    test: false,
    found: [],
    active: (family) => accounts.find((a) => a.family === family) ?? null,
    caps: () => ({ silent: false, batchSign: 1, signOnly: true }),
    network: (chain): ChainNetwork => ({
      id: chain,
      name: NAMES[chain][0],
      networkName: NAMES[chain][1],
      provenance,
      on: chain !== 'base',
    }),
    signIn: () => Promise.resolve(),
    signOut: () => Promise.resolve(),
    ensureWallets: () => Promise.resolve(),
    sign: never,
    send: never,
    exportKey: never,
    signMessage: never,
    authHeaders: () => Promise.resolve({}),
    ...over,
  };
}

/** The same port, signed in with these accounts. */
export const signedInPort = (
  accounts: WalletAccount[],
  over: Partial<WebWalletPort> = {},
  provenance: Provenance = 'sandbox',
): WebWalletPort =>
  fakePort({ status: 'ready', userId: 'did:privy:test', accounts, ...over }, provenance);

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** What stands in for `<WalletProvider>` in a test: the port of the moment, and the API. */
export function createPortStore(initial: WebWalletPort = fakePort()) {
  let port = initial;
  let apiFetch: ApiFetch = () => Promise.reject(new TypeError('fetch failed'));
  const listeners = new Set<() => void>();
  return {
    get: () => port,
    set(next: WebWalletPort) {
      port = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The API as the screens call it. The function handed to components never changes. */
    api: ((path, init) => apiFetch(path, init)) as ApiFetch,
    setApi(next: ApiFetch) {
      apiFetch = next;
    },
  };
}
export type PortStore = ReturnType<typeof createPortStore>;

/** An answer of the API. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

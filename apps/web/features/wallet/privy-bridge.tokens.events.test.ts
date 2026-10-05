// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, settle, unmountAll } from '../../components/ui/test/dom';
import { readIdentityToken } from './identity-token';
import type { WebWalletPort } from './port';
import { identityTokenOf, privyDouble } from './test/privy-double';

vi.mock('@privy-io/react-auth', async () => (await import('./test/privy-double')).reactAuth);
vi.mock('@privy-io/react-auth/solana', async () => (await import('./test/privy-double')).solana);
vi.mock('./use-api-check', () => {
  const ok = { ok: true, chains: [] };
  return { useApiCheck: () => ok };
});

// The sign-in headers, with the bridge mounted over the stand-in for Privy. A run against the hosted
// API sent the identity token once, then not at all: the bridge asked Privy's server for a new one on
// every call, Privy answered 429, and the API answered 401. Every call now carries both tokens, Privy
// is asked for a new identity token at most once per token, and a 429 keeps the one held.

process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'app-id';

async function bridge() {
  const { default: PrivyBridge } = await import('./privy-bridge');
  const ports: WebWalletPort[] = [];
  await mount(
    createElement(PrivyBridge, { onPort: (port: WebWalletPort) => void ports.push(port) }),
  );
  await settle();
  return () => ports.at(-1) as WebWalletPort;
}

/** A passkey person whose two wallets have been made: the token from the sign-in lists none. */
async function passkeyPersonReady() {
  privyDouble.reset(privyDouble.passkeyPerson());
  const port = await bridge();
  // one call at a time: the second is asked for once the first has answered
  for (let call = privyDouble.pending.shift(); call; call = privyDouble.pending.shift()) {
    const answer = call;
    await act(async () => answer.made());
    await settle();
  }
  expect(port().status).toBe('ready');
  return port;
}

const headersOf = (port: () => WebWalletPort, options?: { fresh?: boolean }) =>
  act(async () => port().authHeaders(options));

const walletsIn = (token: string | undefined) => [
  ...(readIdentityToken(token ?? '')?.wallets ?? []),
];

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe('every call the API gets from a signed-in person', () => {
  it('carries the access token and the identity token, call after call', async () => {
    privyDouble.reset(privyDouble.walletPerson('solana'));
    const port = await bridge();
    for (let i = 0; i < 10; i += 1) {
      const headers = await headersOf(port);
      expect(headers.authorization).toBe('Bearer access-token');
      expect(headers['privy-id-token']).toBeTruthy();
    }
    // the token from the sign-in lists the wallet and is good for an hour: Privy is not asked
    expect(privyDouble.identityFetches).toBe(0);
  });

  it('asks Privy once when the token does not list the wallets made since the sign-in', async () => {
    const port = await passkeyPersonReady();
    const first = await headersOf(port);
    expect(walletsIn(first['privy-id-token'])).toHaveLength(2);
    for (let i = 0; i < 10; i += 1) {
      const headers = await headersOf(port);
      expect(headers['privy-id-token']).toBe(first['privy-id-token']);
    }
    expect(privyDouble.identityFetches).toBe(1);
  });

  it('asks Privy once for a token that has run out, and not again while the new one lasts', async () => {
    privyDouble.reset(privyDouble.walletPerson('ethereum'));
    const port = await bridge();
    const ended = identityTokenOf(privyDouble.walletPerson('ethereum'), -10);
    await act(async () => privyDouble.holdIdentity(ended));
    await settle();
    const first = await headersOf(port);
    expect(privyDouble.identityFetches).toBe(1);
    expect(readIdentityToken(first['privy-id-token'] ?? '')?.exp).toBeGreaterThan(
      Date.now() / 1000,
    );
    for (let i = 0; i < 5; i += 1) await headersOf(port);
    expect(privyDouble.identityFetches).toBe(1);
  });

  it('keeps the token it holds when Privy answers 429, and leaves Privy alone a while', async () => {
    const port = await passkeyPersonReady();
    const held = identityTokenOf(privyDouble.passkeyPerson());
    await act(async () => privyDouble.holdIdentity(held));
    privyDouble.limited = true;
    for (let i = 0; i < 5; i += 1) {
      const headers = await headersOf(port);
      expect(headers.authorization).toBe('Bearer access-token');
      expect(headers['privy-id-token']).toBe(held);
    }
    expect(privyDouble.identityFetches).toBe(1);
  });

  it('never sends the token of the person who signed in before', async () => {
    privyDouble.reset(privyDouble.walletPerson('solana', 'did:privy:one'));
    const port = await bridge();
    await headersOf(port);
    await act(async () => privyDouble.signOut());
    await act(async () =>
      privyDouble.signIn(privyDouble.walletPerson('ethereum', 'did:privy:two')),
    );
    await settle();
    const headers = await headersOf(port);
    expect(readIdentityToken(headers['privy-id-token'] ?? '')?.sub).toBe('did:privy:two');
  });
});

describe('after the API refused the sign-in', () => {
  it('asks Privy for a new identity token once, not for every call refused at the same moment', async () => {
    privyDouble.reset(privyDouble.walletPerson('solana'));
    const port = await bridge();
    await headersOf(port);
    expect(privyDouble.identityFetches).toBe(0);
    const [a, b] = await act(async () =>
      Promise.all([port().authHeaders({ fresh: true }), port().authHeaders({ fresh: true })]),
    );
    expect(privyDouble.identityFetches).toBe(1);
    expect(a['privy-id-token']).toBeTruthy();
    expect(b['privy-id-token']).toBeTruthy();
    await headersOf(port, { fresh: true });
    expect(privyDouble.identityFetches).toBe(1);
  });
});

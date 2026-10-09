// @vitest-environment happy-dom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { BearingFromBar } from './BearingFromBar';
import { useBearing } from './BearingProvider';

// Bearing's chain toggle and the bar's switcher (gate CHAIN-SWITCH). Signed out they are one choice:
// the toggle moves the bar. Signed in they are two: the bar's chain is where the person's plans are
// made, and the toggle only filters the page.

const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/analytics/stocks',
  useRouter: () => router,
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));

/** Bearing's toggle, as its shell draws it: the chain it reads, and a press that reads the other. */
function Toggle() {
  const { chain, setChain } = useBearing();
  return createElement(
    'button',
    { type: 'button', 'data-ui': 'toggle', onClick: () => setChain('robinhood') },
    chain,
  );
}

const view = () =>
  mount(
    withAccount('en', [
      createElement(ChainSwitch, { key: 'bar' }),
      createElement(BearingFromBar, { key: 'bearing' } as never, createElement(Toggle)),
    ]),
  );
const bar = (host: HTMLElement) =>
  find(host, '[data-ui="chain-switch"] > button').getAttribute('data-chain');
const page = (host: HTMLElement) => find(host, '[data-ui="toggle"]').textContent;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/analytics/stocks');
  router.replace.mockClear();
  // the risk API is not there: nothing here reads a figure
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ error: 'not found' }, 404)),
  );
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

describe('Bearing’s chain toggle and the bar', () => {
  it('signed out, moves the bar with it', async () => {
    portStore.set(fakePort());
    const host = await view();
    await settle();
    expect([bar(host), page(host)]).toEqual(['solana', 'solana']);
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    expect([bar(host), page(host)]).toEqual(['robinhood', 'robinhood']);
    expect(window.localStorage.getItem('tf-chain')).toBe('robinhood');
    // named in the address once, by the toggle: the bar's answer is not followed as a second move
    expect(
      router.replace.mock.calls.filter(([to]) => String(to).includes('robinhood')),
    ).toHaveLength(1);
  });

  it('signed in, filters the page and leaves the person’s chain where it is', async () => {
    const puts: unknown[] = [];
    const person: Person = {
      userId: 'did:privy:test',
      wallets: EMBEDDED,
      chain: 'solana',
      chainSource: 'picked',
      chainOptions: ['solana', 'robinhood'],
    };
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me/chain') puts.push(JSON.parse(String(init?.body)));
      return path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404);
    });
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    expect([bar(host), page(host)]).toEqual(['solana', 'solana']);
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    expect(page(host)).toBe('robinhood');
    expect(bar(host)).toBe('solana');
    expect(puts).toEqual([]);
  });
});

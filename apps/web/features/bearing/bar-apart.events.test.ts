// @vitest-environment happy-dom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { ChainSwitch } from '../account/ChainSwitch';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { BearingProvider, useBearing } from './BearingProvider';

// Bearing's chain toggle and the bar's switcher are two things (gate CHAIN-AT-THE-PLAN): the toggle
// filters the analytics pages and is kept for them; the bar's chain is where a person's new plans
// start. Neither moves the other, signed in or out.

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
    {
      type: 'button',
      'data-ui': 'toggle',
      onClick: () => setChain(chain === 'solana' ? 'robinhood' : 'solana'),
    },
    chain,
  );
}

const view = () =>
  mount(
    withAccount('en', [
      createElement(ChainSwitch, { key: 'bar' }),
      createElement(BearingProvider, { key: 'bearing' } as never, createElement(Toggle)),
    ]),
  );
const barButton = (host: HTMLElement) => find(host, '[data-ui="chain-switch"] > button');
const bar = (host: HTMLElement) => barButton(host).getAttribute('data-chain');
const page = (host: HTMLElement) => find(host, '[data-ui="toggle"]').textContent;
const named = () => router.replace.mock.calls.map(([to]) => String(to));

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
  it('signed out, the toggle filters the page and leaves the bar where it is', async () => {
    portStore.set(fakePort());
    const host = await view();
    await settle();
    expect([bar(host), page(host)]).toEqual(['solana', 'solana']);
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    expect([bar(host), page(host)]).toEqual(['solana', 'robinhood']);
    expect(window.localStorage.getItem('tf-bearing-chain')).toBe('robinhood');
    expect(window.localStorage.getItem('tf-chain')).toBeNull();
    expect(named().filter((to) => to.includes('robinhood'))).toHaveLength(1);
  });

  it('signed out, the bar’s switch does not move the page', async () => {
    portStore.set(fakePort());
    const host = await view();
    await settle();
    await click(barButton(host));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="robinhood"]'));
    await settle();
    expect([bar(host), page(host)]).toEqual(['robinhood', 'solana']);
    expect(named().some((to) => to.includes('robinhood'))).toBe(false);
  });

  it('does not open on the chain the bar is on', async () => {
    window.localStorage.setItem('tf-chain', 'robinhood');
    portStore.set(fakePort());
    const host = await view();
    await settle();
    expect([bar(host), page(host)]).toEqual(['robinhood', 'solana']);
  });

  it('signed in, each stays where it is, and nothing is stored on the API', async () => {
    const puts: unknown[] = [];
    let person: Person = {
      userId: 'did:privy:test',
      wallets: EMBEDDED,
      chain: 'robinhood',
      chainSource: 'picked',
      chainOptions: ['solana', 'robinhood'],
    };
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me/chain') {
        const { chain } = JSON.parse(String(init?.body));
        puts.push(chain);
        person = { ...person, chain };
        return json(person);
      }
      return path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404);
    });
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    // the person's plans start on Robinhood Chain; the page still opens on its own first chain
    expect([bar(host), page(host)]).toEqual(['robinhood', 'solana']);
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    expect([bar(host), page(host)]).toEqual(['robinhood', 'solana']);
    expect(puts).toEqual([]);
    // and the bar's switch moves the person's chain alone
    await click(barButton(host));
    await click(find(host, '[data-ui="chain-switch-panel"] button[data-chain="solana"]'));
    await settle();
    await click(find(host, '[data-ui="toggle"]'));
    await settle();
    expect([bar(host), page(host)]).toEqual(['solana', 'robinhood']);
    expect(puts).toEqual(['solana']);
  });
});

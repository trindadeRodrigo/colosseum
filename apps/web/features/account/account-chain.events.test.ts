// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNav } from '../../components/shell/AppNav';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { type AccountValue, useAccount } from './AccountProvider';
import { switchFailure } from './chain-failure';
import type { Person } from './person';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Where a new plan starts (gates CHAIN-SWITCH and CHAIN-AT-THE-PLAN). The bar's chain switcher is
// gone (Thom, Oct 9: the chain is not a mode, and the bar shows and switches none): this file was its
// test, and holds what is left of it. The account still gives the screens one chain: signed out, the
// one someone is looking at, kept in this browser; signed in, the one their new plans start on,
// stored by the API. It is chosen on /goal (goal-chain.events.test.ts), and nowhere in the bar.

const en = dictionary('en');

/** What the screens read and call: the chain the account gives them, and the way to choose one. */
let account: AccountValue;
function Shown() {
  account = useAccount();
  return createElement('output', { 'data-ui': 'shown' }, account.chain ?? 'none');
}

const view = () =>
  mount(
    withAccount('en', [createElement(AppNav, { key: 'bar' }), createElement(Shown, { key: 'v' })]),
  );
const shown = (host: HTMLElement) => find(host, '[data-ui="shown"]').textContent;
/** A choice as /goal makes it, and why it was not stored if it was not. */
const choose = async (chain: 'solana' | 'robinhood') => {
  let refused: unknown = null;
  await act(async () => {
    await account.choose(chain).catch((e: unknown) => {
      refused = e;
    });
  });
  return refused;
};

/** The API's side of a person, and the switches sent to it. */
function api(start: Person, answer?: (chain: string) => Response | null) {
  let person = start;
  const puts: unknown[] = [];
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    if (path === '/v1/me' && method === 'GET') return json(person);
    if (path === '/v1/me/chain' && method === 'PUT') {
      const { chain } = JSON.parse(String(init?.body));
      puts.push(chain);
      const forced = answer?.(chain);
      if (forced) return forced;
      person = { ...person, chain, chainSource: 'picked' };
      return json(person);
    }
    return json({ error: 'not found' }, 404);
  });
  return { puts, stored: () => person };
}

const passkey = (chain: Person['chain'] = 'solana'): Person => ({
  userId: 'did:privy:test',
  wallets: EMBEDDED,
  chain,
  chainSource: 'picked',
  chainOptions: ['solana', 'robinhood'],
});

beforeEach(() => {
  window.localStorage.removeItem('tf-chain');
  window.history.replaceState(null, '', '/');
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the bar', () => {
  it('shows and switches no chain, signed out or signed in', async () => {
    const visitor = await view();
    await settle();
    expect(visitor.querySelector('[data-ui="chain-switch"], [data-ui="chain-options"]')).toBeNull();
    expect(find(visitor, '[data-ui="compact-nav-bar"]').textContent).not.toMatch(
      /Solana|Robinhood/,
    );
    await unmountAll();
    api(passkey('solana'));
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    const button = find(host, '[data-ui="account-menu-button"]');
    expect(find(host, '[data-ui="compact-nav-bar"]').textContent).not.toMatch(/Solana|Robinhood/);
    expect(button.hasAttribute('data-chain')).toBe(false);
    // its menu names the chains of the person's wallets, and holds nothing that switches one
    await click(button);
    const menu = find(host, '[data-ui="account-menu"]');
    expect(menu.querySelector('[aria-pressed], [role="group"], input[type="radio"]')).toBeNull();
    expect(menu.textContent).not.toMatch(/switch|Choose a chain/i);
  });
});

describe('signed out', () => {
  it('starts on Solana, takes Robinhood Chain when it is chosen, and keeps it in this browser', async () => {
    const host = await view();
    await settle();
    expect(shown(host)).toBe('solana');
    expect(await choose('robinhood')).toBeNull();
    expect(shown(host)).toBe('robinhood');
    expect(window.localStorage.getItem('tf-chain')).toBe('robinhood');

    // a later visit in the same browser opens on it
    await unmountAll();
    const again = await view();
    await settle();
    expect(shown(again)).toBe('robinhood');
  });

  it('opens on the chain the address names', async () => {
    window.history.replaceState(null, '', '/shelf?chain=robinhood');
    const host = await view();
    await settle();
    expect(shown(host)).toBe('robinhood');
  });
});

describe('signed in', () => {
  it('stores where new plans start on the API', async () => {
    const server = api(passkey('solana'));
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    expect(shown(host)).toBe('solana');
    expect(await choose('robinhood')).toBeNull();
    expect(server.puts).toEqual(['robinhood']);
    expect(server.stored().chain).toBe('robinhood');
    expect(shown(host)).toBe('robinhood');
  });

  it('says why a choice was not stored, and stays on the chain it was on', async () => {
    for (const [answer, sentence] of [
      [json({}, 503), en.chain.failure.unreachable],
      [
        json({ error: 'no', code: 'NO_WALLET_FOR_CHAIN' }, 409),
        en.chain.failure.noWallet('Robinhood Chain'),
      ],
      [json({ error: 'slow down' }, 429), en.shell.slowDown],
      [
        json({ error: 'Robinhood Chain is not a chain you can pick' }, 422),
        en.chain.failure.notOffered,
      ],
      [json({ error: 'sign in first' }, 401), en.chain.failure.signedOut],
    ] as const) {
      api(passkey('solana'), () => answer.clone());
      portStore.set(signedInPort(EMBEDDED));
      const host = await view();
      await settle();
      const refused = await choose('robinhood');
      // the sentence /goal's chain choice says for it
      expect(switchFailure(en, refused, 'Robinhood Chain')).toBe(sentence);
      expect(shown(host)).toBe('solana');
      await unmountAll();
    }
  });

  it('gives the chains the API lists for the person, over what the wallets alone would say', async () => {
    api({ ...passkey('robinhood'), chainOptions: ['robinhood'] });
    portStore.set(signedInPort(EMBEDDED));
    await view();
    await settle();
    expect(account.account).toMatchObject({ status: 'ready', options: ['robinhood'] });
  });
});

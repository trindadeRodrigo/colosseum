// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import {
  EMBEDDED,
  fakePort,
  json,
  METAMASK,
  PHANTOM,
  signedInPort,
} from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { useAccount } from './AccountProvider';
import { ChainSwitch } from './ChainSwitch';
import type { Person } from './person';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));

// The bar's chain switcher (gate CHAIN-SWITCH): signed out, the chain someone is looking at, kept in
// this browser; signed in, the current chain, stored by the API. A chain no wallet of the person's
// signs on, or one our server has switched off, is listed and not chosen, with the reason.

const en = dictionary('en');

/** What the screens read: the chain the account gives them. */
function Shown() {
  const { chain } = useAccount();
  return createElement('output', { 'data-ui': 'shown' }, chain ?? 'none');
}

const view = () =>
  mount(
    withAccount('en', [
      createElement(ChainSwitch, { key: 's' }),
      createElement(Shown, { key: 'v' }),
    ]),
  );
const toggle = (host: HTMLElement) => find(host, '[data-ui="chain-switch"] > button');
const option = (host: HTMLElement, chain: string) =>
  find(host, `[data-ui="chain-switch-panel"] button[data-chain="${chain}"]`);
const shown = (host: HTMLElement) => find(host, '[data-ui="shown"]').textContent;

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

describe('signed out', () => {
  it('starts on Solana, switches to Robinhood Chain, and keeps it in this browser', async () => {
    const host = await view();
    await settle();
    expect(toggle(host).getAttribute('aria-label')).toBe(en.chain.switch.current('Solana'));
    expect(toggle(host).getAttribute('aria-expanded')).toBe('false');
    await click(toggle(host));
    expect(toggle(host).getAttribute('aria-expanded')).toBe('true');
    expect(option(host, 'solana').getAttribute('aria-pressed')).toBe('true');
    expect(find(host, '[data-ui="chain-switch-panel"]').textContent).toContain(
      en.chain.switch.browsing,
    );
    await click(option(host, 'robinhood'));
    await settle();
    expect(shown(host)).toBe('robinhood');
    expect(toggle(host).getAttribute('aria-label')).toBe(
      en.chain.switch.current('Robinhood Chain'),
    );
    expect(host.querySelector('[data-ui="chain-switch-panel"]')).toBeNull();
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

  it('closes on Escape, and gives focus back to the button', async () => {
    const host = await view();
    await settle();
    toggle(host).focus();
    await click(toggle(host));
    option(host, 'robinhood').focus();
    await press(option(host, 'robinhood'), 'Escape');
    expect(host.querySelector('[data-ui="chain-switch-panel"]')).toBeNull();
    expect(document.activeElement).toBe(toggle(host));
    expect(shown(host)).toBe('solana');
  });
});

describe('signed in', () => {
  it('switches the current chain on the API, and says plans already made stay where they are', async () => {
    const server = api(passkey('solana'));
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    expect(shown(host)).toBe('solana');
    await click(toggle(host));
    expect(find(host, '[data-ui="chain-switch-panel"]').textContent).toContain(
      en.chain.switch.plansStay,
    );
    await click(option(host, 'robinhood'));
    await settle();
    expect(server.puts).toEqual(['robinhood']);
    expect(server.stored().chain).toBe('robinhood');
    expect(shown(host)).toBe('robinhood');
    expect(find(host, '[data-ui="chain-switch"] [role="status"]').textContent).toBe(
      en.chain.switch.done('Robinhood Chain'),
    );
  });

  it('keeps an EVM wallet alone on Robinhood Chain: Solana is listed, not chosen, with why', async () => {
    const server = api({
      userId: 'did:privy:test',
      wallets: METAMASK,
      chain: 'robinhood',
      chainSource: 'wallet',
      chainOptions: ['robinhood'],
    });
    portStore.set(signedInPort(METAMASK));
    const host = await view();
    await settle();
    await click(toggle(host));
    const solana = option(host, 'solana');
    expect(solana.getAttribute('aria-disabled')).toBe('true');
    const why = document.getElementById(solana.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe(en.chain.switch.noWallet('Solana'));
    expect(option(host, 'robinhood').getAttribute('aria-disabled')).toBeNull();
    await click(solana);
    await settle();
    expect(server.puts).toEqual([]);
    expect(shown(host)).toBe('robinhood');
  });

  it('lets a wallet of both families switch, as Phantom does', async () => {
    const both = [
      ...PHANTOM,
      { family: 'evm' as const, address: METAMASK[0]?.address ?? '', kind: 'external' as const },
    ];
    const server = api({ ...passkey('solana'), wallets: both });
    portStore.set(signedInPort(both));
    const host = await view();
    await settle();
    await click(toggle(host));
    expect(option(host, 'robinhood').getAttribute('aria-disabled')).toBeNull();
    await click(option(host, 'robinhood'));
    await settle();
    expect(server.puts).toEqual(['robinhood']);
  });

  it('lists a chain our server has switched off, not chosen, with why', async () => {
    const server = api(passkey('solana'));
    portStore.set(
      signedInPort(EMBEDDED, {
        network: (chain) => {
          const network = fakePort().network(chain);
          return network && { ...network, on: chain !== 'robinhood' };
        },
      }),
    );
    const host = await view();
    await settle();
    await click(toggle(host));
    const robinhood = option(host, 'robinhood');
    expect(robinhood.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(robinhood.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe(en.chain.switch.off('Robinhood Chain'));
    await click(robinhood);
    await settle();
    expect(server.puts).toEqual([]);
  });

  it('says why a switch was not stored, and stays on the chain it was on', async () => {
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
      await click(toggle(host));
      await click(option(host, 'robinhood'));
      await settle();
      expect(find(host, '[data-ui="chain-switch-panel"] [role="alert"]').textContent).toBe(
        sentence,
      );
      expect(shown(host)).toBe('solana');
      await unmountAll();
    }
  });

  it('sends one switch for two presses in one go', async () => {
    let answer: (res: Response) => void = () => {};
    const server = api(
      passkey('solana'),
      () => new Promise<Response>((r) => (answer = r)) as never,
    );
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    await click(toggle(host));
    const robinhood = option(host, 'robinhood');
    robinhood.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    robinhood.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(server.puts).toEqual(['robinhood']);
    answer(json({ ...passkey('robinhood') }));
    await settle();
    expect(shown(host)).toBe('robinhood');
  });

  it('closes when focus leaves it', async () => {
    api(passkey('solana'));
    portStore.set(signedInPort(EMBEDDED));
    const outside = document.createElement('button');
    document.body.append(outside);
    try {
      const host = await view();
      await settle();
      toggle(host).focus();
      await click(toggle(host));
      option(host, 'robinhood').focus();
      expect(host.querySelector('[data-ui="chain-switch-panel"]')).not.toBeNull();
      await act(async () => outside.focus());
      expect(host.querySelector('[data-ui="chain-switch-panel"]')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it('offers the chains the API lists for the person, over what the wallets alone would say', async () => {
    const server = api({ ...passkey('robinhood'), chainOptions: ['robinhood'] });
    portStore.set(signedInPort(EMBEDDED));
    const host = await view();
    await settle();
    await click(toggle(host));
    expect(option(host, 'solana').getAttribute('aria-disabled')).toBe('true');
    await click(option(host, 'solana'));
    await settle();
    expect(server.puts).toEqual([]);
  });
});

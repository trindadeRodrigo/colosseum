// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { useAccount } from '../account/AccountProvider';
import { withAccount } from '../account/test/screen';
import type { InvestProps } from '../order/Invest';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyScreen } from './FamilyScreen';
import { FAMILY_ID, familyOf, recipeOf, SLUG, SOLANA, USER, vaultOf } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// A deposit that was pressed on a portfolio's page is signed step by step on the recipe's chain. From
// the press until the run ends or stops, nothing on the page may change that chain: the section that
// holds the run would be drawn again, and the run cut between its deposit and its swaps (review of
// #208). The invest card is stood in for by one that says when it was pressed and when it stopped,
// and counts how often it was mounted.

const en = dictionary('en');
const card = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('../order/Invest', () => ({
  Invest: ({ onProgress, onStopped, onDone }: InvestProps) => {
    useEffect(() => {
      card.mounts += 1;
      return () => {
        card.unmounts += 1;
      };
    }, []);
    return createElement(
      'div',
      { 'data-ui': 'invest-stand-in' },
      createElement(
        'button',
        {
          type: 'button',
          'data-act': 'press',
          onClick: () => onProgress?.({ orderId: 'o', step: 0, of: 0, line: '' }),
        },
        'press',
      ),
      createElement(
        'button',
        { type: 'button', 'data-act': 'stop', onClick: () => onStopped?.({ orderId: 'o' }) },
        'stop',
      ),
      createElement(
        'button',
        {
          type: 'button',
          'data-act': 'done',
          onClick: () => onDone?.({ orderId: 'o', vault: null }),
        },
        'done',
      ),
    );
  },
}));

const both = familyOf(FAMILY_ID, {
  chains: ['solana', 'robinhood'],
  recipes: [
    recipeOf(),
    recipeOf({
      chain: 'robinhood',
      name: 'Robinhood Chain',
      onchainId: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      creator: '0x1111111111111111111111111111111111111111',
      provenance: 'mock',
    }),
  ],
});

/** The person's new plans start on Robinhood Chain; a vault of theirs follows the portfolio on Solana. */
let starts = 'robinhood';
function api() {
  starts = 'robinhood';
  portStore.setApi(async (path, init) => {
    // where new plans start, as /goal's choice stores it
    if (path === '/v1/me/chain') starts = JSON.parse(String(init?.body)).chain;
    if (path === '/v1/me' || path === '/v1/me/chain')
      return json({
        userId: USER,
        wallets: EMBEDDED,
        chain: starts,
        chainSource: 'picked',
        chainOptions: ['solana', 'robinhood'],
      });
    if (path.startsWith(`/v1/indexes/${SLUG}/versions`))
      return json({ familyId: FAMILY_ID, slug: SLUG, chains: [] });
    if (path.startsWith('/v1/indexes/')) return json({ family: both, disclaimer: 'd' });
    if (path === '/v1/portfolio')
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vaults: [{ ...vaultOf({ owner: SOLANA }), provenance: 'sandbox' }],
            prices: [],
          },
        ],
        disclaimer: 'd',
      });
    return json({ error: 'not found' }, 404);
  });
}

const radios = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLInputElement>('[data-ui="family-chain"] input[type="radio"]'),
];
const checked = (host: HTMLElement) => radios(host).find((r) => r.checked)?.value;
const showOther = (host: HTMLElement) => find(host, '[data-ui="vaults-elsewhere"] button');

beforeEach(() => {
  window.localStorage.clear();
  card.mounts = 0;
  card.unmounts = 0;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  api();
});
afterEach(unmountAll);

describe('a portfolio’s page while a deposit runs', () => {
  const page = async () => {
    const host = await mount(withAccount('en', createElement(FamilyScreen, { slug: SLUG })));
    for (let i = 0; i < 6; i += 1) await settle(50);
    await click(find(host, '[data-ui="amount-field"] input, input[inputmode="decimal"]'));
    return host;
  };

  it('locks the chain choice and the way to the other chain from the press until the run stops', async () => {
    const host = await page();
    expect(checked(host)).toBe('robinhood');
    expect(card.mounts).toBe(1);
    await click(find(host, '[data-act="press"]'));
    // every chain control is inert, and says why
    expect(radios(host).every((r) => r.disabled)).toBe(true);
    expect(find(host, '[data-ui="family-chain"]').textContent).toContain(
      en.shared.family.whichLocked,
    );
    expect(showOther(host).getAttribute('aria-disabled')).toBe('true');
    // pressed all the same: the recipe stays, and the card that holds the run is the same one
    await click(radios(host)[0] as HTMLElement);
    await click(showOther(host));
    await settle(50);
    expect(checked(host)).toBe('robinhood');
    expect([card.mounts, card.unmounts]).toEqual([1, 0]);
    // the run stopped short: the choice is the person's again
    await click(find(host, '[data-act="stop"]'));
    expect(radios(host).some((r) => r.disabled)).toBe(false);
    expect(find(host, '[data-ui="family-chain"]').textContent).toContain(
      en.shared.family.whichHint,
    );
    await click(radios(host)[0] as HTMLElement);
    await settle(50);
    expect(checked(host)).toBe('solana');
  });

  it('keeps the recipe under a run when where new plans start changes elsewhere, the page’s own choice never touched', async () => {
    // the bar's switch is gone; what is left to change it is /goal's choice, in another tab. The
    // page fell back on it for the recipe it shows: the run pins the recipe from the press
    let choose: (chain: 'solana' | 'robinhood') => Promise<void> = async () => {};
    function Elsewhere() {
      choose = useAccount().choose;
      return null;
    }
    const host = await mount(
      withAccount(
        'en',
        createElement(
          'div',
          null,
          createElement(FamilyScreen, { slug: SLUG }),
          createElement(Elsewhere),
        ),
      ),
    );
    for (let i = 0; i < 6; i += 1) await settle(50);
    expect(checked(host)).toBe('robinhood');
    await click(find(host, '[data-act="press"]'));
    await act(async () => {
      await choose('solana');
    });
    for (let i = 0; i < 3; i += 1) await settle(50);
    // the same recipe, and the card that holds the run was not drawn again
    expect(checked(host)).toBe('robinhood');
    expect([card.mounts, card.unmounts]).toEqual([1, 0]);
  });

  it('gives the choice back once every step is confirmed', async () => {
    const host = await page();
    await click(find(host, '[data-act="press"]'));
    expect(radios(host).every((r) => r.disabled)).toBe(true);
    await click(find(host, '[data-act="done"]'));
    expect(radios(host).some((r) => r.disabled)).toBe(false);
    expect(showOther(host).getAttribute('aria-disabled')).not.toBe('true');
  });
});

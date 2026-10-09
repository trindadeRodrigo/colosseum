// @vitest-environment happy-dom
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { withAccount } from '../account/test/screen';
import { StartChain } from '../account/test/start-chain';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyBuyScreen } from './FamilyBuyScreen';
import { FAMILY_ID, familyOf, recipeOf, SLUG, SOLANA, USER, vaultOf } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The deposit page of a shared portfolio shows the recipe of the chain the person's new plans start
// on, when the page's own choice was never touched. Once a deposit is pressed that recipe is the
// page's: where new plans start can change elsewhere (/goal in another tab) and the card that holds
// the run is not drawn again on another chain. The card is stood in for by one that says which chain
// it is on and when it was pressed, and counts how often it was mounted.

const card = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('../order/InvestCard', async (original) => ({
  ...(await original<typeof import('../order/InvestCard')>()),
  InvestCard: ({
    chain,
    onProgress,
  }: {
    chain: string;
    onProgress?: (p: { orderId: string; step: number; of: number; line: string }) => void;
  }) => {
    useEffect(() => {
      card.mounts += 1;
      return () => {
        card.unmounts += 1;
      };
    }, []);
    return createElement(
      'button',
      {
        type: 'button',
        'data-ui': 'card-stand-in',
        'data-chain': chain,
        onClick: () => onProgress?.({ orderId: 'o', step: 0, of: 0, line: '' }),
      },
      'press',
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

const view = async () => {
  const host = await mount(
    withAccount('en', [
      createElement(FamilyBuyScreen, { key: 'page', slug: SLUG }),
      createElement(StartChain, { key: 'start' }),
    ]),
  );
  for (let i = 0; i < 6; i += 1) await settle(50);
  return host;
};
const on = (host: HTMLElement) =>
  find(host, '[data-ui="card-stand-in"]').getAttribute('data-chain');
const elsewhere = async (host: HTMLElement, chain: string) => {
  await click(find(host, `[data-ui="start-chain"] [data-start="${chain}"]`));
  for (let i = 0; i < 3; i += 1) await settle(50);
};

beforeEach(() => {
  window.localStorage.clear();
  card.mounts = 0;
  card.unmounts = 0;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  api();
});
afterEach(unmountAll);

describe('a portfolio’s deposit page while a deposit runs', () => {
  it('follows where new plans start until a deposit is pressed', async () => {
    const host = await view();
    expect(on(host)).toBe('robinhood');
    await elsewhere(host, 'solana');
    expect(on(host)).toBe('solana');
  });

  it('keeps the recipe under a run when where new plans start changes elsewhere', async () => {
    const host = await view();
    expect(on(host)).toBe('robinhood');
    await click(find(host, '[data-ui="card-stand-in"]'));
    await elsewhere(host, 'solana');
    expect(on(host)).toBe('robinhood');
    expect([card.mounts, card.unmounts]).toEqual([1, 0]);
  });
});

// @vitest-environment happy-dom
import { solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { recallOrder } from '../order/order-record';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyBuyScreen } from './FamilyBuyScreen';
import { FamilyScreen } from './FamilyScreen';
import { PublishScreen, problemsOf } from './PublishScreen';
import { ShelfScreen } from './ShelfScreen';
import {
  FAMILY_ID,
  FUNDED,
  familyBuyOrder,
  familyOf,
  followOrder,
  ORDER_ID,
  publishOrder,
  RECIPE,
  recipeOf,
  SLUG,
  SOLANA,
  USER,
  VAULT,
  vaultOf,
  WEIGHTS,
} from './test/fixtures';
import { VaultScreen } from './VaultScreen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The shared-portfolio screens with real events, against a double of the API (WEB-4): the shelf of the
// person's chain, the creator's words as text, the auto-follow switch only where it is offered (gate
// GOLD-ONE-TAP), the prompt when a followed portfolio changed, a follow that names the vault's own plan
// number, and the publish form, whose family id and text are its own.

const en = dictionary('en');
type Call = { method: string; path: string; body?: Record<string, unknown> };

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

/** The vault of the fake port's wallet for plan 42, as the guard derives it on Solana. */
const MY_VAULT = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');

function api(o: {
  family?: ReturnType<typeof familyOf> | null;
  vaults?: ReturnType<typeof vaultOf>[];
  order?: () => unknown;
  /** Answers GET /v1/funding: the wallet has what the buy needs. */
  funded?: boolean;
  /** The person's chain; Solana unless said. */
  chain?: Person['chain'];
}) {
  const calls: Call[] = [];
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/me') return json({ ...person, chain: o.chain ?? person.chain });
    if (path.startsWith('/v1/shelf'))
      return json({ families: o.family ? [o.family] : [], disclaimer: 'd' });
    if (path.startsWith(`/v1/indexes/${SLUG}/versions`))
      return json({ familyId: FAMILY_ID, slug: SLUG, chains: [] });
    if (path.startsWith('/v1/indexes/'))
      return o.family ? json({ family: o.family, disclaimer: 'd' }) : json({ error: 'no' }, 404);
    if (path === '/v1/portfolio')
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vaults: (o.vaults ?? []).map((v) => ({ ...v, provenance: 'sandbox' })),
            prices: [],
          },
        ],
        disclaimer: 'd',
      });
    if (path === '/v1/orders' && method === 'POST') return json(o.order ? o.order() : {});
    if (path.startsWith('/v1/funding?') && o.funded) return json(FUNDED);
    return json({ error: 'not found' }, 404);
  });
  return calls;
}

const show = async (node: Parameters<typeof withAccount>[1]) => {
  const host = await mount(withAccount('en', node));
  for (let i = 0; i < 4; i += 1) await settle(50);
  return host;
};
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes(name));

beforeEach(() => {
  window.localStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the shelf', () => {
  it('asks for the person’s chain only, and shows a creator’s words as text, never markup', async () => {
    const calls = api({
      family: familyOf(FAMILY_ID, {
        name: '<img src=x onerror=alert(1)>Three',
        copy: 'Visit <a href="https://x.invalid">this</a>',
        recipes: [recipeOf({ textMatches: null })],
        // the server's word: no badge is drawn from it
        platform: true,
      }),
    });
    const host = await show(createElement(ShelfScreen));
    expect(calls.some((c) => c.path === '/v1/shelf?chain=solana')).toBe(true);
    const card = find(host, '[data-ui="shelf-card"]');
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>Three');
    expect(card.querySelector('img')).toBeNull();
    // the one link is the card's own, to the portfolio's page
    expect([...card.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      `/indexes/${SLUG}`,
    ]);
    // words that match no version the creator published are said to be unverified
    expect(card.textContent).toContain(en.shared.text.unverified);
    expect(card.textContent).toContain('SPYX 40%');
    expect(card.textContent).not.toContain(en.shared.shelf.card.platform);
    // a test network's portfolio carries the hatch and one quiet line, never the word MOCK
    expect(card.textContent).not.toContain('MOCK');
    expect(card.querySelector('[data-ui="sample-note"]')?.textContent).toBe(
      `${en.shell.mockAnnounce} · ${en.shell.testNetwork}`,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('a portfolio’s page (gate GOLD-ONE-TAP)', () => {
  it('offers the auto-follow switch on a vault that follows it where the portfolio offers it', async () => {
    api({ family: familyOf(FAMILY_ID), vaults: [vaultOf({ address: MY_VAULT })] });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(find(host, '[data-ui="auto-follow-offer"]').getAttribute('data-offered')).toBe('true');
    expect(button(host, en.shared.vaults.autoOn)).toBeDefined();
    expect(host.textContent).not.toContain(en.shared.vaults.oneTap);
  });

  it('offers no switch on one that holds an asset with no oracle, says why, and asks for the one tap', async () => {
    api({
      family: familyOf(FAMILY_ID, {
        recipes: [
          recipeOf({
            autoFollow: { offered: false, reason: 'no_oracle', assets: ['solana:gldx'] },
          }),
        ],
      }),
      vaults: [vaultOf({ address: MY_VAULT })],
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const offer = find(host, '[data-ui="auto-follow-offer"]');
    expect(offer.getAttribute('data-offered')).toBe('false');
    expect(offer.textContent).toContain(en.shared.offer.noOracle('GLDX', 'Solana'));
    expect(button(host, en.shared.vaults.autoOn)).toBeUndefined();
    expect(host.textContent).toContain(en.shared.vaults.oneTap);
  });

  it('prompts when the followed portfolio changed, and the accept is a follow of the version shown', async () => {
    const calls = api({
      family: familyOf(FAMILY_ID),
      vaults: [vaultOf({ address: MY_VAULT, acceptedVersion: 1 })],
      order: () => followOrder(['accept_version']),
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const prompt = find(host, '[data-ui="follow-prompt"]');
    expect(prompt.textContent).toContain(en.shared.prompt.inEffect(2));
    await click(button(prompt, en.shared.prompt.accept(2)) as HTMLElement);
    await settle(50);
    const placed = calls.find((c) => c.path === '/v1/orders');
    expect(placed?.body).toEqual({
      type: 'follow',
      vault: MY_VAULT,
      family: SLUG,
      autoFollow: false,
      version: 2,
    });
    // what the order is held to is what the page showed, kept for the order screen
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'follow',
      slug: SLUG,
      familyId: FAMILY_ID,
      vault: MY_VAULT,
      basketId: '42',
      follow: { recipeOnchainId: RECIPE, version: 2 },
      autoFollow: false,
      source: 'api',
    });
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it('never asks to keep auto-follow on where the portfolio does not offer it', async () => {
    // a vault that has the switch on, following a portfolio that now holds an asset with no oracle
    const calls = api({
      family: familyOf(FAMILY_ID, {
        recipes: [
          recipeOf({
            autoFollow: { offered: false, reason: 'no_oracle', assets: ['solana:gldx'] },
          }),
        ],
      }),
      vaults: [vaultOf({ address: MY_VAULT, acceptedVersion: 1, autoFollow: true })],
      order: () => followOrder(['accept_version']),
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const prompt = find(host, '[data-ui="follow-prompt"]');
    await click(button(prompt, en.shared.prompt.accept(2)) as HTMLElement);
    await settle(50);
    expect(calls.find((c) => c.path === '/v1/orders')?.body).toMatchObject({
      type: 'follow',
      vault: MY_VAULT,
      autoFollow: false,
      version: 2,
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({ kind: 'follow', autoFollow: false });
  });

  it('makes no order for a vault whose plan number is not its own', async () => {
    const calls = api({
      family: familyOf(FAMILY_ID),
      vaults: [vaultOf({ address: MY_VAULT, basketId: '43', recipeOnchainId: null })],
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    await click(button(host, en.shared.vaults.followWith) as HTMLElement);
    await settle(50);
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });

  it('offers no follow of a portfolio whose id is not its slug’s (gate FAMILY-ID)', async () => {
    api({ family: familyOf('ab'.repeat(32)) });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(host.textContent).toContain(en.shared.family.foreign);
    expect(
      [...host.querySelectorAll('a')].some((a) => a.textContent === en.shared.family.buy),
    ).toBe(false);
  });

  it('is not offered on another chain than the person’s (gate ONE-CHAIN)', async () => {
    api({
      family: familyOf(FAMILY_ID, {
        recipes: [recipeOf({ chain: 'robinhood', name: 'Robinhood Chain' })],
        chains: ['robinhood'],
      }),
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(host.textContent).toContain(en.shared.family.notHere('Solana'));
    expect(host.textContent).not.toContain(en.shared.family.buy);
  });
});

describe('buying a portfolio, which follows it', () => {
  it('asks for the version the page showed, and keeps the weights the buy is held to', async () => {
    const calls = api({ family: familyOf(FAMILY_ID), order: () => familyBuyOrder(), funded: true });
    const host = await show(createElement(FamilyBuyScreen, { slug: SLUG }));
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(400);
    await settle(50);
    await click(find(host, `input[type="checkbox"]`));
    await click(button(host, en.shared.buy.review('$10')) as HTMLElement);
    await settle(50);
    expect(calls.find((c) => c.path === '/v1/orders')?.body).toEqual({
      type: 'buy',
      owner: { solana: SOLANA },
      amountUsd: 10,
      family: SLUG,
      version: 2,
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'family',
      slug: SLUG,
      familyId: FAMILY_ID,
      follow: { recipeOnchainId: RECIPE, version: 2 },
      targets: WEIGHTS,
      source: 'api',
    });
  });
});

describe('the publish form', () => {
  it('works out the family id from the address, holds the limits, and keeps its own text', async () => {
    const calls = api({ family: null, order: () => publishOrder() });
    const host = await show(createElement(PublishScreen));
    const field = (label: string) =>
      find<HTMLInputElement>(
        host,
        `#${CSS.escape(
          [...host.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor ?? '',
        )}`,
      );
    await type(field(en.shared.publish.name), 'Three of the largest');
    await settle(400);
    await settle(50);
    // the id the form shows is its own: familyIdOf(slug), never the server's
    expect(find(host, '[data-ui="family-id"]').textContent).toBe(FAMILY_ID);
    // weights that do not add up to 100% are refused before anything is sent
    await type(field(`${en.shared.publish.weight} 1`), '50');
    await click(button(host, en.shared.publish.review) as HTMLElement);
    await settle(50);
    expect(host.textContent).toContain(en.shared.publish.problems.sum);
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);

    await type(field(`${en.shared.publish.weight} 1`), '40');
    await click(button(host, en.shared.publish.review) as HTMLElement);
    await settle(50);
    const body = calls.find((c) => c.path === '/v1/orders')?.body;
    expect(body).toMatchObject({
      type: 'publish',
      creator: { solana: SOLANA },
      family: SLUG,
      familyId: FAMILY_ID,
      name: 'Three of the largest',
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      kind: 'publish',
      action: 'publish',
      familyId: FAMILY_ID,
      text: { slug: SLUG, name: 'Three of the largest', copy: '', kind: 'index' },
      version: 1,
    });
  });

  it('does not update a portfolio of the person’s whose id is not its address’s (gate FAMILY-ID)', async () => {
    const calls = api({
      family: familyOf('ab'.repeat(32), { recipes: [recipeOf({ creator: SOLANA })] }),
      order: () => publishOrder(),
    });
    const host = await show(createElement(PublishScreen));
    const name = [...host.querySelectorAll('label')].find(
      (l) => l.textContent === en.shared.publish.name,
    );
    await type(
      find<HTMLInputElement>(host, `#${CSS.escape(name?.htmlFor ?? '')}`),
      'Three of the largest',
    );
    await settle(400);
    await settle(50);
    expect(host.textContent).toContain(en.shared.family.foreign);
    // the id shown is the address's own, not the stored one
    expect(find(host, '[data-ui="family-id"]').textContent).toBe(FAMILY_ID);
    await click(button(host, en.shared.publish.review) as HTMLElement);
    await settle(50);
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
  });

  it('refuses the text the server refuses: a bare web address, an email, a hidden character', () => {
    const rows = [
      { asset: 'solana:spyx', bps: 4000 },
      { asset: 'solana:nvdax', bps: 3000 },
      { asset: 'solana:tslax', bps: 3000 },
    ];
    const form = (name: string, copy: string) => ({ name, slug: 'x', copy, rows });
    expect(problemsOf(form('Three of the largest', 'Three test tokens.'), 'solana')).toEqual([]);
    expect(problemsOf(form('Go to evil.xyz', ''), 'solana')).toEqual(['name']);
    expect(problemsOf(form('U.S. stocks', 'see evil.xyz/airdrop'), 'solana')).toEqual(['copy']);
    expect(problemsOf(form('Three', 'write to me@mail.com'), 'solana')).toEqual(['copy']);
    expect(problemsOf(form('Three', 'plain\u202etext'), 'solana')).toEqual(['copy']);
    expect(problemsOf(form('Three', 'two lines\nare fine'), 'solana')).toEqual([]);
  });

  it('is not offered on Robinhood Chain, where the guard signs no publish yet (AGT-4)', async () => {
    const calls = api({ family: null, chain: 'robinhood' });
    const shelf = await show(createElement(ShelfScreen));
    expect(calls.some((c) => c.path === '/v1/shelf?chain=robinhood')).toBe(true);
    expect(shelf.querySelector('a[href="/publish"]')).toBeNull();
  });

  it('says on Robinhood Chain that publishing is Solana only, with no form', async () => {
    const calls = api({ family: null, chain: 'robinhood' });
    const host = await show(createElement(PublishScreen));
    expect(host.textContent).toContain(en.shared.publish.problems.chain);
    expect(host.querySelector('input')).toBeNull();
    expect(button(host, en.shared.publish.review)).toBeUndefined();
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
  });

  it('refuses an address that is another creator’s', async () => {
    api({ family: familyOf(FAMILY_ID) });
    const host = await show(createElement(PublishScreen));
    const name = [...host.querySelectorAll('label')].find(
      (l) => l.textContent === en.shared.publish.name,
    );
    await type(
      find<HTMLInputElement>(host, `#${CSS.escape(name?.htmlFor ?? '')}`),
      'Three of the largest',
    );
    await settle(400);
    await settle(50);
    expect(host.textContent).toContain(en.shared.publish.theirs);
  });
});

describe('a vault’s public page', () => {
  it('pins the vault’s value to the read and the prices it stands on', async () => {
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path === `/v1/vaults/solana/${VAULT}`)
        return json({
          chain: 'solana',
          name: 'Solana',
          mode: 'live',
          provenance: 'sandbox',
          vault: { ...vaultOf({ valueUsd: '1234.5' }), provenance: 'sandbox' },
          prices: [],
          disclaimer: 'd',
        });
      return json({ error: 'not found' }, 404);
    });
    const host = await show(createElement(VaultScreen, { chain: 'solana', address: VAULT }));
    const figure = [...host.querySelectorAll('[data-ui="figure"]')].find((f) =>
      f.textContent?.includes('$1,234'),
    );
    const pin = figure?.querySelector<HTMLElement>('[data-ui="pin"]');
    expect(pin).toBeTruthy();
    await click(pin as HTMLElement);
    // no priced holding: the value stands on the chain's read of the vault, at its time
    const line = find(host, '[data-ui="pin-source"]').textContent ?? '';
    for (const part of ['Solana', en.portfolio.vault.valueMethod]) expect(line).toContain(part);
  });
});

// @vitest-environment happy-dom
import { type RecipeFigures, ShelfResponse } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { dollars } from '../goal/sheet';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyScreen } from './FamilyScreen';
import { holdingsOf, kindShares, rate, yieldText } from './product-figures';
import { ShelfScreen } from './ShelfScreen';
import { CREATOR, FAMILY_ID, familyOf, recipeOf, SLUG, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The product pages on the plan pane (gate PRODUCTS-PLAN-PANE): the shelf's cards and a shared
// portfolio's page say the figures first, each with its pin, and say plainly where the server has
// none. The API is a double: GET /v1/me, GET /v1/shelf, GET /v1/indexes/{slug}, GET /v1/portfolio.

const en = dictionary('en');
const pt = dictionary('pt');

const read = {
  source: 'Bearing',
  method: 'sell-side depth measured on chain',
  fetchedAt: '2026-10-07T09:00:00.000Z',
  provenance: 'sandbox',
} as const;
const reading = {
  haircutRule: 'a fifth off',
  source: 'the pool’s own rate',
  method: 'the rate paid over 30 days',
  fetchedAt: '2026-10-07T10:00:00.000Z',
  provenance: 'sandbox',
} as const;
const HELD = [
  { asset: 'solana:spyx', weightBps: 5000 },
  { asset: 'solana:jlusdc', weightBps: 3000 },
  { asset: 'solana:syrupusdc', weightBps: 2000 },
];
/** Half a fund with a measured exit and no yield; two dollar tokens with a yield, one with no exit measured. */
const FIGURES: RecipeFigures = {
  holdings: [
    {
      asset: 'solana:spyx',
      cls: 'etf',
      yield: null,
      exit: { capacityUsd: 250_000.4, lowerBound: true, windowDays: 7, maxCostBps: 100, ...read },
    },
    {
      asset: 'solana:jlusdc',
      cls: 'dollar_yield',
      yield: { quoted: 0.05, afterHaircut: 0.04, ...reading },
      exit: { capacityUsd: 40_000, lowerBound: false, windowDays: 7, maxCostBps: 100, ...read },
    },
    {
      asset: 'solana:syrupusdc',
      cls: 'dollar_yield',
      yield: { quoted: 0.08, afterHaircut: 0.06, ...reading },
      exit: null,
    },
  ],
  yield: {
    low: 0.024,
    high: 0.031,
    source: 'the pool’s own rate',
    method: 'each holding’s yield reading times its share, added',
    fetchedAt: '2026-10-07T10:00:00.000Z',
    provenance: 'sandbox',
  },
};
/** The recipe of the tests with these figures; `null`: a server that sends none. */
const withFigures = (figures: RecipeFigures | null = FIGURES) =>
  recipeOf({
    active: {
      version: 2,
      effectiveAt: 1_791_000_000,
      components: HELD,
      metaHash: 'ab'.repeat(32),
      status: 'active',
    },
    ...(figures ? { figures } : {}),
  });

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(families = [familyOf(FAMILY_ID, { recipes: [withFigures()] })]) {
  const [first] = families;
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/shelf'))
      return json(ShelfResponse.parse({ families, disclaimer: 'd' }));
    if (path.startsWith(`/v1/indexes/${SLUG}/versions`))
      return json({ familyId: FAMILY_ID, slug: SLUG, chains: [] });
    if (path.startsWith('/v1/indexes/')) return json({ family: first, disclaimer: 'd' });
    if (path === '/v1/portfolio')
      return json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vaults: [],
            prices: [],
          },
        ],
        disclaimer: 'd',
      });
    return json({ error: 'not found' }, 404);
  });
}

const show = async (node: Parameters<typeof withAccount>[1], lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, node));
  for (let i = 0; i < 4; i += 1) await settle(50);
  return host;
};

beforeEach(() => {
  window.localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('a product’s figures, from the server’s readings', () => {
  it('gives each holding its own yield and exit, and none where the server has none', () => {
    const rows = holdingsOf(withFigures(), HELD, en);
    expect(rows.map((r) => r.name)).toEqual(['SPYx', 'jlUSDC (Jupiter Lend)', 'syrupUSDC (Maple)']);
    expect(rows.map((r) => r.yield && [r.yield.low, r.yield.high])).toEqual([
      null,
      [0.04, 0.05],
      [0.06, 0.08],
    ]);
    expect(rows.map((r) => r.exit?.capacityUsd ?? null)).toEqual([250_000.4, 40_000, null]);
    expect(rows.map((r) => r.why)).toEqual([
      en.shared.product.why.etf,
      en.shared.product.why.dollar_yield,
      en.shared.product.why.dollar_yield,
    ]);
    // a server that sends no figures: every row is there, with nothing made up
    const bare = holdingsOf(withFigures(null), HELD, en);
    expect(bare.map((r) => [r.yield, r.exit, r.why])).toEqual(
      HELD.map(() => [null, null, en.shared.product.why.unread]),
    );
    // a token this app does not list is named by its mint, and takes no figure of another's
    const [unlisted] = holdingsOf(
      withFigures(),
      [{ asset: 'solana:spyx', weightBps: 10_000, mint: 'SomeMint' }],
      en,
    );
    expect([unlisted?.name, unlisted?.yield, unlisted?.exit, unlisted?.why]).toEqual([
      'SomeMint',
      null,
      null,
      en.shared.product.why.unknown,
    ]);
  });

  it('writes a yield as a range, as one figure when both ends read the same, and kinds by share', () => {
    expect(rate(0.0312, 'en-US')).toBe('3.12%');
    expect(yieldText({ low: 0.024, high: 0.031 }, 'en-US', en.shared.product)).toBe(
      '2.4% to 3.1% a year',
    );
    expect(yieldText({ low: 0.04, high: 0.04 }, 'en-US', en.shared.product)).toBe('4% a year');
    expect(yieldText({ low: 0.024, high: 0.031 }, 'pt-BR', pt.shared.product)).toBe(
      '2,4% a 3,1% ao ano',
    );
    const rows = holdingsOf(withFigures(), HELD, en);
    expect(kindShares(rows, 'en-US', en.plan.kinds)).toEqual(['Funds 50%', 'Dollar yield 50%']);
  });
});

describe('the shelf, a card per product with the figures first', () => {
  it('shows one bar of what it holds, each share, its yield with a pin, its chain and its publisher', async () => {
    api();
    const host = await show(createElement(ShelfScreen));
    const card = find(host, '[data-ui="shelf-card"]');
    const bar = find(card, '[data-ui="holdings-bar"]');
    expect([...bar.children].map((s) => (s as HTMLElement).style.width)).toEqual([
      '50%',
      '30%',
      '20%',
    ]);
    // the bar is never the only place a share is said
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    for (const part of ['SPYx 50%', 'jlUSDC 30%', 'syrupUSDC 20%'])
      expect(card.textContent).toContain(part);
    const whole = find(card, '[data-ui="product-yield"]');
    expect(whole.textContent).toContain('2.4% to 3.1% a year');
    await click(find(whole, '[data-ui="pin"]'));
    expect(find(host, '[data-ui="pin-source"]').textContent).toContain('the pool’s own rate');
    expect(find(card, '[data-ui="chain-badge"]').textContent).toBe('Solana');
    expect(card.textContent).toContain(en.shared.shelf.card.by('US51…ELFx'));
    expect(card.textContent).toContain(en.shared.shelf.card.version(2));
    // fewer words: whether auto-follow is offered is said on the product's page, not on its card
    expect(card.querySelector('[data-ui="auto-follow-offer"]')).toBeNull();
    // a test network's figures: the hatch and one quiet line, never the word MOCK
    expect(card.textContent).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('says there is no yield reading where the server has none, and shows no figure in its place', async () => {
    api([
      familyOf(FAMILY_ID, { recipes: [withFigures({ ...FIGURES, yield: null })] }),
      familyOf('cd'.repeat(32), { slug: 'another', recipes: [withFigures(null)] }),
    ]);
    const host = await show(createElement(ShelfScreen));
    const cards = [...host.querySelectorAll('[data-ui="shelf-card"]')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const whole = find(card as HTMLElement, '[data-ui="product-yield"]');
      expect(whole.textContent).toContain(en.shared.product.noYieldReading);
      expect(whole.querySelector('[data-ui="pin"]')).toBeNull();
      expect(whole.textContent).not.toMatch(/\d%/);
    }
  });
});

describe('a product’s page, on the plan pane', () => {
  it('answers in one line, then a row per holding with its share, its yield and why', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(find(pane, 'h2').textContent).toBe(
      en.shared.product.answer('Funds 50% and Dollar yield 50%', 'Solana'),
    );
    const rows = [...pane.querySelectorAll('[data-ui="plan-pane-holding"]')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    const [fund, lend] = rows;
    if (!fund || !lend) throw new Error('two rows');
    expect(fund.textContent).toContain('SPYx');
    expect(fund.textContent).toContain('50%');
    // a holding that pays no yield: a dash for the eye, the words for a reader, never 0%
    const none = find(fund, '[data-ui="plan-pane-yield"]');
    expect(none.querySelector('[data-ui="pin"]')).toBeNull();
    expect(none.textContent).toContain(en.shared.product.noYield);
    expect(none.textContent).not.toContain('0%');
    expect(fund.textContent).toContain(en.shared.product.why.etf);
    // one that does: its range with its pin
    const paid = find(lend, '[data-ui="plan-pane-yield"]');
    expect(paid.textContent).toContain('4% to 5% a year');
    expect(paid.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(lend.textContent).toContain(en.shared.product.why.dollar_yield);
    // no amount is known on this page, so no row says dollars
    expect(pane.querySelector('[data-ui="plan-pane-holdings"]')?.textContent).not.toContain('$');
  });

  it('gives the exit plan its own block: a pinned figure a holding, and "not measured" where there is none', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const exit = find(host, '[data-ui="plan-pane-exit"]');
    expect(find(exit, 'h3').textContent).toBe(en.shared.product.exit.title);
    const lines = [...exit.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(lines).toHaveLength(3);
    // every size measured was taken: at least that much, in whole dollars
    expect(lines[0]).toContain(en.shared.product.exit.atLeast('$250,000'));
    expect(lines[0]).toContain(en.shared.product.exit.rest('SPYx', 7, '1%'));
    expect(lines[1]).toContain(en.shared.product.exit.about('$40,000'));
    expect(lines[2]).toBe(en.shared.product.exit.notMeasured('syrupUSDC (Maple)'));
    expect(exit.querySelectorAll('[data-ui="pin"]')).toHaveLength(2);
    await click(find(exit.querySelector('li') as HTMLElement, '[data-ui="pin"]'));
    expect(find(host, '[data-ui="pin-source"]').textContent).toContain('Bearing');
  });

  it('names the version and the publisher in view, and offers one way to invest', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.textContent).toContain(en.shared.family.versionN(2));
    expect(pane.textContent).toContain(en.shared.product.publisher);
    expect(find(pane, '[data-ui="creator"]').textContent).toBe(CREATOR);
    expect(find(pane, '[data-ui="product-yield"]').textContent).toContain('2.4% to 3.1% a year');
    const invest = find(pane, '[data-ui="plan-pane-invest"]');
    const links = [...invest.querySelectorAll('a, button')];
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(en.shared.family.buy);
    expect(host.textContent).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('reads the same in Portuguese, and for someone signed out offers the sign-in', async () => {
    api();
    portStore.set(fakePort());
    const host = await show(createElement(FamilyScreen, { slug: SLUG }), 'pt');
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.textContent).toContain('4% a 5% ao ano');
    expect(pane.textContent).toContain(pt.shared.product.why.etf);
    expect(find(pane, '[data-ui="plan-pane-exit"] h3').textContent).toBe(
      pt.shared.product.exit.title,
    );
    expect(pane.textContent).toContain(pt.shared.product.exit.atLeast(dollars(250_000, 'pt')));
    const invest = find(pane, '[data-ui="plan-pane-invest"]');
    expect(find(invest, 'a').textContent).toBe(pt.shared.family.signIn);
    expect(host.textContent).not.toContain(pt.shared.family.buy);
  });

  it('with no figures from the server: every holding is there, each says what is not known', async () => {
    api([familyOf(FAMILY_ID, { recipes: [withFigures(null)] })]);
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.querySelectorAll('[data-ui="plan-pane-holding"]')).toHaveLength(3);
    expect(pane.querySelectorAll('[data-ui="plan-pane-yield"] [data-ui="pin"]')).toHaveLength(0);
    expect(find(pane, '[data-ui="product-yield"]').textContent).toContain(
      en.shared.product.noYieldReading,
    );
    const lines = [...pane.querySelectorAll('[data-ui="plan-pane-exit"] li')];
    expect(lines.map((li) => li.textContent)).toEqual([
      en.shared.product.exit.notMeasured('SPYx'),
      en.shared.product.exit.notMeasured('jlUSDC (Jupiter Lend)'),
      en.shared.product.exit.notMeasured('syrupUSDC (Maple)'),
    ]);
  });
});

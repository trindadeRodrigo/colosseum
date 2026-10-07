// @vitest-environment happy-dom
import { type RecipeFigures, ShelfResponse } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { dollars } from '../goal/sheet';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { FamilyScreen } from './FamilyScreen';
import { holdingsOf, kindShares, rate } from './product-figures';
import { ShelfScreen } from './ShelfScreen';
import { CREATOR, FAMILY_ID, FUNDED, familyOf, recipeOf, SLUG, USER } from './test/fixtures';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The product pages on the plan view (gate PRODUCTS-PLAN-PANE): the shelf's cards and a shared
// portfolio's page say the figures first, each with its pin, say plainly where the server has none,
// and add nothing up across holdings. The API is a double: GET /v1/me, GET /v1/shelf, GET /v1/indexes/{slug}, GET /v1/portfolio.

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

/** Every call the screens made, with what they sent. */
const asked: { method: string; path: string; body?: Record<string, unknown> }[] = [];
/** What the double answers beyond the reads, set by a test. */
const server: {
  /** The portfolio the page reads, when it is not the first of the shelf's. */
  family: (() => ReturnType<typeof familyOf>) | null;
  order: ((body: Record<string, unknown>) => Response) | null;
} = { family: null, order: null };

function api(families = [familyOf(FAMILY_ID, { recipes: [withFigures()] })]) {
  const [first] = families;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ method, path, body });
    if (path === '/v1/orders' && method === 'POST' && server.order) return server.order(body);
    if (path.startsWith('/v1/funding?')) return json(FUNDED);
    if (path.startsWith('/v1/indexes/') && !path.includes('/versions') && server.family)
      return json({ family: server.family(), disclaimer: 'd' });
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
  asked.length = 0;
  server.family = null;
  server.order = null;
  window.localStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('a product’s figures, from the server’s readings', () => {
  it('gives each holding its own yield and exit, and none where the server has none', () => {
    const rows = holdingsOf(withFigures(), HELD, en);
    expect(rows.map((r) => r.name)).toEqual(['SPYx', 'jlUSDC (Jupiter Lend)', 'syrupUSDC (Maple)']);
    expect(rows.map((r) => r.yield && [r.yield.afterHaircut, r.yield.quoted])).toEqual([
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

  it('writes a rate as a percentage, and the kinds of asset by share', () => {
    expect(rate(0.0312, 'en-US')).toBe('3.12%');
    expect(rate(0.04, 'pt-BR')).toBe('4%');
    const rows = holdingsOf(withFigures(), HELD, en);
    expect(kindShares(rows, 'en-US', en.plan.kinds)).toEqual(['Funds 50%', 'Dollar yield 50%']);
  });
});

describe('the shelf, a card per product with the figures first', () => {
  it('shows one bar of what it holds, each share, each holding’s yield with a pin, its chain and its publisher', async () => {
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
    // each holding that has a reading, with its own figure after the haircut and its own pin; the
    // fund has none and is not given one; nothing is added up across them
    const yields = find(card, '[data-ui="product-yield"]');
    expect(yields.textContent).toContain(en.shared.product.yield);
    expect(yields.textContent).toContain('jlUSDC4%');
    expect(yields.textContent).toContain('syrupUSDC6%');
    expect(yields.textContent).not.toContain('SPYx');
    expect(yields.querySelectorAll('[data-ui="pin"]')).toHaveLength(2);
    await click(yields.querySelector('[data-ui="pin"]') as HTMLElement);
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

  it('says no holding has a yield reading where the server has none, and shows no figure in its place', async () => {
    api([
      familyOf(FAMILY_ID, {
        recipes: [withFigures({ holdings: FIGURES.holdings.map((h) => ({ ...h, yield: null })) })],
      }),
      familyOf('cd'.repeat(32), { slug: 'another', recipes: [withFigures(null)] }),
    ]);
    const host = await show(createElement(ShelfScreen));
    const cards = [...host.querySelectorAll('[data-ui="shelf-card"]')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const yields = find(card as HTMLElement, '[data-ui="product-yield"]');
      expect(yields.textContent).toContain(en.shared.product.noYieldReading);
      expect(yields.querySelector('[data-ui="pin"]')).toBeNull();
      expect(yields.textContent).not.toMatch(/\d%/);
    }
  });
});

describe('a product’s page, on the plan view', () => {
  it('answers in one line, then a row per holding with its share, its yield and why', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(find(pane, '[data-ui="plan-answer"]').textContent).toBe(
      en.shared.product.answer('Funds 50% and Dollar yield 50%', 'Solana'),
    );
    expect(find(pane, 'h2').textContent).toBe(en.shared.family.recipe('Solana'));
    expect(pane.textContent).toContain(en.shared.family.versionN(2));
    const rows = [...pane.querySelectorAll('[data-ui="plan-rows"] > li')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    const [fund, lend] = rows;
    if (!fund || !lend) throw new Error('two rows');
    expect(fund.textContent).toContain('SPYx');
    expect(fund.textContent).toContain('50%');
    // a holding that pays no yield has no figure and no pin: never 0%, and its line says why
    expect(fund.querySelector('[data-ui="pin"]')).toBeNull();
    expect(fund.textContent).not.toContain('0.00%');
    expect(fund.textContent).toContain(en.shared.product.why.etf);
    // one that does: its own reading after the haircut, with its pin, and the label that says so
    expect(lend.textContent).toContain('4.00%');
    expect(lend.textContent).toContain(en.plan.legs.afterHaircut);
    expect(lend.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(lend.textContent).toContain(en.shared.product.why.dollar_yield);
    // no amount is known on this page, so no row says dollars
    expect(find(pane, '[data-ui="plan-rows"]').textContent).not.toContain('$');
    // the picture: one bar, a part a holding by its share, each named for a reader
    const parts = [...pane.querySelectorAll('[data-ui="plan-bar"] button')];
    expect(parts.map((b) => b.getAttribute('aria-label'))).toEqual([
      'SPYx, 50%',
      'jlUSDC (Jupiter Lend), 30%',
      'syrupUSDC (Maple), 20%',
    ]);
    // and no yield of the whole portfolio is shown anywhere: that is the engine's to work out
    expect(host.textContent).not.toMatch(/\d% to \d/);
  });

  it('gives the exit plan its own block: a tier a measured holding with its pinned cost, and what is not measured', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const exit = find(host, '[data-ui="exit-plan-line"]');
    const said = exit.textContent ?? '';
    expect(said).toContain(en.plan.exitPlan);
    // every size measured was taken: at least that much, in whole dollars
    const tiers = [...exit.querySelectorAll('[data-ui="exit-tier"]')] as HTMLElement[];
    expect(tiers).toHaveLength(2);
    expect(tiers[0]?.textContent).toContain(
      `SPYx: ${en.shared.product.exit.atLeast('$250,000', 7)}`,
    );
    expect(tiers[1]?.textContent).toContain(
      `jlUSDC (Jupiter Lend): ${en.shared.product.exit.about('$40,000', 7)}`,
    );
    for (const tier of tiers) {
      expect(tier.textContent).toContain(en.shared.product.exit.cost('1%'));
      // figures, not a bar: the size is the one measured at that cost, so a meter of the cost
      // against its limit would always be full
      expect(tier.querySelector('[data-ui="meter"]')).toBeNull();
      expect(tier.textContent).not.toContain(en.plan.exitScale);
    }
    // what nobody measured has no tier and no meter: it is named once, under them
    expect(find(exit, '[data-ui="exit-caveat"]').textContent).toBe(
      en.shared.product.exit.notMeasured('syrupUSDC (Maple)'),
    );
    expect(said).not.toContain('syrupUSDC (Maple):');
    expect(exit.querySelectorAll('[data-ui="pin"]')).toHaveLength(2);
    await click(exit.querySelector('[data-ui="pin"]') as HTMLElement);
    expect(find(host, '[data-ui="pin-source"]').textContent).toContain('Bearing');
  });

  it('names the version and the publisher in view, and offers one way to invest', async () => {
    api();
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.textContent).toContain(en.shared.product.publisher);
    const creator = find(pane, '[data-ui="creator"]');
    expect(creator.textContent).toBe(CREATOR);
    expect(creator.closest('details')).toBeNull();
    // one invest step, on the page: the amount and the one-press card, and no way off to a buy page
    const invest = find(pane, '[data-ui="product-invest"]');
    expect(find(invest, 'input[inputmode="decimal"]').getAttribute('value')).toBe('');
    expect(find(invest, '[data-ui="family-invest"]')).toBeTruthy();
    expect(host.querySelector(`a[href="/indexes/${SLUG}/buy"]`)).toBeNull();
    // where the version and weights come from is said once on the page, over the card
    expect(host.querySelectorAll('[data-ui="source-mark"]')).toHaveLength(1);
    expect(find(invest, '[data-ui="source-mark"]')).toBeTruthy();
    // nothing typed: nothing is asked of the server about an order
    expect(asked.filter((c) => c.path === '/v1/orders')).toEqual([]);
    expect(host.textContent).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('reads the same in Portuguese, and for someone signed out offers the sign-in', async () => {
    api();
    portStore.set(fakePort());
    const host = await show(createElement(FamilyScreen, { slug: SLUG }), 'pt');
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.textContent).toContain('4,00%');
    expect(pane.textContent).toContain(pt.shared.product.why.etf);
    expect(pane.textContent).toContain(pt.shared.product.exit.atLeast(dollars(250_000, 'pt'), 7));
    expect(pane.textContent).toContain(pt.shared.product.publisher);
    const invest = find(pane, '[data-ui="product-invest"]');
    expect(find(invest, 'a').textContent).toBe(pt.shared.family.signIn);
    expect(host.textContent).not.toContain(pt.shared.family.buy);
  });

  it('keeps each holding’s yield and its exit tier for a product with more than four holdings', async () => {
    // five holdings: the view turns from the bar to a table, and the yields must not be lost
    const five = [
      { asset: 'solana:spyx', weightBps: 3000 },
      { asset: 'solana:nvdax', weightBps: 2000 },
      { asset: 'solana:tslax', weightBps: 1000 },
      { asset: 'solana:jlusdc', weightBps: 2500 },
      { asset: 'solana:syrupusdc', weightBps: 1500 },
    ];
    const [fund, lend, credit] = FIGURES.holdings;
    if (!fund || !lend || !credit) throw new Error('three figures');
    const figures: RecipeFigures = {
      holdings: [
        fund,
        { ...fund, asset: 'solana:nvdax', cls: 'stock', exit: null },
        { ...fund, asset: 'solana:tslax', cls: 'stock', exit: null },
        lend,
        credit,
      ],
    };
    const recipe = recipeOf({
      active: {
        version: 2,
        effectiveAt: 1_791_000_000,
        components: five,
        metaHash: 'ab'.repeat(32),
        status: 'active',
      },
      figures,
    });
    api([familyOf(FAMILY_ID, { recipes: [recipe] })]);
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    const rows = [...pane.querySelectorAll('[data-ui="plan-rows"] > li')] as HTMLElement[];
    expect(rows).toHaveLength(5);
    // five parts in the bar; the 10% one is too narrow to press, so it is drawn and not a button
    expect(pane.querySelectorAll('[data-ui="plan-bar"] [data-part]')).toHaveLength(5);
    expect(pane.querySelectorAll('[data-ui="plan-bar"] button')).toHaveLength(4);
    // the two dollar tokens keep their own figure and pin on their row; a stock's row has none
    const yieldOf = (i: number) => rows[i]?.querySelector('[data-ui="row-yield"]');
    expect(yieldOf(3)?.textContent).toContain('4.00%');
    expect(yieldOf(4)?.textContent).toContain('6.00%');
    for (const i of [3, 4]) {
      expect(yieldOf(i)?.querySelector('[data-ui="pin"]')).not.toBeNull();
      expect(yieldOf(i)?.textContent).toContain(en.plan.legs.afterHaircut);
    }
    for (const i of [0, 1, 2]) {
      expect(yieldOf(i)).toBeNull();
      expect(rows[i]?.textContent).not.toContain('0.00%');
    }
    // the exit plan: a line a measured holding with its pinned cost, the rest named once
    const exit = find(pane, '[data-ui="exit-plan-line"]');
    expect(exit.querySelectorAll('[data-ui="exit-tier"]')).toHaveLength(2);
    expect(exit.querySelectorAll('[data-ui="pin"]')).toHaveLength(2);
    expect(exit.textContent).toContain(`SPYx: ${en.shared.product.exit.atLeast('$250,000', 7)}`);
    expect(find(exit, '[data-ui="exit-caveat"]').textContent).toBe(
      en.shared.product.exit.notMeasured('NVDAx, TSLAx, and syrupUSDC (Maple)'),
    );
  });

  it('with no figures from the server: every holding is there, and nothing is measured', async () => {
    api([familyOf(FAMILY_ID, { recipes: [withFigures(null)] })]);
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.querySelectorAll('[data-ui="plan-rows"] > li')).toHaveLength(3);
    expect(pane.querySelectorAll('[data-ui="row-yield"]')).toHaveLength(0);
    expect(pane.querySelectorAll('[data-ui="exit-tier"]')).toHaveLength(0);
    const exit = find(pane, '[data-ui="exit-plan-line"]');
    expect(exit.querySelectorAll('[data-ui="pin"]')).toHaveLength(0);
    expect(exit.textContent).toContain(
      en.shared.product.exit.notMeasured('SPYx, jlUSDC (Jupiter Lend), and syrupUSDC (Maple)'),
    );
  });
});

describe('a product’s page, when the portfolio gets a new version as the person invests', () => {
  /** Version 3: the fund is gone, and the two dollar tokens share it all. */
  const NEXT = [
    { asset: 'solana:jlusdc', weightBps: 6000 },
    { asset: 'solana:syrupusdc', weightBps: 4000 },
  ];
  const version = (n: number, components: typeof HELD) =>
    familyOf(FAMILY_ID, {
      recipes: [
        recipeOf({
          active: {
            version: n,
            effectiveAt: 1_791_000_000,
            components,
            metaHash: 'ab'.repeat(32),
            status: 'active',
          },
          figures: {
            holdings: FIGURES.holdings.filter((h) => components.some((c) => c.asset === h.asset)),
          },
        }),
      ],
    });
  const amountField = (host: HTMLElement) =>
    find<HTMLInputElement>(host, '[data-ui="product-invest"] input[inputmode="decimal"]');
  const orders = () => asked.filter((c) => c.path === '/v1/orders' && c.method === 'POST');

  it('reads the portfolio again, shows the new version’s holdings and says so, before any new order', async () => {
    let published = 2;
    api();
    server.family = () => (published === 2 ? version(2, HELD) : version(3, NEXT));
    // our server refuses the buy of version 2: version 3 took effect meanwhile
    server.order = (body) => {
      if (body.version === 2) {
        published = 3;
        return json({ error: 'the portfolio has a newer version', code: 'VERSION_CHANGED' }, 409);
      }
      return json({ error: 'not in this test' }, 500);
    };
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(host.textContent).toContain(en.shared.family.versionN(2));
    expect(host.querySelector('[data-ui="product-version-changed"]')).toBeNull();
    await type(amountField(host), '40');
    for (let i = 0; i < 8; i += 1) await settle(250);
    // the one order asked for named version 2, and was refused
    expect(orders().map((c) => [c.body?.family, c.body?.version, c.body?.amountUsd])).toEqual([
      [SLUG, 2, 40],
    ]);
    for (let i = 0; i < 4; i += 1) await settle(100);

    // the page is the new version's: its holdings, and the sentence that says it changed
    const pane = find(host, '[data-ui="plan-pane"]');
    expect(pane.textContent).toContain(en.shared.family.versionN(3));
    expect(pane.textContent).not.toContain(en.shared.family.versionN(2));
    const rows = [...pane.querySelectorAll('[data-ui="plan-rows"] > li')].map(
      (li) => li.textContent,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('jlUSDC');
    expect(rows[0]).toContain('60%');
    expect(pane.querySelector('[data-ui="plan-rows"]')?.textContent).not.toContain('SPYx');
    const notice = find(host, '[data-ui="product-version-changed"]');
    expect(notice.textContent).toBe(en.shared.product.versionChanged(en.shared.family.versionN(3)));
    expect(notice.getAttribute('role')).toBe('status');
    // no order is made for the new version by itself: the amount is cleared, and none was asked for
    expect(amountField(host).value).toBe('');
    expect(amountField(host).disabled).toBe(false);
    for (let i = 0; i < 6; i += 1) await settle(250);
    expect(orders()).toHaveLength(1);

    // the person reads it and types an amount again: the next order names version 3
    await type(amountField(host), '40');
    for (let i = 0; i < 8; i += 1) await settle(250);
    expect(orders().map((c) => c.body?.version)).toEqual([2, 3]);
    // the card waits a second of a still amount before it makes an order: this test waits for three
  }, 20_000);
});

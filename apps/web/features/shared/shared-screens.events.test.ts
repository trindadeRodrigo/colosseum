// @vitest-environment happy-dom
import { TRUST_STATUS } from '@colosseum/schemas';
import { deploymentsOf, type GuardDeployment, solanaVaultAddress } from '@colosseum/sdk';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import { useAccount } from '../account/AccountProvider';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { acceptTrust, keepOrder, recallOrder, trustAccepted } from '../order/order-record';
import { basketOfPlan, explorerAddressUrlFor, publishableOn } from '../order/readiness';
import { PLAN_ID, planOn, recordOf } from '../order/test/fixtures';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
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
// the card draws the order's own screen, which holds the runner: nothing here presses it
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
// A switch for one case: Robinhood Chain's deployment as a file that names no registry would load.
const deployed = vi.hoisted(() => ({ withoutRegistry: false }));
vi.mock('../order/readiness', async (original) => {
  const real = await original<typeof import('../order/readiness')>();
  return {
    ...real,
    deploymentsFor: (...args: Parameters<typeof real.deploymentsFor>) => {
      const all = real.deploymentsFor(...args);
      if (!deployed.withoutRegistry || all?.robinhood?.family !== 'evm') return all;
      const { registry: _, ...robinhood } = all.robinhood;
      return { ...all, robinhood } as typeof all;
    },
  };
});
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));
vi.mock('./publish-vault', async (original) => {
  const real = await original<typeof import('./publish-vault')>();
  return {
    ...real,
    readPublishVault: vi.fn(async (_api, at) => ({
      kind: 'read',
      source: 'chain',
      components: WEIGHTS,
      strategy: JSON.stringify(WEIGHTS),
      value: {
        chain: at.chain,
        name: null,
        provenance: 'sandbox',
        prices: [],
        disclaimer: 'd',
        vault: vaultOf({ address: at.address, basketId: at.basketId, owner: at.owner }),
      },
    })),
  };
});

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
  vaults?: (ReturnType<typeof vaultOf> & { name?: string | null })[];
  order?: () => unknown;
  portfolio?: () => Promise<Response>;
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
    if (path === '/v1/me/chain' && method === 'PUT') {
      const { chain } = JSON.parse(String(init?.body));
      o.chain = chain;
      return json({ ...person, chain });
    }
    if (path.startsWith('/v1/shelf'))
      return json({ families: o.family ? [o.family] : [], disclaimer: 'd' });
    if (path.startsWith(`/v1/indexes/${SLUG}/versions`))
      return json({ familyId: FAMILY_ID, slug: SLUG, chains: [] });
    if (path.startsWith('/v1/indexes/'))
      return o.family ? json({ family: o.family, disclaimer: 'd' }) : json({ error: 'no' }, 404);
    if (path === '/v1/portfolio' && o.portfolio) return o.portfolio();
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
    if (path === '/v1/orders' && method === 'POST') {
      const made = o.order ? await o.order() : {};
      // an answer the test wrote whole (a refusal), or an order
      return made instanceof Response ? made : json(made);
    }
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
    // the only pictures are the holdings' own marks
    expect(
      [...card.querySelectorAll('img')].filter((i) => !i.closest('[data-ui="asset-mark"]')),
    ).toEqual([]);
    // the one link is the card's own, to the portfolio's page
    expect([...card.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      `/indexes/${SLUG}`,
    ]);
    // words that match no version the creator published are said to be unverified
    expect(card.textContent).toContain(en.shared.text.unverified);
    expect(card.textContent).toContain('SPYx 40%');
    expect(card.textContent).not.toContain(en.shared.shelf.card.platform);
    // a test network's portfolio carries the hatch and one quiet line, never the word MOCK
    expect(card.textContent).not.toContain('MOCK');
    expect(card.querySelector('[data-ui="sample-note"]')?.textContent).toBe(
      en.shell.testNetworkLine,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  describe('for someone signed out (CHAIN-SWITCH)', () => {
    beforeEach(() => {
      portStore.set(fakePort());
      window.history.replaceState(null, '', '/shelf');
    });
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('shows the chain picked in the bar, and names it in the address', async () => {
      window.localStorage.setItem('tf-chain', 'robinhood');
      const calls = api({ family: familyOf(FAMILY_ID) });
      const host = await show(createElement(ShelfScreen));
      expect(calls.map((c) => c.path).filter((p) => p.startsWith('/v1/shelf'))).toEqual([
        '/v1/shelf?chain=robinhood',
      ]);
      expect(window.location.search).toBe('?chain=robinhood');
      expect(host.textContent).toContain(en.shared.shelf.lead('Robinhood Chain'));
    });

    it('opens on the chain a link names, and keeps it in this browser', async () => {
      window.history.replaceState(null, '', '/shelf?chain=robinhood');
      const calls = api({ family: familyOf(FAMILY_ID) });
      await show(createElement(ShelfScreen));
      expect(calls.at(-1)?.path).toBe('/v1/shelf?chain=robinhood');
      expect(calls.some((c) => c.path === '/v1/shelf?chain=solana')).toBe(false);
      expect(window.localStorage.getItem('tf-chain')).toBe('robinhood');
    });
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

  it('names a vault bought from a goal by that goal, and says it holds the person’s own plan', async () => {
    const plan = planOn();
    keepOrder(
      recordOf('solana', {
        userId: USER,
        amountUsd: 40_000,
        goal: {
          sheet: plan.proposal.sheet,
          card: plan.proposal.card,
          verdict: null,
          placedAt: '2026-10-01T00:00:00Z',
        },
      }),
    );
    api({
      family: familyOf(FAMILY_ID),
      vaults: [
        vaultOf({ address: MY_VAULT, basketId: basketOfPlan(PLAN_ID), recipeOnchainId: null }),
      ],
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(host.querySelector('[data-ui="my-vault"]')).toBeNull();
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    const mine = find(host, '[data-ui="my-vault"]');
    expect(find(mine, 'h3').textContent).toBe('Grow $40,000 over 36 months.');
    expect(find(mine, 'a').getAttribute('href')).toBe(`/vaults/solana/${MY_VAULT}`);
    expect(mine.textContent).toContain(en.shared.vaults.ownPlan);
    expect(mine.textContent).not.toContain('something else');
  });

  it.each(['en', 'pt'] as const)(
    'draws each vault’s actual holdings, including cash, without copying product targets (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const cashVault = solanaVaultAddress(
        '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        SOLANA,
        '43',
      );
      const emptyVault = solanaVaultAddress(
        '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        SOLANA,
        '44',
      );
      const unknownVault = solanaVaultAddress(
        '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        SOLANA,
        '45',
      );
      const calls = api({
        family: familyOf(FAMILY_ID),
        vaults: [
          vaultOf({
            address: MY_VAULT,
            valueUsd: '100',
            cash: { asset: 'solana:usdc', raw: '35000000', multiplier: '1', display: '35' },
            positions: [
              {
                asset: 'solana:spyx',
                raw: '1',
                multiplier: '1',
                display: '1',
                targetBps: 9000,
                weightBps: 6500,
                driftBps: -2500,
                valueUsd: '65',
                lastKeeperAt: null,
              },
            ],
          }),
          vaultOf({
            address: cashVault,
            valueUsd: '50',
            cash: { asset: 'solana:usdc', raw: '50000000', multiplier: '1', display: '50' },
          }),
          vaultOf({ address: emptyVault }),
          vaultOf({
            address: unknownVault,
            valueUsd: '0',
            positions: [
              {
                asset: 'solana:paxg',
                raw: '1',
                multiplier: '1',
                display: '1',
                targetBps: 10000,
                weightBps: 0,
                driftBps: -10000,
                valueUsd: null,
                lastKeeperAt: null,
              },
            ],
          }),
        ],
      });
      const host = await mount(withAccount(lang, createElement(FamilyScreen, { slug: SLUG })));
      for (let i = 0; i < 4; i += 1) await settle(50);
      const cards = [...host.querySelectorAll<HTMLElement>('[data-ui="my-vault"]')];
      expect(cards).toHaveLength(4);
      const allocations = cards.map((card) => find(card, '[data-ui="vault-holdings"]'));
      expect(
        [...find(allocations[0], '[data-ui="holdings-bar"]').children].map(
          (segment) => (segment as HTMLElement).style.width,
        ),
      ).toEqual(['65%', '35%']);
      expect(allocations[0].textContent).toContain('SPYx 65%');
      expect(allocations[0].textContent).toContain('USDC 35%');
      expect(allocations[0].textContent).not.toContain('90%');
      expect(find(allocations[1], '[data-ui="holdings-bar"] span').getAttribute('style')).toContain(
        '100%',
      );
      expect(allocations[1].textContent).toContain('USDC 100%');
      expect(allocations[2].querySelector('[data-ui="holdings-bar"]')).toBeNull();
      expect(allocations[2].textContent).toContain(t.shared.vaults.noHoldings);
      expect(allocations[3].querySelector('[data-ui="holdings-bar"]')).toBeNull();
      expect(allocations[3].textContent).toContain('PAXG —');
      expect(allocations[3].textContent).toContain(t.portfolio.vault.unpriced(1));
      // Existing page reads: other-chain vaults and owned-vault cards; bars add no per-vault requests.
      expect(calls.filter((call) => call.path === '/v1/portfolio')).toHaveLength(2);
      expect(calls.some((call) => call.path === '/v1/orders')).toBe(false);
    },
  );

  it.each(['en', 'pt'] as const)(
    'keeps followers visible and reviews just the locally selected vault (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const second = solanaVaultAddress(
        '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        SOLANA,
        '43',
      );
      const third = solanaVaultAddress(
        '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        SOLANA,
        '44',
      );
      const calls = api({
        family: familyOf(FAMILY_ID),
        vaults: [
          { ...vaultOf({ address: MY_VAULT }), name: 'Already following' },
          {
            ...vaultOf({ address: second, basketId: '43', recipeOnchainId: null }),
            name: 'Trip fund',
          },
          {
            ...vaultOf({ address: third, basketId: '44', recipeOnchainId: null }),
            name: 'Long term',
          },
        ],
        order: () => ({ ...followOrder(['accept_version']), vault: third }),
      });
      const host = await mount(withAccount(lang, createElement(FamilyScreen, { slug: SLUG })));
      for (let i = 0; i < 4; i += 1) await settle(50);
      expect(host.querySelectorAll('[data-ui="my-vault"]')).toHaveLength(1);
      expect(host.textContent).not.toContain('Trip fund');
      const panel = find(host, '[data-ui="my-vault"]').closest('section');
      expect(panel?.getAttribute('data-ui')).not.toBe('card');
      await click(button(host, t.shared.vaults.useExisting) as HTMLElement);
      const cards = [...host.querySelectorAll<HTMLElement>('[data-ui="my-vault"]')];
      expect(cards).toHaveLength(3);
      expect(find(cards[1], 'h3').textContent).toBe('Trip fund');
      for (const card of cards) {
        expect(find(card, 'a').textContent).toBe(t.shared.vaults.open);
        expect(find(card, '[data-ui="chain-badge"]').textContent).toBe('Solana');
      }
      await click(button(cards[1], t.shared.vaults.choose) as HTMLElement);
      expect(button(cards[1], t.shared.vaults.selected)?.getAttribute('aria-pressed')).toBe('true');
      await click(button(cards[2], t.shared.vaults.choose) as HTMLElement);
      expect(button(cards[1], t.shared.vaults.choose)?.getAttribute('aria-pressed')).toBe('false');
      expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
      expect(host.querySelectorAll('[data-ui="review-follow"]')).toHaveLength(1);
      const review = find(host, '[data-ui="review-follow"]');
      expect(review.textContent).toContain(
        t.shared.vaults.reviewTarget('Long term', familyOf(FAMILY_ID).name, 2),
      );
      expect(host.textContent?.split(t.shared.vaults.followNote)).toHaveLength(2);
      await click(button(review, t.shared.vaults.reviewFollow) as HTMLElement);
      await settle(50);
      expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);
      expect(calls.find((c) => c.path === '/v1/orders')?.body).toMatchObject({
        type: 'follow',
        vault: third,
        family: SLUG,
        autoFollow: false,
        version: 2,
      });
      expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
        kind: 'follow',
        vault: third,
        basketId: '44',
        follow: { recipeOnchainId: RECIPE, version: 2 },
      });
      expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
    },
  );

  it('closing and reopening the chooser drops its selection without placing an order', async () => {
    const calls = api({
      family: familyOf(FAMILY_ID),
      vaults: [vaultOf({ address: MY_VAULT, recipeOnchainId: null })],
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    await click(button(host, en.shared.vaults.choose) as HTMLElement);
    expect(host.querySelector('[data-ui="review-follow"]')).not.toBeNull();
    await click(button(host, en.shared.vaults.closeChooser) as HTMLElement);
    expect(host.querySelector('[data-ui="review-follow"]')).toBeNull();
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    expect(host.querySelector('[data-ui="review-follow"]')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
  });

  it('holds the selection and makes only one order while following is busy', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '43');
    const calls = api({
      family: familyOf(FAMILY_ID),
      vaults: [
        vaultOf({ address: MY_VAULT, recipeOnchainId: null }),
        vaultOf({ address: second, basketId: '43', recipeOnchainId: null }),
      ],
      order: async () => {
        await waiting;
        return followOrder(['accept_version']);
      },
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    await click(button(host, en.shared.vaults.choose) as HTMLElement);
    const review = button(host, en.shared.vaults.reviewFollow) as HTMLElement;
    await click(review);
    const other = button(host, en.shared.vaults.choose) as HTMLElement;
    expect(other.getAttribute('aria-disabled')).toBe('true');
    expect(button(host, en.shared.vaults.closeChooser)?.getAttribute('aria-disabled')).toBe('true');
    await click(other);
    await click(review);
    expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);
    expect(calls.find((c) => c.path === '/v1/orders')?.body?.vault).toBe(MY_VAULT);
    release();
    await settle(50);
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it('drops the chooser, selection and refusal when the account changes, including while its vault read waits', async () => {
    let paused = false;
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const bad = vaultOf({ address: MY_VAULT, basketId: '43', recipeOnchainId: null });
    const response = () =>
      json({
        chains: [
          {
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vaults: [{ ...bad, provenance: 'sandbox' }],
            prices: [],
          },
        ],
        disclaimer: 'd',
      });
    const calls = api({
      family: familyOf(FAMILY_ID),
      portfolio: () => (paused ? waiting : Promise.resolve(response())),
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    await click(button(host, en.shared.vaults.choose) as HTMLElement);
    await click(button(host, en.shared.vaults.reviewFollow) as HTMLElement);
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
    paused = true;
    await act(async () => {
      portStore.set(signedInPort(EMBEDDED, { userId: 'another-person' }));
    });
    await settle(50);
    expect(host.querySelector('[data-ui="my-vault"]')).toBeNull();
    expect(host.querySelector('[data-ui="review-follow"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    release(response());
    await settle(50);
    expect(button(host, en.shared.vaults.useExisting)).toBeDefined();
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    expect(host.querySelector('[data-ui="review-follow"]')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
  });

  it.each([
    ['account', 'placed'],
    ['account', 'refused'],
    ['chain', 'placed'],
    ['chain', 'refused'],
  ] as const)(
    'ignores a late %s-context follow reply (%s) before storing or navigating',
    async (context, outcome) => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = api({
        family: familyOf(FAMILY_ID),
        vaults: [vaultOf({ address: MY_VAULT, recipeOnchainId: null })],
        order: async () => {
          await waiting;
          return outcome === 'placed'
            ? followOrder(['accept_version'])
            : json({ error: 'Changed', code: 'RECIPE_VERSION_CHANGED' }, 409);
        },
      });
      function SwitchChain() {
        const { choose } = useAccount();
        return createElement(
          'button',
          { type: 'button', onClick: () => choose('robinhood') },
          'Test chain switch',
        );
      }
      const host = await show(
        createElement(
          'div',
          null,
          createElement(FamilyScreen, { slug: SLUG }),
          createElement(SwitchChain),
        ),
      );
      await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
      await click(button(host, en.shared.vaults.choose) as HTMLElement);
      await click(button(host, en.shared.vaults.reviewFollow) as HTMLElement);
      expect(calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);
      if (context === 'account') {
        await act(async () => {
          portStore.set(signedInPort(EMBEDDED, { userId: 'another-person' }));
        });
      } else {
        await click(button(host, 'Test chain switch') as HTMLElement);
      }
      await settle(50);
      expect(host.querySelector('[data-ui="review-follow"]')).toBeNull();
      release();
      await settle(50);
      expect(recallOrder(ORDER_ID, USER)).toBeNull();
      expect(recallOrder(ORDER_ID, 'another-person')).toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('keeps the publisher and where the weights come from in view, and the routine check behind Details', async () => {
    api({ family: familyOf(FAMILY_ID) });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    const checks = find<HTMLDetailsElement>(host, '[data-ui="family-checks"]');
    expect(checks.open).toBe(false);
    // who published it is part of the pane (gate PRODUCTS-PLAN-PANE), not folded away
    const creator = find(host, '[data-ui="creator"]');
    expect(checks.contains(creator)).toBe(false);
    expect(creator.closest('[data-ui="plan-pane"]')).not.toBeNull();
    // the word on where the version and weights come from is not folded away
    const source = find(host, '[data-ui="source-mark"]');
    expect(checks.contains(source)).toBe(false);
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
    expect(offer.textContent).toContain(en.shared.offer.noOracle('GLDx', 'Solana'));
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

  it.each(['en', 'pt'] as const)(
    'a follow of a version that is no longer in effect says so in its own words, and reads the portfolio again when asked (%s)',
    async (lang) => {
      const words = dictionary(lang);
      const calls = api({
        family: familyOf(FAMILY_ID),
        vaults: [vaultOf({ address: MY_VAULT, acceptedVersion: 1 })],
        order: () =>
          json({ error: 'version 2 is not the one in effect', code: 'VERSION_CHANGED' }, 409),
      });
      const host = await mount(withAccount(lang, createElement(FamilyScreen, { slug: SLUG })));
      for (let i = 0; i < 4; i += 1) await settle(50);
      const prompt = find(host, '[data-ui="follow-prompt"]');
      await click(button(prompt, words.shared.prompt.accept(2)) as HTMLElement);
      await settle(50);
      const alert = find(host, '[role="alert"]');
      expect(alert.textContent).toBe(words.shared.refusal.versionChanged);
      expect(host.textContent).not.toContain('not the one in effect');
      expect(router.push).not.toHaveBeenCalled();
      const reads = () => calls.filter((c) => c.path.startsWith(`/v1/indexes/${SLUG}`)).length;
      const before = reads();
      await click(button(host, words.shared.refusal.reread) as HTMLElement);
      for (let i = 0; i < 4; i += 1) await settle(50);
      expect(reads()).toBeGreaterThan(before);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );

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
    await click(button(host, en.shared.vaults.useExisting) as HTMLElement);
    await click(button(host, en.shared.vaults.choose) as HTMLElement);
    expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
    await click(button(host, en.shared.vaults.reviewFollow) as HTMLElement);
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

  it('says a vault on another chain follows it, and switches there to update it (CHAIN-SWITCH)', async () => {
    const calls = api({
      chain: 'robinhood',
      family: familyOf(FAMILY_ID),
      vaults: [vaultOf({ address: MY_VAULT })],
    });
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    // on Robinhood Chain, where the portfolio is not published; the Solana vault follows it
    expect(host.textContent).toContain(en.shared.family.notHere('Robinhood Chain'));
    const note = find(host, '[data-ui="vaults-elsewhere"]');
    expect(note.textContent).toContain(en.shared.family.elsewhere('Solana'));
    await click(button(note, en.shared.family.switchTo('Solana')) as HTMLElement);
    for (let i = 0; i < 4; i += 1) await settle(50);
    expect(calls.filter((c) => c.path === '/v1/me/chain')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
    // on Solana now: the vault is in the page's own panel, and the note is gone
    expect(host.querySelector('[data-ui="vaults-elsewhere"]')).toBeNull();
  });

  it('says nothing of a vault on another chain that follows something else', async () => {
    api({
      chain: 'robinhood',
      family: familyOf(FAMILY_ID),
      vaults: [vaultOf({ address: MY_VAULT, recipeOnchainId: 'another' })],
    });
    const host = await show(createElement(FamilyScreen, { slug: SLUG }));
    expect(host.querySelector('[data-ui="vaults-elsewhere"]')).toBeNull();
  });
});

describe('buying a portfolio, which follows it', () => {
  /** The buy page for $10, with our server refusing the order the card asks for once the amount is still. */
  const refusedBuy = async (lang: 'en' | 'pt', refusal: () => Response) => {
    const words = dictionary(lang);
    const calls = api({ family: familyOf(FAMILY_ID), order: refusal, funded: true });
    const host = await mount(withAccount(lang, createElement(FamilyBuyScreen, { slug: SLUG })));
    for (let i = 0; i < 4; i += 1) await settle(50);
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(400);
    await settle(1050);
    await settle(50);
    return { host, words, calls };
  };

  it.each(['en', 'pt'] as const)(
    'says that the portfolio has a new version, in its own words, and leads back to it (%s)',
    async (lang) => {
      // as the API refuses it: a code, and always a sentence of its own beside it
      const { host, words, calls } = await refusedBuy(lang, () =>
        json({ error: 'version 2 is no longer the one in effect', code: 'VERSION_CHANGED' }, 409),
      );
      const alert = find(host, '[role="alert"]');
      expect(alert.textContent).toBe(words.shared.refusal.versionChanged);
      // not our server's sentence, and not the plan's ("Build the plan again from your goal")
      expect(host.textContent).not.toContain('no longer the one in effect');
      expect(host.textContent).not.toContain(words.buy.failure.VERSION_CHANGED);
      const reopen = find(host, 'a[data-ui="family-reopen"]');
      expect([reopen.textContent, reopen.getAttribute('href')]).toEqual([
        words.shared.refusal.reopen,
        `/indexes/${SLUG}`,
      ]);
      // and this page has read the portfolio again
      expect(calls.filter((c) => c.path.startsWith(`/v1/indexes/${SLUG}`)).length).toBeGreaterThan(
        1,
      );
    },
  );

  it.each(['en', 'pt'] as const)(
    'says which asset can no longer be bought, and that the portfolio cannot be bought as it stands (%s)',
    async (lang) => {
      const { host, words } = await refusedBuy(lang, () =>
        json({ error: 'solana:spyx cannot be bought on Solana', code: 'ASSET_NOT_ELIGIBLE' }, 422),
      );
      expect(find(host, '[role="alert"]').textContent).toBe(
        words.shared.refusal.assetNamed('SPYx'),
      );
      expect(host.textContent).not.toContain(words.buy.failure.ASSET_NOT_ELIGIBLE);
      // nothing changed about the portfolio: no way back is offered for it
      expect(host.querySelector('[data-ui="family-reopen"]')).toBeNull();
    },
  );

  it('keeps our server’s sentence for a refusal this app has no words for', async () => {
    const { host } = await refusedBuy('en', () =>
      json({ error: 'the creator reached their limit' }, 409),
    );
    expect(find(host, '[role="alert"]').textContent).toBe(
      en.shared.publish.failure.said('the creator reached their limit'),
    );
  });

  it('asks for the version the page showed, and keeps the weights the buy is held to', async () => {
    const calls = api({ family: familyOf(FAMILY_ID), order: () => familyBuyOrder(), funded: true });
    const host = await show(createElement(FamilyBuyScreen, { slug: SLUG }));
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    // the wallet is read, then the order is made for the card: no press, and no other page
    await settle(400);
    await settle(1050);
    await settle(50);
    expect(router.push).not.toHaveBeenCalled();
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

describe('a shared portfolio that changed under the buy', () => {
  it('tells the host, reads the portfolio again, and makes no other order until the person asks', async () => {
    const calls = api({
      family: familyOf(FAMILY_ID),
      order: () => json({ error: 'x', code: 'VERSION_CHANGED' }, 409),
      funded: true,
    });
    const changed = vi.fn();
    const host = await show(
      createElement(FamilyBuyScreen, {
        slug: SLUG,
        embedded: { amount: 10, onVersionChanged: changed },
      }),
    );
    await settle(400);
    await settle(1050);
    await settle(50);
    const posted = () => calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST');
    const reads = () => calls.filter((c) => c.path.startsWith(`/v1/indexes/${SLUG}`));
    expect(posted()).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    // the portfolio's own sentence, never the plan's ("Build the plan again from your goal")
    expect(find(host, '[role="alert"]').textContent).toBe(en.shared.refusal.versionChanged);
    expect(host.textContent).not.toContain(en.buy.failure.VERSION_CHANGED);
    // the portfolio is read again, and nothing is ordered by itself however long the card is left
    expect(reads().length).toBeGreaterThan(1);
    await settle(1500);
    expect(posted()).toHaveLength(1);
    // the person asks for the prices: one order, for the version read now
    await click(button(host, en.invest.again) as HTMLElement);
    await settle(1050);
    await settle(50);
    expect(posted()).toHaveLength(2);
  });
});

describe('the trust notice on a buy the keeper may trade', () => {
  const stored = (keeperShown?: boolean) =>
    window.localStorage.setItem(
      `tf-trust:${USER}`,
      JSON.stringify({
        textVersion: TRUST_STATUS.textVersion,
        ...(keeperShown === undefined ? {} : { keeperShown }),
      }),
    );
  /** The notice as it is asked: with its box to tick, on the card. */
  const trustStep = (host: HTMLElement) =>
    host.querySelector('[data-ui="invest-card"] [data-ui="trust-notice"] input[type="checkbox"]');

  it('shows the keeper’s limits among its short points', async () => {
    api({ family: familyOf(FAMILY_ID), funded: true });
    const host = await show(createElement(FamilyBuyScreen, { slug: SLUG }));
    const short = [...find(host, '[data-ui="trust-short"]').querySelectorAll('li')].map(
      (li) => li.textContent,
    );
    expect(short).toContain(en.trust.short.keeper('0.75%', '1%'));
  });

  it('asks again of someone who accepted it on a plan’s buy, where the keeper’s limits were not shown', async () => {
    stored(false);
    api({ family: familyOf(FAMILY_ID), funded: true });
    const host = await show(createElement(FamilyBuyScreen, { slug: SLUG }));
    expect(trustStep(host)).not.toBeNull();
    expect(find(host, '[data-ui="trust-short"]').textContent).toContain(
      en.trust.short.keeper('0.75%', '1%'),
    );
  });

  it('does not ask again of someone who accepted it with the keeper’s limits shown, or before that was recorded', async () => {
    for (const shown of [true, undefined]) {
      stored(shown);
      api({ family: familyOf(FAMILY_ID), funded: true });
      const host = await show(createElement(FamilyBuyScreen, { slug: SLUG }));
      expect(trustStep(host), String(shown)).toBeNull();
      await unmountAll();
    }
  });

  it('records what was shown, and an acceptance with the keeper’s limits is not written over by one without', () => {
    acceptTrust(USER, TRUST_STATUS.textVersion, false);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(true);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, true)).toBe(false);
    acceptTrust(USER, TRUST_STATUS.textVersion, true);
    acceptTrust(USER, TRUST_STATUS.textVersion, false);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, true)).toBe(true);
  });
});

describe('the publish form', () => {
  it('works out the family id from the address, holds the limits, and keeps its own text', async () => {
    const calls = api({
      family: null,
      vaults: [vaultOf({ address: MY_VAULT })],
      order: () => publishOrder(),
    });
    const host = await show(createElement(PublishScreen));
    // an empty form says nothing is wrong with it: the person has typed nothing yet
    for (const problem of Object.values(en.shared.publish.problems))
      expect(host.textContent, problem).not.toContain(problem);
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
    // The selected vault supplies immutable targets; holdings never become target weights.
    expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(3);
    expect(host.querySelectorAll('select')).toHaveLength(1);
    expect(host.querySelector(`input[inputmode="decimal"]`)).toBeNull();
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
      vaults: [vaultOf({ address: MY_VAULT })],
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
    expect(problemsOf(form('Three of the largest', 'Three test tokens.'))).toEqual([]);
    expect(problemsOf(form('Go to evil.xyz', ''))).toEqual(['name']);
    expect(problemsOf(form('U.S. stocks', 'see evil.xyz/airdrop'))).toEqual(['copy']);
    expect(problemsOf(form('Three', 'write to me@mail.com'))).toEqual(['copy']);
    expect(problemsOf(form('Three', 'plain\u202etext'))).toEqual(['copy']);
    expect(problemsOf(form('Three', 'two lines\nare fine'))).toEqual([]);
  });

  it('is offered on Robinhood Chain, whose deployment names its registry (AGT-4)', async () => {
    const calls = api({ family: null, chain: 'robinhood' });
    const shelf = await show(createElement(ShelfScreen));
    expect(calls.some((c) => c.path === '/v1/shelf?chain=robinhood')).toBe(true);
    expect(shelf.querySelector('a[href="/publish"]')).not.toBeNull();
  });

  it('shows the form on Robinhood Chain, and not the notice that publishing is closed', async () => {
    api({ family: null, chain: 'robinhood' });
    const host = await show(createElement(PublishScreen));
    expect(host.textContent).not.toContain(en.shared.publish.problems.chain);
    expect(host.querySelector('input')).not.toBeNull();
    expect(button(host, en.shared.publish.review)).toBeDefined();
  });

  it('is closed on screen where the deployment names no registry: the notice, no form, no order', async () => {
    deployed.withoutRegistry = true;
    try {
      const calls = api({ family: null, chain: 'robinhood' });
      const shelf = await show(createElement(ShelfScreen));
      expect(shelf.querySelector('a[href="/publish"]')).toBeNull();
      expect(find(shelf, '[data-ui="shelf-publish-soon"]').textContent).toBe(
        en.shared.shelf.publishSoon('Robinhood Chain'),
      );
      const host = await mount(withAccount('en', createElement(PublishScreen)));
      for (let i = 0; i < 4; i += 1) await settle(50);
      expect(host.textContent).toContain(en.shared.publish.problems.chain);
      expect(host.querySelector('input')).toBeNull();
      expect(button(host, en.shared.publish.review)).toBeUndefined();
      expect(calls.some((c) => c.path === '/v1/orders')).toBe(false);
    } finally {
      deployed.withoutRegistry = false;
    }
  });

  it('is closed on an EVM chain whose deployment names no registry', () => {
    const robinhood = deploymentsOf('testnet').robinhood;
    expect(publishableOn(robinhood)).toBe(true);
    const { registry: _, ...without } = robinhood as Extract<GuardDeployment, { family: 'evm' }>;
    expect(publishableOn(without as GuardDeployment)).toBe(false);
    expect(publishableOn(deploymentsOf('testnet').solana)).toBe(true);
    // no deployment at all is a chain not ready, which the screens say on their own
    expect(publishableOn(undefined)).toBe(true);
  });

  it('refuses an address that is another creator’s', async () => {
    api({ family: familyOf(FAMILY_ID), vaults: [vaultOf({ address: MY_VAULT })] });
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
    // written as the portfolio writes it: cents in full
    expect(figure?.textContent).toContain('$1,234.50');
  });

  it('asks for the vault once, and for a vault that is not there says so with the way back', async () => {
    let asked = 0;
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path.startsWith('/v1/vaults/')) asked += 1;
      return json({ error: 'not found' }, 404);
    });
    const host = await show(createElement(VaultScreen, { chain: 'solana', address: VAULT }));
    await settle();
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.missing);
    // a change of the sign-in around the page does not ask again
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    portStore.setApi(async (path) => {
      if (path.startsWith('/v1/vaults/')) asked += 1;
      return json({ error: 'not found' }, 404);
    });
    for (let i = 0; i < 3; i += 1) await settle(50);
    expect(asked).toBe(1);
    const ways = [...host.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(ways).toEqual(['/shelf', '/monitor']);
  });
});

describe('auto-follow on a vault’s page, after a withdrawal switched it off', () => {
  const page = async (over: Parameters<typeof vaultOf>[0]) => {
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path === `/v1/vaults/solana/${VAULT}`)
        return json({
          chain: 'solana',
          name: 'Solana',
          mode: 'live',
          provenance: 'sandbox',
          vault: { ...vaultOf(over), provenance: 'sandbox' },
          prices: [],
          disclaimer: 'd',
        });
      return json({ error: 'not found' }, 404);
    });
    return show(createElement(VaultScreen, { chain: 'solana', address: VAULT }));
  };

  it('draws no share and no drift for a holding with no price: a dash, never 0%', async () => {
    const host = await page({
      valueUsd: '50',
      positions: [
        {
          asset: 'solana:paxg',
          raw: '1',
          multiplier: '1',
          display: '1',
          targetBps: 4000,
          weightBps: 0,
          driftBps: -4000,
          valueUsd: null,
          lastKeeperAt: null,
        },
      ],
    });
    const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('PAXG'),
    ) as HTMLElement;
    const cells = [...row.querySelectorAll('th, td')].map((cell) => cell.textContent);
    const heads = [...host.querySelectorAll('thead th')].map((th) => th.textContent);
    const at = (name: string) => cells[heads.indexOf(name)];
    expect(at(en.shared.vault.columns.price)).toBe('—');
    expect(at(en.shared.vault.columns.weight)).toBe('—');
    expect(at(en.shared.vault.columns.drift)).toBe('—');
    // what it is meant to be is the plan's own number, and is still said
    expect(at(en.shared.vault.columns.target)).toMatch(/40/);
  });

  it('says to a visitor, as to the owner, that the value leaves out a holding with no price', async () => {
    const OTHER = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
    const paxg = {
      asset: 'solana:paxg',
      raw: '1',
      multiplier: '1',
      display: '1',
      targetBps: 4000,
      weightBps: 0,
      driftBps: -4000,
      valueUsd: null,
      lastKeeperAt: null,
    };
    const visitor = await page({
      owner: OTHER,
      valueUsd: '50',
      positions: [paxg],
    });
    expect(find(visitor, '[data-ui="vault-unpriced"]').textContent).toBe(
      en.portfolio.vault.unpriced(1),
    );
    await unmountAll();
    // nothing is said where every holding has its price
    const priced = await page({ owner: OTHER });
    expect(priced.querySelector('[data-ui="vault-unpriced"]')).toBeNull();
    await unmountAll();
    // the owner is told on their own card: the fold under it does not say it again
    const owner = await page({ valueUsd: '50', positions: [paxg] });
    expect(owner.textContent).toContain(en.portfolio.vault.unpriced(1));
    expect(owner.querySelector('[data-ui="vault-unpriced"]')).toBeNull();
  });

  it('tells the owner where to switch it on again, with the way there', async () => {
    const host = await page({ autoFollow: false });
    const line = find(host, '[data-ui="vault-auto-follow-off"]');
    expect(line.textContent).toContain(en.shared.vault.autoFollowOff);
    expect(find(line, 'a').getAttribute('href')).toBe('/shelf');
  });

  it('says nothing of it while auto-follow is on, for a vault that follows nothing, or to anybody else', async () => {
    for (const over of [
      { autoFollow: true },
      { autoFollow: false, recipeOnchainId: null },
      { autoFollow: false, owner: 'Stranger1111111111111111111111111111111111' },
    ]) {
      const host = await page(over);
      expect(
        host.querySelector('[data-ui="vault-auto-follow-off"]'),
        JSON.stringify(over),
      ).toBeNull();
      await unmountAll();
    }
  });
});

describe('the chain, on the shelf and on a vault’s page', () => {
  const badges = (el: Element) =>
    [...el.querySelectorAll('[data-ui="chain-badge"]')].map((b) => b.getAttribute('data-chain'));

  it('badges a shared portfolio with every chain it has a recipe on', async () => {
    api({ family: familyOf(FAMILY_ID, { chains: ['solana', 'robinhood'] }) });
    const host = await show(createElement(ShelfScreen));
    const card = find(host, '[data-ui="shelf-card"]');
    expect(badges(card)).toEqual(['solana', 'robinhood']);
    expect(card.textContent).toContain('Robinhood Chain');
  });

  it('badges one that is on one chain with that chain alone', async () => {
    api({ family: familyOf(FAMILY_ID) });
    const host = await show(createElement(ShelfScreen));
    expect(badges(find(host, '[data-ui="shelf-card"]'))).toEqual(['solana']);
  });

  const RH = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
  it.each([
    ['solana', VAULT, 'solana:usdc', 'USDC'],
    ['robinhood', RH, 'robinhood:usdc', 'tUSDG'],
  ] as const)(
    'badges a vault on %s, and names its cash as that chain does',
    async (chain, address, cash, name) => {
      portStore.setApi(async (path) => {
        if (path === '/v1/me') return json({ ...person, chain });
        if (path === `/v1/vaults/${chain}/${address}`)
          return json({
            chain,
            name: chain === 'solana' ? 'Solana' : 'Robinhood Chain',
            mode: 'mock',
            provenance: 'mock',
            vault: {
              ...vaultOf({
                chain,
                address,
                ...(chain === 'robinhood'
                  ? {
                      owner: '0x204faca1764b154221e35c0d20abb3c525710498',
                      keeper: '0x2222222222222222222222222222222222222222',
                      recipeOnchainId: null,
                    }
                  : {}),
                cash: { asset: cash, raw: '5000000', multiplier: '1', display: '5' },
              }),
              provenance: 'mock',
            },
            prices: [],
            disclaimer: 'd',
          });
        return json({ error: 'not found' }, 404);
      });
      const host = await show(createElement(VaultScreen, { chain, address }));
      expect(badges(host)).toEqual([chain]);
      // cash is a holding like any other, named as the plan and the portfolio name it
      const rows = [...find(host, 'table').querySelectorAll('tbody tr')].map((tr) =>
        [...tr.children].map((cell) => cell.textContent?.trim()),
      );
      expect(rows.at(-1)?.slice(0, 2)).toEqual([`Cash (${name})`, '5']);
      // and the page leads back to the portfolio
      const back = [...host.querySelectorAll('a')].find(
        (a) => a.textContent === en.shared.vault.back,
      );
      expect(back?.getAttribute('href')).toBe('/monitor');
      if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
    },
  );
});

describe('the flow audit’s findings on these screens (34, 38, 42)', () => {
  const pt = dictionary('pt');

  it('the vault page leads back, links its explorer, and writes figures as the portfolio does', async () => {
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path === `/v1/vaults/solana/${VAULT}`)
        return json({
          chain: 'solana',
          name: 'Solana',
          mode: 'live',
          provenance: 'sandbox',
          vault: {
            ...vaultOf({
              valueUsd: '377.4',
              cash: { asset: 'solana:usdc', raw: '10000000', multiplier: '1', display: '10' },
              positions: [
                {
                  asset: 'solana:spyx',
                  raw: '837024',
                  multiplier: '1',
                  display: '0.00837024899664214',
                  targetBps: 6500,
                  lastKeeperAt: null,
                  valueUsd: '367.4',
                  weightBps: 6500,
                  driftBps: 0,
                },
              ],
            }),
            provenance: 'sandbox',
          },
          prices: [],
          disclaimer: 'd',
        });
      return json({ error: 'not found' }, 404);
    });
    const host = await show(createElement(VaultScreen, { chain: 'solana', address: VAULT }));
    const back = [...host.querySelectorAll('a')].find(
      (a) => a.textContent === en.shared.vault.back,
    );
    expect(back?.getAttribute('href')).toBe('/monitor');
    const explorer = find<HTMLAnchorElement>(host, '[data-ui="vault-explorer"]');
    expect(explorer.textContent).toBe(en.shared.vault.explorer('Solscan'));
    expect(explorer.getAttribute('href')).toBe(explorerAddressUrlFor('solana', VAULT, false));
    expect(explorer.getAttribute('href')).toContain(`/account/${VAULT}`);
    expect(explorer.getAttribute('target')).toBe('_blank');
    expect(find(host, 'header [data-ui="chain-badge"]').textContent).toBe('Solana');
    // the portfolio's formats: cents in full, shares to one decimal at most, six places on a token
    const text = host.textContent ?? '';
    expect(text).toContain('$377.40');
    expect(text).toContain('0.00837');
    expect(text).not.toContain('0.00837024899664214');
    expect(text).toContain('65%');
    expect(text).not.toContain('65.00%');
    // and cash is a holding of its own, so the shares add up to the whole
    expect(text).toContain('Cash (USDC)');
    expect(text).not.toMatch(/\$377\.4(?!0)/);
  });

  it.each(['en', 'pt'] as const)(
    'the shelf of a chain with no registry says publishing is coming, where Solana offers the link (%s)',
    async (lang) => {
      const words = lang === 'en' ? en : pt;
      // Robinhood Chain as a deployment that names no registry would load it (AGT-4)
      deployed.withoutRegistry = true;
      try {
        api({ family: familyOf(FAMILY_ID), chain: 'robinhood' });
        const rh = await mount(withAccount(lang, createElement(ShelfScreen)));
        for (let i = 0; i < 4; i += 1) await settle(50);
        expect(find(rh, '[data-ui="shelf-publish-soon"]').textContent).toBe(
          words.shared.shelf.publishSoon('Robinhood Chain'),
        );
        expect(rh.querySelector('a[href="/publish"]')).toBeNull();
        await unmountAll();
      } finally {
        deployed.withoutRegistry = false;
      }
      api({ family: familyOf(FAMILY_ID) });
      const sol = await mount(withAccount(lang, createElement(ShelfScreen)));
      for (let i = 0; i < 4; i += 1) await settle(50);
      expect(sol.querySelector('a[href="/publish"]')?.textContent).toBe(words.shared.shelf.publish);
      expect(sol.querySelector('[data-ui="shelf-publish-soon"]')).toBeNull();
    },
  );

  it('the shelf says so when the person signs out on it, and not to someone who came signed out', async () => {
    api({ family: familyOf(FAMILY_ID) });
    const host = await show(createElement(ShelfScreen));
    expect(host.querySelector('[data-ui="shelf-signed-out"]')).toBeNull();
    await act(async () => portStore.set(fakePort()));
    for (let i = 0; i < 4; i += 1) await settle(50);
    expect(find(host, '[data-ui="shelf-signed-out"]').textContent).toBe(
      en.shared.shelf.signedOut('Solana'),
    );
    await unmountAll();
    // a visitor who was never signed in is told nothing of the kind
    portStore.set(fakePort());
    api({ family: familyOf(FAMILY_ID) });
    const visitor = await show(createElement(ShelfScreen));
    expect(visitor.querySelector('[data-ui="shelf-signed-out"]')).toBeNull();
  });

  it.each(['en', 'pt'] as const)(
    'sharing requires a source vault and never offers manual weight controls (%s)',
    async (lang) => {
      const words = (lang === 'en' ? en : pt).shared.publish;
      api({ family: null, order: () => publishOrder() });
      const host = await mount(withAccount(lang, createElement(PublishScreen)));
      for (let i = 0; i < 4; i += 1) await settle(50);
      expect(host.textContent).toContain(words.noVaults);
      expect(host.querySelectorAll('[data-ui="publish-row"]')).toHaveLength(0);
      const labels = [...host.querySelectorAll('label')].map((l) => l.textContent);
      expect(labels).toContain(words.sourceVault);
      expect(labels).not.toContain(words.weightOf(1));
      await click(button(host, words.review) as HTMLElement);
      expect(router.push).not.toHaveBeenCalled();
    },
  );
});

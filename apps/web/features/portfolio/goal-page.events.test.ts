// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GoalPage from '../../app/(app)/goal/page';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { keepOrder } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import { PLAN_ID, planOn, recordOf } from '../order/test/fixtures';
import { shortAddress } from '../shared/use-person';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { sharesOf } from './figures';
import { PORTFOLIO_PATH } from './portfolio';
import {
  chainOf,
  portfolioBody,
  portfolioOf,
  price,
  robinhoodChain,
  SECOND_VAULT,
  VAULT,
  vault,
} from './test/portfolio';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The product's first screen (`/goal`): the goal comes first (DESIGN-VAULT section 11). Under it, for a
// person who already holds a vault, one line on where their money is and the way to the monitor; for
// anyone else, the goal alone. A visitor at `/` gets his landing page (features/landing).

const en = dictionary('en');
const onSolana: Person = {
  userId: 'did:privy:test',
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};

function api(person: Person | null, portfolio: () => Response = () => json(portfolioBody())) {
  const calls: string[] = [];
  portStore.setApi(async (path) => {
    calls.push(path);
    if (path === '/v1/me') return person ? json(person) : json({}, 503);
    if (path === PORTFOLIO_PATH) return portfolio();
    return json({ error: 'not found' }, 404);
  });
  return calls;
}

const home = async (lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(GoalPage)));
  await settle();
  return host;
};
const summary = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-ui="owned-vaults"]');
const owned = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('[data-ui="owned-vault"]'),
];

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('home', () => {
  it.each(['en', 'pt'] as const)(
    'shows measured holdings and cash rather than planned weights, with compact wrapping labels (%s)',
    async (lang) => {
      const t = dictionary(lang);
      const calls = api(onSolana);
      portStore.set(signedInPort(PHANTOM));
      const card = owned(await home(lang))[0];
      const held = find(card, '[data-ui="owned-vault-holdings"]');
      expect(held.textContent).toContain(t.plan.holds);
      const bar = find(held, '[data-ui="holdings-bar"]');
      expect([...bar.children].map((el) => (el as HTMLElement).style.width)).toEqual([
        '63.46%',
        '12.5%',
        '24.04%',
      ]);
      const labels = [...held.querySelectorAll('[data-asset]')];
      const shares = sharesOf(lang, [6346, 1250, 2404]);
      expect(labels.map((el) => el.querySelector('span.min-w-0')?.textContent)).toEqual([
        `USDY ${shares[0]}`,
        `PAXG ${shares[1]}`,
        `USDC ${shares[2]}`,
      ]);
      expect(
        labels.every(
          (el) => el.classList.contains('min-w-0') && el.classList.contains('max-w-full'),
        ),
      ).toBe(true);
      expect(held.querySelectorAll('[data-ui="asset-mark"]')).toHaveLength(3);
      expect(card.querySelector('[data-ui="card"]')?.classList.contains('h-full')).toBe(false);
      expect(calls.filter((path) => path === PORTFOLIO_PATH)).toHaveLength(1);
      expect(calls.some((path) => /\/me\/(plans|withdrawals)|\/orders/.test(path))).toBe(false);
    },
  );

  it('shows cash alone at its measured 100%, excluding zero positions even when their target is nonzero', async () => {
    const original = vault();
    const cashOnly = vault({
      valueUsd: '250',
      positions: original.positions.map((row) => ({
        ...row,
        raw: '0',
        display: '0',
        valueUsd: '0',
        weightBps: 0,
      })),
    });
    api(onSolana, () => json(portfolioBody(chainOf([cashOnly]))));
    portStore.set(signedInPort(PHANTOM));
    const held = find(owned(await home())[0], '[data-ui="owned-vault-holdings"]');
    expect(held.querySelectorAll('[data-asset]')).toHaveLength(1);
    expect(held.textContent).toContain('USDC 100%');
    expect(held.textContent).not.toMatch(/USDY|PAXG/);
    expect(
      (find(held, '[data-ui="holdings-bar"]').firstElementChild as HTMLElement).style.width,
    ).toBe('100%');
  });

  it('names an empty vault honestly without a target allocation bar', async () => {
    const original = vault();
    const empty = vault({
      valueUsd: '0',
      cash: { ...original.cash, raw: '0', display: '0' },
      positions: original.positions.map((row) => ({
        ...row,
        raw: '0',
        display: '0',
        valueUsd: '0',
        weightBps: 0,
      })),
    });
    api(onSolana, () => json(portfolioBody(chainOf([empty]))));
    portStore.set(signedInPort(PHANTOM));
    const card = owned(await home())[0];
    expect(find(card, '[data-ui="owned-vault-holdings"]').textContent).toContain(en.withdraw.empty);
    expect(card.querySelector('[data-ui="holdings-bar"]')).toBeNull();
    expect(card.querySelectorAll('[data-asset]')).toHaveLength(0);
    expect(find(card, '[data-ui="figure"]').textContent).toBe('$0.00\u202f');
    expect(find(card, 'a').getAttribute('href')).toBe(`/vaults/solana/${VAULT}`);
  });
  it('is the goal, first: the one serif question and the typing box, and nothing else for a visitor', async () => {
    const calls = api(null);
    const host = await home();
    expect(find(host, 'h1').textContent).toBe(en.goal.title);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, 'textarea')).toBeTruthy();
    expect(summary(host)).toBeNull();
    // nothing about a vault is asked for someone who is not signed in
    expect(calls).not.toContain(PORTFOLIO_PATH);
  });

  it('adds, under the goal, the vault of a person who holds one, with its value pinned and the way to the monitor', async () => {
    api(onSolana);
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    const card = summary(host) as HTMLElement;
    expect(card).not.toBeNull();
    // the goal stays first: the typing box comes before the vault in the page
    const box = find(host, 'textarea');
    expect(box.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain(en.shared.vaults.address(shortAddress(VAULT)));
    expect(card.querySelector('[data-ui="figure"]')?.textContent).toContain('$1,040.00\u202f');
    const link = find(card, 'header a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.portfolio.summary.see,
      '/monitor',
    ]);
    // a test network: the hatch and one quiet line with the words, never MOCK
    expect(card.textContent).not.toContain('MOCK');
    expect(find(card, '[data-ui="sample-note"]').textContent).toBe(en.shell.testNetworkLine);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    expect(find(owned(host)[0], 'a').getAttribute('href')).toBe(`/vaults/solana/${VAULT}`);
    // still one serif line on the page, and no primary button but the goal's own
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(card.querySelector('[data-variant="primary"]')).toBeNull();
  });

  it('gives every vault its own pinned value and direct link, without a count-only or aggregate card', async () => {
    api(onSolana, () => json(portfolioBody(chainOf([vault(), vault({ address: SECOND_VAULT })]))));
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    const cards = owned(host);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => find(card, '[data-ui="figure"]').textContent)).toEqual([
      '$1,040.00\u202f',
      '$1,040.00\u202f',
    ]);
    expect(cards.map((card) => find(card, 'a').getAttribute('href'))).toEqual([
      `/vaults/solana/${VAULT}`,
      `/vaults/solana/${SECOND_VAULT}`,
    ]);
    expect(summary(host)?.getAttribute('data-ui')).toBe('owned-vaults');
    expect(summary(host)?.textContent).not.toContain(en.portfolio.summary.many(2, 'Solana'));
    expect(summary(host)?.textContent).not.toContain('$2,080');
  });

  it('names the chain of the vault with its badge', async () => {
    api(onSolana);
    portStore.set(signedInPort(PHANTOM));
    const card = summary(await home()) as HTMLElement;
    const badges = [...card.querySelectorAll('[data-ui="chain-badge"]')];
    expect(badges.map((b) => b.getAttribute('data-chain'))).toEqual(['solana']);
  });

  it('shows distinct vault cards on two chains, with a separate pin and test stamp on each', async () => {
    api(onSolana, () => json(portfolioOf(chainOf(), robinhoodChain())));
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    const card = summary(host) as HTMLElement;
    expect(owned(host)).toHaveLength(2);
    expect(owned(host).map((vault) => find(vault, '[data-ui="figure"]').textContent)).toEqual([
      '$1,040.00\u202f',
      '$26.50\u202f',
    ]);
    expect(owned(host).map((vault) => find(vault, '[data-ui="sample-note"]').textContent)).toEqual([
      en.shell.testNetworkLine,
      en.shell.mockAnnounce,
    ]);
    expect(card.textContent).not.toContain('$1,066.50');
    const badges = [...card.querySelectorAll('[data-ui="chain-badge"]')];
    expect(badges.map((b) => b.getAttribute('data-chain'))).toEqual(['solana', 'robinhood']);
    expect(owned(host)[0].textContent).toContain('USDC');
    expect(owned(host)[1].textContent).toContain('tUSDG');
    expect(owned(host)[1].textContent).not.toMatch(/usdc/i);
  });

  it.each([
    ['no vault yet', () => json(portfolioBody(chainOf([])))],
    ['no route', () => json({ message: 'Route GET:/v1/portfolio not found' }, 404)],
    ['the chain down', () => json({ error: 'down' }, 503)],
  ])('is the goal alone with %s', async (_, answer) => {
    api(onSolana, answer);
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    expect(summary(host)).toBeNull();
    expect(find(host, 'h1').textContent).toBe(en.goal.title);
  });

  it('says the vault in Portuguese', async () => {
    const pt = dictionary('pt');
    api(onSolana);
    portStore.set(signedInPort(PHANTOM));
    const host = await home('pt');
    expect(host.textContent).toContain(pt.portfolio.summary.title);
    expect(owned(host)).toHaveLength(1);
    expect(find(owned(host)[0], 'a').textContent).toBe(pt.shared.vaults.open);
    expect(host.textContent?.replace(/\s/g, ' ')).toContain('US$ 1.040,00');
    expect(host.textContent).toContain(pt.portfolio.summary.see);
  });
  it('prefers a plain-text vault name, then its saved goal, then its short address, without history requests', async () => {
    const plan = planOn();
    const basketId = basketOfPlan(PLAN_ID);
    keepOrder(
      recordOf('solana', {
        userId: onSolana.userId,
        goal: {
          sheet: plan.proposal.sheet,
          card: plan.proposal.card,
          verdict: null,
          placedAt: '2026-10-01T00:00:00Z',
        },
      }),
    );
    const calls = api(onSolana, () =>
      json(
        portfolioBody(
          chainOf([
            vault({ name: '<img src=x onerror=alert(1)>Trip fund', basketId }),
            vault({ address: SECOND_VAULT, name: null, basketId }),
            vault({ address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', basketId: '8' }),
          ]),
        ),
      ),
    );
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    const cards = owned(host);
    expect(cards.map((card) => find(card, 'h3').textContent)).toEqual([
      '<img src=x onerror=alert(1)>Trip fund',
      'Grow $40,000 over 36 months.',
      en.shared.vaults.address(shortAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')),
    ]);
    expect(cards.every((card) => find(card, 'h3').querySelector('img') === null)).toBe(true);
    expect(
      Array.from(host.querySelectorAll('img')).every(
        (image) =>
          image.getAttribute('src') === '/assets/tokens/paxg.png' && !image.hasAttribute('onerror'),
      ),
    ).toBe(true);
    expect(calls.filter((path) => path === PORTFOLIO_PATH)).toHaveLength(1);
    expect(calls.some((path) => /\/me\/(plans|withdrawals)|\/orders/.test(path))).toBe(false);
    expect(cards.every((card) => card.querySelectorAll('a').length === 1)).toBe(true);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
  });

  it('marks a live-labelled vault whose held price is sandbox, retains stale source details, and explains omitted holdings', async () => {
    const first = vault();
    const partial = vault({
      provenance: 'live',
      valueUsd: '380',
      positions: [{ ...first.positions[0], valueUsd: null }, first.positions[1]],
    });
    api(onSolana, () =>
      json(
        portfolioBody(
          chainOf([partial], {
            provenance: 'live',
            prices: [
              price('solana:paxg', '2600', {
                ageSeconds: 600,
                maxAgeSeconds: 120,
                provenance: 'sandbox',
              }),
            ],
          }),
        ),
      ),
    );
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    const card = owned(host)[0];
    expect(find(card, '[data-ui="sample-note"]').textContent).toBe(en.shell.testNetworkLine);
    expect(card.textContent).toContain(en.portfolio.vault.unpriced(1));
    const held = find(card, '[data-ui="owned-vault-holdings"]');
    expect(find(held, '[data-asset="solana:usdy"]').textContent).toContain('USDY —');
    expect(find(held, '[data-ui="holdings-bar"]').children).toHaveLength(2);
    expect(
      [...find(held, '[data-ui="holdings-bar"]').children].map(
        (el) => (el as HTMLElement).style.width,
      ),
    ).toEqual(['12.5%', '24.04%']);
    expect(find(card, '[data-ui="figure"]').textContent).toBe('$380.00\u202f');
    const pin = find(card, '[data-ui="figure"]').querySelector('button') as HTMLElement;
    await click(pin);
    expect(card.textContent).toContain('Pyth Hermes');
    expect(card.textContent).toContain('2026-10-05');
    expect(card.textContent).toContain(en.portfolio.vault.valueMethod);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('keeps a real zero value pinned instead of treating it as missing', async () => {
    api(onSolana, () => json(portfolioBody(chainOf([vault({ valueUsd: '0' })]))));
    portStore.set(signedInPort(PHANTOM));
    const card = owned(await home())[0];
    expect(find(card, '[data-ui="figure"]').textContent).toBe('$0.00\u202f');
    expect(card.querySelector('[data-ui="pin-glyph"]')).not.toBeNull();
  });

  it('does not expose a saved goal or a late vault response after another account signs in', async () => {
    const plan = planOn();
    keepOrder(
      recordOf('solana', {
        userId: onSolana.userId,
        goal: {
          sheet: plan.proposal.sheet,
          card: plan.proposal.card,
          verdict: null,
          placedAt: '2026-10-01T00:00:00Z',
        },
      }),
    );
    let release!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let current = onSolana;
    let reads = 0;
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(current);
      if (path === PORTFOLIO_PATH)
        return ++reads === 1
          ? old
          : json(portfolioBody(chainOf([vault({ basketId: basketOfPlan(PLAN_ID) })])));
      return json({}, 404);
    });
    portStore.set(signedInPort(PHANTOM));
    const host = await home();
    current = { ...onSolana, userId: 'other-person' };
    await act(async () => {
      portStore.set(signedInPort(PHANTOM, { userId: current.userId }));
    });
    await settle();
    expect(host.textContent).not.toContain('Grow $40,000');
    release(json(portfolioBody(chainOf([vault({ name: 'Private earlier account name' })]))));
    await settle();
    expect(host.textContent).not.toContain('Private earlier account name');
    expect(host.textContent).not.toContain('Grow $40,000');
    expect(find(owned(host)[0], 'h3').textContent).toBe(
      en.shared.vaults.address(shortAddress(VAULT)),
    );
  });
});

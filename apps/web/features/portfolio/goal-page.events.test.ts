// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GoalPage from '../../app/(app)/goal/page';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PORTFOLIO_PATH } from './portfolio';
import {
  chainOf,
  portfolioBody,
  portfolioOf,
  robinhoodChain,
  SECOND_VAULT,
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
const summary = (host: HTMLElement) =>
  [...host.querySelectorAll('section[data-ui="card"]')].find(
    (card) => card.querySelector('h2')?.textContent === en.portfolio.summary.title,
  ) ?? null;

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('home', () => {
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
    expect(card.textContent).toContain(en.portfolio.summary.worth('Solana'));
    expect(card.querySelector('[data-ui="figure"]')?.textContent).toContain('$1,040.00');
    const link = find(card, 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.portfolio.summary.see,
      '/monitor',
    ]);
    // a test network: the hatch, MOCK, and the words
    expect(card.querySelector('[data-ui="mock-plate"]')).not.toBeNull();
    expect(find(card, '[data-ui="mock-note"]').textContent).toBe(en.shell.testNetwork);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    // still one serif line on the page, and no primary button but the goal's own
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(card.querySelector('[data-variant="primary"]')).toBeNull();
  });

  it('counts vaults when there is more than one, and adds no figure up', async () => {
    api(onSolana, () => json(portfolioBody(chainOf([vault(), vault({ address: SECOND_VAULT })]))));
    portStore.set(signedInPort(PHANTOM));
    const card = summary(await home()) as HTMLElement;
    expect(card.textContent).toContain(en.portfolio.summary.many(2, 'Solana'));
    expect(card.querySelector('[data-ui="figure"]')).toBeNull();
  });

  it('names the chain of the vault with its badge', async () => {
    api(onSolana);
    portStore.set(signedInPort(PHANTOM));
    const card = summary(await home()) as HTMLElement;
    const badges = [...card.querySelectorAll('[data-ui="chain-badge"]')];
    expect(badges.map((b) => b.getAttribute('data-chain'))).toEqual(['solana']);
  });

  it('counts vaults on two chains with both named, and adds nothing across them', async () => {
    api(onSolana, () => json(portfolioOf(chainOf(), robinhoodChain())));
    portStore.set(signedInPort(PHANTOM));
    const card = summary(await home()) as HTMLElement;
    expect(card.textContent).toContain(
      en.portfolio.summary.manyChains(2, 'Solana and Robinhood Chain'),
    );
    expect(card.querySelector('[data-ui="figure"]')).toBeNull();
    const badges = [...card.querySelectorAll('[data-ui="chain-badge"]')];
    expect(badges.map((b) => b.getAttribute('data-chain'))).toEqual(['solana', 'robinhood']);
    expect(card.textContent).not.toMatch(/usdc/i);
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
    expect(host.textContent).toContain(pt.portfolio.summary.worth('Solana'));
    expect(host.textContent?.replace(/\s/g, ' ')).toContain('US$ 1.040,00');
    expect(host.textContent).toContain(pt.portfolio.summary.see);
  });
});

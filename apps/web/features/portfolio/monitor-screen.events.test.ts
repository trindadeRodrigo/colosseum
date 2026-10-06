// @vitest-environment happy-dom
import { DISCLAIMER, DISCLAIMER_SHORT } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { keepOrder, type OrderRecord } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import { doneOrder, ORDER_ID, orderOn, PLAN_ID, planOn, recordOf } from '../order/test/fixtures';
import {
  EMBEDDED,
  fakePort,
  json,
  METAMASK,
  PHANTOM,
  signedInPort,
} from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { MonitorScreen } from './MonitorScreen';
import { cashHolding, PORTFOLIO_PATH } from './portfolio';
import {
  chainOf,
  labelled,
  portfolioBody,
  portfolioOf,
  robinhoodChain,
  SECOND_VAULT,
  VAULT,
  vault,
} from './test/portfolio';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The monitor with real events: who is asking decides what is read, every figure the API gives is
// written with its pin, nothing that is not live is drawn as live, and where the API cannot say, a
// sentence says why and no holding is drawn in its place. The API is a double: GET /v1/me, and
// GET /v1/portfolio as apps/api answers it.

const en = dictionary('en');

const onSolana: Person = {
  userId: 'did:privy:test',
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};

function api(options: {
  person?: Person;
  portfolio?: () => Response | Promise<Response>;
  /** Other routes the test answers: the orders, for the activity. */
  more?: (path: string) => Response | null;
}) {
  const calls: string[] = [];
  portStore.setApi(async (path) => {
    calls.push(path);
    const other = options.more?.(path);
    if (other) return other;
    if (path === '/v1/me') return options.person ? json(options.person) : json({}, 503);
    if (path === PORTFOLIO_PATH)
      return options.portfolio ? options.portfolio() : json(portfolioBody());
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (path: string) => calls.filter((c) => c === path) };
}

const screen = async (lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(MonitorScreen)));
  await settle();
  return host;
};
const signIn = (accounts = PHANTOM, provenance: 'sandbox' | 'live' | 'mock' = 'sandbox') =>
  portStore.set(signedInPort(accounts, {}, provenance));
const vaults = (host: HTMLElement) => host.querySelectorAll('[data-ui="card"] h2');
const pins = (host: HTMLElement) => [...host.querySelectorAll('[data-ui="figure"]')];
/** The vault's own panel: what it holds. */
const panel = (host: HTMLElement) => find(host, '[data-ui="vault"] > [data-ui="card"]');
const primary = (host: HTMLElement) => host.querySelector('[data-variant="primary"]');
const text = (host: HTMLElement) => host.textContent ?? '';

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the monitor, for a person with a vault on their chain', () => {
  it('asks once for the portfolio, and shows the vault with its value, cash and switches', async () => {
    const server = api({ person: onSolana });
    signIn();
    const host = await screen();
    expect(server.to(PORTFOLIO_PATH)).toHaveLength(1);
    expect(find(host, 'h1').textContent).toBe(en.portfolio.title(1));
    // the serif is spent once, on that line
    // the serif is spent on the goal: in a list of goal cards the page heading is the sans face
    // (goal-card.md), and each vault's card has its one serif sentence
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').closest('[data-ui="goal-card"]')).not.toBeNull();
    expect(vaults(host)).toHaveLength(1);
    const words = en.portfolio.vault;
    expect(find(host, '[data-ui="card"] h2').textContent).toBe(words.title);
    for (const label of [words.value, words.cash, words.autoFollow, words.lossUsed])
      expect(text(host)).toContain(label);
    expect(text(host)).toContain('$1,040.00');
    expect(text(host)).toContain(words.on);
    // the keeper's tiles are there because auto-follow is on
    expect(text(host)).toContain('0.1%');
    expect(text(host)).toContain(words.observed('2026-10-05 14:00 UTC'));
  });

  it('writes each holding with its price, value, weight, target and drift, as the API gave them', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const table = find(host, 'table');
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(heads).toEqual(Object.values(en.portfolio.vault.columns));
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.children].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
    );
    expect(rows.map((r) => [r[0], r[1], r[4], r[5], r[6]])).toEqual([
      // each asset by the name the plan screen gives it, to one decimal at most
      ['USDY (Ondo)', '600', '63.5%', '60%', '+3.5%'],
      ['PAXG', '0.05', '12.5%', '15%', '−2.5%'],
      // cash is a holding too, the last row: what the others leave, against what their targets leave
      ['Cash (USDC)', '250', '24%', '25%', '−1%'],
    ]);
    expect(rows[0]?.[2]).toContain('$1.10');
    expect(rows[0]?.[3]).toContain('$660.00');
    expect(rows[1]?.[2]).toContain('$2,600.00');
    expect(rows[2]?.[2]).toContain('$1.00');
    expect(rows[2]?.[3]).toContain('$250.00');
    // with it the weights add up to the whole, and so do the targets
    const held = vault();
    const cash = cashHolding(held);
    expect(held.positions.reduce((sum, p) => sum + p.weightBps, cash.weightBps)).toBe(10_000);
    expect(held.positions.reduce((sum, p) => sum + p.targetBps, cash.targetBps)).toBe(10_000);
    expect(find(table, 'caption').textContent).toBe('What you hold');
  });

  it('puts a pin on every price and value, and none on a count, a share or an amount (rule 1)', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const table = find(host, 'table');
    // two holdings and cash: a price and a value each, in the table
    expect(table.querySelectorAll('[data-ui="figure"]')).toHaveLength(6);
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.children];
      expect(cells[2]?.querySelector('[data-ui="figure"]'), 'price').not.toBeNull();
      expect(cells[3]?.querySelector('[data-ui="figure"]'), 'value').not.toBeNull();
      for (const i of [1, 4, 5, 6])
        expect(cells[i]?.querySelector('[data-ui="figure"]')).toBeNull();
    }
    // the vault's value has its pin too, and its cash, switch and loss share none
    expect(find(host, '[data-ui="vault-value"] [data-ui="figure"]')).toBeTruthy();
    const stats = [...host.querySelectorAll('[data-ui="stat"]')];
    expect(stats.map((stat) => stat.querySelector('[data-ui="figure"]') !== null)).toEqual([
      false,
      false,
      false,
    ]);
    // and every pin can be opened, by its name
    for (const pin of pins(host))
      expect(pin.querySelector('button')?.getAttribute('aria-label')).toMatch(/^Source for /);
  });

  it('draws a test network as the hatch and a quiet line with the words, never as live (rule 2)', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const card = panel(host);
    expect(card.querySelector('.tf-hatch')).not.toBeNull();
    expect(card.textContent).not.toContain('MOCK');
    // one plain line: figures read from a test network are not called samples
    expect(find(card, '[data-ui="sample-note"]').textContent).toBe(en.shell.testNetworkFigures);
    expect(en.shell.testNetworkFigures.toLowerCase()).toContain(en.shell.testNetwork);
    // the chain line says it too
    expect(find(host, 'header [data-ui="chain-name"]').textContent).toContain(en.shell.testNetwork);
    // no figure is drawn live
    expect(pins(host).map((pin) => pin.getAttribute('data-state'))).not.toContain('live');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('draws a live vault with live pins and no mark, and the same vault on the mock with the line alone', async () => {
    api({ person: onSolana, portfolio: () => json(portfolioBody(labelled('live'))) });
    signIn(PHANTOM, 'live');
    const live = await screen();
    expect(live.querySelector('[data-ui="sample-note"]')).toBeNull();
    expect(live.querySelector('.tf-hatch')).toBeNull();
    expect(new Set(pins(live).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['live']),
    );
    await unmountAll();
    api({ person: onSolana, portfolio: () => json(portfolioBody(labelled('mock'))) });
    signIn(PHANTOM, 'mock');
    const mocked = await screen();
    const card = panel(mocked);
    expect(find(card, '[data-ui="sample-note"]').textContent).toBe(en.shell.mockAnnounce);
    expect(hatchProblems(parse(mocked.innerHTML))).toEqual([]);
  });

  it('puts the disclaimer under the vaults, from the one constant, in the language of the view (rule 3)', async () => {
    for (const lang of ['en', 'pt'] as const) {
      api({ person: onSolana });
      signIn();
      const host = await screen(lang);
      const block = find(host, '[data-ui="disclaimer"]');
      expect(find(block, 'p[lang]').textContent).toBe(DISCLAIMER[lang]);
      // after the last vault
      const order = [...host.querySelectorAll('[data-ui="card"], [data-ui="disclaimer"]')];
      expect(order.at(-1)).toBe(block);
      await unmountAll();
    }
  });

  it('shows each vault, and says the title for more than one', async () => {
    api({
      person: onSolana,
      portfolio: () =>
        json(
          portfolioBody(chainOf([vault(), vault({ address: SECOND_VAULT, autoFollow: false })])),
        ),
    });
    signIn();
    const host = await screen();
    expect(vaults(host)).toHaveLength(2);
    expect(find(host, 'h1').textContent).toBe(en.portfolio.title(2));
    expect(text(host)).toContain(en.portfolio.vault.off);
  });

  it('says what is still to come from the portfolio it follows, and what has no price', async () => {
    const [usdy, paxg] = vault().positions;
    if (!usdy || !paxg) throw new Error('fixture');
    api({
      person: onSolana,
      portfolio: () =>
        json(
          portfolioBody(
            chainOf([
              vault({
                positions: [usdy, { ...paxg, valueUsd: null }],
                pending: { version: 2, effectiveAt: 1_791_300_000, newAssets: ['solana:spyx'] },
              }),
            ]),
          ),
        ),
    });
    signIn();
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.vault.pending(2, '2026-10-06 15:20 UTC'));
    expect(text(host)).toContain(en.portfolio.vault.pendingAssets('SPYx'));
    expect(text(host)).toContain(en.portfolio.vault.unpriced(1));
    expect(text(host)).toContain(en.portfolio.vault.noPrice);
  });

  it('draws its parts as his case does: a bar by weight, each part with its weight and target', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const parts = find(host, '[data-ui="vault-parts"]');
    const items = [...parts.querySelectorAll('li')].map((li) => li.textContent);
    // cash is a part like the others: named, with what the positions leave, by weight
    expect(items).toEqual([
      `USDY (Ondo)63.5%${en.portfolio.vault.target('60%')}`,
      `Cash (USDC)24%${en.portfolio.vault.target('25%')}`,
      `PAXG12.5%${en.portfolio.vault.target('15%')}`,
    ]);
    // and counted in the title, with a segment of its own in the bar
    expect(find(parts.closest('section') as HTMLElement, 'h3').textContent).toBe(
      en.portfolio.vault.planTitle(3),
    );
    expect(parts.querySelectorAll('[aria-hidden="true"].flex > span')).toHaveLength(3);
    expect(host.textContent).not.toMatch(/USDY63|SYRUPUSDC/);
    // the vault's facts for the team are folded under "Details", not chips, and the foot has the
    // short disclaimer
    expect(host.querySelector('ul[aria-label="The vault"]')).toBeNull();
    const details = find(host, '[data-ui="vault-details"]');
    expect(details.hasAttribute('open')).toBe(false);
    expect(find(details, 'summary').textContent).toBe(en.portfolio.vault.details.label);
    const facts = [...details.querySelectorAll('dt, dd')].map((el) => el.textContent);
    // a vault bought from a goal follows no shared portfolio: no version is shown for it
    expect(facts).toEqual([
      en.portfolio.vault.address,
      vault().address,
      en.portfolio.vault.autoFollow,
      en.portfolio.vault.on,
    ]);
    expect(host.textContent).not.toMatch(/version: |auto-follow: /);
    expect(host.textContent).toContain(DISCLAIMER_SHORT.en);
  });

  it('says a vault of cash alone in words, with cash as its one holding, the whole of it', async () => {
    api({
      person: onSolana,
      portfolio: () => json(portfolioBody(chainOf([vault({ positions: [], valueUsd: '250' })]))),
    });
    signIn();
    const host = await screen();
    const rows = [...find(host, 'table').querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.children[0]?.textContent).toBe('Cash (USDC)');
    expect(rows[0]?.children[4]?.textContent).toBe('100%');
    expect(text(host)).toContain(en.portfolio.vault.onlyCash);
  });

  it('signs nothing: no primary button, no signing word, and the vault’s switches are not offered', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    expect(primary(host)).toBeNull();
    expect(host.querySelectorAll('button:not([aria-label^="Source for"])')).toHaveLength(0);
    expect(text(host)).not.toMatch(/\bsign\b|withdraw|rebalance now/i);
  });
});

describe('the monitor, when there is nothing to read or the API cannot say', () => {
  it('asks a person who is signed out to sign in, and asks the API nothing', async () => {
    const server = api({});
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.signedOut);
    const link = find(host, 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.shell.signIn,
      '/sign-in?next=/monitor',
    ]);
    expect(server.to(PORTFOLIO_PATH)).toEqual([]);
    expect(host.querySelector('[data-ui="disclaimer"]')).toBeNull();
  });

  it('says it cannot tell the chain when the one a person starts on is not stored, and reads nothing', async () => {
    const server = api({
      person: {
        ...onSolana,
        wallets: EMBEDDED,
        chain: null,
        chainSource: null,
        chainOptions: ['solana', 'robinhood'],
      },
    });
    signIn(EMBEDDED);
    const host = await screen();
    // the double has no PUT /v1/me/chain: the chain they start on (CHAIN-SWITCH) is not stored
    expect(text(host)).toContain(en.chain.unknown.body);
    expect(text(host)).toContain(en.chain.unknown.retry);
    expect(server.to(PORTFOLIO_PATH)).toEqual([]);
  });

  it('says there is no vault yet, and leads back to the goal', async () => {
    api({ person: onSolana, portfolio: () => json(portfolioBody(chainOf([]))) });
    signIn();
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.empty('Solana'));
    const link = find(host, 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.portfolio.startGoal,
      '/goal',
    ]);
    expect(host.querySelector('table')).toBeNull();
  });

  it('says this server cannot read vaults when the route is missing, and draws no holding', async () => {
    api({
      person: onSolana,
      portfolio: () => json({ message: 'Route GET:/v1/portfolio not found' }, 404),
    });
    signIn();
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.unavailable);
    expect(host.querySelector('table')).toBeNull();
    expect(pins(host)).toEqual([]);
    expect(host.querySelector('[data-ui="disclaimer"]')).toBeNull();
  });

  it('calls a chain that does not answer unavailable, in words and a shape, and reads again on request', async () => {
    let down = true;
    const server = api({
      person: onSolana,
      portfolio: () =>
        down
          ? json({ error: 'Solana did not answer', code: 'CHAIN_UNAVAILABLE' }, 503)
          : json(portfolioBody()),
    });
    signIn();
    const host = await screen();
    const status = find(host, '[data-ui="status"]');
    expect(status.textContent).toBe(en.portfolio.down.word);
    // nothing is known to be wrong: watch, not off track
    expect(status.getAttribute('data-status')).toBe('watch');
    expect(status.querySelector('svg')).not.toBeNull();
    expect(text(host)).toContain(en.portfolio.down.body('Solana'));
    const again = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith(en.portfolio.again),
    ) as HTMLElement;
    // reading again is not the view's primary action
    expect(again.getAttribute('data-variant')).toBe('secondary');
    down = false;
    await click(again);
    await settle();
    expect(server.to(PORTFOLIO_PATH)).toHaveLength(2);
    expect(vaults(host)).toHaveLength(1);
  });

  it.each([
    [() => json({ error: 'slow down' }, 429), en.shell.slowDown],
    [() => Promise.reject(new TypeError('fetch failed')), en.portfolio.unreachable],
    [() => json({ chains: 'nope' }), en.portfolio.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.portfolio.signInAgain],
    [() => json({ error: 'no identity token was sent' }, 401), en.portfolio.noIdentity],
    [() => json({ error: 'pick the chain your plans live on first' }, 409), en.portfolio.noChain],
  ])('says each failure in its own sentence: %#', async (answer, sentence) => {
    api({ person: onSolana, portfolio: answer });
    signIn();
    const host = await screen();
    expect(text(host)).toContain(sentence);
    expect(host.querySelector('table')).toBeNull();
  });

  it('drops an answer that lands after the person changed', async () => {
    let release: (res: Response) => void = () => {};
    const server = api({
      person: onSolana,
      portfolio: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    signIn();
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.reading);
    // the person signs out while the read is on its way: nothing is said to be reading any more
    await act(async () => portStore.set(fakePort()));
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(find(host, '[role="status"]').textContent).toBe('');
    await act(async () => release(json(portfolioBody())));
    await settle();
    expect(vaults(host)).toHaveLength(0);
    expect(text(host)).toContain(en.portfolio.signedOut);
    expect(server.to(PORTFOLIO_PATH)).toHaveLength(1);
  });
});

it('shows a person only the answer read for them, when another signs in while a read is on its way', async () => {
  const pending: Array<(res: Response) => void> = [];
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json({ ...onSolana, userId: portStore.get().userId });
    if (path === PORTFOLIO_PATH) return new Promise<Response>((resolve) => pending.push(resolve));
    return json({}, 404);
  });
  signIn();
  const host = await screen();
  expect(pending).toHaveLength(1);
  // another person signs in on this browser before the first read lands
  await act(async () => portStore.set(signedInPort(PHANTOM, { userId: 'did:privy:other' })));
  await settle();
  expect(pending).toHaveLength(2);
  // the first person's vault lands late: it is not shown to the second
  await act(async () => pending[0]?.(json(portfolioBody())));
  await settle();
  expect(vaults(host)).toHaveLength(0);
  expect(text(host)).toContain(en.portfolio.reading);
  // the second person's own answer is
  await act(async () =>
    pending[1]?.(json(portfolioBody(chainOf([vault({ address: SECOND_VAULT })])))),
  );
  await settle();
  expect(vaults(host)).toHaveLength(1);
  expect(host.querySelector(`[title="${SECOND_VAULT}"]`)).not.toBeNull();
  expect(host.querySelector(`[title="${VAULT}"]`)).toBeNull();
});

describe('the throwaway wallet of development', () => {
  const throwaway = () =>
    portStore.set(signedInPort(PHANTOM, { test: true, userId: 'test:So111111' }, 'mock'));

  it('is read like anyone, so a stand-in API that answers it shows its vault', async () => {
    const server = api({ portfolio: () => json(portfolioBody(labelled('mock'))) });
    throwaway();
    const host = await screen();
    expect(server.to('/v1/me')).toEqual([]);
    expect(server.to(PORTFOLIO_PATH)).toHaveLength(1);
    expect(vaults(host)).toHaveLength(1);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('is told it has no account, not to sign in again, when a real API refuses it', async () => {
    api({ portfolio: () => json({ error: 'sign in first' }, 401) });
    throwaway();
    const host = await screen();
    expect(text(host)).toContain(en.portfolio.throwaway);
    expect(text(host)).not.toContain(en.portfolio.signInAgain);
  });
});

describe('each vault as his guide’s goal card, plan and activity', () => {
  /** The vault of the order this browser placed, joined by the plan's number on chain. */
  const bought = (over: Partial<OrderRecord> = {}) => {
    const plan = planOn();
    keepOrder(
      recordOf('solana', {
        userId: onSolana.userId,
        amountUsd: 40_000,
        goal: {
          sheet: plan.proposal.sheet,
          card: plan.proposal.card,
          verdict: null,
          placedAt: '2026-10-01T00:00:00Z',
        },
        ...over,
      }),
    );
    return json(portfolioBody(chainOf([vault({ basketId: basketOfPlan(PLAN_ID) })])));
  };

  /** The order, as the API says it stands: signed and confirmed, or not signed yet. */
  const orders = (done: boolean) => (path: string) =>
    path === `/v1/orders/${ORDER_ID}` ? json(done ? doneOrder() : orderOn()) : null;

  it('opens with the goal its plan was built for, its date, its value, and no made-up status', async () => {
    api({ person: onSolana, portfolio: () => bought(), more: orders(true) });
    signIn();
    const host = await screen();
    await settle();
    const card = find(host, '[data-ui="goal-card"]');
    expect(find(card, 'h3').textContent).toBe('Grow $40,000 over 36 months.');
    // a growth goal has no status from the engine: the card says so, with the goal's date
    expect(card.querySelector('[data-ui="status"]')).toBeNull();
    expect(find(card, '[data-ui="goal-no-status"]').textContent).toBe(
      en.portfolio.goalCard.runsTo('October 2029'),
    );
    expect(card.textContent).not.toMatch(/engine|No status/);
    expect(find(card, '[data-ui="figure"]').textContent).toContain('$1,040.00');
    // what went in: the order whose deposit is confirmed on chain
    expect(card.textContent).toContain(
      `${en.portfolio.goalCard.putIn('$40,000')} · up to $40,000 within a day`,
    );
    const link = find(card, 'a');
    expect([link.textContent, link.getAttribute('href')]).toEqual([
      en.portfolio.goalCard.seeOrder,
      `/orders/${ORDER_ID}`,
    ]);
    // beside it, his plan: the parts by weight
    const titles = [...host.querySelectorAll('[data-ui="vault"] section h3')].map(
      (h) => h.textContent,
    );
    // two positions and the cash
    expect(titles).toContain(en.portfolio.vault.planTitle(3));
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('counts nothing as put in from an order kept but not confirmed on chain', async () => {
    api({ person: onSolana, portfolio: () => bought(), more: orders(false) });
    signIn();
    const host = await screen();
    await settle();
    const card = find(host, '[data-ui="goal-card"]');
    expect(card.textContent).not.toContain(en.portfolio.goalCard.putIn('$40,000'));
    expect(card.textContent).toContain('up to $40,000 within a day');
  });

  const income = (amountUsd: number) => {
    const plan = planOn();
    return bought({
      amountUsd,
      goal: {
        sheet: { ...plan.proposal.sheet, goal: 'income' },
        card: plan.proposal.card,
        verdict: { met: true, gapUsdMonthly: 0, ways: [] },
        placedAt: '2026-10-01T00:00:00Z',
      },
    });
  };

  it('says an income plan’s verdict only as the verdict when it was built, and only for its own amount', async () => {
    api({ person: onSolana, portfolio: () => income(40_000), more: orders(true) });
    signIn();
    const host = await screen();
    await settle();
    const status = find(find(host, '[data-ui="goal-card"]'), '[data-ui="status"]');
    expect(status.getAttribute('data-status')).toBe('on-track');
    expect(status.textContent).toBe(`${en.portfolio.goalCard.builtMet} · October 2029`);
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('says a short income plan in figures: what it paid a month of what was asked, and the target in the goal', async () => {
    const plan = planOn();
    api({
      person: onSolana,
      portfolio: () =>
        bought({
          amountUsd: 40_000,
          goal: {
            sheet: { ...plan.proposal.sheet, goal: 'income', incomeTargetUsdMonthly: 300 },
            card: plan.proposal.card,
            verdict: { met: false, gapUsdMonthly: 228.23, ways: [] },
            placedAt: '2026-10-01T00:00:00Z',
          },
        }),
      more: orders(true),
    });
    signIn();
    const host = await screen();
    await settle();
    const card = find(host, '[data-ui="goal-card"]');
    const status = find(card, '[data-ui="status"]');
    expect(status.getAttribute('data-status')).toBe('off-track');
    expect(status.textContent).toBe(en.portfolio.goalCard.builtPaid('$71.77', '$300'));
    expect(status.textContent).toBe(
      'When this plan was built, it paid $71.77 a month of the $300 you asked for.',
    );
    // the old line, and the gap said a second time, are gone
    expect(card.textContent).not.toContain(en.portfolio.goalCard.builtShort);
    expect(card.textContent).not.toContain(en.plan.verdict.gap('$228.23'));
    // the goal says what it asked for a month
    expect(find(card, 'h3').textContent).toBe('Earn $300 a month from $40,000 for 36 months.');
  });

  it('says no status when what went in is not the amount the plan was built for', async () => {
    api({ person: onSolana, portfolio: () => income(50), more: orders(true) });
    signIn();
    const host = await screen();
    await settle();
    const card = find(host, '[data-ui="goal-card"]');
    expect(card.querySelector('[data-ui="status"]')).toBeNull();
    expect(find(card, '[data-ui="goal-no-status"]').textContent).toMatch(/^Runs to /);
    // the card leads with what was put in, not with the amount the goal was written for
    expect(find(card, 'h3').textContent).toContain('$50');
    expect(find(card, 'h3').textContent).not.toContain('$40,000');
  });

  it('shows what is known of a vault this browser cannot join to a goal, and invents no target', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const card = find(host, '[data-ui="goal-card"]');
    expect(find(card, 'h3').textContent).toBe(en.portfolio.goalCard.unknown('Solana'));
    expect(card.textContent).toContain(en.portfolio.goalCard.notJoined);
    expect(card.textContent).not.toMatch(/ of \$/);
    expect(find(card, 'a').getAttribute('href')).toBe('/goal');
  });

  it('lists what reached the chain from the orders this browser placed, each line with its link, beside the disclaimer', async () => {
    api({
      person: onSolana,
      portfolio: () => bought(),
      more: (path) => (path === `/v1/orders/${ORDER_ID}` ? json(doneOrder()) : null),
    });
    signIn();
    const host = await screen();
    await settle();
    const activity = find(host, '[data-ui="activity-panel"]');
    const lines = [...activity.querySelectorAll('[data-ui="execution-list"] li')];
    expect(lines.length).toBe(doneOrder().legs.length);
    // each link from this app's own chain table, devnet's explorer, whatever the API sent
    for (const line of lines)
      expect(line.querySelector('a[href^="https://solscan.io/tx/"]')).not.toBeNull();
    expect(find(activity, '[data-ui="disclaimer"] p[lang]').textContent).toBe(DISCLAIMER.en);
  });

  it('groups what was done by order, each under what it was and when, with no step listed twice', async () => {
    const second = 'order-2';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      api({
        person: onSolana,
        portfolio: () => {
          bought({ orderId: second, amountUsd: 500 });
          return bought();
        },
        // two orders whose steps are numbered alike, as every order's are
        more: (path) =>
          path === `/v1/orders/${ORDER_ID}`
            ? json(doneOrder())
            : path === `/v1/orders/${second}`
              ? json({ ...doneOrder(), id: second, createdAt: '2026-10-05T16:00:00.000Z' })
              : null,
      });
      signIn();
      const host = await screen();
      await settle();
      const orders = [...host.querySelectorAll('[data-ui="activity-order"]')];
      expect(orders.map((o) => o.querySelector('h3 span')?.textContent).sort()).toEqual(
        [en.activity.order.buy('$40,000'), en.activity.order.buy('$500')].sort(),
      );
      for (const order of orders) {
        expect(order.querySelector('h3 time')?.textContent).toMatch(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
        );
        expect(order.querySelectorAll('[data-ui="execution-list"] li')).toHaveLength(
          doneOrder().legs.length,
        );
      }
      // React is given one key per line: no "same key" complaint
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(/key/i);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('the monitor in Portuguese', () => {
  it('says every word of the vault in Portuguese, and the figures the Brazilian way', async () => {
    const pt = dictionary('pt');
    api({ person: onSolana });
    signIn();
    const host = await screen('pt');
    expect(find(host, 'h1').textContent).toBe(pt.portfolio.title(1));
    for (const label of Object.values(pt.portfolio.vault.columns))
      expect(text(host)).toContain(label);
    expect(text(host).replace(/\s/g, ' ')).toContain('US$ 1.040,00');
    expect(text(host)).toContain('−2,5%');
    expect(find(panel(host), '[data-ui="sample-note"]').textContent).toBe(
      pt.shell.testNetworkFigures,
    );
    // the goal card's line is in Portuguese too, never "Sample figures"
    expect(find(host, '[data-ui="goal-card"] [data-ui="sample-note"]').textContent).toBe(
      pt.shell.testNetworkFigures,
    );
    expect(text(host)).not.toContain('Sample figures');
    for (const pin of pins(host))
      expect(pin.querySelector('button')?.getAttribute('aria-label')).toMatch(/^Fonte de /);
    expect(text(host)).not.toContain(en.portfolio.vault.title);
  });
});

it('names the vault by its address, cut, with the whole of it kept for whoever asks', async () => {
  api({ person: onSolana });
  signIn();
  const host = await screen();
  const meta = find(host, `[title="${VAULT}"]`);
  expect(meta.textContent).toContain('EPjF…kGDw');
});

describe('the chain of each vault', () => {
  const onRobinhood: Person = { ...onSolana, wallets: EMBEDDED, chain: 'robinhood' };
  const chainsOf = (host: HTMLElement, where = '') =>
    [...host.querySelectorAll(`${where} [data-ui="chain-badge"]`)].map((b) =>
      b.getAttribute('data-chain'),
    );

  it.each([
    ['solana', onSolana, () => portfolioBody()],
    ['robinhood', onRobinhood, () => portfolioOf(robinhoodChain())],
  ] as const)(
    'is badged on the goal card and the vault panel, on %s',
    async (chain, person, body) => {
      api({ person, portfolio: () => json(body()) });
      signIn(chain === 'solana' ? PHANTOM : EMBEDDED, chain === 'solana' ? 'sandbox' : 'mock');
      const host = await screen();
      const vault = find(host, '[data-ui="vault"]');
      expect(chainsOf(vault as HTMLElement)).toEqual([chain, chain]);
      expect(chainsOf(vault as HTMLElement, '[data-ui="goal-card"]')).toEqual([chain]);
      expect(chainsOf(vault as HTMLElement, '[data-ui="card-header"]')).toEqual([chain]);
      // the page's chain line names it too, and there is nothing to group
      expect(find(host, 'header [data-ui="chain-badge"]').textContent).toBe(CHAIN_NAMES[chain]);
      expect(host.querySelector('[data-ui="chain-group"]')).toBeNull();
      expect(host.querySelector('[data-ui="across-chains"]')).toBeNull();
    },
  );

  it('says tUSDG for a Robinhood vault’s dollar, and never USDC, in English and Portuguese', async () => {
    for (const lang of ['en', 'pt'] as const) {
      api({ person: onRobinhood, portfolio: () => json(portfolioOf(robinhoodChain())) });
      signIn(EMBEDDED, 'mock');
      const host = await screen(lang);
      const vault = find(host, '[data-ui="vault"]');
      expect(vault.textContent).toContain('tUSDG');
      expect(vault.textContent).not.toMatch(/usdc/i);
      expect(host.textContent).not.toMatch(/usdc/i);
      await unmountAll();
    }
  });

  it('groups vaults on two chains under a heading each, with a total each, and adds them only where it says so', async () => {
    api({ person: onSolana, portfolio: () => json(portfolioOf(chainOf(), robinhoodChain())) });
    signIn();
    const host = await screen();
    const groups = [...host.querySelectorAll<HTMLElement>('[data-ui="chain-group"]')];
    expect(groups.map((g) => g.getAttribute('data-chain'))).toEqual(['solana', 'robinhood']);
    expect(groups.map((g) => g.querySelector('h2')?.textContent)).toEqual([
      expect.stringContaining('Solana'),
      expect.stringContaining('Robinhood Chain'),
    ]);
    // each chain's vaults sit under its heading, each badged with that chain
    for (const group of groups) {
      const chain = group.getAttribute('data-chain');
      expect(group.querySelectorAll('[data-ui="vault"]')).toHaveLength(1);
      expect(new Set(chainsOf(group))).toEqual(new Set([chain]));
    }
    // a total per chain, each with its pin, never one chain's figure under the other's heading
    const totals = groups.map((g) => find(g, '[data-ui="chain-total"]').textContent);
    expect(totals[0]).toContain(en.portfolio.group.worth(1, 'Solana'));
    expect(totals[0]).toContain('$1,040.00');
    expect(totals[1]).toContain(en.portfolio.group.worth(1, 'Robinhood Chain'));
    expect(totals[1]).toContain('$26.50');
    expect(totals[1]).not.toContain('$1,040.00');
    for (const group of groups)
      expect(find(group, '[data-ui="chain-total"] [data-ui="pin"]')).toBeTruthy();
    // the one figure across chains says so
    const across = find(host, '[data-ui="across-chains"]').textContent ?? '';
    expect(across).toContain(en.portfolio.group.across(2));
    expect(en.portfolio.group.across(2)).toBe('Across both chains, together');
    expect(across).toContain('$1,066.50');
    // the Robinhood vault still never says USDC
    expect(groups[1]?.textContent).not.toMatch(/usdc/i);
    // no single chain line in the header once there are two
    expect(host.querySelector('header [data-ui="chain-badge"]')).toBeNull();
  });

  it('shows the chain that was read when another is unavailable, and says which, in English and Portuguese', async () => {
    const out = {
      chain: 'solana',
      name: 'Solana',
      code: 'CHAIN_UNAVAILABLE',
      error: 'the node did not answer',
      retryable: true,
    };
    for (const lang of ['en', 'pt'] as const) {
      api({
        person: onSolana,
        portfolio: () => json({ ...portfolioOf(robinhoodChain()), unavailable: [out] }),
      });
      signIn();
      const host = await screen(lang);
      // the Robinhood vault is shown, not a sentence that the portfolio could not be read
      expect(host.querySelectorAll('[data-ui="vault"]')).toHaveLength(1);
      expect(host.textContent).not.toContain(dictionary(lang).portfolio.unreadable);
      expect(find(host, '[data-ui="chains-out"] [data-chain="solana"]').textContent).toBe(
        dictionary(lang).portfolio.chainOut('Solana'),
      );
      await unmountAll();
    }
    expect(en.portfolio.chainOut('Robinhood Chain')).toBe(
      'Robinhood Chain is unavailable right now.',
    );
  });

  it('never says there is no vault on a chain it could not read, nor while another chain is out', async () => {
    const out = (chain: 'solana' | 'robinhood', retryable: boolean) => ({
      chain,
      name: chain === 'solana' ? 'Solana' : 'Robinhood Chain',
      code: 'CHAIN_UNAVAILABLE',
      error: 'x',
      retryable,
    });
    for (const answer of [
      // the current chain could not be read, and no vault was read anywhere
      { ...portfolioOf(robinhoodChain([])), unavailable: [out('solana', true)] },
      // the current chain is not held, and nothing was read
      { ...portfolioOf(robinhoodChain([])), unavailable: [] },
      // the current chain was read empty, but another could not be read
      { ...portfolioOf(chainOf([])), unavailable: [out('robinhood', false)] },
    ]) {
      api({ person: onSolana, portfolio: () => json(answer) });
      signIn();
      const host = await screen();
      expect(host.textContent).not.toContain(en.portfolio.empty('Solana'));
      expect(host.querySelector('[data-ui="chains-out"]')).not.toBeNull();
      await unmountAll();
    }
    // a chain switched off here is said so, and not offered a read again
    api({
      person: onSolana,
      portfolio: () =>
        json({ ...portfolioOf(chainOf([])), unavailable: [out('robinhood', false)] }),
    });
    signIn();
    const host = await screen();
    expect(find(host, '[data-ui="chains-out"] [data-chain="robinhood"]').textContent).toBe(
      en.portfolio.chainOff('Robinhood Chain'),
    );
    expect(host.textContent).not.toContain(en.portfolio.again);
    // and when every chain was read and holds none, it is said
    await unmountAll();
    api({ person: onSolana, portfolio: () => json(portfolioOf(chainOf([]))) });
    signIn();
    expect((await screen()).textContent).toContain(en.portfolio.empty('Solana'));
  });

  it('says the current chain is not held only when no wallet of this sign-in signs there', async () => {
    // signed in with an EVM wallet alone, on a stored Solana chain: nothing of Solana was asked
    api({ person: onSolana, portfolio: () => json(portfolioOf(robinhoodChain())) });
    signIn(METAMASK);
    const none = await screen();
    expect(none.querySelectorAll('[data-ui="vault"]')).toHaveLength(1);
    expect(find(none, '[data-ui="chains-out"] [data-chain="solana"]').textContent).toBe(
      en.portfolio.notHeld('Solana'),
    );
    await unmountAll();
    // with a Solana wallet, as the bar shows, it is not "not held": the server left it out this time
    api({ person: onSolana, portfolio: () => json(portfolioOf(robinhoodChain())) });
    signIn();
    const held = await screen();
    expect(held.textContent).not.toContain(en.portfolio.notHeld('Solana'));
    expect(find(held, '[data-ui="chains-out"] [data-chain="solana"]').textContent).toBe(
      en.portfolio.chainOut('Solana'),
    );
    expect(held.textContent).toContain(en.portfolio.again);
  });

  it('follows the bar: on a chain with no vault, says so first, then what another chain holds', async () => {
    // on Solana, read and empty; the vault is on Robinhood Chain
    api({ person: onSolana, portfolio: () => json(portfolioOf(chainOf([]), robinhoodChain())) });
    signIn();
    const host = await screen();
    expect(find(host, '[data-ui="none-here"]').textContent).toContain(en.portfolio.empty('Solana'));
    // what is held is under its own chain's heading, never under "Chain: Solana"
    const groups = [...host.querySelectorAll('[data-ui="chain-group"]')];
    expect(groups.map((g) => g.getAttribute('data-chain'))).toEqual(['robinhood']);
    expect(host.querySelector('header [data-ui="chain-name"]')).toBeNull();
    // one chain holds vaults: nothing is added "across" chains
    expect(host.querySelector('[data-ui="across-chains"]')).toBeNull();
    // the empty line comes before the group
    expect(
      find(host, '[data-ui="none-here"]').compareDocumentPosition(groups[0] as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('groups in Portuguese too, with the label that says it adds the chains up', async () => {
    api({ person: onSolana, portfolio: () => json(portfolioOf(chainOf(), robinhoodChain())) });
    signIn();
    const host = await screen('pt');
    const pt = dictionary('pt');
    expect(find(host, '[data-ui="across-chains"]').textContent).toContain(
      pt.portfolio.group.across(2),
    );
    expect(host.querySelectorAll('[data-ui="chain-group"]')).toHaveLength(2);
  });
});

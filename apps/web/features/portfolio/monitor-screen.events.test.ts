// @vitest-environment happy-dom
import { DISCLAIMER, DISCLAIMER_SHORT } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { keepOrder, type OrderRecord } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import { doneOrder, ORDER_ID, orderOn, PLAN_ID, planOn, recordOf } from '../order/test/fixtures';
import { EMBEDDED, fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { MonitorScreen } from './MonitorScreen';
import { PORTFOLIO_PATH } from './portfolio';
import { chainOf, labelled, portfolioBody, SECOND_VAULT, VAULT, vault } from './test/portfolio';

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
    expect(text(host)).toContain('0.12%');
    expect(text(host)).toContain(words.observed('Oct 5, 2026, 14:00 UTC'));
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
      ['USDY', '600', '63.46%', '60.00%', '+3.46%'],
      ['PAXG', '0.05', '12.50%', '15.00%', '−2.50%'],
    ]);
    expect(rows[0]?.[2]).toContain('$1.10');
    expect(rows[0]?.[3]).toContain('$660.00');
    expect(rows[1]?.[2]).toContain('$2,600.00');
  });

  it('puts a pin on every price and value, and none on a count, a share or an amount (rule 1)', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const table = find(host, 'table');
    // two holdings: a price and a value each, in the table
    expect(table.querySelectorAll('[data-ui="figure"]')).toHaveLength(4);
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

  it('draws a test network as the hatch and MOCK, with the words, never as live (rule 2)', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const card = panel(host);
    expect(card.querySelector('.tf-hatch')).not.toBeNull();
    expect(card.querySelector('[data-ui="mock-plate"]')?.textContent).toContain('MOCK');
    expect(find(card, '[data-ui="mock-note"]').textContent).toBe(en.shell.testNetwork);
    // the chain line says it too
    expect(find(host, 'header [data-ui="chain-name"]').textContent).toContain(en.shell.testNetwork);
    // no figure is drawn live
    expect(pins(host).map((pin) => pin.getAttribute('data-state'))).not.toContain('live');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('draws a live vault with live pins and no plate, and the same vault on the mock with MOCK alone', async () => {
    api({ person: onSolana, portfolio: () => json(portfolioBody(labelled('live'))) });
    signIn(PHANTOM, 'live');
    const live = await screen();
    expect(live.querySelector('[data-ui="mock-plate"]')).toBeNull();
    expect(live.querySelector('.tf-hatch')).toBeNull();
    expect(new Set(pins(live).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['live']),
    );
    await unmountAll();
    api({ person: onSolana, portfolio: () => json(portfolioBody(labelled('mock'))) });
    signIn(PHANTOM, 'mock');
    const mocked = await screen();
    const card = panel(mocked);
    expect(card.querySelector('[data-ui="mock-plate"]')).not.toBeNull();
    expect(card.querySelector('[data-ui="mock-note"]')).toBeNull();
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
    expect(text(host)).toContain(en.portfolio.vault.pending(2, 'Oct 6, 2026, 15:20 UTC'));
    expect(text(host)).toContain(en.portfolio.vault.pendingAssets('SPYX'));
    expect(text(host)).toContain(en.portfolio.vault.unpriced(1));
    expect(text(host)).toContain(en.portfolio.vault.noPrice);
  });

  it('draws its parts as his case does: a bar by weight, each part with its weight and target', async () => {
    api({ person: onSolana });
    signIn();
    const host = await screen();
    const parts = find(host, '[data-ui="vault-parts"]');
    const items = [...parts.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual([
      `USDY63.46%${en.portfolio.vault.target('60.00%')}`,
      `PAXG12.50%${en.portfolio.vault.target('15.00%')}`,
    ]);
    // the chips state the vault's facts, and the foot has the short disclaimer
    const chips = find(host, `ul[aria-label="${en.portfolio.vault.chips.label}"]`).textContent;
    expect(chips).toContain('version: 1');
    expect(chips).toContain('auto-follow: on');
    expect(host.textContent).toContain(DISCLAIMER_SHORT);
  });

  it('says a vault of cash alone in words, with no empty table', async () => {
    api({
      person: onSolana,
      portfolio: () => json(portfolioBody(chainOf([vault({ positions: [], valueUsd: '250' })]))),
    });
    signIn();
    const host = await screen();
    expect(host.querySelector('table')).toBeNull();
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

  it('leads a person with no chain yet to where it is chosen, and asks the API nothing', async () => {
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
    expect(text(host)).toContain(en.portfolio.noChain);
    expect(find(host, 'a').getAttribute('href')).toBe('/sign-in?next=/monitor');
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
      `${en.portfolio.goalCard.noStatus} · October 2029`,
    );
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
    expect(titles).toContain(en.portfolio.vault.planTitle(2));
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

  it('says no status when what went in is not the amount the plan was built for', async () => {
    api({ person: onSolana, portfolio: () => income(50), more: orders(true) });
    signIn();
    const host = await screen();
    await settle();
    const card = find(host, '[data-ui="goal-card"]');
    expect(card.querySelector('[data-ui="status"]')).toBeNull();
    expect(card.textContent).toContain(en.portfolio.goalCard.noStatus);
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
    for (const line of lines)
      expect(line.querySelector('a[href^="https://explorer.example/tx/"]')).not.toBeNull();
    expect(find(activity, '[data-ui="disclaimer"] p[lang]').textContent).toBe(DISCLAIMER.en);
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
    expect(text(host)).toContain('−2,50%');
    expect(find(panel(host), '[data-ui="mock-note"]').textContent).toBe(pt.shell.testNetwork);
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

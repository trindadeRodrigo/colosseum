// @vitest-environment happy-dom
import type { Provenance } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { HISTORY_PATH, PLANS_PATH, type PlansAnswer } from './api';
import { OverviewPage, vaultHref } from './OverviewPage';
import { flowsOf, vaultPeriods } from './overview-series';
import { serve } from './test/api';
import {
  history,
  plans,
  RH_EMPTY,
  RH_SILENT,
  SOL_GROW,
  SOL_INCOME,
  SOL_NEVER,
  SOL_STALE,
  SOL_UNPRICED,
} from './test/fixtures';
import { inFrame, inSection } from './test/screen';
import { vaultTitle } from './vault-title';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The overview as a board, with real events, on the sample answers: what the vaults are worth
// together, how many there are, what went in and what they made, all time and over the period, each
// with its pin; the chart of that value as a line or as stacks, over a period the person picks; and a
// row a vault that opens the vault's own page. Figures of two kinds are never added: the sample's
// Solana vaults are on a test network and its Robinhood ones on the mock, so the sums hold Solana's
// and the page says Robinhood's are left out. Where the API cannot say, a sentence says why.

const en = portfolioDictionary('en');
const t = dictionary('en');
const DAY = 86_400_000;

const overview = async (lang: Lang = 'en') => {
  const host = await mount(inSection(lang, createElement(OverviewPage)));
  await settle();
  await settle();
  return host;
};
const signIn = () => portStore.set(signedInPort(EMBEDDED));
const rows = (host: HTMLElement) => [...host.querySelectorAll('[data-ui="overview-vault"]')];
const row = (host: HTMLElement, address: string) =>
  find(host, `[data-ui="overview-vault"][data-address="${address}"]`);
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-ui="figure"]')];
const text = (el: Element) => el.textContent ?? '';
const part = (root: Element, ui: string) => text(find(root, `[data-ui="${ui}"]`));
const board = (host: HTMLElement, label = en.overview.board.total) =>
  find(host, `section[aria-label="${label}"]`);
const query = (call: string) => new URL(call, 'http://api.test').searchParams;
/** A chart mode, by its name: the chosen one shows its word, the others their icon alone. */
const show = async (host: HTMLElement, label: string) => {
  await click(find(host, `[data-ui="chart-modes"] button[aria-label="${label}"]`));
  await settle();
  await settle();
};
/** A period, from its drop-down. */
const choose = async (host: HTMLElement, period: string) => {
  const select = find<HTMLSelectElement>(host, 'select[data-ui="period"]');
  select.value = period;
  await fire(select, new Event('change', { bubbles: true }));
  await settle();
  await settle();
};

/** The sample plans with every label set to `provenance`. */
function labelled(provenance: Provenance): PlansAnswer {
  const answer = plans();
  return {
    ...answer,
    chains: answer.chains.map((chain) => ({
      ...chain,
      provenance,
      plans: chain.plans.map((plan) => ({
        ...plan,
        provenance,
        putIn: plan.putIn && { ...plan.putIn, provenance },
        newest: plan.newest && {
          ...plan.newest,
          provenance,
          prices: plan.newest.prices.map((price) => ({ ...price, provenance })),
        },
      })),
    })),
  };
}

const WITHDRAWAL = {
  withdrawals: [
    {
      orderId: '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d',
      createdAt: '2026-10-06T10:00:00.000Z',
      chain: 'solana',
      vault: SOL_GROW,
      status: 'done',
      steps: [
        {
          legId: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
          status: 'confirmed',
          txId: null,
          explorerUrl: null,
          at: '2026-10-06T10:05:00.000Z',
          provenance: 'sandbox',
          withdrawals: [
            {
              asset: 'solana:usdc',
              amountRaw: '100000000',
              heldRaw: '900000000',
              valued: {
                usd: '100',
                source: 'reader',
                fetchedAt: '2026-10-06T10:00:00.000Z',
                method: 'reference price',
                provenance: 'sandbox',
              },
            },
          ],
        },
      ],
    },
  ],
  next: null,
};

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio';
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the board', () => {
  it('adds up the vaults of one kind: the value, the count, what went in and what they made', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    expect(server.to(PLANS_PATH)).toHaveLength(1);
    const top = board(host);
    // Solana's four vaults that were read: 2,051.37 + 81,243.55 + 500.28 + 251.90
    expect(part(top, 'board-total')).toContain('$84,047.10');
    // five vaults on Solana, the one never read among them
    expect(text(find(top, '[data-ui="board-vaults"] dd'))).toBe('5');
    // what went into the four that were read: 2,000 + 80,000 + 500 + 250
    expect(part(top, 'board-net-in')).toContain('$82,750.00');
    expect(part(top, 'board-all-time')).toContain('+$1,297.10');
    expect(find(top, '[data-ui="board-all-time"] [data-ui="figure"]').className).toContain(
      'text-success',
    );
    // the mock's vaults are not added in, and the page says so
    expect(text(top)).toContain(en.overview.board.leftOut('sample chain'));
  });

  it('says what the period made or lost, from the history, with the vaults gaining', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const top = board(host);
    const { flows } = flowsOf(plans(), []);
    const each = vaultPeriods(history(), flows, new Set(['solana']));
    expect(each.length).toBeGreaterThan(0);
    const pnl = each.reduce((sum, v) => sum + v.pnlUsd, 0);
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
      Math.abs(pnl),
    );
    expect(part(top, 'board-pnl')).toContain(`${pnl >= 0 ? '+' : '−'}${money}`);
    expect(text(find(top, '[data-ui="board-gaining"] dd'))).toBe(
      `${each.filter((v) => v.pnlUsd >= 0).length} / ${each.length}`,
    );
    // the period it is for is said beside it
    expect(text(top)).toContain('30D');
  });

  it('takes a confirmed withdrawal off what went in, at its value when ordered', async () => {
    serve(portStore, {
      more: (path) => (path.startsWith('/v1/me/withdrawals') ? json(WITHDRAWAL) : null),
    });
    signIn();
    const host = await overview();
    expect(part(board(host), 'board-net-in')).toContain('$82,650.00');
    expect(part(board(host), 'board-all-time')).toContain('+$1,397.10');
    expect(part(row(host, SOL_GROW), 'vault-net-in')).toContain('$1,900.00');
    expect(part(row(host, SOL_GROW), 'vault-all-time')).toContain('+$151.37');
  });

  it('puts a pin on every amount of money on the page (rule 1)', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const page = find(host, '[data-ui="portfolio-overview"]');
    expect(pins(page).length).toBeGreaterThan(0);
    for (const figure of pins(page)) {
      expect(figure.getAttribute('data-state')).not.toBe('missing');
      expect(figure.querySelector('button[data-ui="pin"]')?.getAttribute('aria-label')).toMatch(
        /^Source for [+−]?\$/,
      );
    }
    // outside the figures and the vaults' names, which may be a goal, no amount is written
    const copy = page.cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll(
      '[data-ui="figure"], [data-ui="vault-sentence"], [data-ui="plan-note"], [data-ui="board-best"] span, [data-ui="chart-legend"], svg',
    ))
      el.remove();
    expect(text(copy)).not.toMatch(/\$\s?\d/);
  });

  it('draws a test network and the mock as the hatch, never as live (rule 2), and live as live', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['mock']),
    );
    // no hatch down the board's edge: its plate says it in words, and its figures keep their pins
    expect(board(host).querySelector('[data-ui="hatch-band"]')).toBeNull();
    expect(part(board(host), 'board-plate')).toBe(t.shell.testNetworkLine);
    expect(text(host)).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    await unmountAll();

    serve(portStore, { plans: () => json(labelled('live')) });
    signIn();
    const live = await overview();
    expect(board(live).querySelector('[data-ui="board-plate"]')).toBeNull();
    for (const pin of pins(row(live, SOL_GROW)))
      expect(pin.getAttribute('data-state')).toBe('live');
    // every vault live: nothing is left out of the sums
    expect(text(board(live))).not.toContain(en.overview.board.leftOut('sample chain'));
    expect(part(board(live), 'board-total')).toContain('$84,088.60');
  });
});

describe('the chart', () => {
  it('opens on the line over 30 days, asking the history by the hour', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    const asked = server.to(HISTORY_PATH);
    expect(asked).toHaveLength(1);
    const q = query(asked[0] as string);
    expect(q.get('step')).toBe('1h');
    expect(Date.parse(q.get('to') ?? '') - Date.parse(q.get('from') ?? '')).toBe(30 * DAY);
    expect(find(host, '[data-ui="overview-chart"]').getAttribute('data-kind')).toBe('line');
    // the period is a drop-down, 30D chosen
    const period = find<HTMLSelectElement>(host, 'select[data-ui="period"]');
    expect(period.closest('label')?.textContent).toContain(en.overview.board.chart.period);
    expect(period.value).toBe('30d');
    expect([...period.options].map((o) => o.textContent)).toEqual([
      '1D',
      '7D',
      '30D',
      '1Y',
      'This year',
      'All',
    ]);
    // the modes: the chosen one a pill with its word, the others their icon alone, each named
    const modes = [...find(host, '[data-ui="chart-modes"]').querySelectorAll('button')];
    expect(
      modes.map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed'), text(b)]),
    ).toEqual([
      [en.overview.board.chart.line, 'true', en.overview.board.chart.line],
      [en.overview.board.chart.byVault, 'false', ''],
      [en.overview.board.chart.byAsset, 'false', ''],
    ]);
    // nothing is written over the chart until it is pointed at
    expect(host.querySelector('[data-ui="chart-tooltip"]')).toBeNull();
    expect(
      host.querySelectorAll('[data-ui="line-up"], [data-ui="line-down"]').length,
    ).toBeGreaterThan(0);
  });

  it('says a point only when the chart is pointed at, in a tooltip with its pins', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const plot = find(host, '[data-ui="overview-chart"] [data-ui="case-plot"]');
    await fire(plot, new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const tip = find(host, '[data-ui="chart-tooltip"]');
    expect(tip.getAttribute('aria-live')).toBe('polite');
    expect(pins(tip).length).toBe(2);
    await fire(plot, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.querySelector('[data-ui="chart-tooltip"]')).toBeNull();
  });

  it('draws a vault read once as a flat line at its value, not an empty chart', async () => {
    const one = history();
    for (const chain of one.chains)
      for (const series of chain.vaults) series.points = series.points.slice(-1);
    // one reading of one vault: the newest of the plan to grow
    one.chains = one.chains.map((chain) => ({
      ...chain,
      vaults: chain.vaults.filter((series) => series.address === SOL_GROW),
    }));
    serve(portStore, { history: () => json(one) });
    signIn();
    const host = await overview();
    const chart = find(host, '[data-ui="overview-chart"]');
    expect(chart.getAttribute('data-kind')).toBe('line');
    expect(chart.querySelectorAll('[data-ui="line-up"], [data-ui="line-down"]')).toHaveLength(1);
    expect(text(host)).not.toContain(en.overview.board.chart.empty);
  });

  it('asks the window a period names', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    await choose(host, '7d');
    const week = query(server.to(HISTORY_PATH).at(-1) as string);
    expect(week.get('step')).toBe('1h');
    expect(Date.parse(week.get('to') ?? '') - Date.parse(week.get('from') ?? '')).toBe(7 * DAY);
    await choose(host, '1d');
    expect(query(server.to(HISTORY_PATH).at(-1) as string).get('step')).toBe('10m');
    await choose(host, 'ytd');
    const ytd = query(server.to(HISTORY_PATH).at(-1) as string);
    expect(ytd.get('step')).toBe('1d');
    expect(ytd.get('from')).toBe(`${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`);
  });

  it('stacks the value by vault and by asset, a bar a day', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    await show(host, en.overview.board.chart.byVault);
    expect(query(server.to(HISTORY_PATH).at(-1) as string).get('step')).toBe('1d');
    const chart = find(host, '[data-ui="overview-chart"]');
    expect(chart.getAttribute('data-kind')).toBe('bars');
    expect(chart.querySelectorAll('[data-ui="overview-bar"]').length).toBeGreaterThan(0);
    // the legend names the vaults as the table does, and no mock vault is stacked with them
    const legend = text(find(chart, '[data-ui="chart-legend"]'));
    const grow = plans().chains[0]?.plans.find((p) => p.address === SOL_GROW);
    if (!grow) throw new Error('no grow plan');
    expect(legend).toContain(
      vaultTitle(grow, { t, words: en.overview.card, lang: 'en', chainName: 'Solana' }).sentence,
    );
    expect(legend).not.toContain('Robinhood');
    await show(host, en.overview.board.chart.byAsset);
    expect(text(find(host, '[data-ui="chart-legend"]'))).toContain(en.overview.board.chart.cash);
  });
});

describe('the table of vaults', () => {
  it('has a row a vault, named as the vault is everywhere, each opening the vault’s own page', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    expect(rows(host).map((r) => r.getAttribute('data-address'))).toEqual([
      SOL_GROW,
      SOL_INCOME,
      SOL_UNPRICED,
      SOL_STALE,
      SOL_NEVER,
      RH_SILENT,
      RH_EMPTY,
    ]);
    expect(rows(host).map((r) => part(r, 'vault-sentence'))).toEqual([
      'Grow $2,000 over 36 months.',
      'Earn income from $80,000 for 60 months.',
      'Protect $500 for 18 months.',
      'Your vault follows Steady dollars.',
      'Rainy day',
      'Your vault was opened to follow US stocks.',
      'Your vault on Robinhood Chain.',
    ]);
    for (const r of rows(host))
      expect(find(r, 'a').getAttribute('href')).toBe(
        vaultHref(r.getAttribute('data-chain') as string, r.getAttribute('data-address') as string),
      );
    // nothing on the page signs or moves money
    expect(text(host)).not.toMatch(/\bsign\b|withdraw|rebalance now/i);
  });

  it('shows no value for a vault never read, and each status as the server says it', async () => {
    serve(portStore);
    signIn();
    const host = await overview();
    const never = row(host, SOL_NEVER);
    expect(text(never)).toContain(en.overview.table.neverRead);
    expect(pins(never)).toEqual([]);
    expect(part(row(host, SOL_GROW), 'status')).toBe(en.status.words.on_track);
    expect(part(row(host, SOL_INCOME), 'status')).toBe(en.status.words.watch);
  });

  it('offers a new plan in orange, and reads again on request', async () => {
    const server = serve(portStore);
    signIn();
    const host = await overview();
    const fresh = find(host, '[data-ui="new-plan"]');
    expect(fresh.getAttribute('href')).toBe('/goal');
    expect(fresh.className).toContain('text-warning');
    await click(find(host, '[data-action="read-again"]'));
    await settle();
    expect(server.to(PLANS_PATH)).toHaveLength(2);
    expect(rows(host)).toHaveLength(7);
  });
});

describe('the overview, when there is nothing to read or the API cannot say', () => {
  it('asks someone signed out to sign in, and shows no figure', async () => {
    const server = serve(portStore);
    const host = await overview();
    expect(server.to(PLANS_PATH)).toEqual([]);
    expect(text(host)).toContain(en.shell.signedOut);
    expect(find(host, 'a').getAttribute('href')).toBe('/sign-in?next=/portfolio');
    expect(pins(host)).toEqual([]);
  });

  it('says an empty portfolio in a sentence, and leads back to the goal', async () => {
    const answer = plans();
    serve(portStore, {
      plans: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({ ...chain, plans: [] })),
          unavailable: [],
        }),
    });
    signIn();
    const host = await overview();
    expect(text(host)).toContain(en.shell.empty);
    expect(find(host, 'a[href="/goal"]').textContent).toBe(en.shell.startGoal);
    expect(rows(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
  });

  it('never says there is no plan while a chain of theirs could not be read', async () => {
    const answer = plans();
    serve(portStore, {
      plans: () => json({ ...answer, chains: answer.chains.map((c) => ({ ...c, plans: [] })) }),
    });
    signIn();
    const host = await overview();
    expect(text(find(host, '[data-ui="chains-out"]'))).toBe(t.portfolio.chainOff('Base'));
    expect(text(host)).not.toContain(en.shell.empty);
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => Promise.reject(new TypeError('fetch failed')), en.shell.failure.unreachable],
    [() => json({ chains: 'nope' }), en.shell.failure.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.shell.failure.signedOut],
  ])('says a failed read in its own sentence, and draws no row: %#', async (answer, sentence) => {
    serve(portStore, { plans: answer });
    signIn();
    const host = await overview();
    expect(text(host)).toContain(sentence);
    expect(rows(host)).toEqual([]);
    expect(pins(host)).toEqual([]);
  });

  it('keeps the board when the history cannot be read, and says so where the chart is', async () => {
    serve(portStore, { history: () => Promise.reject(new TypeError('fetch failed')) });
    signIn();
    const host = await overview();
    expect(part(board(host), 'board-total')).toContain('$84,047.10');
    expect(text(board(host))).toContain(en.shell.failure.unreachable);
    expect(rows(host)).toHaveLength(7);
  });
});

describe('the overview in Portuguese', () => {
  it('says the board and the table in Portuguese, and the figures the Brazilian way', async () => {
    const pt = portfolioDictionary('pt');
    const plain = (value: string) => value.replace(/[  ]/g, ' ');
    serve(portStore);
    signIn();
    const host = await overview('pt');
    const top = board(host, pt.overview.board.total);
    expect(plain(part(top, 'board-total'))).toContain('US$ 84.047,10');
    expect(plain(part(row(host, SOL_GROW), 'vault-sentence'))).toBe(
      'Fazer US$ 2.000 crescer em 36 meses.',
    );
    expect(text(host)).toContain(pt.overview.table.heading);
    expect(text(host)).toContain(pt.overview.board.leftOut('rede de exemplo'));
    for (const english of [
      en.overview.board.total,
      en.overview.table.heading,
      en.overview.table.newPlan,
    ])
      expect(text(host)).not.toContain(english);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('the overview inside the section’s frame', () => {
  it('sits under the menu with the overview current, and the disclaimer once under it', async () => {
    serve(portStore);
    signIn();
    const host = await mount(inFrame('en', createElement(OverviewPage)));
    await settle();
    await settle();
    expect(find(host, '#portfolio-nav [aria-current="page"]').getAttribute('href')).toBe(
      '/portfolio',
    );
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    expect(rows(host)).toHaveLength(7);
  });
});

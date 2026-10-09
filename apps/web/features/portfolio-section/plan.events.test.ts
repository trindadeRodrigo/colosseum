// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  PortfolioExposureResponse,
  PortfolioHistoryQuery,
  type Provenance,
} from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEB } from '../../components/ui/test/css';
import {
  click,
  find,
  mount,
  pinLine,
  press,
  settle,
  unmountAll,
} from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { doneOrder } from '../order/test/fixtures';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import {
  EXPOSURE_PATH,
  type ExposureAnswer,
  HISTORY_PATH,
  type HistoryAnswer,
  PLANS_PATH,
  type PlansAnswer,
  REBALANCES_PATH,
} from './api';
import { narrowExposure } from './fixtures/narrow';
import { EXPOSURE_BY_PLAN } from './fixtures/plan';
import { OverviewPage, vaultHref } from './OverviewPage';
import { PlanPage } from './PlanPage';
import { planHref } from './pages';
import { held, type Served, serve } from './test/api';
import {
  EXPOSURE_OF_NOTHING,
  history,
  NOW,
  ORDER_GROW,
  ORDER_INCOME_2,
  planAt,
  plans,
  RH_EMPTY,
  RH_SILENT,
  rebalances,
  SHEET_GROW,
  SHEET_INCOME,
  SOL_GROW,
  SOL_INCOME,
  SOL_NEVER,
  SOL_STALE,
  SOL_UNPRICED,
} from './test/fixtures';
import { inFrame, inSection } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// A plan's own page with real events, on the sample answers: the goal first as its card says it, the
// head, the value over time with the deposits marked, each part against its target with the band,
// what leaving would cost, where the risk sits, the latest trades and the person's own steps. Every
// figure has its pin, nothing that is not live is drawn as live, a window the route would refuse is
// never asked, and where the API cannot say, a sentence says so and no figure is drawn.

const en = portfolioDictionary('en');
const t = dictionary('en');

const text = (el: Element) => el.textContent ?? '';
const part = (root: ParentNode, ui: string) => text(find(root, `[data-ui="${ui}"]`));
const block = (host: ParentNode, ui: string) => find(host, `[data-ui="${ui}"]`);
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-ui="figure"]')];
const signIn = () => portStore.set(signedInPort(EMBEDDED));
const queryOf = (path: string) => new URL(path, 'http://api.test').searchParams;

/** The exposure of one vault alone, narrowed to the chain that was asked for, as the route answers. */
const exposureOf = (address: string, chain?: string) =>
  PortfolioExposureResponse.parse(
    narrowExposure(EXPOSURE_BY_PLAN[address] ?? EXPOSURE_OF_NOTHING, { chain }),
  );

/**
 * The API of these tests: the section's sample answers, and for a vault's own exposure the one made
 * for that vault (fixtures/plan.ts), unless the test hands an answer of its own.
 */
function api(over: Served = {}) {
  return serve(portStore, {
    ...over,
    more: (path) => {
      const other = over.more?.(path);
      if (other) return other;
      const url = new URL(path, 'http://api.test');
      const address = url.searchParams.get('address');
      if (url.pathname === EXPOSURE_PATH && address && !over.exposure)
        return json(exposureOf(address, url.searchParams.get('chain') ?? undefined));
      return null;
    },
  });
}

async function open(chain: string, address: string, lang: Lang = 'en') {
  location.pathname = `/portfolio/plan/${chain}/${address}`;
  const host = await mount(inSection(lang, createElement(PlanPage, { chain, address })));
  await settle();
  await settle();
  return host;
}

/** The pin of a figure, opened to its details: the line the API wrote. */
const sourceOf = (figure: Element): Promise<string> => pinLine(figure);

/** The rows of the parts' table, as text, cell by cell. */
const rows = (host: ParentNode) =>
  [...find(block(host, 'plan-parts'), 'table').querySelectorAll('tbody tr')].map((tr) =>
    [...tr.querySelectorAll('th, td')].map((cell) => text(cell).trim()),
  );

/** Every label of the sample plans set to `provenance`. */
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
const liveHistory = (q: { chain?: string; address?: string }): HistoryAnswer => {
  const answer = history(q);
  return { ...answer, chains: answer.chains.map((c) => ({ ...c, provenance: 'live' })) };
};
const liveExposure = (address: string, chain?: string): ExposureAnswer => {
  const answer = exposureOf(address, chain);
  return { ...answer, chains: answer.chains.map((c) => ({ ...c, provenance: 'live' })) };
};
/** A server whose every label is live. */
const liveApi = () =>
  serve(portStore, {
    plans: () => json(labelled('live')),
    more: (path) => {
      const url = new URL(path, 'http://api.test');
      const q = {
        chain: url.searchParams.get('chain') ?? undefined,
        address: url.searchParams.get('address') ?? undefined,
      };
      if (url.pathname === HISTORY_PATH) return json(liveHistory(q));
      if (url.pathname === EXPOSURE_PATH && q.address)
        return json(liveExposure(q.address, q.chain));
      return null;
    },
  });

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  portStore.set(fakePort());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await unmountAll();
});

describe('a plan’s page, for a plan made to measure with two deposits', () => {
  it('asks for the vault’s own history and exposure once each, by the chain and address the server answered', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
    const server = api();
    signIn();
    await open('solana', SOL_INCOME);
    expect(server.to(PLANS_PATH)).toHaveLength(1);
    const asked = server.to(HISTORY_PATH);
    expect(asked).toHaveLength(1);
    expect(Object.fromEntries(queryOf(asked[0] as string))).toEqual({
      chain: 'solana',
      address: SOL_INCOME,
      from: '2026-09-30T12:00:00.000Z',
      to: NOW,
      step: '1h',
    });
    const own = server.to(EXPOSURE_PATH).filter((path) => queryOf(path).has('address'));
    expect(own).toEqual([`${EXPOSURE_PATH}?chain=solana&address=${SOL_INCOME}`]);
    // the trades are the section's read, narrowed on the page: not asked again
    expect(server.to(REBALANCES_PATH)).toHaveLength(1);
  });

  it('says the goal first, in the page’s one serif line, with the way back over it', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const page = block(host, 'portfolio-plan');
    expect(text(find(page, 'h1'))).toBe('Earn income from $80,000 for 60 months.');
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').tagName).toBe('H1');
    expect(part(page, 'plan-note')).toBe('Rent fund');
    const back = find(page, '[data-ui="plan-back"]');
    expect([text(back), back.getAttribute('href')]).toEqual([en.plan.back, '/portfolio']);
    // the blocks, in their order
    expect(
      [...block(host, 'plan-blocks').children].map((el) => el.getAttribute('data-ui')),
    ).toEqual([
      'card',
      'plan-history',
      'plan-parts',
      'plan-exit',
      'plan-risk',
      'plan-trades',
      'plan-refresh',
      'plan-activity',
    ]);
    expect(
      [...host.querySelectorAll('[data-ui="plan-blocks"] > section > header h2')].map(text),
    ).toEqual([
      en.plan.history.heading,
      en.plan.parts.heading,
      en.plan.exit.heading,
      en.plan.risk.heading,
      en.plan.trades.heading,
    ]);
    // nothing on the page signs
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(text(host)).not.toMatch(/\bsign\b|withdraw|rebalance now/i);
  });

  it('states where the plan stands as the server says: the status, its reason, the rule, the two figures, the read', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const head = block(host, 'plan-head');
    const status = find(head, '[data-ui="status"]');
    expect([status.getAttribute('data-status'), text(status)]).toEqual(['watch', 'Watch']);
    expect(status.querySelector('svg[data-ui="status-mark"]')).not.toBeNull();
    expect(part(head, 'chain-badge')).toBe('Solana');
    expect(part(head, 'plan-reason')).toBe(
      'USDY (Ondo) is 3.5% over its planned share, more than the 2% it may drift.',
    );
    expect(part(head, 'plan-rule')).toBe('Rule ON-TRACK-V1');
    expect(text(host)).not.toContain(planAt(SOL_INCOME).plan.status.text);
    expect(
      [...find(head, '[data-ui="plan-figures"]').querySelectorAll('dt, dd')].map((el) =>
        text(el).trim(),
      ),
    ).toEqual([en.overview.card.value, '$81,243.55', en.overview.card.putIn, '$80,000.00']);
    const [value, putIn] = pins(head);
    const { newest, putIn: put } = planAt(SOL_INCOME).plan;
    expect(await sourceOf(value as Element)).toContain(
      `${newest?.source} · 2026-10-07T11:56:02Z · ${newest?.method}`,
    );
    expect(await sourceOf(putIn as Element)).toContain(
      `${put?.source} · 2026-10-07T12:00:00Z · ${put?.method}`,
    );
    expect(text(find(head, '[data-ui="plan-read"] > span:first-child'))).toBe(
      'Read 4 minutes ago, on Oct 7, 2026, 11:56 UTC.',
    );
    expect(head.querySelector('[data-ui="stale-plate"]')).toBeNull();
    // a test network: the hatch and the one quiet line
    const card = head.closest('[data-ui="card"]') as Element;
    expect(card.getAttribute('aria-label')).toBe(en.plan.head.label);
    expect(card.querySelector('[data-ui="hatch-band"]')).not.toBeNull();
    expect(part(card, 'sample-note')).toBe(t.shell.testNetworkLine);
  });

  it('draws the value over time as one solid line, named for a screen reader, with one pinned figure', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const chart = block(host, 'plan-value-chart');
    const line = find(chart, 'polyline[data-ui="value-line"]');
    expect((line.getAttribute('points') ?? '').split(' ')).toHaveLength(7);
    // measured, so solid: nothing of the line is dashed
    expect(line.hasAttribute('stroke-dasharray')).toBe(false);
    expect(chart.querySelectorAll('[data-ui="value-point"]')).toHaveLength(7);
    expect(find(chart, '[data-ui="case-plot"] svg').getAttribute('aria-hidden')).toBe('true');
    const plot = find(chart, '[data-ui="case-plot"]');
    expect([plot.getAttribute('role'), plot.getAttribute('tabindex')]).toEqual(['img', '0']);
    expect(plot.getAttribute('aria-label')).toBe(
      'This vault’s value from Sep 30, 2026, 12:00 UTC to Oct 7, 2026, 12:00 UTC, one point for each snapshot kept.',
    );
    // the figure's one pin: the newest point, on the series' source and method and the chain's label
    const readout = find(chart, '[data-ui="chart-readout"]');
    expect(readout.getAttribute('aria-live')).toBe('polite');
    expect(text(readout)).toContain('Newest snapshot · Oct 7, 2026, 11:56 UTC');
    expect(pins(readout)).toHaveLength(1);
    expect(pins(chart)).toHaveLength(1);
    const [figure] = pins(readout);
    expect(text(figure as Element).trim()).toBe('$81,243.55');
    expect(figure?.getAttribute('data-state')).toBe('mock');
    const series = history({ address: SOL_INCOME }).chains[0]?.vaults[0];
    const said = await sourceOf(figure as Element);
    expect(said).toContain(`${series?.source} · 2026-10-07T11:56:02Z · ${series?.method}`);
    expect(text(find(figure as Element, '[data-ui="pin-popover"]'))).toContain(t.pin.kinds.sandbox);
    expect(text(chart)).toContain(en.plan.history.hint);
    expect(text(chart)).toContain(en.plan.history.legend.value);
  });

  it('reads a point out with its own stamp when the arrow keys step to it', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_GROW);
    const chart = block(host, 'plan-value-chart');
    const plot = find(chart, '[data-ui="case-plot"]');
    const readout = find(chart, '[data-ui="chart-readout"]');
    await press(plot, 'ArrowLeft');
    expect(text(readout)).toContain('Oct 6, 2026, 23:50 UTC');
    expect(text(readout)).not.toContain(en.plan.history.newest);
    expect(text(find(readout, '[data-ui="figure"]')).trim()).toBe('$2,044.10');
    expect(chart.querySelector('[data-ui="chart-cross"]')).not.toBeNull();
    // a point read through another node says so: its own source, not the series'
    await press(plot, 'Home');
    await press(plot, 'ArrowRight');
    expect(text(readout)).toContain('Oct 4, 2026, 23:50 UTC');
    const said = await sourceOf(find(readout, '[data-ui="figure"]'));
    expect(said).toContain('on its second node · 2026-10-04T23:50:00Z');
    expect(pins(chart)).toHaveLength(1);
    // the first Escape is the open source's own and closes only that; the next is the chart's
    await press(plot, 'Escape');
    expect(readout.querySelector('[data-ui="pin-popover"]')).toBeNull();
    expect(text(readout)).not.toContain(en.plan.history.newest);
    await press(plot, 'Escape');
    expect(text(readout)).toContain(en.plan.history.newest);
    expect(chart.querySelector('[data-ui="chart-cross"]')).toBeNull();
  });

  it('marks each deposit on the figure at its time, and names it under the figure with its amount pinned', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const chart = block(host, 'plan-value-chart');
    const deposits = planAt(SOL_INCOME).plan.putIn?.deposits ?? [];
    const marks = [...chart.querySelectorAll('[data-ui="deposit-mark"]')];
    expect(marks.map((m) => [m.getAttribute('data-n'), m.getAttribute('data-at')])).toEqual([
      ['1', deposits[0]?.at],
      ['2', deposits[1]?.at],
    ]);
    expect(marks.map((m) => text(find(m, 'text')))).toEqual(['1', '2']);
    // at its time: on the scale the readings themselves are drawn on
    const xs = (find(chart, '[data-ui="value-line"]').getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[0]));
    const times = (history({ address: SOL_INCOME }).chains[0]?.vaults[0]?.points ?? []).map((p) =>
      Date.parse(p.observedAt),
    );
    const per =
      ((xs[1] as number) - (xs[0] as number)) / ((times[1] as number) - (times[0] as number));
    const expected = (at: string) =>
      (xs[0] as number) + (Date.parse(at) - (times[0] as number)) * per;
    marks.forEach((mark, i) => {
      const x = Number(find(mark, 'line').getAttribute('x1'));
      expect(Math.abs(x - expected(deposits[i]?.at as string))).toBeLessThan(0.2);
    });
    // the second fell between two readings: it is marked on the line too; the first came before any
    expect(
      [...chart.querySelectorAll('[data-ui="deposit-on-line"]')].map((r) =>
        r.getAttribute('data-n'),
      ),
    ).toEqual(['2']);
    expect(text(chart)).toContain(en.plan.history.legend.deposit);

    const listed = [...find(host, '[data-ui="history-deposits"]').querySelectorAll('li')];
    expect(find(host, '[data-ui="history-deposits"]').getAttribute('aria-label')).toBe(
      en.plan.history.deposits.label,
    );
    expect(listed.map((li) => text(li).replace(/\s+/g, ' ').trim())).toEqual([
      '1Deposit 1$50,000.00 recorded on Oct 1, 2026, 15:04 UTC',
      '2Deposit 2$30,000.00 recorded on Oct 5, 2026, 09:30 UTC',
    ]);
    const put = planAt(SOL_INCOME).plan.putIn;
    for (const li of listed) expect(pins(li)).toHaveLength(1);
    expect(await sourceOf(find(listed[1] as Element, '[data-ui="figure"]'))).toContain(
      `${put?.source} · 2026-10-07T12:00:00Z · ${put?.method}`,
    );
    expect(text(block(host, 'plan-history'))).toContain(en.plan.history.deposits.note);
    expect(host.querySelector('[data-ui="history-deposits-outside"]')).toBeNull();
  });

  it('says a deposit from before the window is outside it, and marks only those inside', async () => {
    api();
    signIn();
    // the vault that follows a shared portfolio was opened on Sep 28, two days before the window
    const host = await open('solana', SOL_STALE);
    expect(host.querySelector('[data-ui="deposit-mark"]')).toBeNull();
    expect(host.querySelector('[data-ui="history-deposits"]')).toBeNull();
    expect(part(host, 'history-deposits-outside')).toBe(
      '1 deposit of yours falls outside this window.',
    );
  });

  it('sets each part against its target, its value on the pin of the price it stood on', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const parts = block(host, 'plan-parts');
    const table = find(parts, 'table');
    expect(text(find(table, 'caption'))).toBe(en.plan.parts.caption);
    expect([...table.querySelectorAll('thead th')].map(text)).toEqual([
      'Asset',
      'Value',
      'Share now',
      'Planned',
      'Difference',
      en.plan.parts.status,
    ]);
    expect(rows(host)).toEqual([
      ['USDY (Ondo)', '$51,557.00', '63.5%', '60%', '+3.5%', en.plan.parts.outside],
      ['SGOV (iShares)', '$22,836.20', '28.1%', '30%', '−1.9%', ''],
      ['Cash (USDC)', '$6,850.35', '8.4%', '10%', '−1.6%', ''],
    ]);
    const figures = pins(table);
    expect(figures).toHaveLength(3);
    const { newest } = planAt(SOL_INCOME).plan;
    const price = newest?.prices[0];
    expect(await sourceOf(figures[0] as Element)).toContain(
      `${price?.source} · 2026-10-07T11:55:32Z · ${price?.method}`,
    );
    // the cash is counted at one dollar by the snapshot itself: its stamp
    expect(await sourceOf(figures[2] as Element)).toContain(
      `${newest?.source} · 2026-10-07T11:56:02Z · ${newest?.method}`,
    );
    // shares, targets and differences are no priced figures: no pin of their own
    for (const tr of table.querySelectorAll('tbody tr')) expect(pins(tr)).toHaveLength(1);
    // on a phone the same rows stack: each figure is there once more, with its pin
    expect(pins(find(parts, '[data-ui="data-table-stacked"]'))).toHaveLength(3);
  });

  it('draws the band as a shaded range with the part marked on it, and says "outside the band" in words and shape', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const parts = block(host, 'plan-parts');
    expect(text(find(parts, 'header p'))).toBe(
      'A part may sit up to 2% from its planned share before it counts as outside the band. Cash counts only when it is over its share.',
    );
    const table = find(parts, 'table');
    const gauges = [...table.querySelectorAll('svg[data-ui="band-gauge"]')];
    expect(gauges).toHaveLength(3);
    const at = (gauge: Element) => {
      const range = find(gauge, '[data-ui="band-range"]');
      const mark = find(gauge, '[data-ui="band-mark"]');
      const from = Number(range.getAttribute('x'));
      return {
        from,
        to: from + Number(range.getAttribute('width')),
        mark: Number(mark.getAttribute('x')) + 3.5,
      };
    };
    const [usdy, sgov, cash] = gauges.map(at) as [
      ReturnType<typeof at>,
      ReturnType<typeof at>,
      ReturnType<typeof at>,
    ];
    // a range about the planned share, the same for every part
    expect(usdy.to - usdy.from).toBeGreaterThan(10);
    expect([sgov.from, sgov.to]).toEqual([usdy.from, usdy.to]);
    // 3.46% over a band of 2%: past the range; 1.89% under: inside it
    expect(usdy.mark).toBeGreaterThan(usdy.to);
    expect(sgov.mark).toBeGreaterThan(sgov.from);
    expect(sgov.mark).toBeLessThan(48);
    // the cash is held to the band on one side only: its range runs from the left end
    expect(cash.from).toBe(0);
    expect(cash.to).toBe(usdy.to);
    expect(cash.mark).toBeLessThan(cash.to);
    // never a hatch, which means sample or stale and nothing else
    for (const gauge of gauges) expect(gauge.outerHTML).not.toContain('hatch');

    // outside the band: the word, the Watch mark, and only then the tint
    const marked = [...table.querySelectorAll('[data-ui="status"]')];
    expect(marked).toHaveLength(1);
    const [status] = marked as [Element];
    expect([status.getAttribute('data-status'), text(status)]).toEqual([
      'watch',
      'Outside the band',
    ]);
    expect(status.querySelector('svg[data-ui="status-mark"]')).not.toBeNull();
    const tinted = [...table.querySelectorAll('tbody tr')].filter((tr) =>
      tr.className.includes('bg-status-watch-bg'),
    );
    expect(tinted).toEqual([status.closest('tr')]);
    // as the server's own status has it
    expect(planAt(SOL_INCOME).plan.status.line).toBe('outside_band');
  });

  it('marks no part outside a band it is inside, or exactly at', async () => {
    const answer = plans();
    const edge: PlansAnswer = {
      ...answer,
      chains: answer.chains.map((chain) => ({
        ...chain,
        plans: chain.plans.map((plan) =>
          plan.address === SOL_GROW && plan.newest
            ? {
                ...plan,
                newest: {
                  ...plan.newest,
                  positions: plan.newest.positions.map((p, i) =>
                    i === 0 ? { ...p, weightBps: 5200, driftBps: 200 } : p,
                  ),
                },
              }
            : plan,
        ),
      })),
    };
    api({ plans: () => json(edge) });
    signIn();
    const host = await open('solana', SOL_GROW);
    expect(find(block(host, 'plan-parts'), 'table').querySelector('[data-ui="status"]')).toBeNull();
  });

  it('says what leaving would cost: a measured cost on its pin, and no number where the size was not measured', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const exit = block(host, 'plan-exit');
    // said once what the figure is: one asset sold alone at this size, not everything at once
    expect(text(exit).split(en.plan.exit.lead)).toHaveLength(2);
    expect(en.plan.exit.lead).toMatch(/one asset, alone, at the size shown/);
    expect(en.plan.exit.lead).toMatch(/not the cost of selling everything at once/);
    const lines = [...exit.querySelectorAll('[data-ui="exit-line"]')];
    expect(lines.map((li) => li.getAttribute('data-asset'))).toEqual([
      'solana:usdy',
      'solana:sgov',
    ]);
    const [usdy, sgov] = lines as [Element, Element];
    expect(text(find(usdy, 'p'))).toBe('USDY (Ondo)');
    expect(part(usdy, 'exit-size').trim()).toBe('$51,557.00');
    expect(part(usdy, 'exit-cost').trim()).toBe('7.1 basis points');
    const cost = find(usdy, '[data-ui="exit-cost"] [data-ui="figure"]');
    // Bearing's own label is live; the holding is on a test network, and the pin is no more live
    expect(cost.getAttribute('data-state')).toBe('mock');
    expect(await sourceOf(cost)).toContain(
      'Bearing, from the pools its collectors read each hour · 2026-10-07T11:00:00Z · risk-0.3',
    );
    const [solana] = exposureOf(SOL_INCOME, 'solana').chains;
    expect(await sourceOf(find(usdy, '[data-ui="exit-size"] [data-ui="figure"]'))).toContain(
      `${solana?.source} · 2026-10-07T11:56:02Z · ${solana?.method}`,
    );
    // measured, and this size is beyond what was measured
    expect(part(sgov, 'exit-cost')).toBe(en.plan.exit.beyond);
    expect(find(sgov, '[data-ui="exit-cost"]').querySelector('[data-ui="figure"]')).toBeNull();
    expect(exit.querySelector('[data-ui="exit-unvalued"]')).toBeNull();
  });

  it('says where the risk sits: the shares by issuer and by kind, of a pinned value, and each flag as a sentence', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const risk = block(host, 'plan-risk');
    expect(part(risk, 'risk-of')).toContain(en.plan.risk.of);
    expect(text(find(risk, '[data-ui="risk-of"] [data-ui="figure"]')).trim()).toBe('$81,243.55');
    const table = (ui: string) =>
      [...find(risk, `[data-ui="${ui}"]`).querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('th, td')].map(text),
      );
    expect(text(find(risk, '[data-ui="risk-issuers"] caption'))).toBe('By issuer');
    expect(table('risk-issuers')).toEqual([
      ['ondo', '63.5%'],
      ['ishares', '28.1%'],
      ['test network', '8.4%'],
    ]);
    expect(table('risk-classes')).toEqual([
      ['Dollar yield', '91.6%'],
      ['Cash', '8.4%'],
    ]);
    expect([...find(risk, '[data-ui="risk-flags"]').querySelectorAll('li')].map(text)).toEqual([
      en.plan.risk.flags.known.exit_quote_missing,
    ]);
    expect(risk.querySelector('[data-ui="risk-stand-in"]')).toBeNull();
    // the roll-up's own averaged cost has no stamp of its own: it is not shown
    expect(text(risk)).not.toMatch(/7[.,]1/);
    expect(pins(risk)).toHaveLength(1);
  });

  it('lists the vault’s latest trades, whose they were and how they ended, and leads to all of them', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const trades = block(host, 'plan-trades');
    const lines = [...find(trades, '[data-ui="trades-list"]').querySelectorAll('li')];
    expect(
      lines.map((li) => [li.getAttribute('data-by'), li.getAttribute('data-outcome')]),
    ).toEqual([
      ['keeper', 'confirmed'],
      ['owner', 'confirmed'],
    ]);
    const keeper = lines[0] as Element;
    const owner = lines[1] as Element;
    expect(text(find(keeper, ':scope > span:first-child'))).toBe('Our keeper');
    expect(part(keeper, 'trade-what')).toBe('USDY (Ondo) → Cash (USDC)');
    expect(text(find(keeper, 'time'))).toBe('traded on Oct 7, 2026, 06:12 UTC');
    // worked out from snapshots: it says so, and has no transaction to link
    expect(part(keeper, 'trade-derived')).toBe(en.plan.trades.derived);
    expect(keeper.querySelector('[data-ui="explorer-link"]')).toBeNull();
    expect(text(find(owner, ':scope > span:first-child'))).toBe('You');
    expect(part(owner, 'trade-what')).toBe(
      'Cash (USDC) → USDY (Ondo), Cash (USDC) → SGOV (iShares)',
    );
    // a step of the person's is timed at when it was built
    expect(text(find(owner, 'time'))).toBe('built on Oct 5, 2026, 09:29 UTC');
    expect(part(owner, 'trade-outcome')).toBe('confirmed');
    expect(text(find(owner, '[data-ui="explorer-link"]'))).toContain('5VER…kQUW');
    const all = find(trades, 'a[href="/portfolio/rebalancing"]');
    expect(text(all)).toBe(en.plan.trades.all);
    // no quote, price or amount here: the rebalancing page owns those
    expect(pins(trades)).toEqual([]);
    expect(text(trades)).not.toMatch(/\$\s?\d/);
  });

  it('shows a failed step with the word and the notched mark, and says how many older steps it leaves out', async () => {
    const answer = rebalances();
    const [solana] = answer.chains;
    const mine = (solana?.entries ?? []).filter((e) => e.vault === SOL_GROW);
    // four steps of this vault: the failed one first
    const four = [...mine].reverse().concat(mine);
    api({
      rebalances: () =>
        json({
          ...answer,
          chains: answer.chains.map((c) => (c.chain === 'solana' ? { ...c, entries: four } : c)),
        }),
    });
    signIn();
    const host = await open('solana', SOL_GROW);
    const trades = block(host, 'plan-trades');
    const lines = [...find(trades, '[data-ui="trades-list"]').querySelectorAll('li')];
    expect(lines).toHaveLength(3);
    const failed = lines[0] as Element;
    expect(failed.getAttribute('data-outcome')).toBe('failed');
    expect(part(failed, 'trade-outcome')).toBe('failed');
    expect(
      find(failed, '[data-ui="trade-outcome"] svg[data-ui="status-mark"]').getAttribute(
        'data-status',
      ),
    ).toBe('off-track');
    expect(part(trades, 'trades-more')).toBe('1 older step is not shown here.');
    expect(trades.querySelector('[data-ui="trades-cut"]')).toBeNull();
  });
});

describe('the goal of a plan’s page', () => {
  it.each(['en', 'pt'] as const)(
    'is the sentence its card states on the overview, for every vault (%s)',
    async (lang) => {
      api();
      signIn();
      location.pathname = '/portfolio';
      const overview = await mount(inSection(lang, createElement(OverviewPage)));
      await settle();
      // each vault is a row of the overview's table, named as its own page names it
      const cards = [...overview.querySelectorAll('[data-ui="overview-vault"]')].map((row) => ({
        chain: row.getAttribute('data-chain') as string,
        address: row.getAttribute('data-address') as string,
        sentence: text(find(row, '[data-ui="vault-sentence"]')),
        notes: [...row.querySelectorAll('[data-ui="plan-note"]')].map(text),
        href: find(row, 'a').getAttribute('href'),
      }));
      expect(cards).toHaveLength(7);
      await unmountAll();
      for (const card of cards) {
        // the row opens the vault's own page, where its chat and its plan are
        expect(card.href).toBe(vaultHref(card.chain, card.address));
        const host = await open(card.chain, card.address, lang);
        expect(text(find(host, 'h1')), card.address).toBe(card.sentence);
        expect([...host.querySelectorAll('[data-ui="plan-note"]')].map(text)).toEqual(card.notes);
        // the serif is spent once, on the goal
        expect(host.querySelectorAll('.font-display')).toHaveLength(1);
        await unmountAll();
      }
    },
  );
});

describe('the figures of a plan’s page', () => {
  it.each([SOL_GROW, SOL_INCOME, SOL_UNPRICED, SOL_STALE, RH_SILENT, RH_EMPTY, SOL_NEVER])(
    'puts a pin on every figure, and writes no amount and no cost without one: %s',
    async (address) => {
      api();
      signIn();
      const { chain } = planAt(address);
      const host = await open(chain.chain, address);
      for (const figure of pins(host)) {
        expect(figure.getAttribute('data-state')).not.toBe('missing');
        // every chain here is a test network or the mock: nothing is drawn as live
        expect(figure.getAttribute('data-state')).toBe('mock');
        expect(figure.querySelector('button[data-ui="pin"]')?.getAttribute('aria-label')).toMatch(
          /^Source for .+, sample figure$/,
        );
      }
      // outside the figures, the goal (the person's own words) and the scale of the drawing, no
      // amount of money and no cost is written
      const copy = block(host, 'portfolio-plan').cloneNode(true) as HTMLElement;
      for (const el of copy.querySelectorAll('[data-ui="figure"], h1, svg')) el.remove();
      expect(text(copy)).not.toMatch(/\$\s?\d/);
      expect(text(copy)).not.toMatch(/\d\s*basis point/);
      expect(text(host)).not.toContain('MOCK');
      expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
      // each block that shows a figure which is not live says so once, with the hatch
      for (const card of host.querySelectorAll('[data-ui="plan-blocks"] [data-ui="card"]')) {
        if (pins(card).length === 0) continue;
        expect(card.querySelector(':scope > [data-ui="hatch-band"]')).not.toBeNull();
        expect(text(find(card, ':scope > div > [data-ui="sample-note"]'))).toBe(
          chain.provenance === 'mock' ? t.shell.mockAnnounce : t.shell.testNetworkLine,
        );
      }
    },
  );

  it('draws a live plan with live pins and no mark', async () => {
    liveApi();
    signIn();
    const host = await open('solana', SOL_INCOME);
    expect(pins(host).length).toBeGreaterThan(10);
    expect(new Set(pins(host).map((pin) => pin.getAttribute('data-state')))).toEqual(
      new Set(['live']),
    );
    const blocks = block(host, 'plan-blocks');
    for (const ui of ['plan-head', 'plan-history', 'plan-parts', 'plan-exit', 'plan-risk']) {
      const root =
        ui === 'plan-head'
          ? (block(host, ui).closest('[data-ui="card"]') as Element)
          : block(blocks, ui);
      expect(root.querySelector('[data-ui="hatch-band"]'), ui).toBeNull();
      expect(root.querySelector('[data-ui="sample-note"]'), ui).toBeNull();
    }
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('says a snapshot older than an hour is stale, as the answer says, in the head and over the table', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_STALE);
    expect(part(block(host, 'plan-head'), 'stale-plate')).toBe('stale · 3 h');
    expect(part(find(host, '[data-ui="parts-stale"]'), 'stale-plate')).toBe('stale · 3 h');
    expect(text(find(host, '[data-ui="plan-read"] > span:first-child'))).toBe(
      'Read 3 hours ago, on Oct 7, 2026, 08:55 UTC.',
    );
    await unmountAll();

    // live, the figure's own pin says it too: hollow, with the word and the age
    liveApi();
    const live = await open('solana', SOL_STALE);
    const [value, putIn] = pins(block(live, 'plan-head'));
    expect(value?.getAttribute('data-state')).toBe('stale');
    expect(part(value as Element, 'stale-tag')).toBe('stale · 3 h');
    // what was put in is no read of the vault: it is not stale with it
    expect(putIn?.getAttribute('data-state')).toBe('live');
    // the cash is the snapshot's own count; a position's value is as stale as its price says
    const figures = pins(find(block(live, 'plan-parts'), 'table'));
    expect(figures.map((f) => f.getAttribute('data-state'))).toEqual(['live', 'live', 'stale']);
    await unmountAll();

    // and a fresh one says nothing of it
    api();
    const fresh = await open('solana', SOL_GROW);
    expect(fresh.querySelector('[data-ui="stale-plate"]')).toBeNull();
  });
});

describe('a vault that follows a shared portfolio', () => {
  it('is headed by what it follows, and shows a measured exit beside a tier that stands in', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_STALE);
    expect(text(find(host, 'h1'))).toBe('Your vault follows Steady dollars.');
    expect(part(block(host, 'plan-head'), 'plan-reason')).toBe(
      'The vault was last read 185 minutes ago, more than an hour.',
    );
    expect(rows(host)).toEqual([
      ['USDY (Ondo)', '$130.80', '51.9%', '50%', '+1.9%', ''],
      ['syrupUSDC (Maple)', '$108.60', '43.1%', '45%', '−1.9%', ''],
      ['Cash (USDC)', '$12.50', '5%', '5%', '0%', ''],
    ]);
    const lines = [...block(host, 'plan-exit').querySelectorAll('[data-ui="exit-line"]')];
    const [usdy, syrup] = lines as [Element, Element];
    expect(part(usdy, 'exit-cost').trim()).toBe('1.2 basis points');
    expect(pins(find(usdy, '[data-ui="exit-cost"]'))).toHaveLength(1);
    // not measured: the tier is named, as a ceiling on its share that states no cost
    expect(part(syrup, 'exit-cost')).toBe(
      'Not measured. Its tier, B, is only a ceiling on its share of a plan and states no cost.',
    );
    expect(pins(find(syrup, '[data-ui="exit-cost"]'))).toEqual([]);
    // its holding still has its own figure and pin
    expect(part(syrup, 'exit-size').trim()).toBe('$108.60');
    expect([...find(host, '[data-ui="risk-flags"]').querySelectorAll('li')].map(text)).toEqual([
      en.plan.risk.flags.known.exit_partly_measured,
      en.plan.risk.flags.known.exit_quote_missing,
      en.plan.risk.flags.known.issuer_concentration,
    ]);
    // a version accepted by hand trades nothing
    const steps = [...block(host, 'plan-trades').querySelectorAll('[data-ui="trade-what"]')].map(
      text,
    );
    expect(steps).toEqual(['Cash (USDC) → USDY (Ondo)', en.plan.trades.version]);
  });
});

describe('what leaving would cost, where the answer lacks a part of a stamp', () => {
  it('shows no number for a measured cost that carries no time, and says it is not dated', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_GROW);
    const lines = [...block(host, 'plan-exit').querySelectorAll('[data-ui="exit-line"]')];
    const [spyx, usdy] = lines as [Element, Element];
    expect(spyx.getAttribute('data-asset')).toBe('solana:spyx');
    expect(part(spyx, 'exit-cost')).toBe(en.plan.exit.notDated);
    expect(pins(find(spyx, '[data-ui="exit-cost"]'))).toEqual([]);
    // the cost the answer carried for it is nowhere on the page
    expect(text(block(host, 'plan-exit'))).not.toMatch(/3[.,]1/);
    expect(part(usdy, 'exit-cost').trim()).toBe('2.4 basis points');
  });

  it('shows no number for one that carries no source, and none for an asset with no tier named', async () => {
    const answer = exposureOf(SOL_GROW, 'solana');
    api({
      more: (path) =>
        path.startsWith(`${EXPOSURE_PATH}?chain=solana&address=${SOL_GROW}`)
          ? json({
              ...answer,
              chains: answer.chains.map((c) => ({
                ...c,
                exit: [
                  {
                    asset: 'solana:spyx',
                    usd: '1025',
                    measured: true,
                    costBps: 1,
                    method: 'risk-0.3',
                    fetchedAt: '2026-10-07T11:00:00.000Z',
                    provenance: 'live',
                  },
                  { asset: 'solana:usdy', usd: '926.5', measured: false, costBps: null },
                ],
              })),
            })
          : null,
    });
    signIn();
    const host = await open('solana', SOL_GROW);
    const [spyx, usdy] = [
      ...block(host, 'plan-exit').querySelectorAll('[data-ui="exit-cost"]'),
    ] as [Element, Element];
    expect(text(spyx)).toBe(en.plan.exit.noSource);
    expect(text(usdy)).toBe(en.plan.exit.notMeasured);
    expect(pins(spyx).concat(pins(usdy))).toEqual([]);
    // one basis point is said in the singular
    expect(en.plan.exit.cost(1, '1')).toBe('1 basis point');
  });
});

describe('the flags of the roll-up', () => {
  it('have a sentence here for every flag the roll-up can raise', () => {
    const source = readFileSync(join(WEB, '../../packages/basket/src/roll-up.ts'), 'utf8');
    const body = /ROLL_UP_FLAGS = \{([\s\S]*?)\} as const/.exec(source)?.[1] ?? '';
    const raised = [...body.matchAll(/^\s+\w+: '([^']+)',$/gm)].map((m) => m[1] as string);
    expect(raised).toHaveLength(12);
    const fixed = raised.filter((flag) => !flag.endsWith(':'));
    for (const lang of ['en', 'pt'] as const)
      expect(Object.keys(portfolioDictionary(lang).plan.risk.flags.known).sort()).toEqual(
        [...fixed].sort(),
      );
    expect(raised.filter((flag) => flag.endsWith(':')).sort()).toEqual([
      'measured_provenance:',
      'quoted_provenance:',
    ]);
  });

  it('are each said in a person’s words, and one with no sentence is shown by its own name', async () => {
    const answer = exposureOf(SOL_INCOME, 'solana');
    const flags = [
      'a_flag_from_tomorrow',
      'asset_not_on_shelf',
      'exit_beyond_measured_size',
      'exit_capacity_short',
      'exit_not_measured',
      'exit_quote_far_from_size',
      'exit_quote_partial',
      'exit_quote_stale',
      'measured_provenance:sandbox',
      'quoted_provenance:from_nowhere',
    ];
    api({
      more: (path) =>
        path.startsWith(`${EXPOSURE_PATH}?chain=solana&address=${SOL_INCOME}`)
          ? json({
              ...answer,
              chains: answer.chains.map((c) => ({
                ...c,
                rollUp: c.rollUp && { ...c.rollUp, flags },
              })),
            })
          : null,
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    const known = en.plan.risk.flags.known;
    expect([...find(host, '[data-ui="risk-flags"]').querySelectorAll('li')].map(text)).toEqual([
      'One more flag, which I have no sentence for yet: a_flag_from_tomorrow.',
      known.asset_not_on_shelf,
      known.exit_beyond_measured_size,
      known.exit_capacity_short,
      known.exit_not_measured,
      known.exit_quote_far_from_size,
      known.exit_quote_partial,
      known.exit_quote_stale,
      'A measured cost behind these figures comes from a test network, not from a live market.',
      'A quote behind these figures comes from a source that is not live, not from a live market.',
    ]);
  });

  it('says nothing is flagged where the roll-up raised none', async () => {
    const answer = exposureOf(SOL_INCOME, 'solana');
    api({
      more: (path) =>
        path.startsWith(`${EXPOSURE_PATH}?chain=solana&address=${SOL_INCOME}`)
          ? json({
              ...answer,
              chains: answer.chains.map((c) => ({
                ...c,
                rollUp: c.rollUp && { ...c.rollUp, flags: [] },
              })),
            })
          : null,
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    expect(part(host, 'risk-no-flags')).toBe(en.plan.risk.flags.none);
  });
});

describe('a vault with a part that has no price', () => {
  it('shows no value and no share for it, holds nothing to the band, and says it is in no sum', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_UNPRICED);
    expect(part(block(host, 'plan-head'), 'plan-unpriced')).toBe(
      '1 holding has no price, so the value leaves it out.',
    );
    const parts = block(host, 'plan-parts');
    expect(text(find(parts, 'header p'))).toBe(en.plan.parts.unweighed);
    expect(rows(host)).toEqual([
      ['PAXG', en.plan.parts.noPrice, en.plan.parts.notWeighed, '30%', en.plan.parts.notWeighed],
      ['USDY (Ondo)', '$250.70', '50.1%', '50%', '+0.1%'],
      ['Cash (USDC)', '$249.58', '49.9%', '20%', '+29.9%'],
    ]);
    const table = find(parts, 'table');
    expect(pins(find(table, 'tbody tr:first-child'))).toEqual([]);
    // the plan cannot be weighed: no band is drawn and no part is called outside it
    expect(parts.querySelector('[data-ui="band-gauge"]')).toBeNull();
    expect(parts.querySelector('[data-ui="status"]')).toBeNull();
    expect([...table.querySelectorAll('thead th')].map(text)).not.toContain(en.plan.parts.status);
    expect(part(block(host, 'plan-exit'), 'exit-unvalued')).toBe(
      'PAXG is held with no price, so it is in none of these figures.',
    );
  });

  it('shows no value for a part whose price was not kept with the snapshot', async () => {
    const answer = plans();
    api({
      plans: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({
            ...chain,
            plans: chain.plans.map((plan) =>
              plan.address === SOL_GROW && plan.newest
                ? { ...plan, newest: { ...plan.newest, prices: plan.newest.prices.slice(1) } }
                : plan,
            ),
          })),
        }),
    });
    signIn();
    const host = await open('solana', SOL_GROW);
    expect(rows(host)[0]?.slice(0, 2)).toEqual(['SPYx', en.plan.parts.priceNotKept]);
    expect(text(block(host, 'plan-parts'))).not.toContain('$1,025.00');
  });

  it('draws no band on a chain that states none, and says so', async () => {
    const answer = plans();
    api({
      plans: () =>
        json({
          ...answer,
          chains: answer.chains.map((chain) => ({
            ...chain,
            plans: chain.plans.map((plan) =>
              plan.address === SOL_INCOME && plan.newest
                ? { ...plan, newest: { ...plan.newest, bandBps: null } }
                : plan,
            ),
          })),
        }),
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    const parts = block(host, 'plan-parts');
    expect(text(find(parts, 'header p'))).toBe(en.status.lines.no_band);
    expect(parts.querySelector('[data-ui="band-gauge"], [data-ui="status"]')).toBeNull();
  });
});

describe('a vault that was never read', () => {
  it('says so in its head, replaces every figure below with one sentence, and asks for none', async () => {
    const server = api();
    signIn();
    const host = await open('solana', SOL_NEVER);
    expect(text(find(host, 'h1'))).toBe('Rainy day');
    const head = block(host, 'plan-head');
    expect(head.querySelector('[data-ui="status"], [data-ui="status-mark"]')).toBeNull();
    expect(part(head, 'plan-no-status')).toBe('No status yet');
    expect(part(head, 'plan-reason')).toBe(
      'This vault hasn’t been read yet, so there is no status to give.',
    );
    expect(part(head, 'plan-never-read')).toBe(en.overview.card.neverRead);
    expect(part(head, 'plan-no-put-in')).toBe(en.overview.card.noPutIn);
    expect(head.querySelector('[data-ui="plan-read"]')).toBeNull();
    expect(text(host).split(en.plan.unread)).toHaveLength(2);
    for (const ui of ['plan-history', 'plan-parts', 'plan-exit', 'plan-risk'])
      expect(host.querySelector(`[data-ui="${ui}"]`), ui).toBeNull();
    expect(pins(host)).toEqual([]);
    expect(
      host.querySelector('svg[data-ui="band-gauge"], [data-ui="plan-value-chart"]'),
    ).toBeNull();
    expect(text(host)).not.toMatch(/\$\s?\d/);
    expect(server.to(HISTORY_PATH)).toEqual([]);
    expect(server.to(EXPOSURE_PATH).filter((p) => queryOf(p).has('address'))).toEqual([]);
    // what does not stand on a snapshot is still there
    expect(part(block(host, 'plan-trades'), 'trades-none')).toContain(en.plan.trades.none);
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
  });
});

describe('a vault on the sample chain', () => {
  it('says "Sample figures", names the tier that stands in, and links no transaction of the mock', async () => {
    api();
    signIn();
    const host = await open('robinhood', RH_SILENT);
    expect(text(find(host, 'h1'))).toBe('Your vault was opened to follow US stocks.');
    const head = block(host, 'plan-head');
    const status = find(head, '[data-ui="status"]');
    expect([status.getAttribute('data-status'), text(status)]).toEqual(['off-track', 'Off track']);
    expect(part(head.closest('[data-ui="card"]') as Element, 'sample-note')).toBe(
      t.shell.mockAnnounce,
    );
    expect(part(head, 'stale-plate')).toBe('stale · 26 h');
    expect(rows(host)).toEqual([
      ['SPY', '$25.00', '60.2%', '60%', '+0.2%', ''],
      ['Cash (tUSDG)', '$16.50', '39.8%', '40%', '−0.2%', ''],
    ]);
    const exit = block(host, 'plan-exit');
    expect(part(exit, 'exit-cost')).toBe(en.plan.exit.tier('A'));
    const risk = block(host, 'plan-risk');
    // on the mock every issuer is the mock: the page says the split is no real one
    expect(part(risk, 'risk-stand-in')).toBe(en.plan.risk.standIn);
    expect([...find(risk, '[data-ui="risk-flags"]').querySelectorAll('li')].map(text)).toEqual([
      en.plan.risk.flags.known.exit_not_measured,
      en.plan.risk.flags.known.exit_quote_missing,
    ]);
    const trades = block(host, 'plan-trades');
    expect(part(trades, 'trade-what')).toBe('Cash (tUSDG) → SPY');
    expect(text(find(trades, '[data-ui="explorer-link"]'))).toContain(t.order.link.unavailable);
    expect(host.querySelector('a[href^="mock:"]')).toBeNull();
  });

  it('says a vault that holds nothing holds nothing: one snapshot as a sentence, no table, no split', async () => {
    api();
    signIn();
    const host = await open('robinhood', RH_EMPTY);
    expect(text(find(host, 'h1'))).toBe('Your vault on Robinhood Chain.');
    // one point in the window: a sentence and that one figure, never an empty frame
    const one = block(host, 'history-one');
    expect(text(find(one, ':scope > p:first-child'))).toBe(en.plan.history.one);
    expect(en.plan.history.one).toMatch(/about every ten minutes/);
    expect(text(one)).toContain('On Oct 6, 2026, 10:00 UTC:');
    expect(pins(one)).toHaveLength(1);
    expect(
      host.querySelector('[data-ui="plan-value-chart"], svg[aria-hidden] polyline'),
    ).toBeNull();
    expect(part(host, 'parts-empty')).toBe(en.plan.parts.empty);
    expect(host.querySelector('[data-ui="plan-parts"] table')).toBeNull();
    expect(part(host, 'exit-nothing')).toBe(en.plan.exit.nothing);
    expect(part(host, 'risk-nothing')).toBe(en.plan.risk.nothing);
  });
});

describe('how far back a plan’s page looks', () => {
  const sent = (server: ReturnType<typeof api>) =>
    server.to(HISTORY_PATH).map((path) => Object.fromEntries(queryOf(path)));
  const choice = (host: ParentNode, label: string) => {
    const found = [
      ...find(host, '[data-ui="plan-history"] [data-ui="segmented"]').querySelectorAll('button'),
    ].find((b) => text(b) === label);
    if (!found) throw new Error(`no choice ${label}`);
    return found;
  };

  it('offers four windows, asks only windows the route serves, and asks afresh on "Read again"', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
    const server = api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const group = find(host, '[data-ui="plan-history"] [data-ui="segmented"]');
    expect(group.getAttribute('aria-label')).toBe(en.plan.history.window.label);
    expect(
      [...group.querySelectorAll('button')].map((b) => [text(b), b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['24 hours', 'false'],
      ['7 days', 'true'],
      ['30 days', 'false'],
      ['90 days', 'false'],
    ]);
    for (const label of ['24 hours', '30 days', '90 days', '7 days']) {
      await click(choice(host, label));
      await settle();
      expect(choice(host, label).getAttribute('aria-pressed')).toBe('true');
    }
    // a later moment: "Read again" asks for the window that ends then
    now.mockReturnValue(Date.parse(NOW) + 600_000);
    await click(find(host, '[data-ui="plan-refresh"] [data-action="read-again"]'));
    await settle();
    await settle();
    const queries = sent(server);
    expect(queries.map((q) => [q.from, q.to, q.step])).toEqual([
      ['2026-09-30T12:00:00.000Z', NOW, '1h'],
      ['2026-10-06T12:00:00.000Z', NOW, '10m'],
      ['2026-09-07T12:00:00.000Z', NOW, '1h'],
      ['2026-07-09T12:00:00.000Z', NOW, '1d'],
      // the week again: its answer was not kept under another window's name
      ['2026-09-30T12:00:00.000Z', NOW, '1h'],
      ['2026-09-30T12:10:00.000Z', '2026-10-07T12:10:00.000Z', '1h'],
    ]);
    for (const query of queries) {
      const parsed = PortfolioHistoryQuery.safeParse(query);
      expect(parsed.success).toBe(true);
      if (!parsed.success) continue;
      const { from, to, step, chain, address } = parsed.data;
      expect([chain, address]).toEqual(['solana', SOL_INCOME]);
      const span = Date.parse(to as string) - Date.parse(from as string);
      expect(span).toBeGreaterThan(0);
      expect(span / 1000 / HISTORY_STEP_SECONDS[step]).toBeLessThanOrEqual(HISTORY_MAX_POINTS);
    }
    // the figure is still there after it all
    expect(host.querySelector('[data-ui="plan-value-chart"]')).not.toBeNull();
  });

  it('says so in a sentence when no snapshot falls in the window, and draws no frame', async () => {
    api({
      history: () => {
        const answer = history({ chain: 'solana', address: SOL_INCOME });
        return json({ ...answer, chains: answer.chains.map((c) => ({ ...c, vaults: [] })) });
      },
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    expect(part(host, 'history-none')).toBe(
      'No snapshot of this vault falls in this window: its newest is from Oct 7, 2026, 11:56 UTC. We take a snapshot about every ten minutes.',
    );
    const figure = block(host, 'plan-history');
    expect(figure.querySelector('svg, [data-ui="card"], [data-ui="figure"]')).toBeNull();
    // the choice of another window is still there
    expect(figure.querySelectorAll('[data-ui="segmented"] button')).toHaveLength(4);
  });
});

describe('the person’s own steps on a plan’s page', () => {
  const order = (id: string) => {
    const done = doneOrder();
    return { ...done, id, legs: done.legs.map((leg) => ({ ...leg, orderId: id })) };
  };
  /** GET /v1/me/plans: the income plan with its second buy, and the plan to grow with its own. */
  const listed = () => {
    const of = (address: string, id: string, orderId: string, amountUsd: number) => {
      const { plan } = planAt(address);
      return {
        id,
        createdAt: '2026-10-01T15:00:00.000Z',
        fromLink: false,
        chain: 'solana',
        sheet: address === SOL_INCOME ? SHEET_INCOME : SHEET_GROW,
        card: plan.plan?.card,
        verdict: null,
        bought: true,
        orders: [
          {
            id: orderId,
            createdAt: '2026-10-05T09:29:00.000Z',
            amountUsd,
            status: 'done',
            deposited: true,
          },
        ],
        vault: { chain: 'solana', basketId: plan.basketId },
      };
    };
    return json({
      plans: [
        of(SOL_INCOME, '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d', ORDER_INCOME_2, 30_000),
        of(SOL_GROW, '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60', ORDER_GROW, 2000),
      ],
      next: null,
    });
  };
  const withOrders = (path: string) =>
    path === '/v1/me/plans'
      ? listed()
      : path === `/v1/orders/${ORDER_INCOME_2}`
        ? json(order(ORDER_INCOME_2))
        : path === `/v1/orders/${ORDER_GROW}`
          ? json(order(ORDER_GROW))
          : null;

  it('lists the steps of this vault’s orders alone, says what the list is, and ends with one disclaimer', async () => {
    api({ more: withOrders });
    signIn();
    const host = await open('solana', SOL_INCOME);
    await settle();
    const activity = block(host, 'plan-activity');
    expect(part(activity, 'plan-activity-note')).toBe(en.plan.activity.note);
    const groups = [...activity.querySelectorAll('[data-ui="activity-order"]')];
    // the order of this vault, and not the other vault's
    expect(groups.map((g) => text(find(g, 'h3')))).toEqual([
      t.activity.buy('$30,000', 'Oct 5, 2026, 12:00 UTC'),
    ]);
    expect(activity.querySelectorAll('[data-ui="execution-list"] li')).toHaveLength(2);
    // the page's head names the one chain every line is on
    expect(activity.querySelector('[data-ui="chain-badge"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    // the last thing on the page
    const blocks = block(host, 'plan-blocks');
    expect(blocks.lastElementChild).toBe(activity);
  });

  it('says in a sentence that nothing of the vault’s orders reached the chain, where none did', async () => {
    api();
    signIn();
    const host = await open('solana', SOL_INCOME);
    const activity = block(host, 'plan-activity');
    expect(text(activity)).toContain(en.plan.activity.none);
    expect(activity.querySelector('[data-ui="execution-list"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
  });

  it('has exactly one disclaimer in the section’s frame too: the frame’s own stands down for the page’s', async () => {
    api();
    signIn();
    location.pathname = planHref('solana', SOL_INCOME);
    const host = await mount(
      inFrame('en', createElement(PlanPage, { chain: 'solana', address: SOL_INCOME })),
    );
    await settle();
    await settle();
    const page = find(host, '[data-ui="portfolio-page"]');
    expect(page.querySelectorAll('[data-ui="disclaimer"]')).toHaveLength(1);
    const all = [...host.querySelectorAll('[data-ui="disclaimer"]')];
    const frames = all.filter((d) => !page.contains(d));
    expect(frames).toHaveLength(1);
    // hidden by the stylesheet whenever the page carries one (PortfolioShell.tsx)
    expect(frames[0]?.className).toContain(
      'group-has-[[data-ui=portfolio-page]_[data-ui=disclaimer]]/portfolio:hidden',
    );
    // a plan's page is under no item of the menu
    expect(host.querySelector('#portfolio-nav [aria-current="page"]')).toBeNull();
  });
});

describe('a plan’s page, when there is nothing to show or the API cannot say', () => {
  it('asks someone signed out to sign in, and asks the server nothing', async () => {
    const server = api();
    const host = await open('solana', SOL_INCOME);
    expect(server.calls.filter((c) => c.startsWith('/v1/portfolio'))).toEqual([]);
    expect(text(find(host, 'h1'))).toBe(en.plan.title);
    expect(text(host)).toContain(en.shell.signedOut);
    expect(find(host, 'a').getAttribute('href')).toBe(
      `/sign-in?next=/portfolio/plan/solana/${SOL_INCOME}`,
    );
    expect(pins(host)).toEqual([]);
    expect(host.querySelector('[data-ui="plan-blocks"]')).toBeNull();
  });

  it('waits under its own title while the plans are read, then shows the plan', async () => {
    const wait = held();
    api({ plans: wait.answer });
    signIn();
    const host = await open('solana', SOL_INCOME);
    expect(text(find(host, 'h1'))).toBe(en.plan.title);
    expect(host.querySelector('[data-ui="waiting"]')).not.toBeNull();
    expect(pins(host)).toEqual([]);
    wait.release(json(plans()));
    await settle();
    await settle();
    expect(text(find(host, 'h1'))).toBe('Earn income from $80,000 for 60 months.');
    expect(host.querySelector('[data-ui="plan-value-chart"]')).not.toBeNull();
  });

  it.each([
    ['another person’s vault, or none', 'solana', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T'],
    ['words that are no address', 'solana', 'not an address'],
    ['a vault of theirs under another chain', 'robinhood', SOL_GROW],
    ['a chain that is none', 'bitcoin', SOL_GROW],
  ])(
    'says there is no plan to show, the same for %s, and asks nothing with it',
    async (_, chain, address) => {
      const server = api();
      signIn();
      const host = await open(chain, address);
      expect(text(find(host, 'h1'))).toBe(en.plan.title);
      const said = find(host, '[data-ui="card-empty"]');
      expect(text(find(said, 'p'))).toBe('There is no plan of yours to show at this address.');
      const back = find(said, 'a');
      expect([text(back), back.getAttribute('href')]).toEqual([en.plan.back, '/portfolio']);
      // one sentence and the way back, and nothing else: no hint of whether such a vault exists
      expect(text(find(host, '[data-ui="section-read"]'))).toBe(
        `There is no plan of yours to show at this address.${en.plan.back}`,
      );
      expect(pins(host)).toEqual([]);
      expect(server.to(HISTORY_PATH)).toEqual([]);
      expect(server.to(EXPOSURE_PATH).filter((p) => queryOf(p).has('address'))).toEqual([]);
      expect(server.calls.join(' ')).not.toContain(address.replace(/ /g, '+'));
    },
  );

  it('finds a vault on an EVM chain whatever the case its address is written in', async () => {
    api();
    signIn();
    const written = `0x${RH_SILENT.slice(2).toUpperCase()}`;
    const host = await open('robinhood', written);
    expect(text(find(host, 'h1'))).toBe('Your vault was opened to follow US stocks.');
    expect(pins(host).length).toBeGreaterThan(3);
  });

  it('says the plan’s chain is switched off, never that there is no plan, where the chain was not read', async () => {
    api();
    signIn();
    const host = await open('base', '0x5fbdb2315678afecb367f032d93f642f64180aa3');
    expect(text(find(host, '[data-ui="chains-out"] [data-ui="status"]'))).toBe(
      t.portfolio.chainOff('Base'),
    );
    expect(text(host)).toContain(
      'Your plans on Base couldn’t be read, so I can’t show this one now.',
    );
    expect(text(host)).not.toContain(en.plan.notFound);
    expect(find(host, '[data-ui="card-empty"] a').getAttribute('href')).toBe('/portfolio');
    expect(pins(host)).toEqual([]);
  });

  it.each([
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => Promise.reject(new TypeError('fetch failed')), en.shell.failure.unreachable],
    [() => json({ chains: 'nope' }), en.shell.failure.unreadable],
    [() => json({ error: 'sign in first' }, 401), en.shell.failure.signedOut],
  ])(
    'says a failed read of the plans in its own sentence, under its title: %#',
    async (answer, sentence) => {
      api({ plans: answer });
      signIn();
      const host = await open('solana', SOL_INCOME);
      expect(text(find(host, 'h1'))).toBe(en.plan.title);
      expect(text(host)).toContain(sentence);
      expect(pins(host)).toEqual([]);
    },
  );

  it.each([
    [() => json({ error: 'the database did not answer' }, 503), en.shell.failure.unreachable],
    [() => json({ error: 'Route not found' }, 404), en.shell.failure.unavailable],
    [() => json({ error: 'a window that is not served' }, 400), en.shell.failure.refused],
    [() => json({ from: 1 }), en.shell.failure.unreadable],
  ])(
    'says a failed read of the history in its block alone, and the rest stands: %#',
    async (answer, sentence) => {
      api({ history: answer });
      signIn();
      const host = await open('solana', SOL_INCOME);
      const figure = block(host, 'plan-history');
      expect(text(figure)).toContain(sentence);
      expect(
        figure.querySelector('svg[aria-hidden="true"] polyline, [data-ui="figure"]'),
      ).toBeNull();
      // the window can still be chosen, and everything else is as it was
      expect(figure.querySelectorAll('[data-ui="segmented"] button')).toHaveLength(4);
      expect(text(find(host, 'h1'))).toBe('Earn income from $80,000 for 60 months.');
      expect(pins(block(host, 'plan-head'))).toHaveLength(2);
      expect(rows(host)).toHaveLength(3);
      expect(block(host, 'plan-exit').querySelectorAll('[data-ui="exit-line"]')).toHaveLength(2);
      expect(host.querySelector('[data-ui="risk-flags"]')).not.toBeNull();
      expect(host.querySelector('[data-ui="trades-list"]')).not.toBeNull();
    },
  );

  it('says a failed read of the exposure in its two blocks alone, and the rest stands', async () => {
    api({ exposure: () => Promise.reject(new TypeError('fetch failed')) });
    signIn();
    const host = await open('solana', SOL_INCOME);
    for (const ui of ['plan-exit', 'plan-risk']) {
      expect(text(block(host, ui)), ui).toContain(en.shell.failure.unreachable);
      expect(pins(block(host, ui)), ui).toEqual([]);
      expect(block(host, ui).querySelector('[data-action="read-again"]')).not.toBeNull();
    }
    expect(host.querySelector('[data-ui="plan-value-chart"]')).not.toBeNull();
    expect(rows(host)).toHaveLength(3);
    expect(host.querySelector('[data-ui="trades-list"]')).not.toBeNull();
  });

  it('says a failed read of the trades in its block alone, and the rest stands', async () => {
    api({ rebalances: () => json({ error: 'the database did not answer' }, 503) });
    signIn();
    const host = await open('solana', SOL_INCOME);
    const trades = block(host, 'plan-trades');
    expect(text(trades)).toContain(en.shell.failure.unreachable);
    expect(trades.querySelector('[data-ui="trades-list"]')).toBeNull();
    expect(host.querySelector('[data-ui="plan-value-chart"]')).not.toBeNull();
    expect(block(host, 'plan-exit').querySelectorAll('[data-ui="exit-line"]')).toHaveLength(2);
  });

  it('says a chain an own read could not cover in a sentence, in that block, never a zero', async () => {
    const out = {
      chain: 'solana',
      name: 'Solana devnet',
      code: 'CHAIN_UNAVAILABLE',
      error: 'the reader of Solana did not answer',
      retryable: true,
    };
    api({
      history: () => json({ ...history({ chain: 'solana' }), chains: [], unavailable: [out] }),
      exposure: () => json({ ...EXPOSURE_OF_NOTHING, total: null, chains: [], unavailable: [out] }),
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    for (const ui of ['plan-history', 'plan-exit', 'plan-risk']) {
      expect(text(find(block(host, ui), '[data-ui="chains-out"] [data-ui="status"]')), ui).toBe(
        t.portfolio.chainOut('Solana'),
      );
      expect(pins(block(host, ui)), ui).toEqual([]);
    }
    expect(rows(host)).toHaveLength(3);
  });

  it('says an older trade may be missing where the section’s read of them was at its limit', async () => {
    const answer = rebalances();
    const [solana] = answer.chains;
    const other = (solana?.entries ?? []).find((e) => e.vault === SOL_GROW);
    api({
      rebalances: () =>
        json({
          ...answer,
          chains: answer.chains.map((c) =>
            c.chain === 'solana' ? { ...c, entries: Array.from({ length: 200 }, () => other) } : c,
          ),
        }),
    });
    signIn();
    const host = await open('solana', SOL_INCOME);
    const trades = block(host, 'plan-trades');
    expect(part(trades, 'trades-none')).toContain(en.plan.trades.none);
    expect(part(trades, 'trades-cut')).toBe(
      'Only the newest 200 steps of your vaults are read here, so an older one may be missing.',
    );
  });
});

describe('a plan’s page in Portuguese', () => {
  it('says every word of the page in Portuguese, and the figures the Brazilian way', async () => {
    const pt = portfolioDictionary('pt');
    const tp = dictionary('pt');
    const plain = (value: string) => value.replace(/[  ]/g, ' ');
    const said = (el: Element) => plain(el.textContent ?? '');
    api();
    signIn();
    const host = await open('solana', SOL_INCOME, 'pt');
    expect(said(find(host, '[data-ui="plan-back"]'))).toBe('Todos os seus planos');
    const head = block(host, 'plan-head');
    expect(said(find(head, '[data-ui="status"]'))).toBe('Atenção');
    expect(
      [...find(head, '[data-ui="plan-figures"]').querySelectorAll('dt, dd')].map((el) =>
        said(el).trim(),
      ),
    ).toEqual(['Valor agora', 'US$ 81.243,55', 'Você colocou', 'US$ 80.000,00']);
    expect(said(find(head.closest('[data-ui="card"]') as Element, '[data-ui="sample-note"]'))).toBe(
      tp.shell.testNetworkLine,
    );
    expect(
      [...host.querySelectorAll('[data-ui="plan-blocks"] > section > header h2')].map(said),
    ).toEqual([
      'Valor ao longo do tempo',
      'Cada parte comparada ao planejado',
      'Quanto custaria sair',
      'Onde está o risco',
      'Últimas operações',
    ]);
    expect([...host.querySelectorAll('[data-ui="segmented"] button')].map(said)).toEqual([
      '24 horas',
      '7 dias',
      '30 dias',
      '90 dias',
    ]);
    expect(find(host, '[data-ui="segmented"]').getAttribute('aria-label')).toBe('Período');
    expect(said(find(host, '[data-ui="chart-readout"]'))).toContain('Retrato mais recente');
    expect(said(find(host, '[data-ui="chart-readout"] [data-ui="figure"]')).trim()).toBe(
      'US$ 81.243,55',
    );
    expect(said(find(host, '[data-ui="history-deposits"]'))).toContain('Depósito 2');
    expect(said(find(host, '[data-ui="history-deposits"]'))).toContain('US$ 30.000,00');
    const row = rows(host)[0]?.map(plain);
    expect(row).toEqual([
      'USDY (Ondo)',
      'US$ 51.557,00',
      '63,5%',
      '60%',
      '+3,5%',
      'Fora da margem',
    ]);
    expect(said(find(block(host, 'plan-parts'), 'header p'))).toBe(pt.plan.parts.band('2%'));
    const exit = block(host, 'plan-exit');
    expect(said(find(exit, '[data-ui="exit-cost"] [data-ui="figure"]')).trim()).toBe(
      '7,1 pontos-base',
    );
    expect(said(exit)).toContain(pt.plan.exit.beyond);
    expect(said(block(host, 'plan-risk'))).toContain(pt.plan.risk.flags.known.exit_quote_missing);
    const trades = block(host, 'plan-trades');
    expect(said(find(trades, 'li:first-child > span:first-child'))).toBe('Nosso operador');
    expect(said(trades)).toContain('deduzido de dois retratos do cofre');
    expect(said(find(trades, 'a[href="/portfolio/rebalancing"]'))).toBe(pt.plan.trades.all);
    expect(said(block(host, 'plan-activity'))).toContain(pt.plan.activity.none);
    for (const pin of pins(host))
      expect(plain(pin.querySelector('button')?.getAttribute('aria-label') ?? '')).toMatch(
        /^Fonte de .+, número de exemplo$/,
      );
    // no English sentence of the page is left on it
    for (const english of [
      en.plan.back,
      en.plan.history.heading,
      en.plan.history.lead,
      en.plan.history.hint,
      en.plan.history.deposits.note,
      en.plan.parts.heading,
      en.plan.parts.outside,
      en.plan.exit.heading,
      en.plan.exit.lead,
      en.plan.risk.heading,
      en.plan.risk.lead,
      en.plan.risk.flags.heading,
      en.plan.trades.heading,
      en.plan.trades.lead,
      en.plan.activity.note,
      'basis point',
      'Our keeper',
    ])
      expect(said(host)).not.toContain(english);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('says the states in Portuguese too: a vault never read, and no plan at the address', async () => {
    const pt = portfolioDictionary('pt');
    api();
    signIn();
    const never = await open('solana', SOL_NEVER, 'pt');
    expect(text(never)).toContain(pt.plan.unread);
    expect(text(never)).toContain(pt.plan.trades.none);
    await unmountAll();
    const none = await open('solana', 'nada', 'pt');
    expect(text(find(none, 'h1'))).toBe(pt.plan.title);
    expect(text(find(none, '[data-ui="card-empty"] p'))).toBe(
      'Não há plano seu para mostrar neste endereço.',
    );
  });
});

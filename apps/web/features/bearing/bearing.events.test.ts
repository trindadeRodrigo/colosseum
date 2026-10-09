// @vitest-environment happy-dom

import { DISCLAIMER } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeChart } from '../../components/ui/TimeChart';
import { click, find, fire, mount, press, unmountAll } from '../../components/ui/test/dom';
import { BearingProvider, TICK_MS } from './BearingProvider';
import { Banner } from './BearingShell';
import { DexPage, HISTORIES_AT_ONCE } from './DexPage';
import { R } from './data';
import { mk, none, sumFact } from './fact';
import { LendingPage } from './LendingPage';
import { Fig, MultiSelect, Pie } from './parts';
import { inPortuguese, onSnapshot } from './test/cases';
import { snapshotReader } from './test/snapshot';
import type { LiqHistBody, LiquidityBody } from './types';

// Bearing's pages as a person uses them, in happy-dom, on Rodrigo's recording of the risk API.

vi.mock('next/navigation', () => ({
  usePathname: () => '/analytics/commodities',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
      h('a', { href, ...rest }, children as never),
  };
});

afterEach(unmountAll);
beforeEach(() => localStorage.clear());

/** Lets the reads settle and React render what they brought. */
async function settle(host: HTMLElement, done: (h: HTMLElement) => boolean) {
  for (let i = 0; i < 200 && !done(host); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  if (!done(host)) throw new Error('the page never finished reading');
}
const busy = (h: HTMLElement) =>
  h.querySelector('[data-ui="waiting"]') != null ||
  [...h.querySelectorAll('p')].some((p) => /^(Reading|Pricing)/.test(p.textContent ?? ''));
const ready = (h: HTMLElement) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h);
/** The card of the chart, beside the pie's. */
const chartCard = (h: HTMLElement) =>
  [...h.querySelectorAll<HTMLElement>('[data-ui="bearing-card"]')][1] as HTMLElement;
/** A button of the chart's metric selector; `group` is the selector's name in the reader's words. */
const metric = (h: HTMLElement, name: string, group = 'Metric') =>
  [...h.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`)].find(
    (b) => b.textContent === name,
  ) as HTMLButtonElement;

describe('the commodities page on the recording', () => {
  it('says every figure is stale, and gives every figure its pin and its age; nothing is MOCK', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const banner = find(host, '[data-ui="bearing-banner"]');
    expect(banner.getAttribute('data-mode')).toBe('stale');
    expect(banner.textContent).toContain('Every figure is stale: measured, only old.');
    const figures = [...host.querySelectorAll('[data-ui="figure"]')];
    expect(figures.length).toBeGreaterThan(10);
    for (const f of figures) {
      expect(f.getAttribute('data-state')).toBe('stale');
      expect(f.querySelector('[data-ui="pin"]')).not.toBeNull();
      expect(f.querySelector('[data-ui="stale-tag"]')?.textContent).toMatch(
        /^stale · \d+ (min|h|d)$/,
      );
    }
    expect(host.textContent).not.toContain('MOCK');
    const kpis = find(host, '[data-ui="bearing-kpis"]').textContent ?? '';
    expect(kpis).toContain('$184.1K');
    expect(kpis).toContain('≥ $870.3K');
    expect(kpis).toContain('weekend');
  });

  it('pins every figure a chart’s readout names, as the figures beside it are (rule 1)', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const readouts = [...host.querySelectorAll('[data-ui="chart-readout"]')];
    expect(readouts.length).toBeGreaterThan(0);
    for (const readout of readouts) {
      const figures = [...readout.querySelectorAll('[data-ui="figure"]')];
      expect(figures.length, readout.textContent ?? '').toBeGreaterThan(0);
      for (const f of figures) {
        expect(f.querySelector('[data-ui="pin"]')).not.toBeNull();
        // the recording is old: its pins say so, with the age
        expect(f.getAttribute('data-state')).toBe('stale');
      }
    }
  });

  it('makes each ticker in the table a 24px target (WCAG 2.5.8)', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const tickers = [...host.querySelectorAll('a[href^="/analytics/simulation?asset="]')];
    expect(tickers.length).toBeGreaterThan(0);
    for (const a of tickers)
      expect(a.className.split(' ')).toEqual(expect.arrayContaining(['min-h-6', 'min-w-6']));
  });

  it('the asset filter narrows every block, and None says nothing is selected', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const assets = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-ui="bearing-multi"] > button'),
    ][0] as HTMLButtonElement;
    expect(assets.textContent).toContain('All (1)');
    await click(assets);
    expect(assets.getAttribute('aria-expanded')).toBe('true');
    const none = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'None',
    ) as HTMLButtonElement;
    await click(none);
    expect(assets.textContent).toContain('None');
    expect(host.textContent).toContain('nothing selected');
    assets.focus();
    await press(document, 'Escape');
    expect(assets.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(assets);
  });

  it('the side menu hides to a rail and shows again, says so, and remembers it', async () => {
    const host = await mount(onSnapshot(null));
    const toggle = find<HTMLButtonElement>(host, 'button[aria-controls="bearing-nav"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide menu');
    // the methodology is reached from here: the bar has no Resources item (Thom, Oct 6)
    expect(
      find(host, '#bearing-nav a[href="/analytics/methodology?chain=solana"]').textContent,
    ).toBe('Methodology');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show menu');
    expect(localStorage.getItem('tf-an2-side')).toBe('1');
    expect(find(host, '[data-ui="bearing"]').hasAttribute('data-collapsed')).toBe(true);
    expect(find(host, 'a[aria-current="page"]').textContent).toContain('Commodities');
  });
});

describe('the recorded pools on the commodities page', () => {
  // Gold's two recorded pools: one against USDC, one against a token with no measured way to dollars.
  const USDC_POOL = '78ReVNMLGRWmjtf2HmBoHUe2pRcsctXTTbxJnbhchyze';
  const OTHER_POOL = '7WQcQi2dDgZDnpJKwoY7F9cALk3QEUG4kAyhtjZVkVa1';
  const NO_USD = 'no USD price for the quote token';

  /** His recording, with one pool answered as the API answers a quote token that has no price in dollars. */
  function withNoUsd(pool: string) {
    const recording = snapshotReader();
    return {
      ...recording,
      get: async <T>(path: string) => {
        const r = await recording.get<T>(path);
        if (!r.ok) return r;
        if (path === R.liquidity(pool)) {
          const d = r.body as LiquidityBody;
          const body: LiquidityBody = {
            ...d,
            bands: d.bands.map((band) => ({ ...band, amountUsd: null })),
            totalAssetUsd: null,
            totalQuoteUsd: null,
            usdNullReason: 'no_quote_price',
          };
          return { ...r, body: body as T };
        }
        if (path === R.liqHist(pool)) {
          const h = r.body as LiqHistBody;
          const body: LiqHistBody = {
            ...h,
            points: h.points.map((p) => ({
              ...p,
              valueUsd: null,
              assetUsd: null,
              usdNullReason: 'no_quote_price',
            })),
          };
          return { ...r, body: body as T };
        }
        return r;
      },
    };
  }
  /** Picks an option of a select the way React hears it: the value, then a `change` event. */
  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('captions a recording as the pool’s newest, and cites the answer’s own source under the chart', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(host, ready);
    await click(metric(host, 'Liquidity'));
    await settle(host, (h) => h.querySelector('[data-ui="dist-chart"]') != null && !busy(h));
    const card = chartCard(host);
    const head = find(card, '[data-ui="chart-head"]');
    expect(head.textContent).toContain(
      'held within ±30% of the price, from the pool’s newest recording, 2026-10-03 15:12 UTC;',
    );
    expect(head.textContent).not.toMatch(/collector|hourly/);
    expect(find(head, '[data-ui="figure"] .tf-figure').textContent).toBe('$831.9K');
    // whose recording it is, the answer says itself, beside its time and its pin
    const src = find(card, '[data-ui="bearing-src"]');
    expect(src.textContent).toContain(
      'pool collector hourly raw recording (Solana RPC getMultipleAccounts: pool head + every tick/bin array), decoded by packages/risk/src/pools · 2026-10-03T15:12:02Z',
    );
    expect(src.querySelector('[data-ui="pin"]')).not.toBeNull();
  });

  it('says a pool has no dollar figure in place of its total and its bands; no $0 is shown', async () => {
    const host = await mount(
      onSnapshot(createElement(DexPage, { page: 'commodities' }), withNoUsd(OTHER_POOL)),
    );
    await settle(host, ready);
    await click(metric(host, 'Liquidity'));
    await settle(host, (h) => h.querySelector('[data-ui="dist-chart"]') != null && !busy(h));
    await choose(find<HTMLSelectElement>(chartCard(host), 'select'), OTHER_POOL);
    await settle(host, (h) => h.querySelector('[data-ui="dist-chart"]') == null && !busy(h));
    const card = chartCard(host);
    expect(card.textContent).toContain('Liquidity by price band, both sides');
    expect(find(card, '[data-ui="bearing-reason"]').textContent).toBe(NO_USD);
    // no figure, so no pin and no source line: nothing here is a measured amount
    expect(card.querySelectorAll('[data-ui="figure"]')).toHaveLength(0);
    expect(card.querySelector('[data-ui="bearing-src"]')).toBeNull();
    expect(card.textContent).not.toMatch(/\$0(?![\d.,])/);
  });

  it('says the same reason for that pool’s TVL over time, not that it was not collected', async () => {
    const reader = withNoUsd(OTHER_POOL);
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' }), reader));
    await settle(host, ready);
    // the pool filter: that pool alone
    const pools = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-ui="bearing-multi"] > button'),
    ][1] as HTMLButtonElement;
    await click(pools);
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'None') as HTMLElement,
    );
    await click(find(host, `input[type="checkbox"][value="${OTHER_POOL}"]`));
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    const card = chartCard(host);
    // the pool is recorded and not in the sum: the note counts it apart, and nothing as in the sum
    expect(card.textContent).toContain(
      '0 of 1 selected pools are recorded and in the sum; the value of the tokens their liquidity holds, uncollected fees not counted. 1 is recorded and has no USD price for the quote token, so it is not in the sum. A pool not recorded',
    );
    expect(
      [...card.querySelectorAll('[data-ui="bearing-reason"]')].map((r) => r.textContent),
    ).toEqual([NO_USD, NO_USD]);
    expect(card.textContent).not.toContain('not collected yet');
    expect(card.querySelectorAll('[data-ui="figure"]')).toHaveLength(0);
    // its registry row says its quote token has no way to dollars: its history was not asked for
    expect(reader.read).not.toContain(R.liqHist(OTHER_POOL));
  });

  it('counts that pool as a pool short in a sum with the other, a lower bound', async () => {
    const host = await mount(
      onSnapshot(createElement(DexPage, { page: 'commodities' }), withNoUsd(OTHER_POOL)),
    );
    await settle(host, ready);
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    const head = find(chartCard(host), '[data-ui="chart-head"]');
    expect(find(head, '[data-ui="figure"] .tf-figure').textContent).toBe('≥ $915.8K');
  });

  it('the note counts the pool in the sum and its share, and says the other recorded one apart', async () => {
    // his recording as it is: of gold's two recorded pools, one is against USDC (41.44% of the TVL
    // of the 63 selected) and one against a token with no measured way to dollars (17.53%)
    const reader = snapshotReader();
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' }), reader));
    await settle(host, ready);
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    const head = find(chartCard(host), '[data-ui="chart-head"]');
    expect(head.textContent).toContain(
      '1 of 63 selected pools is recorded and in the sum, holding 41.44% of the selection’s TVL; the value of the tokens its liquidity holds, uncollected fees not counted. 1 more is recorded and has no USD price for the quote token, so it is not in the sum. A pool not recorded in an hour keeps its last value for up to 6 h. No recording is older than 2026-10-01.',
    );
    expect(head.textContent).not.toContain('58.97%');
    expect(find(head, '[data-ui="figure"] .tf-figure').textContent).toBe('≥ $915.8K');
    // one history read, the USDC pool's; the other pool is counted from its registry row alone
    expect(reader.read.filter((path) => path.includes('/liquidity/history'))).toEqual([
      R.liqHist(USDC_POOL),
    ]);
  });

  it('says the note in Portuguese too', async () => {
    const host = await mount(
      inPortuguese(onSnapshot(createElement(DexPage, { page: 'commodities' }))),
    );
    await settle(host, ready);
    await click(metric(host, 'TVL no tempo', 'Métrica'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    expect(find(chartCard(host), '[data-ui="chart-head"]').textContent).toContain(
      '1 de 63 pools selecionados é registrado e entra na soma, com 41,44% do TVL da seleção; o valor dos tokens que a liquidez dele guarda, sem contar taxas não coletadas. Mais 1 é registrado e não tem preço em dólar para a moeda de cotação, por isso não entra na soma. Um pool sem registro',
    );
  });

  it('counts a pool whose every recording read has no price with the one left unread: none in the sum', async () => {
    // the USDC pool answered as a pool is whose recordings all lack a price: its row does not say
    // so, its history is read, and it is the history that says it
    const reader = withNoUsd(USDC_POOL);
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' }), reader));
    await settle(host, ready);
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    const card = chartCard(host);
    expect(card.textContent).toContain(
      '0 of 63 selected pools are recorded and in the sum; the value of the tokens their liquidity holds, uncollected fees not counted. 2 are recorded and have no USD price for the quote token, so they are not in the sum. A pool not recorded',
    );
    expect(
      [...card.querySelectorAll('[data-ui="bearing-reason"]')].map((r) => r.textContent),
    ).toEqual([NO_USD, NO_USD]);
    expect(reader.read).toContain(R.liqHist(USDC_POOL));
    expect(reader.read).not.toContain(R.liqHist(OTHER_POOL));
  });

  it('says a history did not load, not the other pool’s missing price, when a read fails', async () => {
    const recording = snapshotReader();
    const reader = {
      ...recording,
      get: async <T>(path: string) =>
        path === R.liqHist(USDC_POOL)
          ? { ok: false as const, status: 503, body: { error: 'busy' }, reason: 'api_error' }
          : recording.get<T>(path),
    };
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' }), reader));
    await settle(host, ready);
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    const card = chartCard(host);
    expect(
      [...card.querySelectorAll('[data-ui="bearing-reason"]')].map((r) => r.textContent),
    ).toEqual(['the API returned no answer', 'the API returned no answer']);
    // the pool that did not load is in neither of those counts: nothing is known of it, and the
    // note says so apart, with why
    expect(card.textContent).toContain(
      '0 of 63 selected pools are recorded and in the sum; the value of the tokens their liquidity holds, uncollected fees not counted. 1 is recorded and has no USD price for the quote token, so it is not in the sum. 1 more did not load (the API returned no answer), so it is not in the sum. A pool not recorded',
    );
    expect(card.querySelectorAll('[data-ui="figure"]')).toHaveLength(0);
  });
});

describe('the recorded pools on the stocks page: thirty of them, one with no way to dollars', () => {
  // SPYx's recorded pool against a token with no measured way to dollars (exit path `other`).
  const SPY_OTHER = '7a8xxAJBELDo6P9dikSYctdw6ce8F4mWr3ahcAD8Ao49';
  const isHistory = (path: string) => path.includes('/liquidity/history');

  /** His recording, each history a moment in coming, as the API's is, and the most open at once. */
  function watched() {
    const recording = snapshotReader();
    const seen = { asked: [] as string[], open: 0, most: 0 };
    return {
      seen,
      reader: {
        ...recording,
        get: async <T>(path: string) => {
          if (!isHistory(path)) return recording.get<T>(path);
          seen.asked.push(path);
          seen.most = Math.max(seen.most, ++seen.open);
          await new Promise((r) => setTimeout(r, 3));
          seen.open--;
          return recording.get<T>(path);
        },
      },
    };
  }

  it('asks for no history of that pool, and for the others a few at a time', async () => {
    const { reader, seen } = watched();
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'stocks' }), reader));
    await settle(host, ready);
    expect(seen.asked).toEqual([]);
    await click(metric(host, 'TVL over time'));
    await settle(host, (h) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h));
    // thirty recorded pools are selected: twenty-nine histories, each asked for once
    expect(seen.asked).toHaveLength(29);
    expect(new Set(seen.asked).size).toBe(29);
    expect(seen.asked).not.toContain(R.liqHist(SPY_OTHER));
    // never more than the bound in flight, and that many when there are that many to read
    expect(seen.most).toBe(HISTORIES_AT_ONCE);
    expect(seen.open).toBe(0);
    expect(find(chartCard(host), '[data-ui="chart-head"]').textContent).toContain(
      '29 of 929 selected pools are recorded and in the sum, holding 75.10% of the selection’s TVL; the value of the tokens their liquidity holds, uncollected fees not counted. 1 more is recorded and has no USD price for the quote token, so it is not in the sum. A pool not recorded',
    );
    // the whole stocks page is mounted, 46 assets and 929 pools: slower than the tests of one asset
  }, 20_000);

  // Tesla's two recorded pools, and Apple's two, which are far down the queue of the 29.
  const TSLA = '8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF';
  const TSLA_SMALL = 'HHQUnUbmWLrYzkscDY1C3deEFbGtiGBGoHjpANogmvum';
  const APPLE = [
    'CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y',
    'ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT',
  ];
  const HAS_NO_USD =
    ' uncollected fees not counted. 1 more is recorded and has no USD price for the quote token, so it is not in the sum.';

  /** The stocks page on a reader, its chart on TVL over time; the reads are left as they stand. */
  async function onTvl(reader = snapshotReader()) {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'stocks' }), reader));
    await settle(host, ready);
    await click(metric(host, 'TVL over time'));
    return host;
  }
  const drawn = (h: HTMLElement) => h.querySelector('[data-ui="time-chart"]') != null && !busy(h);
  const head = (h: HTMLElement) => find(chartCard(h), '[data-ui="chart-head"]');
  const figure = (h: HTMLElement) => find(head(h), '[data-ui="figure"] .tf-figure').textContent;
  const readout = (h: HTMLElement) => find(chartCard(h), '[data-ui="chart-readout"]').textContent;
  /** The line that says how many histories are still being read; none once all have come. */
  const reading = (h: HTMLElement) =>
    chartCard(h).querySelector('[data-ui="bearing-reading"]')?.textContent;

  /** His recording, each history held back until the test lets it come. */
  function held() {
    const recording = snapshotReader();
    const seen = { asked: [] as string[], open: 0, most: 0 };
    const waiting: Array<() => void> = [];
    return {
      seen,
      /** Lets the next `n` histories asked for come, one by one, the page taking each in. */
      come: async (n: number) => {
        for (let i = 0; i < n; i++)
          await act(async () => {
            waiting.shift()?.();
            await new Promise((r) => setTimeout(r, 0));
          });
      },
      reader: {
        ...recording,
        get: async <T>(path: string) => {
          if (!isHistory(path)) return recording.get<T>(path);
          seen.asked.push(path);
          seen.most = Math.max(seen.most, ++seen.open);
          await new Promise<void>((come) => waiting.push(come));
          seen.open--;
          return recording.get<T>(path);
        },
      },
    };
  }

  it('the note counts the pools of the figure’s own hour: one whose newest recording is 7 h behind is not one', async () => {
    // Tesla's smaller pool, each of its recordings set 7 hours back: the newest is of 08:42, and the
    // figure is taken from the hour of 15:00
    const recording = snapshotReader();
    const reader = {
      ...recording,
      get: async <T>(path: string) => {
        const r = await recording.get<T>(path);
        if (path !== R.liqHist(TSLA_SMALL) || !r.ok) return r;
        const h = r.body as LiqHistBody;
        const back = (t: string) => new Date(Date.parse(t) - 7 * 3600e3).toISOString();
        const body: LiqHistBody = { ...h, points: h.points.map((p) => ({ ...p, t: back(p.t) })) };
        return { ...r, body: body as T };
      },
    };
    const host = await onTvl(reader);
    await settle(host, drawn);
    // 28 pools in the figure, and 28 in the note: 75.10% less that pool's $431K of $39.08M
    expect(readout(host)).toContain('(28 of 30 pools)');
    expect(head(host).textContent).toContain(
      // 28 in the sum, 1 with no USD price, 1 too old for this hour: the 30 recorded pools, each said once
      `28 of 929 selected pools are recorded and in the sum, holding 74.00% of the selection’s TVL; the value of the tokens their liquidity holds,${HAS_NO_USD} 1 more has no recording within 6 h of the newest hour, so it is not in the sum. A pool not recorded`,
    );
    expect(figure(host)).toMatch(/^≥ \$/);
  }, 20_000);

  it('asks once more for a history that did not come, and says the one that still did not, with why', async () => {
    // Tesla's smaller pool never comes; its larger one fails the first time and comes the second
    const recording = snapshotReader();
    const asked: string[] = [];
    const reader = {
      ...recording,
      get: async <T>(path: string) => {
        if (!isHistory(path)) return recording.get<T>(path);
        asked.push(path);
        const first = asked.filter((x) => x === path).length === 1;
        return path === R.liqHist(TSLA_SMALL) || (path === R.liqHist(TSLA) && first)
          ? { ok: false as const, status: 503, body: { error: 'busy' }, reason: 'api_error' }
          : recording.get<T>(path);
      },
    };
    const host = await onTvl(reader);
    await settle(host, drawn);
    // each of the two was asked for twice, and no other more than once
    expect(asked).toHaveLength(31);
    expect(new Set(asked).size).toBe(29);
    expect(asked.filter((x) => x === R.liqHist(TSLA))).toHaveLength(2);
    expect(asked.filter((x) => x === R.liqHist(TSLA_SMALL))).toHaveLength(2);
    // the one that came the second time is in the sum; the other is said apart, and is not “no price”
    expect(readout(host)).toContain('(28 of 30 pools)');
    expect(head(host).textContent).toContain(
      `28 of 929 selected pools are recorded and in the sum, holding 74.00% of the selection’s TVL; the value of the tokens their liquidity holds,${HAS_NO_USD} 1 more did not load (the API returned no answer), so it is not in the sum. A pool not recorded`,
    );
    expect(figure(host)).toMatch(/^≥ \$/);
  }, 20_000);

  it('draws with the histories that have come, keeps the selector, and ends as a read all at once does', async () => {
    const { reader, seen, come } = held();
    const host = await onTvl(reader);
    const pressed = () =>
      metric(chartCard(host), 'TVL over time')?.getAttribute('aria-pressed') ?? 'no selector';
    // none has come: the frame of the chart and what it waits for, under the selector
    expect(seen.asked).toHaveLength(HISTORIES_AT_ONCE);
    expect(chartCard(host).querySelector('[data-ui="time-chart"]')).toBeNull();
    expect(chartCard(host).querySelector('[data-ui="waiting"]')).not.toBeNull();
    expect(pressed()).toBe('true');
    // the first four have come: the chart is drawn with them, a lower bound that says how many
    // pools it holds, and the card says how many are still being read
    await come(HISTORIES_AT_ONCE);
    expect(reading(host)).toBe('Reading 25 recorded pools…');
    expect(figure(host)).toMatch(/^≥ \$/);
    expect(readout(host)).toContain('(4 of 30 pools)');
    // the four largest recorded pools: $11.60M of the selection's $39.08M
    expect(head(host).textContent).toContain(
      '4 of 929 selected pools are recorded and in the sum, holding 29.68% of the selection’s TVL;',
    );
    expect(pressed()).toBe('true');
    // the chart says it is busy, and its readout does not announce each figure that changes under it
    const chart = find(chartCard(host), '[data-ui="time-chart"]');
    expect(chart.getAttribute('aria-busy')).toBe('true');
    expect(find(chart, '[data-ui="chart-readout"]').getAttribute('aria-live')).toBe('off');
    // three more, one by one: the count of pools read grows
    await come(3);
    expect(reading(host)).toBe('Reading 22 recorded pools…');
    expect(readout(host)).toContain('(7 of 30 pools)');
    expect(head(host).textContent).toContain(
      '7 of 929 selected pools are recorded and in the sum,',
    );
    // the rest: nothing is still being read, and never more than the bound was
    await come(22);
    await settle(host, drawn);
    expect(reading(host)).toBeUndefined();
    // the same chart all along, not one drawn afresh for each history
    expect(find(chartCard(host), '[data-ui="time-chart"]')).toBe(chart);
    expect(chart.hasAttribute('aria-busy')).toBe(false);
    expect(seen.asked).toHaveLength(29);
    expect(seen.most).toBe(HISTORIES_AT_ONCE);
    // and the card is the one a read all at once ends in, to the letter
    const whole = await onTvl();
    await settle(whole, drawn);
    expect(chartCard(whole).textContent).toContain(
      '29 of 929 selected pools are recorded and in the sum, holding 75.10% of the selection’s TVL;',
    );
    expect(chartCard(host).innerHTML).toBe(chartCard(whole).innerHTML);
  }, 20_000);

  it('stops reading a selection that was left, and the next one waits its turn behind the reads still out', async () => {
    const { reader, seen, come } = held();
    const host = await onTvl(reader);
    await come(2);
    // every stock is selected: six of its 29 histories have been asked for, and four are out
    expect(seen.asked).toHaveLength(6);
    expect(seen.open).toBe(HISTORIES_AT_ONCE);
    const before = [...seen.asked];
    const apple = APPLE.map((pool) => R.liqHist(pool));
    expect(before.filter((path) => apple.includes(path))).toEqual([]);
    // the selection changes to Apple alone
    await click(
      [...host.querySelectorAll('[data-ui="bearing-multi"] > button')][0] as HTMLButtonElement,
    );
    await click(
      [...host.querySelectorAll('button')].find((b) => b.textContent === 'None') as HTMLElement,
    );
    await click(find(host, 'input[type="checkbox"][value="AAPLx"]'));
    // the four reads out are let finish, and Apple's wait behind them: nothing new is asked for
    expect(seen.asked).toEqual(before);
    expect(seen.open).toBe(HISTORIES_AT_ONCE);
    // they come, and Apple's two after them
    await come(HISTORIES_AT_ONCE + apple.length);
    await settle(host, drawn);
    // of the selection that was left, not one more history was asked for after the change
    const after = seen.asked.slice(before.length);
    expect(after.filter((path) => !apple.includes(path))).toEqual([]);
    expect(after).toEqual(apple);
    // and the bound held throughout, the reads of both selections counted together
    expect(seen.most).toBe(HISTORIES_AT_ONCE);
    expect(seen.open).toBe(0);
    // Apple's chart: its two recorded pools, of its 35
    expect(head(host).textContent).toContain(
      '2 of 35 selected pools are recorded and in the sum, holding 75.98% of the selection’s TVL;',
    );
  }, 20_000);
});

describe('the lending page’s tolerance', () => {
  it('refuses a tolerance out of 0.1% to 10% and says what to change', async () => {
    const host = await mount(onSnapshot(createElement(LendingPage)));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const box = find<HTMLInputElement>(host, 'input[aria-describedby~="bearing-tol-err"]');
    expect(find(host, '[data-ui="bearing-kpis"]').textContent).toContain('≥ 6.82%');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(box, '50');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(box, 'Enter');
    expect(find(host, '#bearing-tol-err').textContent).toBe('Between 0.1% and 10%');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('a figure', () => {
  const live = (children: unknown) =>
    createElement(BearingProvider, {
      reader: snapshotReader(),
      now: Date.parse('2026-10-03T12:00:00Z'),
      children,
    } as never);

  it('a lower bound is shown with ≥, an assumption says so, and no value shows its reason, with no pin', async () => {
    const host = await mount(
      live([
        createElement(Fig, {
          key: 1,
          f: mk(1500, {
            source: 's',
            fetchedAt: '2026-10-03T11:00:00Z',
            method: 'm',
            quality: 'lower_bound',
          }),
          fmt: (v: number) => `$${v}`,
        }),
        createElement(Fig, {
          key: 2,
          f: mk(9, {
            source: 's',
            fetchedAt: '2026-10-03T11:00:00Z',
            method: 'm',
            quality: 'assumption',
          }),
          fmt: String,
        }),
        createElement(Fig, { key: 3, f: none('gate_open'), fmt: String }),
      ]),
    );
    const figs = host.querySelectorAll('[data-ui="figure"]');
    expect(figs).toHaveLength(2);
    expect(figs[0]?.querySelector('.tf-figure')?.textContent).toBe('≥ $1500');
    expect(host.textContent).toContain('assumption');
    expect(find(host, '[data-ui="bearing-reason"]').textContent).toBe('waiting on an open gate');
  });
});

describe('the time chart', () => {
  it('the arrow keys step the readout through the hours; the range tabs say which is on', async () => {
    const t0 = Date.parse('2026-10-03T10:00:00Z');
    const data = [0, 1, 2].map((i) => ({ t: t0 + i * 3600e3, v: 100 + i }));
    const host = await mount(
      createElement(TimeChart, {
        title: 'Exit capacity',
        aria: 'Exit capacity over time',
        hourly: true,
        ranges: [
          { label: '24 h', ms: 864e5 },
          { label: '7 d', ms: 7 * 864e5 },
        ],
        panes: [
          {
            h: 100,
            fmt: (v: number) => `$${v}`,
            series: [{ type: 'area', cls: 's1', label: 'sell (exit)', data }],
          },
        ],
      }),
    );
    const readout = () => find(host, '[data-ui="chart-readout"]').textContent;
    expect(readout()).toContain('2026-10-03 12:00 UTC');
    expect(readout()).toContain('$102');
    const plot = find(host, '[data-ui="chart-plot"]');
    await press(plot, 'ArrowLeft');
    expect(readout()).toContain('2026-10-03 11:00 UTC');
    await press(plot, 'Home');
    expect(readout()).toContain('$100');
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Range"] button')];
    expect(tabs.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    await click(tabs[1] as HTMLButtonElement);
    expect(tabs.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('follows a mouse over the plot to the hour under it, and lets go when it leaves', async () => {
    // a browser measures the chart 640 wide; happy-dom measures nothing
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    const t0 = Date.parse('2026-10-03T10:00:00Z');
    const data = [0, 1, 2].map((i) => ({ t: t0 + i * 3600e3, v: 100 + i }));
    const host = await mount(
      createElement(TimeChart, {
        title: 'Exit capacity',
        aria: 'Exit capacity over time',
        hourly: true,
        panes: [
          {
            h: 100,
            fmt: (v: number) => `$${v}`,
            series: [{ type: 'area', cls: 's1', label: 'sell (exit)', data }],
          },
        ],
      }),
    );
    const readout = () => find(host, '[data-ui="chart-readout"]').textContent;
    const svg = find(host, '[data-ui="chart-plot"] svg');
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 640,
        height: 200,
        right: 640,
        bottom: 200,
        x: 0,
        y: 0,
      }) as DOMRect;
    const move = (type: string, clientX: number) =>
      fire(
        svg,
        new PointerEvent(type, { clientX, clientY: 40, pointerType: 'mouse', bubbles: true }),
      );
    // the first hour sits at the plot's left edge
    await move('pointermove', 10);
    expect(readout()).toContain('2026-10-03 10:00 UTC');
    expect(readout()).toContain('$100');
    expect(host.querySelectorAll('[data-ui="chart-cross"]')).toHaveLength(1);
    await fire(
      svg,
      new PointerEvent('pointerout', {
        bubbles: true,
        relatedTarget: document.body,
        pointerType: 'mouse',
      }),
    );
    expect(host.querySelectorAll('[data-ui="chart-cross"]')).toHaveLength(0);
  });
});

describe('the multi-select', () => {
  it('ticking every option means all again, not a list of all', async () => {
    const seen: Array<string[] | null> = [];
    const host = await mount(
      createElement(MultiSelect, {
        label: 'Pools',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        value: ['a'],
        onChange: (v: string[] | null) => seen.push(v),
      }),
    );
    await click(find(host, 'button[aria-expanded]'));
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    await click(boxes[1] as HTMLInputElement);
    expect(seen.at(-1)).toBeNull();
  });
});

describe('the language of the person', () => {
  const english = [
    'Every figure is stale',
    'Exit capacity now',
    'Hide menu',
    'Volume 24 h,',
    'View as table',
    'Lighter cells',
    'not collected yet',
    'Point at a slice',
  ];

  it('says the page in Portuguese for a Portuguese reader, with the same figures', async () => {
    const host = await mount(
      inPortuguese(onSnapshot(createElement(DexPage, { page: 'commodities' }))),
    );
    await settle(
      host,
      (h) => h.querySelector('[data-ui="heatmap-tile"] table') != null && !busy(h),
    );
    const text = host.textContent ?? '';
    expect(find(host, '[data-ui="bearing-banner"]').textContent).toContain(
      'Todo número está defasado',
    );
    expect(find(host, 'h1').textContent).toBe(
      'Quanto custa sair do ouro, e quanto os pools conseguem absorver.',
    );
    expect(find(host, 'a[aria-current="page"]').textContent).toContain('Commodities');
    expect(text).toContain('Esconder menu');
    expect(text).toContain('Capacidade de saída agora');
    expect(text).toContain('Ver como tabela');
    expect(text).toContain(DISCLAIMER.pt);
    // the same figures, written as Brazil writes them
    const kpis = (find(host, '[data-ui="bearing-kpis"]').textContent ?? '').replace(/\u00a0/g, ' ');
    expect(kpis).toContain('US$ 184,1 mil');
    expect(kpis).toContain('30,33%');
    expect(kpis).not.toContain('$184.1K');
    for (const phrase of english) expect(text, phrase).not.toContain(phrase);
  });

  it('keeps Rodrigo’s words, as he wrote them, for an English reader', async () => {
    const host = await mount(onSnapshot(createElement(DexPage, { page: 'commodities' })));
    await settle(
      host,
      (h) => h.querySelector('[data-ui="heatmap-tile"] table') != null && !busy(h),
    );
    expect(find(host, 'h1').textContent).toBe(
      'What it costs to leave gold, and how much the pools can take.',
    );
    expect(host.textContent).toContain(
      'Capacity is the largest sale that costs at most 1%, by time of week. Exit capacity is that figure hour by hour.',
    );
    expect(host.textContent).toContain(DISCLAIMER.en);
  });
});

describe('the banner: live, stale with time, or the API down', () => {
  const banner = (h: HTMLElement) => find(h, '[data-ui="bearing-banner"]');
  const settled = (h: HTMLElement) => banner(h).getAttribute('data-mode') !== 'loading';

  it('says live from the collectors, with the newest reading’s time, when it is recent', async () => {
    const host = await mount(
      createElement(BearingProvider, {
        reader: snapshotReader(),
        now: Date.parse('2026-10-03T15:17:00Z'),
        children: createElement(Banner),
      } as never),
    );
    await settle(host, settled);
    expect(banner(host).getAttribute('data-mode')).toBe('live');
    expect(banner(host).textContent).toContain('Live from the collectors, as of 15:07 UTC.');
    expect(banner(host).textContent).toContain('now: weekend');
  });

  it('waits in the page’s own boxes: its figures’ labels, the chart cards and the table, busy', async () => {
    // a reader that has not answered yet
    const waiting = { get: () => new Promise<never>(() => {}), probe: async () => true };
    const host = await mount(
      createElement(BearingProvider, {
        reader: waiting,
        now: Date.parse('2026-10-03T15:17:00Z'),
        children: [
          createElement(Banner, { key: 'b' }),
          createElement(DexPage, { key: 'p', page: 'stocks' }),
        ],
      } as never),
    );
    const region = find(host, '[data-ui="waiting"]');
    expect(region.getAttribute('aria-busy')).toBe('true');
    const kpis = [...region.querySelectorAll('[data-ui="bearing-kpi"]')];
    // no counter names the chain: the page's switch does, once
    for (const k of kpis) expect(k.querySelector('[data-ui="chain-badge"]')).toBeNull();
    expect(kpis.map((k) => k.firstElementChild?.textContent)).toEqual([
      'Pool TVL',
      'Pools',
      'Exit capacity now',
      'Volume 24 h',
      'Top-3 LP share',
    ]);
    expect(kpis.every((k) => k.querySelectorAll('[data-ui="skeleton"]').length === 2)).toBe(true);
    expect(
      region.querySelectorAll('[data-ui="bearing-card"] [data-ui="skeleton-chart"]'),
    ).toHaveLength(2);
    expect(region.querySelector('[data-ui="skeleton-rows"]')).not.toBeNull();
    // the banner keeps its box, still, and says nothing a screen reader would read twice
    expect(banner(host).getAttribute('aria-hidden')).toBe('true');
    expect(banner(host).getAttribute('role')).toBeNull();
    expect(host.querySelectorAll('[data-ui="figure"]')).toHaveLength(0);
  });

  it('says the API did not answer, and makes up nothing in its place', async () => {
    const down = {
      get: async () => ({ ok: false as const, status: 0, body: null, reason: 'api_error' }),
      probe: async () => false,
    };
    const host = await mount(
      createElement(BearingProvider, {
        reader: down,
        now: Date.parse('2026-10-03T15:17:00Z'),
        children: [
          createElement(Banner, { key: 'b' }),
          createElement(DexPage, { key: 'p', page: 'stocks' }),
        ],
      } as never),
    );
    await settle(host, (h) => settled(h) && !busy(h));
    expect(banner(host).getAttribute('data-mode')).toBe('none');
    expect(banner(host).textContent).toContain('did not answer');
    expect(host.textContent).toContain('the API returned no answer');
    expect(host.querySelectorAll('[data-ui="figure"]')).toHaveLength(0);
  });

  it('turns stale while it is open, once its newest reading ages past two hours', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-03T16:57:00Z')); // 1 h 50 min after the newest reading
      const host = await mount(
        createElement(BearingProvider, {
          reader: snapshotReader(),
          children: createElement(Banner),
        } as never),
      );
      await settle(host, settled);
      expect(banner(host).getAttribute('data-mode')).toBe('live');
      vi.setSystemTime(Date.parse('2026-10-03T17:17:00Z'));
      await act(async () => {
        vi.advanceTimersByTime(TICK_MS);
      });
      expect(banner(host).getAttribute('data-mode')).toBe('stale');
      expect(banner(host).textContent).toContain('Every figure is stale');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a missing figure is never drawn as a zero (STYLE rule 2)', () => {
  const live = (children: unknown) =>
    createElement(BearingProvider, {
      reader: snapshotReader(),
      now: Date.parse('2026-10-03T12:00:00Z'),
      children,
    } as never);
  const part = (v: number) =>
    mk(v, { source: 's', fetchedAt: '2026-10-03T11:00:00Z', method: 'm' });
  const short = sumFact([part(600), none('not_collected'), part(200)], {});
  const usd = (v: number) => `$${v}`;

  it.each([
    ['en', 'of the 2 measured', '1 pool has no figure and is not drawn.'],
    ['pt', 'dos 2 medidos', '1 pool não tem número e não é desenhado.'],
  ] as const)(
    'a total with a part missing says it is of the measured ones, in %s',
    async (lang, words, line) => {
      const pie = createElement(Pie, {
        title: 'Supplied by pool',
        slices: [
          { label: 'A', value: 600 },
          { label: 'B', value: null },
          { label: 'C', value: 200 },
        ],
        total: short.value,
        totalHtml: createElement(Fig, { f: short, fmt: usd }),
      });
      const host = await mount(lang === 'pt' ? inPortuguese(live(pie)) : live(pie));
      // the total: a lower bound, and of how many
      expect(find(host, '[data-ui="bearing-pie"] .tf-figure').textContent).toBe('≥ $800');
      expect(find(host, '[data-ui="bearing-partial"]').textContent).toBe(words);
      // the pool with no figure gets no slice and no row; the pie says one is not drawn
      expect(host.querySelectorAll('[data-ui="bearing-pie"] svg path')).toHaveLength(2);
      const legend = [...host.querySelectorAll('[data-ui="bearing-pie"] li')].map(
        (li) => li.textContent,
      );
      expect(legend).toHaveLength(2);
      expect(legend[0]).toContain('A');
      expect(legend[0]).toContain('75');
      expect(legend[1]).toContain('C');
      expect(legend[1]).toContain('25');
      expect(legend.join(' ')).not.toContain('B');
      expect(find(host, '[data-ui="bearing-pie-missing"]').textContent).toBe(line);
    },
  );

  it.each([
    ['en', 'the stored value could not be used'],
    ['pt', 'o valor guardado não pôde ser usado'],
  ] as const)(
    'a stored value that is not a number says so in its own words, in %s',
    async (lang, words) => {
      const fig = createElement(Fig, {
        f: none('not_a_number', 'the measured value was not a finite number'),
        fmt: usd,
      });
      const host = await mount(lang === 'pt' ? inPortuguese(live(fig)) : live(fig));
      expect(find(host, '[data-ui="bearing-reason"]').textContent).toBe(words);
      expect(host.querySelector('[data-ui="figure"]')).toBeNull();
    },
  );

  it('a whole total carries no such words, and a pie with every pool measured no such line', async () => {
    const whole = sumFact([part(600), part(200)], {});
    const host = await mount(
      live(
        createElement(Pie, {
          title: 'Supplied by pool',
          slices: [
            { label: 'A', value: 600 },
            { label: 'C', value: 200 },
          ],
          total: whole.value,
          totalHtml: createElement(Fig, { f: whole, fmt: usd }),
        }),
      ),
    );
    expect(find(host, '[data-ui="bearing-pie"] .tf-figure').textContent).toBe('$800');
    expect(host.querySelector('[data-ui="bearing-partial"]')).toBeNull();
    expect(host.querySelector('[data-ui="bearing-pie-missing"]')).toBeNull();
  });

  it('with no total, the shares are of the pools drawn, and no slice is the size of a zero total', async () => {
    const host = await mount(
      live(
        createElement(Pie, {
          title: 'TVL by pool',
          slices: [
            { label: 'A', value: 300 },
            { label: 'C', value: 100 },
          ],
          total: null,
          totalHtml: createElement(Fig, { f: none('not_collected'), fmt: usd }),
        }),
      ),
    );
    const legend = [...host.querySelectorAll('[data-ui="bearing-pie"] li')].map(
      (li) => li.textContent,
    );
    expect(legend[0]).toContain('75');
    expect(legend[1]).toContain('25');
    expect(legend.join(' ')).not.toMatch(/∞|NaN|Infinity/);
  });
});

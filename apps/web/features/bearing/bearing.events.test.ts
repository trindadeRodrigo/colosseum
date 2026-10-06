// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeChart } from '../../components/ui/TimeChart';
import { click, find, mount, press, unmountAll } from '../../components/ui/test/dom';
import { BearingProvider } from './BearingProvider';
import { DexPage } from './DexPage';
import { mk, none } from './fact';
import { LendingPage } from './LendingPage';
import { Fig, MultiSelect } from './parts';
import { onSnapshot } from './test/cases';
import { snapshotReader } from './test/snapshot';

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
  [...h.querySelectorAll('p')].some((p) => /^(Reading|Pricing)/.test(p.textContent ?? ''));

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
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show menu');
    expect(localStorage.getItem('tf-an2-side')).toBe('1');
    expect(find(host, '[data-ui="bearing"]').hasAttribute('data-collapsed')).toBe(true);
    expect(find(host, 'a[aria-current="page"]').textContent).toContain('Commodities');
  });
});

describe('the lending page’s tolerance', () => {
  it('refuses a tolerance out of 0.1% to 10% and says what to change', async () => {
    const host = await mount(onSnapshot(createElement(LendingPage)));
    await settle(host, (h) => h.querySelector('[data-ui="bearing-kpis"]') != null && !busy(h));
    const box = find<HTMLInputElement>(host, 'input[aria-describedby="bearing-tol-err"]');
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

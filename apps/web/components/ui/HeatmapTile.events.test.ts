// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { HEAT_CELLS } from './fixtures/mock';
import { type HeatmapState, HeatmapTile } from './HeatmapTile';
import { click, find, mount, press, unmountAll } from './test/dom';

// bearing-heatmap-tile.md as a person uses it: one tab stop for the grid, the arrow keys through the
// hours, the hour read out; a cell with no sample is the ground with an en dash, never hatched; stale
// and MOCK put the band and their plate on the tile; "View as table" gives the same hours as a table.

afterEach(unmountAll);

const usdM = (v: number) => `$${(v / 1e6).toFixed(2)}M`;
const tile = (state: HeatmapState = { kind: 'live' }) =>
  createElement(HeatmapTile, {
    head: 'xAAPL · sellable at ≤ 2% impact',
    kpi: '$0.40M',
    cells: HEAT_CELLS,
    deeper: 'high',
    fmt: usdM,
    what: 'at ≤ 2%',
    zone: 'UTC',
    least: '$0.40M',
    most: '$2.36M',
    meta: 'USD · n=412 · method v1.3',
    state,
    aria: 'Sellable at ≤ 2% by hour of week',
  });
const cells = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('[role="grid"] td[data-how]'),
];
const cell = (host: HTMLElement, how: number) => find<HTMLElement>(host, `td[data-how="${how}"]`);
const readout = (host: HTMLElement) => find(host, '[aria-live="polite"]').textContent;

describe('the heatmap tile', () => {
  it('draws 7 days by 24 hours, with one tab stop for the grid', async () => {
    const host = await mount(tile());
    expect(find(host, '[role="grid"]').getAttribute('aria-label')).toBe(
      'Sellable at ≤ 2% by hour of week',
    );
    expect(cells(host)).toHaveLength(168);
    expect(cells(host).filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(host.querySelectorAll('th[scope="row"]')).toHaveLength(7);
    expect(host.querySelectorAll('th[scope="col"]')).toHaveLength(24);
  });

  it('moves through the hours with the arrow keys, Home and End, and reads the hour out', async () => {
    const host = await mount(tile());
    cell(host, 0).focus();
    await press(cell(host, 0), 'ArrowRight');
    expect(document.activeElement).toBe(cell(host, 1));
    expect(readout(host)).toBe(
      `Mon 01:00 UTC · ${usdM(HEAT_CELLS[1]?.value as number)} at ≤ 2% · n=${HEAT_CELLS[1]?.samples}`,
    );
    await press(cell(host, 1), 'ArrowDown');
    expect(document.activeElement).toBe(cell(host, 25));
    await press(cell(host, 25), 'End');
    expect(document.activeElement).toBe(cell(host, 47));
    await press(cell(host, 47), 'Home');
    expect(document.activeElement).toBe(cell(host, 24));
    expect(cells(host).filter((c) => c.tabIndex === 0)).toEqual([cell(host, 24)]);
    await press(cell(host, 24), 'ArrowUp');
    await press(cell(host, 0), 'ArrowUp');
    expect(document.activeElement).toBe(cell(host, 0));
  });

  it('draws an hour with no sample as the ground with an en dash, and names it so; never hatched', async () => {
    const host = await mount(tile());
    const none = cell(host, 4); // Monday 04:00 has no sample in the fixture
    expect(none.textContent).toBe('–');
    expect(none.getAttribute('aria-label')).toBe('Mon 04:00 UTC · no sample');
    expect(none.className).toContain('bg-background');
    expect(none.hasAttribute('data-level')).toBe(false);
    expect(find(host, '[role="grid"]').querySelector('.tf-hatch')).toBeNull();
    expect(host.textContent).toContain('– no sample');
  });

  it('puts the deepest hours on the fifth step and the thinnest on the first', async () => {
    const host = await mount(tile());
    const levels = cells(host).map((c) => Number(c.getAttribute('data-level') ?? 0));
    const deepest = HEAT_CELLS.reduce((a, b) => (b.value > a.value ? b : a));
    const thinnest = HEAT_CELLS.reduce((a, b) => (b.value < a.value ? b : a));
    expect(levels[deepest.day * 24 + deepest.hour]).toBe(5);
    expect(levels[thinnest.day * 24 + thinnest.hour]).toBe(1);
  });

  it('a stale tile has the band and "stale · 9 h"; a sample tile the band and its named glyph; a live one neither', async () => {
    const live = await mount(tile());
    expect(live.querySelector('.tf-hatch')).toBeNull();
    const stale = await mount(tile({ kind: 'stale', ageSec: 9 * 3600 }));
    expect(stale.querySelector('[data-ui="heatmap-tile"] > .tf-hatch')).not.toBeNull();
    expect(find(stale, '[data-ui="stale-plate"]').textContent).toContain('stale · 9 h');
    const mock = await mount(tile({ kind: 'mock' }));
    expect(mock.querySelector('[data-ui="heatmap-tile"] > .tf-hatch')).not.toBeNull();
    expect(mock.textContent).not.toContain('MOCK');
    expect(find(mock, '[data-ui="sample-glyph"]').getAttribute('aria-label')).toBe('sample figure');
  });

  it('shows the same hours as a table of days, which can put the deepest day first', async () => {
    const host = await mount(tile());
    const toggle = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'View as table',
    ) as HTMLButtonElement;
    await click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const rows = () => [...host.querySelectorAll('[data-ui="heatmap-table"] tbody tr')];
    expect(rows()).toHaveLength(7);
    expect(rows()[0]?.querySelector('th')?.textContent).toBe('Mon');
    expect(rows()[0]?.querySelectorAll('td')[4]?.textContent).toBe('–');
    const deep = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Deepest day first',
    ) as HTMLButtonElement;
    await click(deep);
    // ordered by the mean depth of each day's sampled hours, deepest first
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const mean = (d: number) => {
      const v = HEAT_CELLS.filter((c) => c.day === d).map((c) => c.value);
      return v.reduce((a, x) => a + x, 0) / v.length;
    };
    const expected = [0, 1, 2, 3, 4, 5, 6].sort((a, b) => mean(b) - mean(a)).map((d) => names[d]);
    expect(expected).not.toEqual(names);
    expect(rows().map((r) => r.querySelector('th')?.textContent)).toEqual(expected);
  });
});

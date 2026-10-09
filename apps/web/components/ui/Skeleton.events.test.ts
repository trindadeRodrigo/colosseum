// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton, SkeletonChart, SkeletonLine, SkeletonListRow, SkeletonTable } from './Skeleton';
import { GLOBALS } from './test/css';
import { find, mount, unmountAll } from './test/dom';

// The pieces a screen builds its wait from (Skeleton.tsx): each is still, hidden from a screen
// reader, has no role of its own and never draws a figure. What says "loading" is the region they
// stand in (Waiting.tsx), once.

afterEach(unmountAll);

const PIECES = {
  line: createElement(SkeletonLine, { className: 'text-body-sm', width: 'w-40' }),
  'list row': createElement(SkeletonListRow, {}),
  chart: createElement(SkeletonChart, { frame: 'h-[380px]' }),
  table: createElement(SkeletonTable, {
    rows: 3,
    columns: [{ track: '2fr' }, { align: 'end' }, { align: 'end' }],
  }),
};

describe('the skeleton’s pieces', () => {
  for (const [name, piece] of Object.entries(PIECES))
    it(`${name}: hidden from a screen reader, no role, no words and no figure`, async () => {
      const host = await mount(piece);
      const root = host.firstElementChild as HTMLElement;
      expect(root.getAttribute('aria-hidden')).toBe('true');
      // nothing inside is a status, a progress bar or anything else that would be announced
      expect(host.querySelectorAll('[role], progress, [aria-live], [aria-busy]')).toHaveLength(0);
      expect(host.querySelectorAll('a, button, input, select, [tabindex]')).toHaveLength(0);
      expect(host.textContent).toBe('');
      expect(host.querySelectorAll('[data-ui="skeleton"]').length).toBeGreaterThan(0);
    });

  it('a line sits in the text’s own type, so its box is the text’s', async () => {
    const host = await mount(
      createElement(SkeletonLine, { className: 'text-h4', width: 'w-72', lines: 3 }),
    );
    const line = find(host, '[data-ui="skeleton-line"]');
    expect(line.classList).toContain('text-h4');
    const bars = [...line.querySelectorAll('[data-ui="skeleton"]')];
    expect(bars).toHaveLength(3);
    // the bar's height follows the type; the last line is shorter, as a paragraph ends
    for (const bar of bars) expect(bar.classList).toContain('h-[0.7em]');
    expect(bars[0]?.classList).toContain('w-72');
    expect(bars[2]?.classList).toContain('w-3/5');
  });

  it('a table has the screen’s own columns: a head band, then a bar a cell', async () => {
    const host = await mount(PIECES.table);
    const table = find(host, '[data-ui="skeleton-table"]');
    const lines = [...table.children] as HTMLElement[];
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.style.gridTemplateColumns).toBe('2fr minmax(0,1fr) minmax(0,1fr)');
      expect(line.querySelectorAll('[data-ui="skeleton-line"]')).toHaveLength(3);
    }
    // a number's bar sits at the end of its column, where the number will
    expect(lines[1]?.children[1]?.classList).toContain('text-end');
    expect(lines[1]?.children[0]?.classList).not.toContain('text-end');
  });

  it('a list row has its mark, its name and what stands at its end', async () => {
    const row = await mount(PIECES['list row']);
    expect(row.querySelectorAll('[data-ui="skeleton"]')).toHaveLength(3);
    expect(find(row, '[data-ui="skeleton"].rounded-full')).toBeTruthy();
  });

  it('nothing pulses or shimmers, with motion or without: the boxes are still', async () => {
    const host = await mount(createElement(Skeleton, { className: 'h-4 w-10' }));
    const box = find(host, '[data-ui="skeleton"]');
    expect([...box.classList].filter((c) => /animate|transition|pulse|shimmer/.test(c))).toEqual(
      [],
    );
    const css = readFileSync(GLOBALS, 'utf8');
    expect(css).not.toMatch(/skeleton[^{]*\{[^}]*animation/);
    expect(css).not.toMatch(/@keyframes\s+(shimmer|pulse)/);
  });
});

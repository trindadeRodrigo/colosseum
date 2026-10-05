import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../../app/(app)/dev/ui/Showcase';
import { all, classes, closest, render, tag, text, ui } from './test/html';
import { SPEC_DIR } from './test/spec';

// The showcase is what the founders look at to accept the design system: every primitive, in light and
// in dark, under the name of its spec, with made-up content that says it is made up.

const page = render(createElement(Showcase));
const sections = all(page, tag('section')).filter((s) =>
  /-md$/.test(s.attrs['aria-labelledby'] ?? ''),
);
const specOf = (section: (typeof sections)[number]) => `${section.attrs['aria-labelledby']}`;

/** The specs that have a primitive, and the ones that do not yet. */
const BUILT = [
  'button',
  'field',
  'card',
  'provenance-pin',
  'mock-plate',
  'disclaimer-block',
  'data-table',
  'goal-card',
  'plan-leg',
  'exit-plan-line',
  'constraint-sheet',
  'composer',
  'compact-nav',
  'embed-shell',
  'subscribe-block',
  'token-mapping',
];
const NOT_BUILT = ['bearing-heatmap-tile', 'goal-showcase-case', 'joint-stage'];

describe('the showcase (/dev/ui)', () => {
  it('accounts for every component spec: built and shown, or listed as not built', () => {
    const specs = readdirSync(join(SPEC_DIR, 'components'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''));
    expect(specs).toHaveLength(19);
    expect([...BUILT, ...NOT_BUILT].sort()).toEqual(specs.sort());
  });

  it('says which specs are not built', () => {
    for (const name of NOT_BUILT) expect(text(page)).toContain(`${name}.md`);
  });

  it('has one section per built spec, under the name of the spec', () => {
    expect(sections.map(specOf).sort()).toEqual(BUILT.map((name) => `${name}-md`).sort());
    for (const section of sections) {
      const name = specOf(section).replace(/-md$/, '.md');
      expect(text(section)).toContain(`components/${name}`);
    }
  });

  it('shows every section twice: on paper and on warm black, the same specimens in each', () => {
    for (const section of sections) {
      const light = all(
        section,
        (el) => classes(el).includes('tf-app') && classes(el).includes('light'),
      );
      const dark = all(
        section,
        (el) => classes(el).includes('tf-app') && classes(el).includes('dark'),
      );
      expect(dark, specOf(section)).toHaveLength(1);
      const lit = light.at(-1);
      const states = (panel: typeof lit) => all(panel as never, tag('figcaption')).map(text);
      expect(states(lit).length, specOf(section)).toBeGreaterThan(0);
      expect(states(dark[0])).toEqual(states(lit));
    }
  });

  it('labels every panel MOCK: a note at the top of the page is not enough', () => {
    for (const section of sections)
      for (const panel of all(section, (el) => classes(el).includes('tf-app')).slice(-2)) {
        const plates = all(panel, ui('mock-plate'));
        expect(plates.length, specOf(section)).toBeGreaterThan(0);
        expect(text(plates[0] as never)).toContain('MOCK');
      }
    expect(text(all(page, tag('h1'))[0]?.parent as never)).toContain('MOCK');
  });

  it('shows the pin in each of its states', () => {
    const states = new Set(all(page, ui('figure')).map((el) => el.attrs['data-state']));
    expect([...states].sort()).toEqual(['live', 'missing', 'mock', 'stale']);
  });

  it('never shows a live-looking pin outside a panel that says MOCK', () => {
    for (const figure of all(
      page,
      (el) => el.attrs['data-ui'] === 'figure' && el.attrs['data-state'] === 'live',
    )) {
      const panel = closest(
        figure,
        (el) =>
          classes(el).includes('tf-app') &&
          (classes(el).includes('light') || classes(el).includes('dark')),
      );
      expect(panel && all(panel, ui('mock-plate')).length).toBeGreaterThan(0);
    }
  });

  it('spends the serif only where a spec does: the goal sentence, the wordmark, a marketing heading, the type specimen', () => {
    const serif = all(page, (el) => classes(el).includes('font-display'));
    for (const el of serif) {
      const home = closest(el, (e) =>
        ['goal-card', 'compact-nav', 'subscribe-block'].includes(e.attrs['data-ui'] ?? ''),
      );
      const specimen = closest(el, (e) => e.tag === 'figure' && text(e).startsWith('type'));
      expect(home !== null || specimen !== null, text(el)).toBe(true);
    }
  });

  it('writes in sentence case, with no exclamation marks, and MOCK as the only capitals', () => {
    const copy = text(page).replace(/MOCK/g, '');
    expect(copy).not.toMatch(/!/);
    expect(
      copy.match(/\b[A-Z]{4,}\b/g)?.filter((w) => !['USDC', 'USDY', 'HOVER'].includes(w)) ?? [],
    ).toEqual([]);
  });
});

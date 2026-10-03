import { createElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../../app/dev/ui/Showcase';
import * as cases from './test/cases';
import { hatchProblems } from './test/hatch';
import { all, classes, parse, render } from './test/html';

// mock-plate.md, "Enforcement": a hatch with no MOCK plate (or stale tag) in the same component fails.

describe('the hatch never appears without its word', () => {
  const groups = Object.entries(cases).flatMap(([group, set]) =>
    Object.entries(set as Record<string, unknown>)
      .filter(([, node]) => isValidElement(node))
      .map(([name, node]) => [`${group}.${name}`, node] as const),
  );

  it('reads every case of every primitive', () => {
    expect(groups.length).toBeGreaterThan(80);
  });

  it.each(groups)('%s', (_name, node) => {
    expect(hatchProblems(render(node as never))).toEqual([]);
  });

  it('holds on the whole showcase, which has hatches to check', () => {
    const page = render(createElement(Showcase));
    expect(all(page, (el) => classes(el).includes('tf-hatch')).length).toBeGreaterThan(20);
    expect(hatchProblems(page)).toEqual([]);
  });

  it('bites: a band alone, a hatched glyph alone, a word on the hatch', () => {
    const band = parse(
      '<div data-ui="card"><span class="tf-hatch w-1.5"></span><p>6.40%</p></div>',
    );
    expect(hatchProblems(band)).toHaveLength(1);
    expect(hatchProblems(band)[0]).toContain('no MOCK plate');
    const glyph = parse(
      '<span data-ui="figure">6.40%<button data-ui="pin"><svg data-hatch=""></svg></button></span>',
    );
    expect(hatchProblems(glyph)).toHaveLength(1);
    // the word in another row does not count
    const rows = parse(
      '<div data-ui="data-table"><div data-mock="true"><span class="tf-hatch"></span>a</div><div data-mock="true"><span data-ui="mock-plate">MOCK</span></div></div>',
    );
    expect(hatchProblems(rows)).toHaveLength(1);
    const onIt = parse(
      '<div data-ui="card"><span class="tf-hatch">MOCK</span><span data-ui="mock-plate">MOCK</span></div>',
    );
    expect(hatchProblems(onIt)).toEqual([expect.stringContaining('has text on its hatch')]);
    const stale = parse(
      '<div data-ui="card"><span class="tf-hatch"></span><span data-ui="stale-plate">stale · 3 h</span></div>',
    );
    expect(hatchProblems(stale)).toEqual([]);
  });
});

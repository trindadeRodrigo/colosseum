import { createElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../../app/(app)/dev/ui/Showcase';
import * as cases from './test/cases';
import { read, sourceFiles } from './test/css';
import { classTokens } from './test/forbidden';
import { hatchProblems } from './test/hatch';
import { all, classes, parse, render } from './test/html';

// mock-plate.md, "Enforcement", as MOCK-QUIET (Thom, Oct 6) changed it: a hatch with nothing that says
// sample or stale in the same component fails (the card's quiet line, a named glyph, a named pin, or
// "stale"), so does a glyph with no hatch or no name, and the boxed word MOCK is never drawn.

describe('the hatch never appears without words that say sample, and the word MOCK is never boxed', () => {
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

  it('bites: a band alone, a pin with no name, a word on the hatch', () => {
    const band = parse(
      '<div data-ui="card"><span class="tf-hatch w-1.5"></span><p>6.40%</p></div>',
    );
    expect(hatchProblems(band)).toEqual([expect.stringContaining('nothing that says sample')]);
    const glyph = parse(
      '<span data-ui="figure">6.40%<button data-ui="pin"><svg data-hatch=""></svg></button></span>',
    );
    expect(hatchProblems(glyph)).toHaveLength(1);
    // the line in another row does not count
    const rows = parse(
      '<div data-ui="data-table"><div data-mock="true"><span class="tf-hatch"></span>a</div><div data-mock="true"><p data-ui="sample-note">Sample figures</p></div></div>',
    );
    expect(hatchProblems(rows)).toEqual([expect.stringContaining('nothing that says sample')]);
    const onIt = parse(
      '<div data-ui="card"><span class="tf-hatch">sample</span><p data-ui="sample-note">Sample figures</p></div>',
    );
    expect(hatchProblems(onIt)).toEqual([expect.stringContaining('has text on its hatch')]);
    const stale = parse(
      '<div data-ui="card"><span class="tf-hatch"></span><span data-ui="stale-plate">stale · 3 h</span></div>',
    );
    expect(hatchProblems(stale)).toEqual([]);
  });

  it('bites the other way: a glyph with no hatch or no name, and the boxed word', () => {
    expect(
      hatchProblems(
        parse(
          '<p>6.40% <span data-ui="sample-glyph" role="img" aria-label="sample figure"></span></p>',
        ),
      ),
    ).toEqual([expect.stringContaining('no hatch')]);
    expect(
      hatchProblems(parse('<p>6.40% <span data-ui="sample-glyph" class="tf-hatch"></span></p>')),
    ).toEqual([expect.stringContaining('no name')]);
    expect(
      hatchProblems(parse('<div data-ui="card"><span class="tf-mock-plate">MOCK</span></div>')),
    ).toEqual([expect.stringContaining('boxed word MOCK')]);
    // whole: a card's band with its line, a named glyph, a named hatched pin, a hatched frame with its line
    for (const whole of [
      '<div data-ui="card"><span data-ui="hatch-band" class="tf-hatch"></span><p>6.40%</p><p data-ui="sample-note">Sample figures</p></div>',
      '<p>6.40% <span data-ui="sample-glyph" class="tf-hatch" role="img" aria-label="sample figure"></span></p>',
      '<span data-ui="figure">6.40%<button data-ui="pin" aria-label="Source for 6.40%, sample figure"><svg data-hatch=""></svg></button></span>',
      '<div data-ui="mock-frame" class="tf-hatch"><div class="bg-card"><p data-ui="sample-note">Sample figures</p></div></div>',
    ])
      expect(hatchProblems(parse(whole))).toEqual([]);
  });
});

// Only the primitives hold the two halves (components/ui/internal/mock-parts.tsx). A screen has
// whole things only, so it cannot draw a hatch with no word or the word with no hatch.
describe('a screen cannot reach half of the MOCK mark', () => {
  const HALVES = /^tf-(hatch|mock-plate|stale-plate)$/;
  const INTERNAL = /components\/ui\/internal|(^|\/)internal\/mock-parts/;

  /** What a file outside the primitives does that only a primitive may. */
  function reaches(file: string, source: string): string[] {
    const found: string[] = [];
    for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g))
      if (INTERNAL.test(m[1] ?? m[2] ?? '')) found.push(`${file} imports ${m[1] ?? m[2]}`);
    for (const token of classTokens(file, source))
      if (HALVES.test(token.replace(/^.*:/, ''))) found.push(`${file} writes the class ${token}`);
    return found;
  }

  const outside = [...sourceFiles()].filter(
    (file) => /\.tsx?$/.test(file) && !file.startsWith('components/ui/'),
  );

  it('reads every file of the app that is not a primitive, the showcase among them', () => {
    expect(outside).toContain('app/(app)/dev/ui/Showcase.tsx');
    expect(outside.length).toBeGreaterThan(10);
  });

  it('finds no import of the halves and no hatch or plate class written by hand', () => {
    expect(outside.flatMap((file) => reaches(file, read(file)))).toEqual([]);
  });

  it('exports no half from a primitive', () => {
    const exported = [...sourceFiles()]
      .filter((file) => /^components\/ui\/[^/]+\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
      .filter((file) => /export\s+(function|const)\s+(HatchBand|MockWord)\b/.test(read(file)));
    expect(exported).toEqual([]);
    expect(read('components/ui/MockPlate.tsx')).not.toMatch(
      /export\s*\{[^}]*\b(HatchBand|MockWord)\b/,
    );
  });

  it('bites: an import of the band, and the hatch class on a div', () => {
    expect(
      reaches(
        'app/plan/page.tsx',
        "import { HatchBand } from '../../components/ui/internal/mock-parts';\nexport default () => <HatchBand />;",
      ),
    ).toHaveLength(1);
    expect(
      reaches('app/plan/page.tsx', 'export default () => <div className="tf-hatch w-2" />;'),
    ).toEqual(['app/plan/page.tsx writes the class tf-hatch']);
    expect(
      reaches('app/plan/page.tsx', 'export default () => <b className="sm:tf-mock-plate">x</b>;'),
    ).toHaveLength(1);
  });
});

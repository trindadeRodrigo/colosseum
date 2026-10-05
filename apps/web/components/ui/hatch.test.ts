import { createElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../../app/(app)/dev/ui/Showcase';
import * as cases from './test/cases';
import { read, sourceFiles } from './test/css';
import { classTokens } from './test/forbidden';
import { hatchProblems } from './test/hatch';
import { all, classes, parse, render } from './test/html';

// mock-plate.md, "Enforcement": a hatch with no MOCK plate (or stale tag) in the same component fails,
// and so does a MOCK plate with no hatch: three parts, never fewer.

describe('the hatch never appears without its word, nor the word MOCK without its hatch', () => {
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
    // one row has the hatch with no word, the other the word with no hatch
    expect(hatchProblems(rows)).toEqual([
      expect.stringContaining('no MOCK plate'),
      expect.stringContaining('says MOCK with no hatch'),
    ]);
    const onIt = parse(
      '<div data-ui="card"><span class="tf-hatch">MOCK</span><span data-ui="mock-plate">MOCK</span></div>',
    );
    expect(hatchProblems(onIt)).toEqual([expect.stringContaining('has text on its hatch')]);
    const stale = parse(
      '<div data-ui="card"><span class="tf-hatch"></span><span data-ui="stale-plate">stale · 3 h</span></div>',
    );
    expect(hatchProblems(stale)).toEqual([]);
  });

  it('bites the other way: the word with no hatch, and a hatch that belongs to another row', () => {
    const plate = parse(
      '<div data-ui="card"><p>6.40%</p><span data-ui="mock-plate">MOCK</span></div>',
    );
    expect(hatchProblems(plate)).toEqual([expect.stringContaining('says MOCK with no hatch')]);
    const rows = parse(
      '<ul data-ui="execution-list"><li data-mock="true"><span class="tf-hatch"></span><span data-ui="mock-plate">MOCK</span></li><li data-mock="true"><span data-ui="mock-plate">MOCK</span></li></ul>',
    );
    expect(hatchProblems(rows)).toEqual([expect.stringContaining('says MOCK with no hatch')]);
    // whole: the plate with its own band, the plate after a hatched pin, the plate in a hatched frame
    for (const whole of [
      '<p><span data-ui="mock-plate"><span data-ui="hatch-band" class="tf-hatch"></span><span>MOCK</span></span></p>',
      '<span data-ui="figure">6.40%<button data-ui="pin"><svg data-hatch=""></svg></button><span data-ui="mock-plate">MOCK</span></span>',
      '<div data-ui="mock-frame" class="tf-hatch"><div class="bg-card"><span data-ui="mock-plate">MOCK</span></div></div>',
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

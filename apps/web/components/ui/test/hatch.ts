import { all, classes, closest, type El, text } from './html';

// The rule of the hatch (mock-plate.md, "Enforcement"): the hatch means MOCK, stale or a test network
// (DESIGN-VAULT section 2, "Test networks"), and it never
// appears without its word in the same component. The other way too: the word MOCK never appears
// without a hatch in the same component ("three parts, never fewer"). And text never sits on the hatch.
// A screen's own test can run this on its markup: `expect(hatchProblems(render(<Screen />))).toEqual([])`.

/** Pieces of a component, not components: the search for the word goes on above them. */
const PARTS = new Set(['hatch-band', 'pin', 'pin-glyph', 'plan-legs-bar']);
const WORDS = new Set(['mock-plate', 'stale-plate', 'stale-tag', 'network-plate']);

const isHatch = (el: El) => classes(el).includes('tf-hatch') || 'data-hatch' in el.attrs;
const isPlate = (el: El) => el.attrs['data-ui'] === 'mock-plate';
const isBoundary = (el: El) =>
  'data-mock' in el.attrs || (el.attrs['data-ui'] !== undefined && !PARTS.has(el.attrs['data-ui']));
const describe = (el: El) =>
  `<${el.tag}${el.attrs['data-ui'] ? ` data-ui="${el.attrs['data-ui']}"` : ''}${el.attrs.class ? ` class="${el.attrs.class}"` : ''}>`;

/** Every hatch in the markup that breaks the rule, as a sentence. Empty when all is well. */
export function hatchProblems(root: El): string[] {
  const problems: string[] = [];
  for (const hatch of all(root, isHatch)) {
    // A frame is hatched itself; a band sits inside the plate it belongs to.
    const home = isBoundary(hatch) ? hatch : closest(hatch, isBoundary);
    const worded =
      home !== null &&
      (WORDS.has(home.attrs['data-ui'] ?? '') ||
        all(home, (el) => WORDS.has(el.attrs['data-ui'] ?? '')).length > 0);
    if (!worded)
      problems.push(
        `${describe(hatch)} is hatched with no MOCK plate and no "stale" in ${home ? describe(home) : 'any component'}`,
      );
    // Text never sits on the hatch: a hatched element is empty, or holds only solid surfaces.
    const onStrokes = hatch.children.filter(
      (child) =>
        (typeof child === 'string' && child.trim() !== '') ||
        (typeof child === 'object' &&
          hatch.tag !== 'svg' &&
          !classes(child).some((c) => /^bg-(card|background|popover|mock-plate)$/.test(c)) &&
          text(child).trim() !== ''),
    );
    if (onStrokes.length > 0) problems.push(`${describe(hatch)} has text on its hatch`);
  }
  for (const plate of all(root, isPlate)) {
    // A plate with its own band is whole. A plate alone needs a hatch in the component it sits in.
    const home = closest(plate, isBoundary);
    const hatched =
      all(plate, isHatch).length > 0 ||
      (home !== null && (isHatch(home) || all(home, isHatch).length > 0));
    if (!hatched)
      problems.push(
        `${describe(plate)} says MOCK with no hatch in ${home ? describe(home) : 'any component'}`,
      );
  }
  return problems;
}

import { all, classes, closest, type El, text } from './html';

// The rule of the hatch (mock-plate.md, "Enforcement"): the hatch means MOCK or stale, and it never
// appears without its word in the same component. And text never sits on it.
// A screen's own test can run this on its markup: `expect(hatchProblems(render(<Screen />))).toEqual([])`.

/** Pieces of a component, not components: the search for the word goes on above them. */
const PARTS = new Set(['hatch-band', 'pin', 'pin-glyph', 'plan-legs-bar']);
const WORDS = new Set(['mock-plate', 'stale-plate', 'stale-tag']);

const isHatch = (el: El) => classes(el).includes('tf-hatch') || 'data-hatch' in el.attrs;
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
  return problems;
}

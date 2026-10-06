import { all, classes, closest, type El, text } from './html';

// The rule of the hatch (mock-plate.md, "Enforcement", as MOCK-QUIET changed it): the hatch means
// sample or stale, and it never appears without its words in the same component: the card's quiet
// line, a glyph's name for screen readers, a pin whose name says sample, or "stale". The other way
// too: a sample glyph is itself hatched. And text never sits on the hatch.
// A screen's own test can run this on its markup: `expect(hatchProblems(render(<Screen />))).toEqual([])`.

/** Pieces of a component, not components: the search for the word goes on above them. */
const PARTS = new Set(['hatch-band', 'pin', 'pin-glyph', 'plan-legs-bar']);
const WORDS = new Set(['sample-note', 'sample-glyph', 'stale-plate', 'stale-tag']);

const isHatch = (el: El) => classes(el).includes('tf-hatch') || 'data-hatch' in el.attrs;
const isPlate = (el: El) => el.attrs['data-ui'] === 'sample-glyph';
/** A hatched pin is worded by its own name: "Source for 6.40%, sample figure". */
const namedPin = (hatch: El) => {
  const pin = closest(hatch, (el) => el.attrs['data-ui'] === 'pin');
  return pin !== null && (pin.attrs['aria-label'] ?? '').trim() !== '';
};
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
    // a hatched pin with its name in the same component says it too (a leg whose rate is sample)
    const pinned =
      home !== null &&
      all(
        home,
        (el) =>
          el.attrs['data-ui'] === 'pin' &&
          (el.attrs['aria-label'] ?? '').trim() !== '' &&
          all(el, (child) => 'data-hatch' in child.attrs).length > 0,
      ).length > 0;
    const worded =
      namedPin(hatch) ||
      pinned ||
      (home !== null &&
        (WORDS.has(home.attrs['data-ui'] ?? '') ||
          all(home, (el) => WORDS.has(el.attrs['data-ui'] ?? '')).length > 0));
    if (!worded)
      problems.push(
        `${describe(hatch)} is hatched with nothing that says sample or stale in ${home ? describe(home) : 'any component'}`,
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
  for (const glyph of all(root, isPlate)) {
    // A sample glyph is its own hatch, and a named one says what it is.
    if (!isHatch(glyph)) problems.push(`${describe(glyph)} is a sample glyph with no hatch`);
    if (glyph.attrs['aria-hidden'] !== 'true' && (glyph.attrs['aria-label'] ?? '').trim() === '')
      problems.push(`${describe(glyph)} has no name for a screen reader`);
  }
  // The boxed word is gone (MOCK-QUIET): no element says MOCK on a plate.
  for (const plate of all(root, (el) => classes(el).includes('tf-mock-plate')))
    problems.push(`${describe(plate)} is the boxed word MOCK`);
  return problems;
}

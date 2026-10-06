import { describe, expect, it } from 'vitest';
import { mockPlate } from './test/cases';
import { all, classes, hasClass, one, render, text, ui } from './test/html';

describe('MockPlate (mock-plate.md, as MOCK-QUIET changed it)', () => {
  it('never writes the word MOCK: a small hatched glyph with a name for screen readers', () => {
    for (const node of [mockPlate.plate, mockPlate.quiet, mockPlate.frame, mockPlate.reworded]) {
      expect(text(render(node))).not.toContain('MOCK');
      expect(all(render(node), (el) => hasClass(el, 'tf-mock-plate'))).toHaveLength(0);
    }
    const glyph = one(render(mockPlate.plate), ui('sample-glyph'));
    expect(hasClass(glyph, 'tf-hatch')).toBe(true);
    expect(glyph.attrs.role).toBe('img');
    expect(glyph.attrs['aria-label']).toBe('sample figure');
  });

  it('is a glyph whatever it is handed, and says nothing else', () => {
    // `bare` and `reworded` in test/cases.tsx are type errors; forced through, the glyph is drawn
    for (const node of [mockPlate.bare, mockPlate.reworded]) {
      const glyph = one(render(node), ui('sample-glyph'));
      expect(hasClass(glyph, 'tf-hatch')).toBe(true);
      expect(text(render(node))).not.toContain('LIVE');
    }
  });

  it('puts no text on the hatch', () => {
    const glyph = one(render(mockPlate.plate), ui('sample-glyph'));
    expect(text(glyph)).toBe('');
    expect(all(glyph, () => true)).toHaveLength(0);
  });

  it('is not interactive', () => {
    for (const node of [mockPlate.plate, mockPlate.quiet, mockPlate.frame])
      expect(all(render(node), (el) => el.tag === 'button' || el.tag === 'a')).toHaveLength(0);
  });

  it('names the glyph once per panel, and says a panel is sample in one quiet line', () => {
    expect(one(render(mockPlate.quiet), ui('sample-glyph')).attrs['aria-hidden']).toBe('true');
    const note = one(render(mockPlate.frame), ui('sample-note'));
    expect(text(note)).toBe('Sample figures');
    expect(classes(note)).toContain('text-muted-foreground');
    expect(classes(note).join(' ')).not.toMatch(/border|bg-/);
  });

  it('frames a mocked panel: hatch in an 8px margin, everything on a solid surface inside', () => {
    const outer = one(render(mockPlate.frame), ui('mock-frame'));
    expect(classes(outer)).toEqual(expect.arrayContaining(['tf-hatch', 'border', 'p-2']));
    const inner = outer.children[0];
    expect(typeof inner === 'object' && hasClass(inner, 'bg-card')).toBe(true);
    expect(text(inner as never)).toContain('the body');
    expect(text(inner as never)).toContain('Sample plan');
    // nothing but the solid surface sits directly on the hatch
    expect(outer.children).toHaveLength(1);
  });

  it('says how stale on a stale plate, in sentence case, with the same band', () => {
    const plate = render(mockPlate.stale);
    expect(text(plate)).toBe('stale · 3 h');
    expect(text(render(mockPlate.staleNoAge))).toBe('stale · age unknown');
    expect(all(plate, (el) => hasClass(el, 'tf-hatch'))).toHaveLength(1);
    expect(all(plate, (el) => hasClass(el, 'tf-mock-plate'))).toHaveLength(0);
  });
});

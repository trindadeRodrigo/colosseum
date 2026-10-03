import { describe, expect, it } from 'vitest';
import { mockPlate } from './test/cases';
import { all, classes, hasClass, one, render, text, ui } from './test/html';

describe('MockPlate (mock-plate.md)', () => {
  it('always carries the word MOCK, in every placement', () => {
    expect(text(render(mockPlate.inline))).toBe('MOCK');
    expect(text(render(mockPlate.badgeQuiet))).toBe('MOCK');
    expect(text(render(mockPlate.badge))).toContain('MOCK');
    expect(text(render(mockPlate.frame))).toContain('MOCK');
  });

  it('cannot be made to say anything else', () => {
    // `reworded` in test/cases.tsx is a type error, and the props are ignored if forced through.
    expect(text(render(mockPlate.reworded))).toBe('MOCK');
  });

  it('puts the word on a solid plate beside the hatch, never on it', () => {
    const badge = render(mockPlate.badge);
    const hatch = one(badge, (el) => hasClass(el, 'tf-hatch'), 'hatch');
    expect(text(hatch)).toBe('');
    expect(hatch.attrs['aria-hidden']).toBe('true');
    expect(classes(hatch)).toContain('w-1.5'); // a 6px band
    const plate = one(badge, (el) => hasClass(el, 'tf-mock-plate'), 'plate');
    expect(all(hatch, () => true)).toHaveLength(0);
    expect(hasClass(plate, 'tf-hatch')).toBe(false);
  });

  it('is not interactive', () => {
    for (const node of [mockPlate.inline, mockPlate.badge, mockPlate.frame])
      expect(all(render(node), (el) => el.tag === 'button' || el.tag === 'a')).toHaveLength(0);
  });

  it('tells a screen reader once per panel that the data is a sample', () => {
    expect(text(render(mockPlate.badge))).toBe('MOCK: sample data, not live');
    expect(all(render(mockPlate.frame), (el) => hasClass(el, 'sr-only'))).toHaveLength(1);
    expect(all(render(mockPlate.inline), (el) => hasClass(el, 'sr-only'))).toHaveLength(0);
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
    expect(all(plate, (el) => hasClass(el, 'tf-hatch'))).toHaveLength(1);
    expect(all(plate, (el) => hasClass(el, 'tf-mock-plate'))).toHaveLength(0);
  });
});

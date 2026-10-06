import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { formatAge, isoUtc, shorten } from './format';
import { statusWord } from './StatusMark';
import { button, status } from './test/cases';
import { all, classes, one, render, tag, text, ui } from './test/html';

describe('StatusMark (STYLE.md, rule 6: a word, a shape and a colour)', () => {
  it('draws three different shapes, each hidden from screen readers', () => {
    const on = one(render(status.on), ui('status-mark'));
    const watch = one(render(status.watch), ui('status-mark'));
    const off = one(render(status.off), ui('status-mark'));
    for (const mark of [on, watch, off]) expect(mark.attrs['aria-hidden']).toBe('true');
    expect(all(on, tag('rect'))).toHaveLength(1); // a solid square
    expect(all(watch, tag('rect'))).toHaveLength(2); // an outline, half filled
    expect(all(off, tag('path'))).toHaveLength(1); // an outline with a notch
    expect(one(off, tag('path')).attrs.fill).toBe('none');
  });

  it('colours each with its earth pigment', () => {
    expect(classes(one(render(status.on), ui('status')))).toContain('text-status-on');
    expect(classes(one(render(status.watch), ui('status-badge')))).toEqual(
      expect.arrayContaining(['text-status-watch', 'bg-status-watch-bg', 'rounded-none', 'h-5']),
    );
    expect(classes(one(render(status.off), ui('status-mark')))).toContain('text-status-off');
  });

  it('always carries the word', () => {
    expect(text(render(status.on))).toBe('On track · June 2028');
    expect(text(render(status.watch))).toBe('Watch');
    expect(text(render(status.element))).toBe('Watch');
  });

  it('refuses to draw the mark with no word, or with a word of spaces', () => {
    // `wordless` in test/cases.tsx is a type error as well.
    for (const none of [status.wordless, status.blank, status.blankBadge])
      expect(() => render(createElement(none))).toThrow(/A status needs its word/);
    expect(statusWord('Watch')).toBe('Watch');
    for (const none of ['', '  ', null, undefined])
      expect(() => statusWord(none)).toThrow(/A status needs its word/);
  });
});

describe('Icon (iconography.md)', () => {
  it('draws with one 1.5px stroke at every size, square caps, miter joins, no fill', () => {
    const icon = one(render(button.icon), ui('icon'));
    expect(icon.attrs).toMatchObject({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-linecap': 'square',
      'stroke-linejoin': 'miter',
    });
    expect(Number(icon.attrs['stroke-width']) * (Number(icon.attrs.width) / 24)).toBeCloseTo(1.5);
    expect(icon.attrs['aria-hidden']).toBe('true');
  });
});

describe('formatters', () => {
  it('writes an instant in ISO 8601 UTC, and nothing for what is not a date', () => {
    expect(isoUtc('2026-10-01T14:02:11.000Z')).toBe('2026-10-01T14:02:11Z');
    expect(isoUtc('2026-10-01T11:02:11-03:00')).toBe('2026-10-01T14:02:11Z');
    expect(isoUtc('2026-10-01T14:02Z')).toBe('2026-10-01T14:02:00Z');
    expect(isoUtc('2026-10-01T14:02:11.123456Z')).toBe('2026-10-01T14:02:11Z');
    expect(isoUtc('soon')).toBeNull();
  });

  it('takes no number, bare date or time with no zone for an instant', () => {
    // `Date.parse` reads each of these, the last one in the clock of whoever runs it
    for (const not of [
      '1',
      '2026',
      '2026-10',
      '2026-10-01',
      '2026-10-01T14:02:11',
      '2026-13-01T00:00:00Z',
      '',
    ])
      expect(isoUtc(not), not).toBeNull();
    expect(isoUtc(undefined as never)).toBeNull();
  });

  it('writes an age in minutes, hours or days', () => {
    expect(formatAge(90)).toEqual({
      short: '2 min',
      long: '2 minutes old',
      count: 2,
      unit: 'minute',
    });
    expect(formatAge(3 * 3600)).toEqual({
      short: '3 h',
      long: '3 hours old',
      count: 3,
      unit: 'hour',
    });
    expect(formatAge(3600)).toEqual({ short: '1 h', long: '1 hour old', count: 1, unit: 'hour' });
    expect(formatAge(3 * 86_400)).toEqual({
      short: '3 d',
      long: '3 days old',
      count: 3,
      unit: 'day',
    });
    expect(formatAge(0)).toEqual({
      short: '1 min',
      long: '1 minute old',
      count: 1,
      unit: 'minute',
    });
  });

  it('gives no age for what is not one', () => {
    for (const not of [Number.NaN, -1, Number.POSITIVE_INFINITY, '90' as never, null as never])
      expect(formatAge(not)).toBeNull();
  });

  it('cuts a hash in the middle', () => {
    expect(shorten('4kZ9aaaaaaaaaaaamX2p')).toBe('4kZ9…mX2p');
    expect(shorten('short')).toBe('short');
  });
});

import { createElement, isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { goalCard } from './test/cases';
import { all, classes, name, one, render, role, tag, text, ui } from './test/html';

describe('GoalCard (goal-card.md)', () => {
  const root = render(goalCard.onTrack);
  const card = one(root, ui('goal-card'));

  it('is an article named by its sentence', () => {
    expect(role(card)).toBe('article');
    expect(name(card, root)).toBe('Your apartment fund is on track.');
  });

  it('sets the sentence and the amount in the display face, Inter Tight 600 at −2%; never a serif', () => {
    const display = all(card, (e) => classes(e).includes('font-display'));
    expect(display.map(text)).toEqual([
      'Your apartment fund is on track.',
      expect.stringContaining('$12,480 of $40,000'),
    ]);
    const [sentence, amount] = display.map((e) => classes(e as never));
    expect(sentence).toEqual(
      expect.arrayContaining([
        'font-semibold',
        'tracking-[-0.02em]',
        'text-h3',
        'max-w-(--tf-measure-display)',
      ]),
    );
    // the amount is the card's big number: 28px, tabular, with its pin inside it
    expect(amount).toEqual(
      expect.arrayContaining(['font-semibold', 'text-[1.75rem]/8', 'tabular-nums']),
    );
    expect(all(display[1] as never, ui('pin'))).toHaveLength(1);
    for (const list of [sentence, amount])
      expect((list ?? []).join(' ')).not.toMatch(/italic|font-normal|opsz/);
    expect(
      classes(one(render(goalCard.header), (e) => classes(e).includes('font-display'))),
    ).toContain('text-display');
    expect(one(render(goalCard.header), (e) => classes(e).includes('font-display')).tag).toBe('h1');
  });

  it('reads eyebrow-free from the top: the sentence, the amount and its line, then the status pill', () => {
    const order = all(
      card,
      (e) =>
        ['goal-amount', 'status'].includes(e.attrs['data-ui'] as string) ||
        classes(e).includes('text-h3'),
    ).map((e) => (classes(e).includes('text-h3') ? 'sentence' : e.attrs['data-ui']));
    expect(order).toEqual(['sentence', 'goal-amount', 'status']);
    const status = one(card, ui('status'));
    expect(classes(status)).toEqual(expect.arrayContaining(['rounded-full', 'bg-status-on-bg']));
  });

  it('shows the status as a mark, a word and a date', () => {
    const status = one(card, ui('status'));
    expect(text(status)).toBe('On track · June 2028');
    const mark = one(status, ui('status-mark'));
    expect(mark.attrs['data-status']).toBe('on-track');
    expect(mark.attrs['aria-hidden']).toBe('true');
  });

  it('refuses a status with no word: the card throws instead of drawing the mark alone', () => {
    expect(() => render(createElement(goalCard.wordless))).toThrow(/A status needs its word/);
  });

  it('pins the priced figure and names it', () => {
    const pin = one(card, ui('pin'));
    expect(pin.attrs['aria-label']).toBe('Source for $12,480');
    expect(text(card)).toContain('$12,480 of $40,000');
    expect(text(card)).toContain('access to cash within 7 days');
  });

  it('has one action, a link, and the whole card follows it', () => {
    const links = all(card, tag('a'));
    expect(links).toHaveLength(1);
    expect(text(links[0] as never)).toBe('See your plan');
    expect(classes(links[0] as never)).toEqual(
      expect.arrayContaining(['underline', 'text-honey-text', 'after:absolute', 'after:inset-0']),
    );
    expect(all(card, tag('button')).filter((b) => b.attrs['data-ui'] !== 'pin')).toHaveLength(0);
  });

  it('deepens its hairline on hover and is never tinted by its status', () => {
    for (const node of [goalCard.onTrack, goalCard.watch]) {
      const c = one(render(node), ui('goal-card'));
      expect(classes(c)).toEqual(
        expect.arrayContaining(['bg-card', 'border-border', 'hover:border-input']),
      );
      expect(classes(c).join(' ')).not.toMatch(/bg-status|shadow/);
    }
  });

  it('on watch gives the word, the shape and one sentence of reason', () => {
    const c = one(render(goalCard.watch), ui('goal-card'));
    expect(text(one(c, ui('status')))).toBe('Watch · March 2029');
    expect(text(c)).toContain('A stress case breaks in month 14.');
    // an income goal says what it pays; that is a target, not a priced figure, so it has no pin
    expect(text(c)).toContain('pays R$ 5.000 a month from January 2029');
    expect(all(c, ui('pin'))).toHaveLength(0);
  });

  it('with mock inputs has the hatch band on its left edge and one quiet line, never MOCK', () => {
    const c = one(render(goalCard.watch), ui('goal-card'));
    expect(all(c, ui('hatch-band'))).toHaveLength(1);
    expect(c.children[0]).toMatchObject({ attrs: { 'data-ui': 'hatch-band' } });
    expect(text(one(c, ui('sample-note')))).toBe('Sample figures');
    expect(text(c)).not.toContain('MOCK');
    expect(all(card, ui('hatch-band'))).toHaveLength(0);
  });

  it('as a draft has no status mark and no amount', () => {
    const c = one(render(goalCard.draft), ui('goal-card'));
    expect(all(c, ui('status-mark'))).toHaveLength(0);
    expect(all(c, ui('pin'))).toHaveLength(0);
    expect(text(c)).toContain('Draft: finish the sheet');
    expect(text(one(c, tag('a')))).toBe('Edit sheet');
  });

  it('waits in words beside the still lattice', () => {
    const status = one(render(goalCard.loading), (e) => role(e) === 'status');
    expect(text(status)).toBe('Loading your goal');
  });

  it('shows no picture, ring or bar', () => {
    const cards = Object.values(goalCard).filter((node) => isValidElement(node));
    expect(cards.length).toBeGreaterThan(4);
    for (const node of cards)
      expect(
        all(render(node), (e) => ['img', 'progress', 'meter', 'picture'].includes(e.tag)),
      ).toHaveLength(0);
  });
});

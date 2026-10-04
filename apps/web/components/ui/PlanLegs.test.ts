import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { MAX_LEGS } from './PlanLegs';
import { planLegs } from './test/cases';
import { all, classes, one, render, tag, text, ui } from './test/html';

describe('PlanLegs (plan-leg.md)', () => {
  const root = render(planLegs.four);
  const bar = one(root, ui('plan-legs-bar'));
  const segments = bar.children as Array<Exclude<(typeof bar.children)[number], string>>;
  const labels = all(one(root, tag('ol')), tag('li'));

  it('takes four legs in the bar and refuses a fifth as an engine error', () => {
    expect(MAX_LEGS).toBe(4);
    expect(segments).toHaveLength(4);
    expect(() => render(createElement(planLegs.five))).toThrow(/at most 4 legs and was given 5/);
  });

  it('refuses an equity leg in an income plan', () => {
    expect(() => render(createElement(planLegs.incomeWithStocks))).toThrow(
      /income plan may not hold/,
    );
  });

  it('hides the bar from screen readers: the list of labels carries everything', () => {
    expect(bar.attrs['aria-hidden']).toBe('true');
    expect(labels).toHaveLength(4);
  });

  it('draws the bar flat: 12px, square, with 2px gaps in the ground colour', () => {
    expect(classes(bar)).toEqual(
      expect.arrayContaining(['flex', 'gap-0.5', 'bg-background', 'h-3']),
    );
    for (const s of segments) expect(classes(s)).toContain('rounded-none');
    expect(classes(one(render(planLegs.hero), ui('plan-legs-bar')))).toContain('h-6');
  });

  it('fills the legs in order with the four leg colours, each as wide as its weight', () => {
    expect(
      segments.slice(0, 3).map((s) => classes(s).find((c) => c.startsWith('bg-leg-'))),
    ).toEqual(['bg-leg-1', 'bg-leg-2', 'bg-leg-3']);
    expect(segments.map((s) => s.attrs.style?.match(/width:([\d.]+)%/)?.[1])).toEqual([
      '45',
      '25',
      '20',
      '10',
    ]);
  });

  it('hatches a mock leg instead of filling it, and labels it with the band and the plate', () => {
    const mock = segments[3];
    expect(classes(mock as never)).toEqual(expect.arrayContaining(['tf-hatch', 'bg-card']));
    expect(classes(mock as never).some((c) => c.startsWith('bg-leg-'))).toBe(false);
    const label = labels[3];
    expect(all(label as never, ui('hatch-band'))).toHaveLength(1);
    expect(all(label as never, ui('mock-plate'))).toHaveLength(1);
    expect(text(label as never)).toContain('BRL leg·10%·—MOCK·integration in progress');
    for (const live of labels.slice(0, 3))
      expect(all(live as never, ui('hatch-band'))).toHaveLength(0);
  });

  it('labels every leg directly: name, weight, the rate after haircut with its pin, the quoted rate', () => {
    const first = labels[0];
    expect(text(first as never)).toContain('Tokenized treasuries·45%·4.10%');
    expect(text(first as never)).toContain('after haircut');
    expect(text(first as never)).toContain('quoted 4.35%');
    expect(all(first as never, ui('pin'))).toHaveLength(1);
    const quoted = all(first as never, (e) => text(e) === 'quoted 4.35%').at(-1);
    expect(classes(quoted as never)).toContain('text-muted-foreground');
    // a leg with no yield shows a dash, not a zero, and has no pin
    expect(text(labels[2] as never)).toContain('Cash buffer·20%·—·reachable today');
    expect(all(labels[2] as never, ui('pin'))).toHaveLength(0);
  });

  it('shows no rate, quoted or not, for a leg whose rate has no source', () => {
    const lone = render(planLegs.unsourced);
    expect(text(lone)).not.toContain('4.10%');
    expect(text(lone)).not.toContain('4.35%');
    expect(text(lone)).not.toContain('after haircut');
    expect(text(lone)).toContain('no source yet');
  });

  it('marks the segment of the label under the pointer or the focus, and dims nothing', () => {
    for (const [index, s] of segments.entries())
      expect(classes(s)).toContain(
        `group-has-[[data-leg="${index}"]:is(:hover,:focus-within)]/legs:border-t-2`,
      );
    expect(labels.map((l) => l.attrs['data-leg'])).toEqual(['0', '1', '2', '3']);
    for (const el of all(root)) expect(classes(el).join(' ')).not.toMatch(/opacity/);
  });

  it('plays the plan-lock once when asked: legs seat in turn, then the pins drop', () => {
    const hero = render(planLegs.hero);
    const moving = one(hero, ui('plan-legs-bar')).children as typeof segments;
    for (const s of moving) expect(classes(s)).toContain('animate-seat');
    expect(moving[1]?.attrs.style).toContain('animation-delay:calc(1 * var(--tf-stagger))');
    expect(all(hero, (e) => classes(e).includes('animate-pin-drop')).length).toBeGreaterThan(0);
    for (const s of segments) expect(classes(s)).not.toContain('animate-seat');
  });

  it('parts the segments and shows the reasons for "Why this plan?", and closes again', () => {
    const open = render(planLegs.parted);
    const moved = one(open, ui('plan-legs-bar')).children as typeof segments;
    const shifts = moved.map((s) =>
      Number(s.attrs.style?.match(/translateX\((-?[\d.]+)px\)/)?.[1]),
    );
    for (let i = 1; i < shifts.length; i++) {
      const step = (shifts[i] as number) - (shifts[i - 1] as number);
      expect(step >= 12 && step <= 24).toBe(true);
    }
    expect(text(open)).toContain('The steadiest income for a date three years out.');
    expect(text(render(planLegs.closed))).not.toContain('The steadiest income');
    expect(text(root)).toContain('The steadiest income'); // left alone, the reasons are simply shown
  });
});

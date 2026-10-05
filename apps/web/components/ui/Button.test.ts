import { describe, expect, it } from 'vitest';
import { buttonClass } from './button-class';
import { button } from './test/cases';
import { all, classes, name, one, render, role, tag, text } from './test/html';

const el = (node: Parameters<typeof render>[0]) => {
  const root = render(node);
  return { root, button: one(root, (e) => e.attrs['data-ui'] === 'button', 'button') };
};

describe('Button (button.md)', () => {
  it('is a native button with type "button" unless it navigates', () => {
    const { button: b } = el(button.primary);
    expect(b.tag).toBe('button');
    expect(b.attrs.type).toBe('button');
    expect(role(b)).toBe('button');
    const { button: link } = el(button.link);
    expect(link.tag).toBe('a');
    expect(link.attrs.href).toBe('/plans/sample');
    expect(role(link)).toBe('link');
  });

  it('has a 2px ring at a 2px offset on every variant', () => {
    for (const variant of [
      'primary',
      'secondary',
      'link',
      'chip',
      'icon',
      'destructive',
    ] as const) {
      const list = buttonClass({ variant }).split(' ');
      expect(list).toContain('focus-visible:outline-2');
      expect(list).toContain('focus-visible:outline-offset-2');
      expect(list).toContain('focus-visible:outline-ring');
    }
  });

  it('is 40px by default and 32px dense, with 2px corners and never a pill', () => {
    expect(classes(el(button.primary).button)).toEqual(
      expect.arrayContaining(['h-10', 'rounded-md']),
    );
    expect(classes(el(button.dense).button)).toEqual(expect.arrayContaining(['h-8', 'rounded-md']));
    for (const variant of ['primary', 'secondary', 'chip', 'icon', 'destructive'] as const)
      expect(buttonClass({ variant })).not.toMatch(/rounded-(full|round|composer|\[)/);
  });

  it('presses by changing its fill, with no scale and no opacity', () => {
    const list = buttonClass({ variant: 'primary' });
    expect(list).toContain('hover:bg-primary-hover');
    expect(list).toContain('active:bg-primary-pressed');
    for (const variant of ['primary', 'secondary', 'link', 'chip', 'icon', 'destructive'] as const)
      for (const state of [{}, { busy: true }, { disabled: true }])
        expect(buttonClass({ variant, ...state })).not.toMatch(/opacity|scale|translate|shadow/);
  });

  it('when busy changes its label, keeps its width and its focus, and shows no spinner', () => {
    const { root, button: b } = el(button.busy);
    expect(b.attrs['aria-busy']).toBe('true');
    expect(b.attrs['aria-disabled']).toBe('true');
    expect('disabled' in b.attrs).toBe(false); // still focusable
    // Both labels are laid out in one grid cell; only the busy one is exposed.
    const labels = all(b, (e) => classes(e).includes('col-start-1'));
    expect(labels.map(text)).toEqual(['Build my plan', 'Building your plan…']);
    expect(labels[0]?.attrs['aria-hidden']).toBe('true');
    expect(classes(labels[0] as never)).toContain('invisible');
    expect(labels[1]?.attrs['aria-hidden']).toBeUndefined();
    expect(all(root, tag('svg'))).toHaveLength(0);
    expect(classes(b).join(' ')).not.toMatch(/hover:|active:|animate/);
  });

  it('when disabled is muted, not faded, and can point at the reason', () => {
    const { button: b } = el(button.disabled);
    expect(b.attrs['aria-disabled']).toBe('true');
    expect('disabled' in b.attrs).toBe(false);
    expect(b.attrs['aria-describedby']).toBe('why');
    expect(classes(b)).toEqual(expect.arrayContaining(['bg-muted', 'text-muted-foreground']));
    expect(classes(b).join(' ')).not.toMatch(/opacity|bg-primary/);
  });

  it('names an icon button and shows the name as its tooltip', () => {
    const { root, button: b } = el(button.icon);
    expect(name(b, root)).toBe('Close');
    expect(b.attrs.title).toBe('Close');
    expect(classes(b)).toContain('size-10');
  });

  it('marks a toggle as pressed', () => {
    expect(el(button.chip).button.attrs['aria-pressed']).toBe('true');
    expect(el(button.secondary).button.attrs['aria-pressed']).toBeUndefined();
  });

  it('draws the destructive button as an outline in madder, never filled', () => {
    const list = classes(el(button.destructive).button);
    expect(list).toEqual(expect.arrayContaining(['border-destructive', 'text-destructive']));
    expect(list).toContain('bg-transparent');
  });
});

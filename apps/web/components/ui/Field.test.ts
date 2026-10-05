import { describe, expect, it } from 'vitest';
import { field } from './test/cases';
import { all, classes, name, one, render, tag, text } from './test/html';

const control = (root: ReturnType<typeof render>) =>
  one(root, (e) => ['input', 'select', 'textarea'].includes(e.tag), 'control');

describe('Field (field.md)', () => {
  it('always has a visible label, tied to its control', () => {
    for (const node of Object.values(field)) {
      const root = render(node);
      const label = one(root, tag('label'), 'label');
      expect(text(label)).not.toBe('');
      expect(label.attrs.for).toBe(control(root).attrs.id);
      expect(name(control(root), root)).toBe(text(label));
      expect(control(root).attrs.placeholder).toBeUndefined();
    }
  });

  it('edges a control in member and sets it in a sunk well', () => {
    const input = control(render(field.rest));
    expect(classes(input)).toEqual(
      expect.arrayContaining([
        'border',
        'border-input',
        'bg-muted',
        'rounded-md',
        'h-10',
        'tabular-nums',
      ]),
    );
    expect(classes(input)).not.toContain('border-border');
    expect(classes(input)).toEqual(
      expect.arrayContaining(['focus-visible:outline-2', 'focus-visible:outline-offset-2']),
    );
  });

  it('joins the hint to the control', () => {
    const root = render(field.rest);
    const hint = one(root, (e) => e.attrs.id === control(root).attrs['aria-describedby'], 'hint');
    expect(text(hint)).toBe('In reais. Your target, not a promise.');
  });

  it('when invalid says what to change, with a shape as well as a colour', () => {
    const root = render(field.invalid);
    const select = control(root);
    expect(select.attrs['aria-invalid']).toBe('true');
    expect(classes(select)).toContain('border-destructive');
    const error = one(root, (e) => e.attrs.role === 'alert', 'error');
    expect(text(error)).toBe('A monthly income goal needs the income profile.');
    expect(select.attrs['aria-describedby']?.split(' ')).toContain(error.attrs.id);
    expect(all(error, (e) => e.attrs['data-ui'] === 'status-mark')).toHaveLength(1);
    expect(select.attrs.id).toBe('profile'); // "Go to field" links here
  });

  it('marks what the person changed after the parser read the goal', () => {
    const root = render(field.edited);
    const label = one(root, tag('label'));
    expect(all(label, (e) => classes(e).includes('bg-primary'))).toHaveLength(1);
    expect(text(root)).toContain('edited');
    expect(label.attrs.title).toBe('horizonMonths'); // the schema key is a tooltip, never the label
  });

  it('has no well when it cannot be edited', () => {
    for (const node of [field.readOnly, field.disabled]) {
      const input = control(render(node));
      expect(classes(input)).toEqual(expect.arrayContaining(['bg-transparent', 'border-border']));
      expect(classes(input)).not.toContain('bg-muted');
    }
    expect(classes(control(render(field.disabled)))).toContain('text-muted-foreground');
  });

  it('follows the width of its content, and sets amounts on the right', () => {
    const input = control(render(field.rest));
    expect(input.attrs.style).toContain('12ch');
    expect(classes(input)).toContain('text-right');
    expect(input.attrs.inputMode ?? input.attrs.inputmode).toBe('decimal');
  });
});

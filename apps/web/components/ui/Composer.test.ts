import { describe, expect, it } from 'vitest';
import { sendsOnKey } from './Composer';
import { composer } from './test/cases';
import { all, classes, name, one, render, tag, text, ui } from './test/html';

const parts = (node: Parameters<typeof render>[0]) => {
  const root = render(node);
  return {
    root,
    box: one(root, ui('composer-box')),
    send: one(root, ui('composer-send')),
    control: one(root, (e) => e.tag === 'textarea' || e.tag === 'input', 'control'),
  };
};

describe('Composer (composer.md)', () => {
  it('is the one rounded shape: a 20px box and a round send button', () => {
    const { box, send } = parts(composer.empty);
    expect(classes(box)).toEqual(
      expect.arrayContaining(['rounded-composer', 'border', 'border-input', 'bg-card', 'min-h-13']),
    );
    expect(classes(send)).toEqual(expect.arrayContaining(['rounded-round', 'h-9', 'w-9']));
    expect(classes(box).join(' ')).not.toMatch(/shadow|blur/);
  });

  it('always has a label tied to the box, shown or only read out', () => {
    const shown = parts(composer.empty);
    const label = one(shown.root, tag('label'));
    expect(label.attrs.for).toBe(shown.control.attrs.id);
    expect(name(shown.control, shown.root)).toBe('Your goal');
    expect(classes(label)).not.toContain('sr-only');
    const hidden = parts(composer.typed);
    expect(classes(one(hidden.root, tag('label')))).toContain('sr-only');
    expect(name(hidden.control, hidden.root)).toBe('Your goal');
  });

  it('puts the focus ring on the box, not on the borderless textarea inside it', () => {
    const { box, control, send } = parts(composer.empty);
    expect(classes(box)).toEqual(
      expect.arrayContaining([
        'focus-within:outline-2',
        'focus-within:outline-offset-2',
        'focus-within:outline-ring',
      ]),
    );
    expect(classes(control)).toEqual(expect.arrayContaining(['outline-none', 'bg-transparent']));
    expect(classes(control).join(' ')).not.toMatch(/\bborder/);
    expect(classes(send)).toContain('focus-visible:outline-2');
  });

  it('types at 16px, one line growing to five', () => {
    const { control } = parts(composer.empty);
    expect(control.tag).toBe('textarea');
    expect(control.attrs.rows).toBe('1');
    expect(classes(control)).toEqual(
      expect.arrayContaining([
        'text-body',
        'max-h-[120px]',
        'resize-none',
        '[field-sizing:content]',
      ]),
    );
  });

  it('sends on Enter, not on Shift+Enter, and not while an input method is composing', () => {
    expect(sendsOnKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(sendsOnKey({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true } })).toBe(
      false,
    );
    expect(sendsOnKey({ key: 'a', shiftKey: false })).toBe(false);
  });

  it('names the send button, and mutes it while there is nothing to send', () => {
    const empty = parts(composer.empty).send;
    expect(empty.attrs['aria-label']).toBe('Fit it');
    expect(empty.attrs['aria-disabled']).toBe('true');
    expect(classes(empty)).toEqual(expect.arrayContaining(['bg-muted', 'text-muted-foreground']));
    const typed = parts(composer.typed).send;
    expect(typed.attrs['aria-disabled']).toBeUndefined();
    expect(classes(typed)).toEqual(
      expect.arrayContaining([
        'bg-primary',
        'text-primary-foreground',
        'hover:bg-primary-hover',
        'active:bg-primary-pressed',
      ]),
    );
    expect(one(typed, ui('icon'))).toBeDefined();
  });

  it('when busy is read-only, shows the still lattice instead of a spinner, and says so', () => {
    const { root, box, control, send } = parts(composer.busy);
    expect(box.attrs['aria-busy']).toBe('true');
    expect('readOnly' in control.attrs || 'readonly' in control.attrs).toBe(true);
    expect(all(send, ui('lattice'))).toHaveLength(1);
    expect(all(send, ui('icon'))).toHaveLength(0);
    expect(text(one(root, (e) => e.attrs.role === 'status'))).toBe('Reading your goal…');
    for (const el of all(root)) expect(classes(el).join(' ')).not.toMatch(/animate|spin|pulse/);
  });

  it('on error keeps the text, edges the box in madder and says what to do', () => {
    const { root, box, control } = parts(composer.error);
    expect(classes(box)).toContain('border-destructive');
    expect(text(control)).toBe('soon, a lot');
    const alert = one(root, (e) => e.attrs.role === 'alert');
    expect(text(alert)).toBe('We couldn’t read that. Try an amount and a date.');
    expect(control.attrs['aria-describedby']).toContain(alert.attrs.id);
  });

  it('when disabled is not faded, and its button leaves the tab order', () => {
    const { box, control, send } = parts(composer.disabled);
    expect(classes(box)).toContain('border-border');
    expect(classes(control)).toContain('text-muted-foreground');
    expect(send.attrs.tabindex ?? send.attrs.tabIndex).toBe('-1');
    for (const el of [box, control, send]) expect(classes(el).join(' ')).not.toMatch(/opacity/);
  });

  it('as the subscribe field is one line of email with a worded button in the same box', () => {
    const { control, send, box } = parts(composer.subscribe);
    expect(control.tag).toBe('input');
    expect(control.attrs).toMatchObject({ type: 'email', name: 'email' });
    expect(control.attrs.autoComplete ?? control.attrs.autocomplete).toBe('email');
    expect(send.attrs['aria-label']).toBe('Subscribe');
    expect(text(send)).toBe('Subscribe');
    expect(classes(send)).toContain('rounded-round');
    expect(classes(box)).toContain('rounded-composer');
  });
});

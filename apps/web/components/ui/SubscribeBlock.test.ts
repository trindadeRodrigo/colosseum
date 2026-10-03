import { describe, expect, it } from 'vitest';
import { SUBSCRIBE_LABELS } from './SubscribeBlock';
import { subscribe } from './test/cases';
import { all, classes, name, one, render, role, tag, text, ui } from './test/html';

const status = (node: Parameters<typeof render>[0]) => one(render(node), ui('subscribe-status'));

describe('SubscribeBlock (subscribe-block.md)', () => {
  const root = render(subscribe.rest);
  const block = one(root, ui('subscribe-block'));

  it('is a section named by its heading, the one serif line', () => {
    const heading = one(block, tag('h2'));
    expect(name(block, root)).toBe(text(heading));
    expect(classes(heading)).toEqual(
      expect.arrayContaining(['font-display', 'font-normal', 'max-w-[20ch]']),
    );
    expect(all(block, (e) => classes(e).includes('font-display'))).toHaveLength(1);
  });

  it('sets the line above in the mono face, in the brand wood, in sentence case', () => {
    const eyebrow = block.children[0];
    expect(typeof eyebrow === 'object' && text(eyebrow)).toBe('Follow along');
    expect(classes(eyebrow as never)).toEqual(
      expect.arrayContaining(['font-mono', 'text-primary']),
    );
    expect(classes(eyebrow as never)).not.toContain('uppercase');
  });

  it('uses the composer for the field, on one line, with a visible label and a worded button', () => {
    const box = one(block, ui('composer-box'));
    expect(classes(box)).toContain('rounded-composer');
    const input = one(block, (e) => e.tag === 'input' && e.attrs.type === 'email');
    expect(input.attrs.autoComplete ?? input.attrs.autocomplete).toBe('email');
    const label = one(block, (e) => e.tag === 'label' && e.attrs.for === input.attrs.id);
    expect(text(label)).toBe('Email address');
    expect(classes(label)).not.toContain('sr-only');
    expect(one(block, ui('composer-send')).attrs['aria-label']).toBe('Subscribe');
  });

  it('rounds nothing else: the checkboxes are square and named as a group', () => {
    const group = one(block, tag('fieldset'));
    expect(role(group)).toBe('group');
    expect(group.attrs['aria-label']).toBe('What to receive');
    const boxes = all(group, (e) => e.attrs.type === 'checkbox');
    expect(boxes).toHaveLength(2);
    for (const box of boxes)
      expect(classes(box)).toEqual(expect.arrayContaining(['rounded-none', 'accent-primary']));
    expect(all(group, tag('label')).map(text)).toEqual(['Product updates', 'Newsletter']);
    // the page decides what starts ticked; here only the first does
    expect(boxes.map((b) => 'checked' in b.attrs)).toEqual([true, false]);
  });

  it('says the status in one line, as a status at rest and as an alert when something is wrong', () => {
    expect(text(status(subscribe.rest))).toBe('Unsubscribe any time.');
    expect(status(subscribe.rest).attrs.role).toBe('status');
    expect(text(status(subscribe.invalid))).toBe(
      'That email doesn’t look complete. Check for an @ and a domain.',
    );
    expect(status(subscribe.invalid).attrs.role).toBe('alert');
    expect(text(status(subscribe.noOption))).toBe(
      'Pick at least one: product updates or the newsletter.',
    );
    expect(text(status(subscribe.success))).toBe('Check your inbox to confirm.');
    expect(text(status(subscribe.already))).toBe('You’re already on the list.');
    expect(status(subscribe.already).attrs.role).toBe('status'); // neutral, not an error
    expect(text(status(subscribe.error))).toBe(
      'We couldn’t save that just now. Try again in a minute.',
    );
  });

  it('edges the field in madder when the address is not complete', () => {
    expect(classes(one(render(subscribe.invalid), ui('composer-box')))).toContain(
      'border-destructive',
    );
    expect(classes(one(root, ui('composer-box')))).toContain('border-input');
  });

  it('while submitting marks the button busy and changes its word', () => {
    const send = one(render(subscribe.submitting), ui('composer-send'));
    expect(send.attrs['aria-busy']).toBe('true');
    expect(text(send)).toBe('Subscribing…');
  });

  it('never cheers: no exclamation mark in any message', () => {
    for (const message of Object.values(SUBSCRIBE_LABELS.status)) expect(message).not.toMatch(/!/);
  });

  it('frames the photograph with a hairline and puts the caption below it, never on it', () => {
    const figure = one(render(subscribe.withPhoto), tag('figure'));
    const img = one(figure, tag('img'));
    expect(img.attrs.alt).toBe('Stacked offset beams against a forest');
    expect(classes(img)).toEqual(expect.arrayContaining(['border', 'border-border', 'rounded-md']));
    expect(classes(img).join(' ')).not.toMatch(/filter|saturate|contrast|grayscale|opacity/);
    expect(text(one(figure, tag('figcaption')))).toBe('stacked offset beams · reference photo');
    expect(all(root, tag('figure'))).toHaveLength(0);
  });

  it('asks for an email and nothing else', () => {
    expect(all(block, (e) => e.tag === 'input' && e.attrs.type !== 'checkbox')).toHaveLength(1);
  });
});

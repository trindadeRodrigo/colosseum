// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, press, type, unmountAll } from './test/dom';
import { composerToSend, subscribeField } from './test/events.cases';

afterEach(unmountAll);

const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const send = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="composer-send"]');
const submit = (host: HTMLElement) =>
  fire(find(host, 'form'), new Event('submit', { bubbles: true, cancelable: true }));

describe('Composer, sending (composer.md)', () => {
  it('sends what was typed, trimmed, on Enter and on the send button', async () => {
    const onSubmit = vi.fn();
    const host = await mount(composerToSend({}, onSubmit));
    await type(box(host), '  $40,000 by June 2028 ');
    const enter = await press(box(host), 'Enter');
    expect(enter.defaultPrevented).toBe(true); // no new line is added
    await click(send(host));
    expect(onSubmit.mock.calls).toEqual([['$40,000 by June 2028'], ['$40,000 by June 2028']]);
  });

  it('adds a line on Shift+Enter, and leaves Enter to an input method that is composing', async () => {
    const onSubmit = vi.fn();
    const host = await mount(composerToSend({ defaultValue: 'R$ 5.000 por mês' }, onSubmit));
    const shifted = await press(box(host), 'Enter', { shiftKey: true });
    const composing = await press(box(host), 'Enter', { isComposing: true });
    // Safari: the composition has ended, and the key code still says the key was the input method's
    const safari = await press(box(host), 'Enter', { isComposing: false, keyCode: 229 });
    expect(shifted.defaultPrevented).toBe(false);
    expect(composing.defaultPrevented).toBe(false);
    expect(safari.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', {}],
    ['only spaces', { defaultValue: '  \n ' }],
    ['busy', { defaultValue: '$40,000 by June 2028', busy: true }],
    ['disabled', { defaultValue: '$40,000 by June 2028', disabled: true }],
  ] as const)(
    'does not send while it is %s: by Enter, by the button or by the form',
    async (_, props) => {
      const onSubmit = vi.fn();
      const host = await mount(composerToSend(props, onSubmit));
      await press(box(host), 'Enter');
      await click(send(host));
      await submit(host);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(send(host).getAttribute('aria-disabled')).toBe('true');
    },
  );

  it('sends again once it has text and is no longer busy', async () => {
    const onSubmit = vi.fn();
    const host = await mount(composerToSend({}, onSubmit));
    await press(box(host), 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    await type(box(host), 'cash within 7 days');
    await press(box(host), 'Enter');
    expect(onSubmit.mock.calls).toEqual([['cash within 7 days']]);
  });
});

describe('Composer as one line (the subscribe field)', () => {
  // Enter in a one-line field submits its form: the browser clicks the form's submit button.
  it('sends the address on submit, and nothing while it is empty or busy', async () => {
    const onSubmit = vi.fn();
    const empty = await mount(subscribeField({}, onSubmit));
    await click(send(empty));
    await submit(empty);
    const busy = await mount(
      subscribeField({ defaultValue: 'you@example.com', busy: true }, onSubmit),
    );
    await click(send(busy));
    await submit(busy);
    expect(onSubmit).not.toHaveBeenCalled();
    const typed = await mount(subscribeField({}, onSubmit));
    await type(find<HTMLInputElement>(typed, 'input'), ' you@example.com ');
    await click(send(typed));
    expect(onSubmit.mock.calls).toEqual([['you@example.com']]);
  });
});

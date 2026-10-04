// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, unmountAll } from './test/dom';
import { buttonInForm, linkButton, signingForm } from './test/events.cases';

afterEach(unmountAll);

// A click is every way a browser activates a submit button: the pointer, Space or Enter on the
// button, and Enter in a field of the form, which fires a click at the form's first submit button.
describe('Button, clicked (button.md)', () => {
  it('submits its form and calls its handler when it is at rest', async () => {
    const on = { submit: vi.fn(), click: vi.fn(), disabledClick: vi.fn() };
    const host = await mount(buttonInForm({}, on));
    await click(find(host, 'button'));
    expect(on.click).toHaveBeenCalledTimes(1);
    expect(on.submit).toHaveBeenCalledTimes(1);
    expect(on.disabledClick).not.toHaveBeenCalled();
  });

  it('does not submit its form or call its handler while it is busy', async () => {
    const on = { submit: vi.fn(), click: vi.fn(), disabledClick: vi.fn() };
    const host = await mount(buttonInForm({ busy: true }, on));
    const button = find<HTMLButtonElement>(host, 'button');
    expect(button.type).toBe('submit');
    expect(button.disabled).toBe(false); // it keeps its focus, so it has to refuse the click itself
    await click(button);
    await click(button);
    expect(on.submit).not.toHaveBeenCalled();
    expect(on.click).not.toHaveBeenCalled();
    expect(on.disabledClick).not.toHaveBeenCalled();
  });

  it('does not submit its form while it is disabled, and says the click happened', async () => {
    const on = { submit: vi.fn(), click: vi.fn(), disabledClick: vi.fn() };
    const host = await mount(buttonInForm({ disabled: true }, on));
    await click(find(host, 'button'));
    expect(on.submit).not.toHaveBeenCalled();
    expect(on.click).not.toHaveBeenCalled();
    expect(on.disabledClick).toHaveBeenCalledTimes(1);
  });

  it('signs once however many times it is clicked while the signature is in flight', async () => {
    const sign = vi.fn();
    const host = await mount(signingForm(sign));
    const button = find(host, 'button');
    await click(button);
    await click(button);
    await click(button);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('Button as a link, clicked', () => {
  it('calls its handler and keeps its address when it is at rest', async () => {
    const on = { click: vi.fn(), disabledClick: vi.fn() };
    const host = await mount(linkButton({}, on));
    const link = find<HTMLAnchorElement>(host, 'a');
    expect(link.getAttribute('href')).toBe('#sheet');
    await click(link);
    expect(on.click).toHaveBeenCalledTimes(1);
    expect(on.disabledClick).not.toHaveBeenCalled();
  });

  it.each([
    ['busy', { busy: true }, 0],
    ['disabled', { disabled: true }, 1],
  ] as const)(
    'cannot be followed while it is %s, and stays in the tab order',
    async (_, state, told) => {
      const on = { click: vi.fn(), disabledClick: vi.fn() };
      const host = await mount(linkButton(state, on));
      const link = find<HTMLAnchorElement>(host, 'a');
      expect(link.hasAttribute('href')).toBe(false);
      expect(link.getAttribute('role')).toBe('link');
      expect(link.getAttribute('aria-disabled')).toBe('true');
      expect(link.tabIndex).toBe(0);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(on.click).not.toHaveBeenCalled();
      expect(on.disabledClick).toHaveBeenCalledTimes(told);
      await press(link, 'Enter');
      expect(on.click).not.toHaveBeenCalled();
      expect(on.disabledClick).toHaveBeenCalledTimes(told * 2);
    },
  );
});

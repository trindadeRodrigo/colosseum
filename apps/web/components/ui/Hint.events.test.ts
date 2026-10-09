// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HINT_CLOSE_MS, HINT_OPEN_MS, placeFor } from './hover-card';
import { click, find, fire, mount, press, settle, unmountAll } from './test/dom';
import { hintOnLink, hintOnPage } from './test/events.cases';

// The one tooltip (gate TOOLTIP-WORDS): a mouse that rests, the keyboard's focus and a tap all open
// it; Escape closes it; the pointer can move into it; it goes above when there is no room below.

afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

const trigger = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="hint-trigger"]');
const panels = (host: HTMLElement) => host.querySelectorAll('[role="tooltip"]');
const panel = (host: HTMLElement) => find(host, '[role="tooltip"]');
async function move(from: Element | null, to: Element | null, pointerType = 'mouse') {
  const init = { bubbles: true, pointerType };
  if (from) await fire(from, new PointerEvent('pointerout', { ...init, relatedTarget: to }));
  if (to) await fire(to, new PointerEvent('pointerover', { ...init, relatedTarget: from }));
}
const focusOn = (el: Element) => fire(el, new FocusEvent('focusin', { bubbles: true }));

describe('Hint, opened', () => {
  it('is closed until asked for, and takes no title', async () => {
    const host = await mount(hintOnPage());
    expect(panels(host)).toHaveLength(0);
    expect(trigger(host).getAttribute('aria-describedby')).toBeNull();
    expect(host.querySelector('[title]')).toBeNull();
  });

  it('opens once a mouse has rested on it, and not for one that only passes', async () => {
    const host = await mount(hintOnPage());
    await move(null, trigger(host));
    await settle(HINT_OPEN_MS / 2);
    expect(panels(host)).toHaveLength(0);
    await settle(HINT_OPEN_MS / 2 + 30);
    expect(panel(host).textContent).toBe('The whole address of the vault');
    const passing = await mount(hintOnPage());
    await move(null, trigger(passing));
    await move(trigger(passing), find(passing, '#elsewhere'));
    await settle(HINT_OPEN_MS + 30);
    expect(panels(passing)).toHaveLength(0);
  });

  it('opens when the keyboard brings focus to it, and describes its trigger', async () => {
    const host = await mount(hintOnPage());
    await focusOn(trigger(host));
    expect(trigger(host).getAttribute('aria-describedby')).toBe(panel(host).id);
    expect(trigger(host).getAttribute('aria-expanded')).toBe('true');
    await focusOn(find(host, '#elsewhere'));
    expect(panels(host)).toHaveLength(0);
  });

  it('opens on a tap and closes on the next: it does not need a mouse', async () => {
    const host = await mount(hintOnPage());
    const tap = async () => {
      await fire(
        trigger(host),
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      );
      await focusOn(trigger(host));
      await click(trigger(host));
    };
    // a finger that rests opens nothing
    await move(null, trigger(host), 'touch');
    await settle(HINT_OPEN_MS + 30);
    expect(panels(host)).toHaveLength(0);
    await tap();
    expect(panels(host)).toHaveLength(1);
    await tap();
    expect(panels(host)).toHaveLength(0);
  });

  it('closes on Escape, and on a press anywhere else', async () => {
    const host = await mount(hintOnPage());
    await click(trigger(host));
    await press(document, 'Escape');
    expect(panels(host)).toHaveLength(0);
    await click(trigger(host));
    await press(document, 'a');
    expect(panels(host)).toHaveLength(1);
    await fire(
      find(host, '#elsewhere'),
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
    );
    expect(panels(host)).toHaveLength(0);
  });

  it('stays open while the pointer crosses to it and rests inside, and closes once it has left', async () => {
    const host = await mount(hintOnPage());
    await move(null, trigger(host));
    await settle(HINT_OPEN_MS + 30);
    await move(find(host, '[data-ui="hint"]'), document.body);
    await settle(HINT_CLOSE_MS / 2);
    expect(panels(host)).toHaveLength(1);
    await move(document.body, panel(host));
    await settle(HINT_CLOSE_MS + 30);
    expect(panels(host)).toHaveLength(1);
    await move(find(host, '[data-ui="hint"]'), document.body);
    await settle(HINT_CLOSE_MS + 30);
    expect(panels(host)).toHaveLength(0);
  });

  it('wraps a link without a second control: the link is the trigger and is described', async () => {
    const host = await mount(hintOnLink);
    expect(host.querySelectorAll('[data-ui="hint-trigger"]')).toHaveLength(0);
    const link = find(host, '#link');
    await focusOn(link);
    expect(link.getAttribute('aria-describedby')).toBe(panel(host).id);
    expect(panel(host).textContent).toBe('Opens the vault’s page');
    await press(document, 'Escape');
    expect(panels(host)).toHaveLength(0);
    expect(link.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('Hint, placed', () => {
  const view = { width: 375, height: 812 };
  const size = { width: 240, height: 120 };

  it('goes under its trigger, 8px away, and never over it', () => {
    const at = { top: 100, bottom: 120, left: 40 };
    expect(placeFor(at, size, view)).toEqual({ side: 'below', top: 128, left: 40, maxHeight: 668 });
  });

  it('goes above when there is no room below', () => {
    const at = { top: 700, bottom: 720, left: 40 };
    const place = placeFor(at, size, view);
    expect(place.side).toBe('above');
    expect(place.top + size.height).toBe(at.top - 8);
  });

  it('stays 16px inside the right edge, and the left', () => {
    expect(placeFor({ top: 100, bottom: 120, left: 300 }, size, view).left).toBe(375 - 240 - 16);
    expect(placeFor({ top: 100, bottom: 120, left: -40 }, size, view).left).toBe(16);
  });

  it('takes the side with more room when it fits on neither, held to that room', () => {
    const tall = { width: 240, height: 900 };
    const low = placeFor({ top: 600, bottom: 620, left: 40 }, tall, view);
    expect(low).toMatchObject({ side: 'above', top: 16, maxHeight: 576 });
    const high = placeFor({ top: 100, bottom: 120, left: 40 }, tall, view);
    expect(high).toMatchObject({ side: 'below', top: 128, maxHeight: 668 });
  });

  it('is placed against the window, so a scrolling table cannot cut it off, and flips at its foot', async () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(375);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const box = this.matches('[role="tooltip"]')
        ? { top: 0, bottom: 120, left: 0, right: 240, width: 240, height: 120 }
        : { top: 760, bottom: 780, left: 300, right: 360, width: 60, height: 20 };
      return { ...box, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
    });
    const host = await mount(hintOnPage());
    await click(trigger(host));
    const style = panel(host).style;
    expect(style.position).toBe('fixed');
    expect(panel(host).getAttribute('data-side')).toBe('above');
    expect(style.top).toBe(`${760 - 8 - 120}px`);
    expect(style.left).toBe(`${375 - 240 - 16}px`);
  });

  it('fades in only where motion is welcome', async () => {
    const host = await mount(hintOnPage({ defaultOpen: true }));
    expect(panel(host).className.split(' ')).toContain('motion-safe:animate-crossfade');
  });
});

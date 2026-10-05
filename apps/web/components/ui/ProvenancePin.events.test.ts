// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_SPECIMEN } from './fixtures/mock';
import { PIN_CLOSE_MS, PIN_OPEN_MS } from './provenance';
import { click, find, fire, mount, press, settle, unmountAll } from './test/dom';
import { pinOnPage, twoPins } from './test/events.cases';

afterEach(unmountAll);

const pin = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="pin"]');
const popovers = (host: HTMLElement) => host.querySelectorAll('[data-ui="pin-popover"]');
const figure = (host: HTMLElement) => find(host, '[data-ui="figure"]');
const pointerDown = (target: Element) =>
  fire(target, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
/**
 * The pointer moves from one element to another (null: from or to outside the page), as a browser
 * reports it: `pointerout` on what it left, then `pointerover` on what it entered, each naming the other.
 */
async function move(from: Element | null, to: Element | null, pointerType = 'mouse') {
  const init = { bubbles: true, pointerType };
  if (from) await fire(from, new PointerEvent('pointerout', { ...init, relatedTarget: to }));
  if (to) await fire(to, new PointerEvent('pointerover', { ...init, relatedTarget: from }));
}

describe('ProvenancePin, opened and closed (provenance-pin.md)', () => {
  it('opens on a click with source, time and method, and closes on a second click', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    expect(pin(host).getAttribute('aria-expanded')).toBe('false');
    expect(popovers(host)).toHaveLength(0);
    await click(pin(host));
    expect(pin(host).getAttribute('aria-expanded')).toBe('true');
    const line = `${LIVE_SPECIMEN.source} · ${LIVE_SPECIMEN.fetchedAt} · ${LIVE_SPECIMEN.method}`;
    expect(find(host, '[data-ui="pin-source"]').textContent).toContain(line);
    await click(pin(host));
    expect(popovers(host)).toHaveLength(0);
  });

  it('closes on Escape and gives focus back to the pin when focus was inside', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    find(host, '[data-ui="pin-source"]').focus();
    await press(document, 'Escape');
    expect(popovers(host)).toHaveLength(0);
    expect(pin(host).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(pin(host));
  });

  it('closes on Escape without taking focus from elsewhere', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN, { defaultOpen: true }));
    const elsewhere = find(host, '#elsewhere');
    elsewhere.focus();
    await press(document, 'Escape');
    expect(popovers(host)).toHaveLength(0);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('ignores other keys', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN, { defaultOpen: true }));
    await press(document, 'Enter');
    await press(document, 'a');
    expect(popovers(host)).toHaveLength(1);
  });

  it('closes on a press anywhere else, and stays open on a press inside it', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    await pointerDown(find(host, '[data-ui="pin-source"]'));
    await pointerDown(find(host, '[data-ui="pin-popover"]'));
    expect(popovers(host)).toHaveLength(1);
    await pointerDown(find(host, '#elsewhere'));
    expect(popovers(host)).toHaveLength(0);
    expect(pin(host).getAttribute('aria-expanded')).toBe('false');
  });

  it('stops listening once it is closed', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    await press(document, 'Escape');
    await click(pin(host));
    expect(popovers(host)).toHaveLength(1);
    await pointerDown(document.body);
    expect(popovers(host)).toHaveLength(0);
  });
});

describe('ProvenancePin under a mouse (WCAG 1.4.13: the popover can be hovered)', () => {
  it('opens once the mouse has rested on it, and not before', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await move(null, pin(host));
    await settle(PIN_OPEN_MS / 2);
    expect(popovers(host)).toHaveLength(0);
    await settle(PIN_OPEN_MS / 2 + 30);
    expect(popovers(host)).toHaveLength(1);
  });

  it('does not open for a mouse that only passes, or for a finger that rests', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await move(null, pin(host));
    await move(pin(host), find(host, '#elsewhere'));
    await move(null, pin(host), 'touch');
    await settle(PIN_OPEN_MS + 30);
    expect(popovers(host)).toHaveLength(0);
  });

  it('stays open while the pointer crosses to the popover and rests there', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await move(null, pin(host));
    await settle(PIN_OPEN_MS + 30);
    // off the figure, over the gap: nothing of the pin is under the pointer
    await move(figure(host), document.body);
    await settle(PIN_CLOSE_MS / 2);
    expect(popovers(host)).toHaveLength(1);
    await move(document.body, find(host, '[data-ui="pin-popover"]'));
    await settle(PIN_CLOSE_MS + 30);
    expect(popovers(host)).toHaveLength(1);
  });

  it('closes once the pointer has left both for good', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await move(null, pin(host));
    await settle(PIN_OPEN_MS + 30);
    await move(figure(host), document.body);
    await settle(PIN_CLOSE_MS + 30);
    expect(popovers(host)).toHaveLength(0);
  });

  it('stays open when the pointer leaves, if it was opened by a click', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await move(null, pin(host));
    await click(pin(host));
    await move(figure(host), document.body);
    await settle(PIN_CLOSE_MS + 30);
    expect(popovers(host)).toHaveLength(1);
  });

  it('gives the popover the 8px between it and the pin, on both sides', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN, { defaultOpen: true }));
    const list = find(host, '[data-ui="pin-popover"]').className.split(' ');
    for (const bridge of ['before:absolute', 'before:-top-2', 'before:h-2', 'after:-bottom-2'])
      expect(list).toContain(bridge);
  });
});

describe('ProvenancePin and focus', () => {
  it('closes when focus moves to something else on the page', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    pin(host).focus();
    await click(pin(host));
    await fire(find(host, '#elsewhere'), new FocusEvent('focusin', { bubbles: true }));
    expect(popovers(host)).toHaveLength(0);
    expect(pin(host).getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open while focus moves inside it, or goes nowhere', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    pin(host).focus();
    await click(pin(host));
    const source = find(host, '[data-ui="pin-source"]');
    await fire(source, new FocusEvent('focusin', { bubbles: true }));
    source.focus();
    source.blur(); // a press on the popover's text: focus goes to no element
    await settle();
    expect(popovers(host)).toHaveLength(1);
  });
});

describe('ProvenancePin among other figures', () => {
  it('is on a layer above the others while it is open, so none is painted over its popover', async () => {
    const host = await mount(twoPins(LIVE_SPECIMEN));
    const [first, second] = [...host.querySelectorAll('[data-ui="figure"]')] as HTMLElement[];
    const layer = (el?: HTMLElement) => el?.className.split(' ').filter((c) => /^z-/.test(c));
    expect(layer(first)).toEqual(['z-10']);
    expect(layer(second)).toEqual(['z-10']);
    await click(find(first as HTMLElement, '[data-ui="pin"]'));
    expect(layer(first)).toEqual(['z-30']);
    expect(layer(second)).toEqual(['z-10']);
    await press(document, 'Escape');
    expect(layer(first)).toEqual(['z-10']);
  });
});

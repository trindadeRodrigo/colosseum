// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_SPECIMEN } from './fixtures/mock';
import { click, find, fire, mount, press, unmountAll } from './test/dom';
import { pinOnPage } from './test/events.cases';

afterEach(unmountAll);

const pin = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="pin"]');
const popovers = (host: HTMLElement) => host.querySelectorAll('[data-ui="pin-popover"]');
const pointerDown = (target: Element) =>
  fire(target, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));

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

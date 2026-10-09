// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_SPECIMEN, SANDBOX_OBS } from './fixtures/mock';
import { PIN_CLOSE_MS, PIN_OPEN_MS, type PinSource, sourceLine } from './provenance';
import { click, find, fire, mount, press, settle, unmountAll } from './test/dom';
import { pinOnPage, twoPins } from './test/events.cases';

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pin = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="pin"]');
const popovers = (host: HTMLElement) => host.querySelectorAll('[data-ui="pin-popover"]');
const figure = (host: HTMLElement) => find(host, '[data-ui="figure"]');
const details = (host: HTMLElement) => find<HTMLButtonElement>(host, '[data-ui="pin-details"]');
const lines = (host: HTMLElement) =>
  [...find(host, '[data-ui="pin-summary"]').children].map((line) => line.textContent);
/** The price of the screenshot Thom sent: a test network's price account, as the reader writes it. */
const ACCOUNT = 'HSk67BDSrh8486PHxqVgyHMHCbwrnstLbcGfKYdG3q9g';
const OWNER = '2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f';
const PRICE: PinSource = {
  source: `price account ${ACCOUNT} (Scope layout, owner ${OWNER}), entry 484`,
  fetchedAt: '2026-10-09T18:26:20Z',
  method: "value / 10^exponent of the entry; age is the cluster's clock less the entry's time",
  provenance: 'sandbox',
};
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
  it('opens on a click with the plain words, the API’s own one step away, and closes on a second click', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    expect(pin(host).getAttribute('aria-expanded')).toBe('false');
    expect(popovers(host)).toHaveLength(0);
    await click(pin(host));
    expect(pin(host).getAttribute('aria-expanded')).toBe('true');
    expect(lines(host)[0]).toBe('From a sample feed');
    expect(pin(host).getAttribute('aria-describedby')).toBe(
      find(host, '[data-ui="pin-summary"]').id,
    );
    // closed until asked for
    expect(host.querySelector('[data-ui="pin-source"]')).toBeNull();
    await click(details(host));
    expect(details(host).getAttribute('aria-expanded')).toBe('true');
    const facts = find(host, '[data-ui="pin-source"]').textContent ?? '';
    expect(facts).toContain(LIVE_SPECIMEN.source);
    expect(facts).toContain('1 Oct 2026, 14:02:11 UTC');
    expect(facts).toContain(LIVE_SPECIMEN.method);
    expect(find(host, '[data-ui="pin-source"] time').getAttribute('datetime')).toBe(
      LIVE_SPECIMEN.fetchedAt,
    );
    await click(details(host));
    expect(host.querySelector('[data-ui="pin-source"]')).toBeNull();
    await click(pin(host));
    expect(popovers(host)).toHaveLength(0);
  });

  it('opens with its details closed again the next time', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    await click(details(host));
    await click(pin(host));
    await click(pin(host));
    expect(details(host).getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on Escape and gives focus back to the pin when focus was inside', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    details(host).focus();
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
    await pointerDown(details(host));
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
    const source = details(host);
    await fire(source, new FocusEvent('focusin', { bubbles: true }));
    source.focus();
    source.blur(); // a press on the popover's text: focus goes to no element
    await settle();
    expect(popovers(host)).toHaveLength(1);
  });
});

describe('ProvenancePin, reached without a mouse', () => {
  it('opens when the keyboard brings focus to it, and closes when focus goes elsewhere', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await fire(pin(host), new FocusEvent('focusin', { bubbles: true }));
    expect(popovers(host)).toHaveLength(1);
    expect(pin(host).getAttribute('aria-expanded')).toBe('true');
    await fire(find(host, '#elsewhere'), new FocusEvent('focusin', { bubbles: true }));
    expect(popovers(host)).toHaveLength(0);
  });

  it('stays open on Enter once focus has opened it, and closes on the next', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await fire(pin(host), new FocusEvent('focusin', { bubbles: true }));
    await click(pin(host)); // Enter and Space click a button
    expect(popovers(host)).toHaveLength(1);
    await click(pin(host));
    expect(popovers(host)).toHaveLength(0);
  });

  it('opens on a tap: the press, the focus the press brings, then the click', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await fire(pin(host), new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await fire(pin(host), new FocusEvent('focusin', { bubbles: true }));
    // the focus was the press's own: it has not opened it, so the click that follows does not close it
    expect(popovers(host)).toHaveLength(0);
    await click(pin(host));
    expect(popovers(host)).toHaveLength(1);
    // and a second tap closes it
    await fire(pin(host), new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await click(pin(host));
    expect(popovers(host)).toHaveLength(0);
  });

  it('does not open again when Escape gives it focus back', async () => {
    const host = await mount(pinOnPage(LIVE_SPECIMEN));
    await click(pin(host));
    details(host).focus();
    await press(document, 'Escape');
    expect(document.activeElement).toBe(pin(host));
    expect(popovers(host)).toHaveLength(0);
  });
});

describe('what the popover says (gate TOOLTIP-WORDS)', () => {
  it('says the price of the screenshot in plain words, with no account and no formula', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T18:28:20Z'));
    const host = await mount(pinOnPage(PRICE, { value: '$1.0000', what: 'Price' }));
    await click(pin(host));
    expect(lines(host)).toEqual([
      'Price from the test network’s price feed',
      'Updated 2 minutes ago',
      'Test network, not live',
    ]);
    const said = find(host, '[data-ui="pin-popover"]').textContent ?? '';
    expect(said).not.toContain(ACCOUNT);
    expect(said).not.toContain('exponent');
    // the exact time is on the words, for whoever asks the element
    expect(find(host, '[data-ui="pin-fresh"] time').getAttribute('datetime')).toBe(PRICE.fetchedAt);
  });

  it('reads the clock when it opens, and again the next time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T18:26:40Z'));
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    expect(lines(host)[1]).toBe('Updated less than a minute ago');
    await click(pin(host));
    vi.setSystemTime(new Date('2026-10-09T21:26:20Z'));
    await click(pin(host));
    expect(lines(host)[1]).toBe('Updated 3 hours ago');
    await click(pin(host));
    vi.setSystemTime(new Date('2026-10-12T18:26:20Z'));
    await click(pin(host));
    expect(lines(host)[1]).toBe('Updated 3 days ago');
  });

  it('says a stale reading first, with the age the API states and the feed’s own limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T18:26:25Z')); // the read is seconds old; the price is not
    const stale = { ...PRICE, staleAgeSec: 19 * 3600, staleLimitSec: 120 };
    const host = await mount(pinOnPage(stale, { what: 'Price' }));
    await click(pin(host));
    expect(lines(host)).toEqual([
      'Last updated 19 hours ago, older than this feed’s 2 minute limit',
      'Price from the test network’s price feed',
      'Test network, not live',
    ]);
    // a test-network figure keeps its hatched glyph, stale or not: it is never drawn as live
    expect(find(host, '[data-ui="pin-glyph"]').getAttribute('data-state')).toBe('mock');
    const live = await mount(pinOnPage({ ...stale, provenance: 'live' }, { what: 'Price' }));
    expect(find(live, '[data-ui="stale-tag"]').textContent).toBe('stale · 19 h');
    await click(pin(live));
    expect(lines(live)).toEqual([
      'Last updated 19 hours ago, older than this feed’s 2 minute limit',
      'Price from the Kamino Scope price feed',
    ]);
  });

  it('says a stale reading with no stated limit, and one with no age, without making either up', async () => {
    const host = await mount(pinOnPage({ ...LIVE_SPECIMEN, staleAgeSec: 3 * 3600 }));
    await click(pin(host));
    expect(lines(host)[0]).toBe('Last updated 3 hours ago, which is stale');
    const none = await mount(pinOnPage({ ...LIVE_SPECIMEN, staleAgeSec: Number.NaN }));
    await click(pin(none));
    expect(lines(none)[0]).toBe('Stale, and its age is not known');
  });

  it('does not guess at a source it has no name for: the details hold it', async () => {
    const odd = { ...LIVE_SPECIMEN, source: 'ledger 7 of the back office' };
    const host = await mount(pinOnPage(odd));
    await click(pin(host));
    expect(lines(host)[0]).toBe('Source details below');
    await click(details(host));
    expect(find(host, '[data-ui="pin-source"]').textContent).toContain(odd.source);
  });

  it('says what the number is only when the screen names it: a source does not say', async () => {
    const host = await mount(pinOnPage(SANDBOX_OBS, { what: 'Exit cost' }));
    await click(pin(host));
    expect(lines(host)[0]).toBe('Exit cost from the test network’s exchange');
    // a vault's value stands on a price feed, and is not called a price
    const value = await mount(pinOnPage(PRICE));
    await click(pin(value));
    expect(lines(value)[0]).toBe('From the test network’s price feed');
  });
});

describe('the details of a source', () => {
  const clipboard = () => {
    const writeText = vi.fn(async (_: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    return writeText;
  };

  it('shortens each address in the middle, in the mono face, and nothing else is mono', async () => {
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    await click(details(host));
    const shown = [...host.querySelectorAll('[data-ui="pin-address"] .font-mono')].map(
      (el) => el.textContent,
    );
    expect(shown).toEqual(['HSk6…3q9g', '2tic…Kn4f']);
    const facts = find(host, '[data-ui="pin-source"]');
    expect(facts.textContent).not.toContain(ACCOUNT);
    expect(facts.textContent).toContain('(Scope layout, owner ');
    expect(facts.textContent).toContain(PRICE.method);
    expect(facts.querySelectorAll('.font-mono')).toHaveLength(2);
    expect(find(host, '[data-ui="pin-popover"]').className).not.toContain('font-mono');
  });

  it('copies an address whole, and says so', async () => {
    const writeText = clipboard();
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    await click(details(host));
    const [first] = [...host.querySelectorAll<HTMLButtonElement>('[data-ui="pin-copy-address"]')];
    expect(first?.getAttribute('aria-label')).toBe('Copy address HSk6…3q9g');
    await click(first as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith(ACCOUNT);
    expect(find(host, '[data-ui="pin-popover"] [role="status"]').textContent).toBe('Copied');
  });

  it('copies the line the API wrote: source, time in ISO 8601 UTC, method', async () => {
    const writeText = clipboard();
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    await click(details(host));
    await click(find(host, '[data-ui="pin-copy"]'));
    expect(writeText).toHaveBeenCalledWith(sourceLine(PRICE));
    expect(sourceLine(PRICE)).toBe(`${PRICE.source} · 2026-10-09T18:26:20Z · ${PRICE.method}`);
  });

  it('claims no copy where there is no clipboard', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    await click(details(host));
    await click(find(host, '[data-ui="pin-copy"]'));
    expect(find(host, '[data-ui="pin-popover"] [role="status"]').textContent).toBe('');
  });

  it('links an address to the explorer only where the screen hands it one', async () => {
    const host = await mount(pinOnPage(PRICE));
    await click(pin(host));
    await click(details(host));
    expect(host.querySelectorAll('[data-ui="pin-explorer"]')).toHaveLength(0);
    const linked = await mount(
      pinOnPage({ ...PRICE, explorer: 'https://solscan.io/account/{address}?cluster=devnet' }),
    );
    await click(pin(linked));
    await click(details(linked));
    const [link] = [...linked.querySelectorAll<HTMLAnchorElement>('[data-ui="pin-explorer"]')];
    expect(link?.getAttribute('href')).toBe(`https://solscan.io/account/${ACCOUNT}?cluster=devnet`);
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(link?.getAttribute('aria-label')).toBe('View HSk6…3q9g on the explorer');
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

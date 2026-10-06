// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { click, find, fire, mount, press, unmountAll } from './test/dom';
import { navOnPage } from './test/events.cases';

afterEach(unmountAll);

const menu = (host: HTMLElement) => find<HTMLButtonElement>(host, 'button[aria-label="Menu"]');
const sheet = (host: HTMLElement) => find(host, '[data-ui="compact-nav-sheet"]');
const links = (host: HTMLElement) => [...sheet(host).querySelectorAll('a')];
const isOpen = (host: HTMLElement) =>
  !sheet(host).hidden && menu(host).getAttribute('aria-expanded') === 'true';
const pointerDown = (target: Element) =>
  fire(target, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
const focusIn = (target: Element) => fire(target, new FocusEvent('focusin', { bubbles: true }));

describe('CompactNav, the sheet of links on a phone (compact-nav.md)', () => {
  it('is closed at first, and its button says so', async () => {
    const host = await mount(navOnPage);
    expect(sheet(host).hidden).toBe(true);
    expect(menu(host).getAttribute('aria-expanded')).toBe('false');
    expect(menu(host).getAttribute('aria-controls')).toBe(sheet(host).id);
  });

  it('opens from the menu button and takes focus to its first link', async () => {
    const host = await mount(navOnPage);
    menu(host).focus();
    await click(menu(host));
    expect(isOpen(host)).toBe(true);
    expect(document.activeElement).toBe(links(host)[0]);
  });

  it('closes on Escape and gives focus back to the menu button', async () => {
    const host = await mount(navOnPage);
    await click(menu(host));
    links(host)[1]?.focus();
    await press(document, 'Escape');
    expect(isOpen(host)).toBe(false);
    expect(sheet(host).hidden).toBe(true);
    expect(document.activeElement).toBe(menu(host));
  });

  it('closes when focus leaves the header, and stays open while focus is in it', async () => {
    const host = await mount(navOnPage);
    await click(menu(host));
    await focusIn(links(host)[1] as Element);
    await focusIn(find(host, 'a[href="#simulate"]'));
    expect(isOpen(host)).toBe(true);
    await focusIn(find(host, '#elsewhere'));
    expect(isOpen(host)).toBe(false);
  });

  it('closes on a press outside the header, and not on one inside the sheet', async () => {
    const host = await mount(navOnPage);
    await click(menu(host));
    await pointerDown(sheet(host));
    expect(isOpen(host)).toBe(true);
    await pointerDown(find(host, '#elsewhere'));
    expect(isOpen(host)).toBe(false);
  });

  it('closes when a link is followed, and when the button is pressed again', async () => {
    const host = await mount(navOnPage);
    await click(menu(host));
    await click(links(host)[0] as Element);
    expect(isOpen(host)).toBe(false);
    await click(menu(host));
    await click(menu(host));
    expect(isOpen(host)).toBe(false);
  });

  it('hears no key once it is closed', async () => {
    const host = await mount(navOnPage);
    await click(menu(host));
    await press(document, 'Escape');
    find(host, '#elsewhere').focus();
    await press(document, 'Escape');
    expect(document.activeElement).toBe(find(host, '#elsewhere'));
  });
});

describe('CompactNav over a stage (compact-nav.md, Trigger)', () => {
  /** Two steps whose tops a test moves, as scrolling would. */
  function steps() {
    const tops = { s2: 2000, s3: 3000 };
    for (const [id, key] of [
      ['step-2', 's2'],
      ['step-3', 's3'],
    ] as const) {
      const el = document.createElement('div');
      el.id = id;
      el.getBoundingClientRect = () => ({ top: tops[key] }) as DOMRect;
      document.body.append(el);
    }
    return tops;
  }
  const scroll = async () => {
    await fire(window, new Event('scroll'));
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    await fire(window, new Event('scroll'));
  };
  const bar = (host: HTMLElement) => find(host, '[data-ui="compact-nav"]');

  afterEach(() => {
    for (const id of ['step-2', 'step-3']) document.getElementById(id)?.remove();
  });

  it('is compact after a jump past step 03, as End or a link to a section makes', async () => {
    const tops = steps();
    const { CompactNav } = await import('./CompactNav');
    const { createElement } = await import('react');
    const host = await mount(
      createElement(CompactNav, {
        symbol: null,
        wordmark: 'tenonfi',
        homeLabel: 'home',
        links: [{ label: 'Invest', href: '#simulate' }],
        cta: { label: 'Sign in', href: '/sign-in' },
        contentId: 'content',
        stage: { compactAt: 'step-3', releaseAbove: 'step-2' },
      }),
    );
    expect(bar(host).getAttribute('data-compact')).toBe('false');
    // over the hero there is no ground: the band is see-through and lets clicks pass
    const ground = find(host, '[data-ui="compact-nav-ground"]');
    expect(ground.className).toContain('opacity-0');
    expect(ground.className).toContain('pointer-events-none');
    // straight to the end of the page: both steps far above the window
    tops.s2 = -9000;
    tops.s3 = -8000;
    await scroll();
    expect(bar(host).getAttribute('data-compact')).toBe('true');
    // compact, the band the bar floats in is the page's ground, the full width of the window, so no
    // copy is read behind the bar or beside it (e2e/landing-nav.spec.ts checks it in a browser)
    expect(ground.className).toContain('opacity-100');
    expect(ground.className).toEqual(expect.stringContaining('inset-x-0'));
    expect(ground.className).toContain('bg-background');
    expect(ground.getAttribute('aria-hidden')).toBe('true');
    // back between them: it stays compact until step 02 is below the line again
    tops.s2 = 100;
    tops.s3 = 900;
    await scroll();
    expect(bar(host).getAttribute('data-compact')).toBe('true');
    tops.s2 = 5000;
    tops.s3 = 6000;
    await scroll();
    expect(bar(host).getAttribute('data-compact')).toBe('false');
  });
});

// @vitest-environment happy-dom
import { DISCLAIMER } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inShell } from '../../features/account/test/screen';
import {
  EMBEDDED,
  EVM,
  fakePort,
  json,
  PHANTOM,
  SOLANA,
  signedInPort,
} from '../../features/wallet/test/fake-port';
import { location, router } from '../../features/wallet/test/mock-next';
import { portStore } from '../../features/wallet/test/mock-provider';
import { dictionary, type Lang, type ThemeChoice } from '../../i18n';
import { click, find, hintOf, mount, press, settle, unmountAll } from '../ui/test/dom';
import { hatchProblems } from '../ui/test/hatch';
import { parse } from '../ui/test/html';
import { remember } from './remember';

vi.mock(
  '../../features/wallet/WalletProvider',
  () => import('../../features/wallet/test/mock-provider'),
);
vi.mock('next/navigation', () => import('../../features/wallet/test/mock-next'));
vi.mock('next/link', () => import('../../features/wallet/test/mock-next'));

// The shell of the product's routes: the bar, the page, the foot with the disclaimer, and the two
// choices a person makes there, the language and light or dark.

const en = dictionary('en').shell;

const shell = (lang: Lang = 'en', theme: ThemeChoice = 'auto') =>
  mount(inShell(lang, theme, createElement('p', null, 'the page')));
/** The bar's account control for someone signed in, and the menu it opens. */
const menuButton = (host: HTMLElement) => find(host, '[data-ui="account-menu-button"]');
const openMenu = async (host: HTMLElement) => {
  await click(menuButton(host));
  return find(host, '[data-ui="account-menu"]');
};
const pressed = (group: Element) =>
  [...group.querySelectorAll('button')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

beforeEach(() => {
  portStore.set(fakePort());
  portStore.setApi(async () => json({}, 404));
  location.pathname = '/goal';
  router.refresh.mockClear();
  document.documentElement.className = 'fonts tf-auto';
  for (const name of ['tf-theme', 'tf-lang']) remember(name, null);
});
afterEach(unmountAll);

describe('a link drawn as a button', () => {
  const page = (href: string, attrs: Record<string, string> = {}) =>
    mount(
      inShell(
        'en',
        'auto',
        createElement('a', { 'data-ui': 'button', href, ...attrs }, 'See your portfolio'),
      ),
    );
  const clickOn = (el: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    // what the shell decided is read as the click leaves the document; then the test stops the
    // browser's own navigation, which would go and fetch the address
    let routed = false;
    window.addEventListener(
      'click',
      (e) => {
        routed = e.defaultPrevented;
        e.preventDefault();
      },
      { once: true },
    );
    el.dispatchEvent(event);
    return { defaultPrevented: routed };
  };

  it('goes through the router to a page of this app, with no reload of the whole page', async () => {
    router.push.mockClear();
    const host = await page('/monitor');
    const event = clickOn(find(host, 'main a'));
    expect(event.defaultPrevented).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/monitor');
  });

  it('is left to the browser with a key held, to a fragment, another site or a new tab', async () => {
    router.push.mockClear();
    const held = await page('/monitor');
    expect(clickOn(find(held, 'main a'), { metaKey: true }).defaultPrevented).toBe(false);
    expect(clickOn(find(held, 'main a'), { button: 1 }).defaultPrevented).toBe(false);
    await unmountAll();
    for (const [href, attrs] of [
      ['#limits', {}],
      ['https://solscan.io/tx/x', {}],
      ['//elsewhere.example/x', {}],
      ['/monitor', { target: '_blank' }],
    ] as const) {
      const host = await page(href, attrs);
      expect(clickOn(find(host, 'main a')).defaultPrevented, href).toBe(false);
      await unmountAll();
    }
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('the frame', () => {
  it('is a bar, the page and a foot, with a way past the bar for a keyboard', async () => {
    const host = await shell();
    const frame = find(host, '[data-ui="app-shell"]');
    expect([...frame.children].map((el) => el.tagName)).toEqual(['HEADER', 'MAIN', 'FOOTER']);
    // the first link of the bar
    const skip = find<HTMLAnchorElement>(frame, 'a[href="#content"]');
    expect(find(frame, 'header').querySelector('a')).toBe(skip);
    expect(skip.textContent).toBe(en.skip);
    expect(find(frame, 'main').id).toBe('content');
    expect(find(frame, 'main').textContent).toBe('the page');
    expect(find(frame, 'nav').getAttribute('aria-label')).toBe(en.nav);
  });

  it('is his compact bar: the mark and the wordmark, then his items on the product’s routes', async () => {
    const host = await shell();
    const bar = find(host, '[data-ui="compact-nav"]');
    expect(bar.getAttribute('data-compact')).toBe('true');
    const home = find<HTMLAnchorElement>(host, `a[aria-label="${en.home}"]`);
    expect(home.textContent).toBe('tenonfi');
    expect(home.getAttribute('href')).toBe('/');
    expect(home.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const links = (root: HTMLElement) => [...find(root, 'nav').querySelectorAll(':scope > a')];
    // a visitor: no portfolio to show
    expect(links(host).map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [en.products, '/shelf'],
      [en.invest, '/goal'],
      [en.analytics, '/analytics/stocks'],
    ]);
    // no Resources item (Thom, Oct 6): the methodology is reached from Bearing's own side menu
    expect(host.querySelector('nav a[href="/analytics/methodology"]')).toBeNull();
    // the page a person is on is said, not only shown; the plan and the order are under Invest
    expect(links(host).map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    // every page of Bearing's analytics is under Analytics, its methodology too
    location.pathname = '/analytics/lending';
    expect(links(await shell()).map((a) => a.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
    ]);
    location.pathname = '/analytics/methodology';
    expect(links(await shell()).map((a) => a.getAttribute('aria-current'))).toEqual([
      null,
      null,
      'page',
    ]);
    location.pathname = '/plan/abc';
    expect(links(await shell()).map((a) => a.getAttribute('aria-current'))).toEqual([
      null,
      'page',
      null,
    ]);
    // a shared portfolio's page is under Products, the shelf
    location.pathname = '/indexes/some-portfolio';
    expect(links(await shell()).map((a) => a.getAttribute('aria-current'))).toEqual([
      'page',
      null,
      null,
    ]);
    // someone signed in gets their portfolio, after Invest
    portStore.set(signedInPort(EMBEDDED));
    location.pathname = '/monitor';
    const signedIn = await shell();
    expect(links(signedIn).map((a) => [a.textContent, a.getAttribute('aria-current')])).toEqual([
      [en.products, null],
      [en.invest, null],
      [en.portfolio, 'page'],
      [en.analytics, null],
    ]);
    // the portfolio's board, a page of its section and a vault's own page are under it too
    for (const path of ['/portfolio', '/portfolio/plan/solana/abc', '/vaults/solana/abc']) {
      location.pathname = path;
      expect(links(await shell()).map((a) => a.getAttribute('aria-current'))).toEqual([
        null,
        null,
        'page',
        null,
      ]);
    }
    // on a phone the same links are in the sheet under the menu button
    const sheet = find(signedIn, '[data-ui="compact-nav-sheet"]');
    expect([...sheet.querySelectorAll(':scope > a')].map((a) => a.getAttribute('href'))).toEqual([
      '/shelf',
      '/goal',
      '/portfolio',
      '/analytics/stocks',
    ]);
    expect(find(signedIn, `button[aria-label="${en.menu}"]`).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('renders the disclaimer from the one constant, whole, at body size, in the language of the view', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const host = await shell(lang);
      const block = find(host, 'footer [data-ui="disclaimer"]');
      expect(block.tagName).toBe('ASIDE');
      expect(block.getAttribute('aria-label')).toBe(dictionary(lang).shell.disclaimer);
      const text = find(block, 'p');
      expect(text.textContent).toBe(DISCLAIMER[lang]);
      expect(text.getAttribute('lang')).toBe(lang);
      // body size: 1rem unless a partner's embed sets its own, and never a smaller class
      expect(text.className).toContain('text-[length:var(--tf-e-body,1rem)]');
      expect(text.className).not.toMatch(/text-(xs|sm|caption|body-sm)/);
      expect(block.querySelectorAll('p')).toHaveLength(1);
    }
  });

  it('draws no wallet-adapter button: nothing that differs between the server and the browser', async () => {
    const host = await shell();
    expect(host.innerHTML).not.toMatch(/wallet-adapter|Select Wallet/);
    // the port is still loading: the bar says nothing about the person yet
    portStore.set(fakePort({ status: 'loading' }));
    const loading = await shell();
    expect(loading.querySelector('[data-ui="account"]')).toBeNull();
    expect(loading.querySelector('header a[href^="/sign-in"]')).toBeNull();
  });
});

describe('who is signed in, in the bar', () => {
  it('offers "Sign in" to nobody in particular, as a link to the sign-in screen', async () => {
    const host = await shell();
    const link = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    expect(link.textContent).toBe(en.signIn);
    // it comes back to the page the person is on (a link opened in a new tab too)
    expect(link.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(find(host, '[data-ui="account-control"]').getAttribute('data-state')).toBe('signed-out');
    expect(host.querySelector('[data-ui="account"]')).toBeNull();
  });

  it('draws "Sign in" as the bar’s one primary action on every page but the sign-in screen', async () => {
    for (const path of ['/goal', '/shelf', '/analytics/stocks']) {
      location.pathname = path;
      const host = await shell();
      const link = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
      expect(link.className, path).toContain('bg-primary');
      expect(link.className, path).toContain('h-10');
      expect(link.getAttribute('aria-current'), path).toBeNull();
      await unmountAll();
    }
  });

  it('marks "Sign in" as the page the person is on, on the sign-in screen, and not as a button', async () => {
    location.pathname = '/sign-in';
    const host = await shell();
    const links = host.querySelectorAll<HTMLAnchorElement>('header a[href="/sign-in"]');
    expect(links).toHaveLength(1);
    const here = links[0] as HTMLAnchorElement;
    expect(here.textContent).toBe(en.signIn);
    expect(here.getAttribute('aria-current')).toBe('page');
    expect(here.getAttribute('data-ui')).toBe('sign-in-here');
    // the bar's current-link mark, and no button of any kind: the screen's own primary stands alone
    expect(here.className).toContain('underline');
    expect(here.className).toContain('decoration-primary');
    expect(here.className).not.toContain('bg-primary');
    expect(here.className).not.toContain('border');
  });

  it('shows the account control on the sign-in screen once someone is signed in', async () => {
    location.pathname = '/sign-in';
    portStore.set(signedInPort(EMBEDDED));
    const host = await shell();
    await settle();
    expect(host.querySelector('[data-ui="sign-in-here"]')).toBeNull();
    // the same size as "Sign in" elsewhere: the bar keeps its height
    expect(menuButton(host).className).toContain('h-10');
    expect((await openMenu(host)).textContent).toContain(en.signOut);
  });

  it('underlines the bar’s link to the page in view, as compact-nav.md marks a current link', async () => {
    location.pathname = '/goal';
    const host = await shell();
    const invest = find<HTMLAnchorElement>(host, 'nav > a[href="/goal"]');
    expect(invest.getAttribute('aria-current')).toBe('page');
    expect(invest.className).toContain('aria-[current=page]:underline');
  });

  it('shows the person and no chain or address in the bar, and their wallets with a way out in the menu', async () => {
    portStore.setApi(async () =>
      json({
        userId: 'did:privy:test',
        wallets: EMBEDDED,
        chain: 'solana',
        chainSource: 'picked',
        chainOptions: [],
      }),
    );
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await shell();
    await settle();
    // a person with a wallet on each chain has two addresses: the bar shows neither, and no chain
    const button = menuButton(host);
    expect(button.textContent).toBe(en.accountLabel);
    expect(button.innerHTML).not.toMatch(/So11|0x20|Solana|Robinhood/);
    expect(button.querySelector('[title]')).toBeNull();
    const menu = await openMenu(host);
    // a real wallet carries no MOCK plate
    expect(menu.querySelector('.tf-mock-plate')).toBeNull();
    expect(
      [...menu.querySelectorAll('[data-ui="account-address"]')].map((a) => a.getAttribute('title')),
    ).toEqual([SOLANA, EVM]);
    await click(find(menu, '[data-ui="sign-out"]'));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]').textContent).toBe(en.signIn);
  });

  it('is the same control before our server has said anything: the wallets the sign-in holds, and the way out', async () => {
    portStore.set(signedInPort(EMBEDDED));
    const host = await shell();
    await settle();
    // no chain was ever in the bar to wait for: the label is the label
    expect(menuButton(host).textContent).toBe(en.accountLabel);
    expect(menuButton(host).hasAttribute('data-ready')).toBe(false);
    const menu = await openMenu(host);
    expect(menu.querySelectorAll('[data-ui="account-wallet"]')).toHaveLength(2);
    expect([...menu.querySelectorAll('button')].at(-1)?.textContent).toBe(en.signOut);
  });

  it('says nothing about anyone before the wallet has loaded: a still box, nothing to press', async () => {
    portStore.set(fakePort({ status: 'loading' }));
    const host = await shell();
    expect(host.querySelector('[data-ui="account"]')).toBeNull();
    expect(host.querySelector('header a[href^="/sign-in"]')).toBeNull();
    const control = find(host, '[data-ui="account-control"]');
    expect(control.getAttribute('data-state')).toBe('loading');
    const box = find(control, '[data-ui="account-placeholder"]');
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.textContent).toBe('');
    expect(control.querySelectorAll('button, a')).toHaveLength(0);
    // a wait under 400ms is not announced
    expect(find(control, '[data-ui="account-said"]').textContent).toBe('');
  });

  it.each(['making', 'failed'] as const)(
    'always offers the way out to someone signed in whose wallets are %s',
    async (walletsOwed) => {
      const signOut = vi.fn(async () => {
        portStore.set(fakePort());
      });
      portStore.set(
        fakePort({ status: 'loading', userId: 'did:privy:test', walletsOwed, signOut }),
      );
      const host = await shell();
      await settle();
      // no wallet to list yet; the name is "Your account" either way
      const button = menuButton(host);
      expect(button.getAttribute('aria-label')).toBe(en.account);
      expect(button.textContent).toBe(walletsOwed === 'making' ? '' : en.accountLabel);
      const menu = await openMenu(host);
      expect(menu.textContent).toBe(en.signOut);
      await click(find(menu, '[data-ui="sign-out"]'));
      await settle();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(find(host, 'header a[href^="/sign-in"]').textContent).toBe(en.signIn);
    },
  );

  it('keeps the loading look while the wallets of someone signed in are being made, with the way out in it', async () => {
    // a passing state: the button shows a still box where its label will be, is named "Your
    // account" for a screen reader, and opens "Sign out" at once
    portStore.set(fakePort({ status: 'loading', userId: 'did:privy:test', walletsOwed: 'making' }));
    const host = await shell();
    await settle();
    const control = find(host, '[data-ui="account-control"]');
    expect(control.getAttribute('data-state')).toBe('loading');
    const button = menuButton(host);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(find(button, '[data-ui="account-placeholder"]').getAttribute('data-shape')).toBe(
      'account',
    );
    expect(button.getAttribute('aria-label')).toBe(en.account);
    expect(button.querySelector('[data-ui="account-label"]')).toBeNull();
    // the way out without waiting for the help
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect((await openMenu(host)).textContent).toBe(en.signOut);
  });

  it('puts focus on "Sign in" after a sign-out, and tells a screen reader the person is out', async () => {
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await shell();
    await settle();
    const out = find(await openMenu(host), '[data-ui="sign-out"]');
    out.focus();
    await click(out);
    await settle();
    const link = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    expect(document.activeElement).toBe(link);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe(en.signedOut);
  });

  it('says so when signing out did not work, and the person is still signed in', async () => {
    const signOut = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await shell();
    await settle();
    const menu = await openMenu(host);
    await click(find(menu, '[data-ui="sign-out"]'));
    await settle();
    expect(find(menu, '[role="alert"]').textContent).toBe(en.signOutFailed);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe('');
    // still the way out, to try again
    expect(find(menu, '[data-ui="sign-out"]').textContent).toBe(en.signOut);
  });

  it('says nothing and moves no focus when the page loads signed out', async () => {
    const host = await shell();
    await settle();
    expect(document.activeElement).toBe(document.body);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe('');
  });

  it('says "Sample" beside the chain of a wallet on the mock, in words with no glyph, never MOCK', async () => {
    portStore.set(signedInPort(PHANTOM, { test: true }, 'mock'));
    const host = await shell();
    await settle();
    // nothing in the bar is a figure or an address: no mark there
    expect(find(host, '[data-ui="account"] > button').querySelector('.tf-hatch')).toBeNull();
    const menu = await openMenu(host);
    const row = find(menu, '[data-ui="account-wallet"]');
    // a chain named with no figure beside it carries the word, not the hatched glyph (Thom, Oct 9)
    expect(find(row, '[data-ui="account-wallet-run"]').textContent).toBe(en.chainRun.shown.mock);
    expect(row.querySelector('[data-ui="sample-glyph"], .tf-hatch, .tf-mock-plate')).toBeNull();
    expect(row.textContent).toContain(`Solana, ${en.chainRun.said.mock}`);
    expect(menu.textContent).not.toContain('MOCK');
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('the account control of someone signed in (Thom, Oct 6 and Oct 9)', () => {
  const words = dictionary('en');
  /** A passkey person on Solana, and the switches sent to the API. */
  const onSolana = () => {
    const puts: unknown[] = [];
    let chain = 'solana';
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me/chain') {
        chain = JSON.parse(String(init?.body)).chain;
        puts.push(chain);
      }
      return json({
        userId: 'did:privy:test',
        wallets: EMBEDDED,
        chain,
        chainSource: 'picked',
        chainOptions: ['solana', 'robinhood'],
      });
    });
    portStore.set(signedInPort(EMBEDDED));
    return puts;
  };

  it('is one button with a wallet glyph and "Account", named "Your account", of one width', async () => {
    onSolana();
    const host = await shell();
    await settle();
    const bar = find(host, '[data-ui="account-control"]');
    // one control: no chain switcher beside it, no "Sign out" button in the bar
    expect(bar.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('header [data-ui="chain-switch"]')).toBeNull();
    const button = menuButton(host);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe(en.account);
    expect(button.textContent).toBe(en.accountLabel);
    // the person, not a chain: no chain, no address, nothing a chain could change
    expect(button.hasAttribute('data-chain')).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(button.innerHTML).not.toMatch(/Solana|Robinhood|So11|0x20/);
    expect(button.querySelectorAll('svg')).toHaveLength(2);
    // the label sits in a box of one width, the same box the still bar sits in while it loads
    const box = find(button, '[data-ui="account-label"]').parentElement as HTMLElement;
    expect(box.className).toMatch(/\bw-\[/);
    await unmountAll();
    portStore.set(fakePort({ status: 'loading', userId: 'did:privy:test' }));
    const waiting = await shell();
    const bars = find(menuButton(waiting), '[data-ui="account-placeholder"]');
    expect((bars.parentElement as HTMLElement).className).toBe(box.className);
    // a hairline and 2px corners, never a pill
    expect(button.className).toContain('rounded-md');
    expect(button.className).not.toContain('rounded-full');
  });

  it('opens with the person’s wallets, one for each chain they have one on, then "Sign out", and closes with Escape', async () => {
    onSolana();
    const host = await shell();
    await settle();
    menuButton(host).focus();
    const menu = await openMenu(host);
    expect(menuButton(host).getAttribute('aria-expanded')).toBe('true');
    expect(menuButton(host).getAttribute('aria-controls')).toBe(menu.id);
    const list = find(menu, '[data-ui="account-wallets"]');
    expect(list.getAttribute('aria-label')).toBe(en.wallets);
    const rows = [...list.querySelectorAll<HTMLElement>('[data-ui="account-wallet"]')];
    expect(rows.map((r) => r.getAttribute('data-chain'))).toEqual(['solana', 'robinhood']);
    expect(rows.map((r) => find(r, '[data-ui="account-wallet-chain"]').textContent)).toEqual([
      'Solana',
      'Robinhood Chain',
    ]);
    // the chain's own mark before its name, 16px, and silent: the name is written beside it
    for (const row of rows) {
      const logo = find<HTMLImageElement>(row, '[data-ui="chain-logo"]');
      expect(logo.getAttribute('data-chain')).toBe(row.getAttribute('data-chain'));
      expect([logo.getAttribute('alt'), logo.getAttribute('aria-hidden')]).toEqual(['', 'true']);
      expect([logo.getAttribute('width'), logo.getAttribute('height')]).toEqual(['16', '16']);
      expect(logo.nextElementSibling).toBe(find(row, '[data-ui="account-wallet-chain"]'));
    }
    // each on a test network here: said beside the chain's name in words alone, with no glyph (no
    // figure stands here); a screen reader hears "Solana, test network"
    for (const row of rows) {
      const run = find(row, '[data-ui="account-wallet-run"]');
      expect(run.textContent).toBe(en.chainRun.shown.sandbox);
      expect(run.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('[data-ui="sample-glyph"], .tf-hatch, .tf-mock-plate')).toBeNull();
    }
    const heard = (row: HTMLElement) =>
      [...(row.firstElementChild as HTMLElement).childNodes]
        .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true'))
        .map((n) => n.textContent)
        .join('');
    expect(rows.map(heard)).toEqual(['Solana, test network', 'Robinhood Chain, test network']);
    // the address cut short, the whole one for a screen reader and under the pointer
    const [solana, evm] = rows.map((r) => find(r, '[data-ui="account-address"]'));
    expect(find(solana as HTMLElement, '[aria-hidden="true"]').textContent).toBe('So11…1112');
    expect(find(solana as HTMLElement, '.sr-only').textContent).toBe(SOLANA);
    expect(solana?.getAttribute('title')).toBe(SOLANA);
    expect(evm?.getAttribute('title')).toBe(EVM);
    // its copy is an icon on the same line, not a row of its own
    const copy = find(rows[0] as HTMLElement, '[data-ui="copy-button"]');
    // two wallets: each copy is named for its chain, so a screen reader can tell them apart
    expect(copy.getAttribute('aria-label')).toBe(`${en.copyAddress} (Solana)`);
    // what it copies is said in the tooltip, on hover, focus or tap, and not in a native title
    expect(await hintOf(copy, menuButton(host))).toContain(SOLANA);
    expect(copy.getAttribute('title')).toBeNull();
    expect(copy.textContent).toBe('');
    const items = [...menu.querySelectorAll('button, a')].map(
      (el) => el.textContent || el.getAttribute('aria-label'),
    );
    expect(items).toEqual([
      `${en.copyAddress} (Solana)`,
      en.viewOn('Solscan'),
      `${en.copyAddress} (Robinhood Chain)`,
      en.viewOn('Robinhood explorer'),
      en.signOut,
    ]);
    const explorer = find<HTMLAnchorElement>(
      rows[0] as HTMLElement,
      '[data-ui="account-explorer"]',
    );
    expect(explorer.getAttribute('href')).toContain(`/account/${SOLANA}`);
    expect(explorer.getAttribute('target')).toBe('_blank');
    // and the EVM wallet's page on its own chain's explorer
    expect(
      find<HTMLAnchorElement>(rows[1] as HTMLElement, '[data-ui="account-explorer"]').getAttribute(
        'href',
      ),
    ).toContain(`/address/${EVM}`);
    // from an item inside it: focus goes back to the control
    find(menu, '[data-ui="sign-out"]').focus();
    await press(find(menu, '[data-ui="sign-out"]'), 'Escape');
    expect(host.querySelector('[data-ui="account-menu"]')).toBeNull();
    expect(document.activeElement).toBe(menuButton(host));
  });

  it('closes when focus leaves it', async () => {
    onSolana();
    const host = await shell();
    await settle();
    await openMenu(host);
    const outside = find<HTMLAnchorElement>(host, `a[aria-label="${en.home}"]`);
    outside.focus();
    await settle();
    expect(host.querySelector('[data-ui="account-menu"]')).toBeNull();
  });

  it('lists one wallet for a person with one', async () => {
    portStore.setApi(async () =>
      json({
        userId: 'did:privy:test',
        wallets: PHANTOM,
        chain: 'solana',
        chainSource: 'wallet',
        chainOptions: ['solana'],
      }),
    );
    portStore.set(signedInPort(PHANTOM));
    const host = await shell();
    await settle();
    const menu = await openMenu(host);
    const rows = [...menu.querySelectorAll('[data-ui="account-wallet"]')];
    expect(rows.map((r) => r.getAttribute('data-chain'))).toEqual(['solana']);
    expect(menu.textContent).not.toContain('Robinhood');
    // one wallet, one copy: it needs no chain in its name
    expect(find(menu, '[data-ui="copy-button"]').getAttribute('aria-label')).toBe(en.copyAddress);
  });

  it('says how each chain is run on its own row, nothing for a live one, and links no explorer for a chain on the mock', async () => {
    onSolana();
    // Solana live, Robinhood Chain on the mock
    const port = signedInPort(EMBEDDED);
    portStore.set({
      ...port,
      network: (chain) =>
        ({ ...port.network(chain), provenance: chain === 'solana' ? 'live' : 'mock' }) as never,
    });
    const host = await shell();
    await settle();
    const menu = await openMenu(host);
    const [solana, robinhood] = [
      ...menu.querySelectorAll<HTMLElement>('[data-ui="account-wallet"]'),
    ] as [HTMLElement, HTMLElement];
    // a live chain says nothing after its name
    expect(solana.querySelector('[data-ui="account-wallet-run"]')).toBeNull();
    expect((solana.firstElementChild as HTMLElement).textContent).toBe('Solana');
    // the other row says it is a sample, to the eye and to a screen reader, each row for itself
    expect(find(robinhood, '[data-ui="account-wallet-run"]').textContent).toBe(
      en.chainRun.shown.mock,
    );
    expect(robinhood.textContent).toContain(`Robinhood Chain, ${en.chainRun.said.mock}`);
    expect(menu.querySelector('[data-ui="sample-glyph"], .tf-hatch')).toBeNull();
    expect(solana.querySelector('[data-ui="account-explorer"]')).not.toBeNull();
    expect(robinhood.querySelector('[data-ui="account-explorer"]')).toBeNull();
  });

  it('holds nothing that switches a chain: where new plans start is not written from the bar', async () => {
    const puts = onSolana();
    const host = await shell();
    await settle();
    const menu = await openMenu(host);
    expect(
      menu.querySelector('[role="group"], [aria-pressed], input, button[data-chain]'),
    ).toBeNull();
    for (const el of menu.querySelectorAll<HTMLElement>('button:not([data-ui="sign-out"])'))
      await click(el);
    await settle();
    expect(puts).toEqual([]);
    expect(host.querySelector('[data-ui="chain-said"]')).toBeNull();
  });

  it('copies the whole address, and says "Copied"', async () => {
    onSolana();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      const host = await shell();
      await settle();
      const menu = await openMenu(host);
      const copy = find(menu, '[data-chain="solana"] [data-ui="copy-button"]');
      // the button sits in its tooltip's wrapper; what was copied is announced after it
      const status = () =>
        find(menu, '[data-chain="solana"] [data-ui="hint"]:has([data-ui="copy-button"]) + *');
      const said = () => status().textContent;
      const drawn = () =>
        [...copy.querySelectorAll('svg path')].map((path) => path.getAttribute('d')).join(' ');
      expect(copy.getAttribute('aria-label')).toBe(`${en.copyAddress} (Solana)`);
      expect(said()).toBe('');
      const before = drawn();
      await click(copy);
      await settle();
      // the whole address, never the short one on screen
      expect(writeText).toHaveBeenCalledWith(SOLANA);
      expect(status().getAttribute('role')).toBe('status');
      expect(said()).toBe(en.copied);
      // the copy icon turns into the tick
      expect(drawn()).not.toBe(before);
      expect(drawn()).toBe('M4 12L9 17L20 6');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('heads the phone’s sheet with the same block: the wallets, "Sign out"', async () => {
    const puts = onSolana();
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await shell();
    await settle();
    const sheet = find(host, '[data-ui="compact-nav-sheet"]');
    const block = find(sheet, '[data-ui="account-block"]');
    // at its top, before the links
    expect(sheet.firstElementChild?.contains(block)).toBe(true);
    expect(sheet.firstElementChild?.nextElementSibling?.tagName).toBe('A');
    expect(
      [...block.querySelectorAll('[data-ui="account-address"] [aria-hidden="true"]')].map(
        (a) => a.textContent,
      ),
    ).toEqual(['So11…1112', '0x20…0498']);
    expect(block.querySelectorAll('[data-ui="copy-button"]')).toHaveLength(2);
    expect(block.querySelector('button[data-chain], [role="group"]')).toBeNull();
    await click(find(find(host, '[data-ui="compact-nav-sheet"]'), '[data-ui="sign-out"]'));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(puts).toEqual([]);
    // signed out, the sheet has no account block
    expect(
      host.querySelector('[data-ui="compact-nav-sheet"] [data-ui="account-block"]'),
    ).toBeNull();
  });

  it('signed out, is the one primary "Sign in", with no chain switcher in the bar', async () => {
    const host = await shell();
    await settle();
    const bar = find(host, '[data-ui="account-control"]');
    expect(host.querySelector('header [data-ui="chain-switch"]')).toBeNull();
    expect(find(host, '[data-ui="compact-nav-bar"]').textContent).not.toMatch(/Solana|Robinhood/);
    expect(bar.querySelector('[data-ui="account"]')).toBeNull();
    expect(bar.querySelectorAll('a, button')).toHaveLength(1);
    expect(find<HTMLAnchorElement>(bar, 'a[href^="/sign-in"]').textContent).toBe(en.signIn);
  });
});

describe('light or dark, as one icon in the bar', () => {
  it('is one button in the bar, named for what a press does, and no switches in the foot', async () => {
    const host = await shell();
    const toggle = find(host, '[data-ui="compact-nav-bar"] [data-ui="theme-toggle"]');
    // on a phone the bar has no room for it: the same toggle sits in the menu's sheet instead
    expect(
      host.querySelectorAll('[data-ui="compact-nav-sheet"] [data-ui="theme-toggle"]'),
    ).toHaveLength(1);
    expect(toggle.tagName).toBe('BUTTON');
    // the sun is drawn on a dark page and the moon on a light one, by the stylesheet alone
    expect(toggle.textContent).toContain(en.toLight);
    expect(toggle.textContent).toContain(en.toDark);
    expect(host.querySelector('[data-ui="theme-switch"], [data-ui="language-switch"]')).toBeNull();
  });

  it('flips what is drawn now, at once, and keeps the choice for the next page', async () => {
    const host = await shell('en', 'dark');
    const root = document.documentElement;
    root.className = 'fonts dark';
    const bar = '[data-ui="compact-nav-bar"] [data-ui="theme-toggle"]';
    await click(find(host, bar));
    expect(root.className).toBe('fonts light');
    expect(document.cookie).toContain('tf-theme=light');
    await click(find(host, bar));
    expect(root.className).toBe('fonts dark');
    expect(document.cookie).toContain('tf-theme=dark');
  });
});

describe('the language', () => {
  it('says the whole shell in Portuguese when that is the language', async () => {
    const pt = dictionary('pt').shell;
    const host = await shell('pt');
    expect(find(host, 'a[href="#content"]').textContent).toBe(pt.skip);
    expect([...find(host, 'nav').querySelectorAll(':scope > a')].map((a) => a.textContent)).toEqual(
      [pt.products, pt.invest, pt.analytics],
    );
    expect(find(host, 'header a[href^="/sign-in"]').textContent).toBe(pt.signIn);
    expect(host.textContent).not.toMatch(/!/);
  });
});

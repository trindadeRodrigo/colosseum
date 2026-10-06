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
import { click, find, mount, settle, unmountAll } from '../ui/test/dom';
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
const pressed = (group: Element) =>
  [...group.querySelectorAll('button')]
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);

beforeEach(() => {
  portStore.set(fakePort());
  portStore.setApi(async () => json({}, 404));
  location.pathname = '/';
  router.refresh.mockClear();
  document.documentElement.className = 'fonts tf-auto';
  for (const name of ['tf-theme', 'tf-lang']) remember(name, null);
});
afterEach(unmountAll);

describe('the frame', () => {
  it('is a bar, the page and a foot, with a way past the bar for a keyboard', async () => {
    const host = await shell();
    const frame = find(host, '[data-ui="app-shell"]');
    expect([...frame.children].map((el) => el.tagName)).toEqual(['A', 'HEADER', 'MAIN', 'FOOTER']);
    const skip = find<HTMLAnchorElement>(frame, 'a[href="#content"]');
    expect(skip.textContent).toBe(en.skip);
    expect(find(frame, 'main').id).toBe('content');
    expect(find(frame, 'main').textContent).toBe('the page');
    expect(find(frame, 'nav').getAttribute('aria-label')).toBe(en.nav);
  });

  it('shows the mark and the wordmark, in lower case, the goal as the first link, the portfolio after it, then the analytics', async () => {
    const host = await shell();
    const home = find<HTMLAnchorElement>(host, `a[aria-label="${en.home}"]`);
    expect(home.textContent).toBe('tenonfi');
    expect(home.getAttribute('href')).toBe('/');
    expect(home.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const links = [...find(host, 'nav').querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [en.goal, '/'],
      [en.portfolio, '/monitor'],
      [en.analytics, '/analytics/stocks'],
    ]);
    // the page a person is on is said, not only shown
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null]);
    location.pathname = '/monitor';
    const monitor = [...find(await shell(), 'nav').querySelectorAll('a')];
    expect(monitor.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    // every page of Bearing's analytics is under the one link
    location.pathname = '/analytics/lending';
    const bearing = [...find(await shell(), 'nav').querySelectorAll('a')];
    expect(bearing.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, 'page']);
    location.pathname = '/sign-in';
    const elsewhere = [...find(await shell(), 'nav').querySelectorAll('a')];
    expect(elsewhere.map((a) => a.getAttribute('aria-current'))).toEqual([null, null, null]);
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
    expect(find(loading, 'header').textContent).toBe(
      `tenonfi${en.goal}${en.portfolio}${en.analytics}`,
    );
  });
});

describe('who is signed in, in the bar', () => {
  it('offers "Sign in" to nobody in particular, as a link to the sign-in screen', async () => {
    const host = await shell();
    const link = find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]');
    expect(link.textContent).toBe(en.signIn);
    expect(host.querySelector('[data-ui="account"]')).toBeNull();
  });

  it('shows the wallet of the chain the plan lives on, and no other, with a way out', async () => {
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
    const account = find(host, '[data-ui="account"]');
    expect(account.textContent).toContain('So11…1112');
    expect(account.querySelector('[title]')?.getAttribute('title')).toBe(SOLANA);
    expect(account.innerHTML).not.toContain(EVM);
    expect(account.innerHTML).not.toContain('0x20');
    // a real wallet carries no MOCK plate
    expect(account.querySelector('.tf-mock-plate')).toBeNull();
    await click(find(account, 'button'));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]').textContent).toBe(en.signIn);
  });

  it('shows no address before the chain is known: it does not guess which wallet is the one', async () => {
    portStore.set(signedInPort(EMBEDDED));
    const host = await shell();
    await settle();
    const account = find(host, '[data-ui="account"]');
    expect(account.textContent).toBe(`${en.signOut}${en.signingOut}`);
  });

  it('says nothing about anyone before the wallet has loaded', async () => {
    portStore.set(fakePort({ status: 'loading' }));
    const host = await shell();
    expect(host.querySelector('[data-ui="account"]')).toBeNull();
    expect(host.querySelector('header a[href="/sign-in"]')).toBeNull();
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
      const account = find(host, '[data-ui="account"]');
      // no address: there is no chain, and no wallet to show for one
      expect(account.textContent).toBe(`${en.signOut}${en.signingOut}`);
      await click(find(account, 'button'));
      await settle();
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(find(host, 'header a[href="/sign-in"]').textContent).toBe(en.signIn);
    },
  );

  it('puts focus on "Sign in" after a sign-out, and tells a screen reader the person is out', async () => {
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await shell();
    await settle();
    const out = find(find(host, '[data-ui="account"]'), 'button');
    out.focus();
    await click(out);
    await settle();
    const link = find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]');
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
    await click(find(find(host, '[data-ui="account"]'), 'button'));
    await settle();
    expect(find(host, 'header [role="alert"]').textContent).toBe(en.signOutFailed);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe('');
    // still the way out, to try again
    expect(find(find(host, '[data-ui="account"]'), 'button').textContent).toContain(en.signOut);
  });

  it('says nothing and moves no focus when the page loads signed out', async () => {
    const host = await shell();
    await settle();
    expect(document.activeElement).toBe(document.body);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe('');
  });

  it('marks the throwaway wallet of development with the hatch and the word MOCK', async () => {
    portStore.set(signedInPort(PHANTOM, { test: true }, 'mock'));
    const host = await shell();
    await settle();
    const account = find(host, '[data-ui="account"]');
    expect(account.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
    expect(account.querySelectorAll('.tf-hatch')).toHaveLength(1);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });
});

describe('light, dark, or the system’s', () => {
  it('says which is chosen, and the server’s word is what is drawn first', async () => {
    for (const theme of ['auto', 'light', 'dark'] as const) {
      const host = await shell('en', theme);
      const group = find(host, '[data-ui="theme-switch"]');
      expect(group.getAttribute('role')).toBe('group');
      expect(group.getAttribute('aria-label')).toBe(en.appearance);
      expect(pressed(group)).toEqual([en.themes[theme]]);
      await unmountAll();
    }
  });

  it('changes the page at once and keeps the choice for the next one', async () => {
    const host = await shell();
    const group = find(host, '[data-ui="theme-switch"]');
    const choose = (label: string) =>
      click([...group.querySelectorAll('button')].find((b) => b.textContent === label) as Element);
    const root = document.documentElement;

    await choose(en.themes.dark);
    expect(root.className).toBe('fonts dark');
    expect(document.cookie).toContain('tf-theme=dark');
    expect(pressed(group)).toEqual([en.themes.dark]);

    await choose(en.themes.light);
    expect(root.className).toBe('fonts light');
    expect(document.cookie).toContain('tf-theme=light');

    // back to the system's: the choice is forgotten, and the stylesheet follows the system again
    await choose(en.themes.auto);
    expect(root.className).toBe('fonts tf-auto');
    expect(document.cookie).not.toContain('tf-theme');
    expect(pressed(group)).toEqual([en.themes.auto]);
  });
});

describe('English or Portuguese', () => {
  it('names each language in its own words, and says which is the page’s', async () => {
    const host = await shell('pt');
    const group = find(host, '[data-ui="language-switch"]');
    expect(group.getAttribute('aria-label')).toBe(dictionary('pt').shell.language);
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons.map((b) => [b.textContent, b.getAttribute('lang')])).toEqual([
      ['English', 'en'],
      ['Português', 'pt-BR'],
    ]);
    expect(pressed(group)).toEqual(['Português']);
  });

  it('stores the choice and asks the server for the page again, in that language', async () => {
    const host = await shell('en');
    const group = find(host, '[data-ui="language-switch"]');
    const [english, portuguese] = [...group.querySelectorAll('button')];
    // the language the page is already in asks for nothing
    await click(english as Element);
    expect(router.refresh).not.toHaveBeenCalled();
    await click(portuguese as Element);
    expect(document.cookie).toContain('tf-lang=pt');
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('says the whole shell in Portuguese when that is the language', async () => {
    const pt = dictionary('pt').shell;
    const host = await shell('pt');
    expect(find(host, 'a[href="#content"]').textContent).toBe(pt.skip);
    expect([...find(host, 'nav').querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      pt.goal,
      pt.portfolio,
      pt.analytics,
    ]);
    expect(find(host, 'header a[href="/sign-in"]').textContent).toBe(pt.signIn);
    expect(host.textContent).not.toMatch(/!/);
  });
});

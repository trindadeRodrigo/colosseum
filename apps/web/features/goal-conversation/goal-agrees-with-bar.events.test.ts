// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary, SIGNED_IN_COOKIE } from '../../i18n';
import { WAY_IN_MS } from '../account/AccountProvider';
import { inShellWithSignIn } from '../account/test/screen';
import { fakePort, json, PHANTOM, signedInPort } from '../wallet/test/fake-port';
import { location, router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { GoalHome } from './GoalHome';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// /goal says what the bar says (Thom, Oct 9: the bar's control read "Sign-in is slow" over a page
// that read "Sign in to explore a private strategy."). Both read the account's one answer to "who is
// here": while it is not known the page waits as the bar's control does, and once nobody is signed in
// the page's "Sign in" is the bar's.

const en = dictionary('en');
const copy = en.goal.explore;
const person = {
  userId: 'did:privy:test',
  wallets: PHANTOM,
  chain: 'solana',
  chainSource: 'wallet',
  chainOptions: [],
};
const hint = (on: boolean) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test sets the cookie the app reads
  document.cookie = on
    ? `${SIGNED_IN_COOKIE}=1; path=/`
    : `${SIGNED_IN_COOKIE}=; max-age=0; path=/`;
};
const page = () => mount(inShellWithSignIn('en', 'auto', createElement(GoalHome)));
const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const bar = (host: HTMLElement) => find(host, 'header [data-ui="account-control"]');
const conversation = (host: HTMLElement) => find(host, '[data-ui="goal-conversation"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const passkey = () =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.includes(en.signIn.passkey.continue),
  ) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  location.pathname = '/goal';
  router.push.mockClear();
  portStore.setApi(async (path) => (path === '/v1/me' ? json(person) : json({}, 404)));
  portStore.set(fakePort({ status: 'loading' }));
  hint(false);
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  document.documentElement.style.overflow = '';
});

describe('the goal page and the bar', () => {
  it('both wait while it is not known who is here: no "Sign in" on the page under a loading bar', async () => {
    // someone signed in here before, and the wallet has not said anything yet
    hint(true);
    const host = await page();
    await later(2 * WAY_IN_MS);
    expect(bar(host).getAttribute('data-state')).toBe('loading');
    const waiting = find(conversation(host), '[data-ui="goal-account-loading"]');
    expect(waiting.textContent).toBe(copy.loadingAccount);
    // the wait is announced once, by the bar's control: the page's line is no second live region
    expect(waiting.getAttribute('role')).toBeNull();
    expect(waiting.closest('[role="status"], [aria-live]')).toBeNull();
    const announced = [...host.querySelectorAll('[role="status"], [aria-live]')].filter((el) =>
      el.textContent?.includes(en.shell.accountLoading),
    );
    expect(announced).toEqual([find(bar(host), '[data-ui="account-said"]')]);
    expect(host.textContent).not.toContain(copy.signIn);
    expect(host.querySelector('a[href^="/sign-in"]')).toBeNull();
    expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(true);
  });

  it('both wait for a visitor’s first moments, then both offer the same "Sign in"', async () => {
    const host = await page();
    await later(WAY_IN_MS - 1);
    expect(bar(host).getAttribute('data-state')).toBe('loading');
    expect(host.textContent).not.toContain(copy.signIn);
    expect(host.querySelector('a[href^="/sign-in"]')).toBeNull();
    await later(1);
    expect(bar(host).getAttribute('data-state')).toBe('signed-out');
    expect(conversation(host).textContent).toContain(copy.signIn);
    const theirs = find<HTMLAnchorElement>(bar(host), 'a');
    const mine = find<HTMLAnchorElement>(host, '[data-ui="goal-sign-in"]');
    // one address, one label: the page's way in is the bar's
    expect(mine.getAttribute('href')).toBe(theirs.getAttribute('href'));
    expect(mine.textContent).toBe(theirs.textContent);
    expect(host.querySelector('[data-ui="goal-account-loading"]')).toBeNull();
  });

  it.each([
    ['the bar’s', (host: HTMLElement) => find<HTMLAnchorElement>(bar(host), 'a')],
    [
      'the page’s',
      (host: HTMLElement) => find<HTMLAnchorElement>(host, '[data-ui="goal-sign-in"]'),
    ],
  ])(
    'signs in from %s "Sign in" the same way: the dialog over the page, then both are the person’s',
    async (_, way) => {
      portStore.set(
        fakePort({
          signIn: vi.fn(async () => {
            portStore.set(signedInPort(PHANTOM));
          }),
        }),
      );
      const host = await page();
      await later(0);
      expect(bar(host).getAttribute('data-state')).toBe('signed-out');
      expect(conversation(host).textContent).toContain(copy.signIn);
      await click(way(host));
      expect(dialog()).not.toBeNull();
      await click(passkey());
      await later(0);
      // closed on the page the person was on, and nothing was loaded again
      expect(dialog()).toBeNull();
      expect(router.push).not.toHaveBeenCalled();
      expect(bar(host).getAttribute('data-state')).toBe('signed-in');
      expect(find(host, 'header [data-ui="account-menu-button"]').getAttribute('data-chain')).toBe(
        'solana',
      );
      expect(host.textContent).not.toContain(copy.signIn);
      expect(host.querySelector('a[href^="/sign-in"]')).toBeNull();
      expect(find<HTMLTextAreaElement>(host, 'textarea').disabled).toBe(false);
    },
  );

  it('both show nobody signed in after a sign-out, with no reload', async () => {
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(signedInPort(PHANTOM, { signOut }));
    const host = await page();
    await later(0);
    expect(host.textContent).not.toContain(copy.signIn);
    await click(find(host, 'header [data-ui="account-menu-button"]'));
    await click(find(host, 'header [data-ui="account-menu"] [data-ui="sign-out"]'));
    await later(0);
    expect(bar(host).getAttribute('data-state')).toBe('signed-out');
    expect(conversation(host).textContent).toContain(copy.signIn);
    expect(find(host, '[data-ui="goal-sign-in"]').getAttribute('href')).toBe(
      find(bar(host), 'a').getAttribute('href'),
    );
  });
});

// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary, SIGNED_IN_COOKIE } from '../../i18n';
import { keepOrder, recallOrder } from '../order/order-record';
import { ORDER_ID, recordOf, USER } from '../order/test/fixtures';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location, router } from '../wallet/test/mock-next';
import { left, portStore, restarts } from '../wallet/test/mock-provider';
import { SLOW_MS, WAY_IN_MS } from './AccountProvider';
import { inShellWithSignIn } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The bar is never left without a way in (Thom, Oct 7: in a browser where the sign-in service never
// loaded, the bar kept an empty box where "Sign in" belongs, for good). A visitor nobody knows to be
// signed in gets "Sign in" after a short wait whatever the service does; the screen it opens says the
// service has not answered and offers to try again; after a quarter of a minute the bar says sign-in
// is slow; and when the service loads late, everything is as if it had loaded at once.

/** The sign-in service has not loaded: the port is loading, and names nobody. */
const neverReady = () => fakePort({ status: 'loading' });
const shell = (lang: 'en' | 'pt') =>
  mount(inShellWithSignIn(lang, 'auto', createElement('p', null, 'page')));
const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const control = (host: HTMLElement) => find(host, '[data-ui="account-control"]');
const way = (host: HTMLElement) =>
  host.querySelector<HTMLAnchorElement>('[data-ui="account-control"] a[href="/sign-in"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const OTHERS_ORDER = '44444444-4444-4444-8444-444444444444';
/** The hint this app keeps while someone is signed in, as a reload finds it. */
const hint = (on: boolean) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the test sets the cookie the app reads
  document.cookie = on
    ? `${SIGNED_IN_COOKIE}=1; path=/`
    : `${SIGNED_IN_COOKIE}=; max-age=0; path=/`;
};
const hinted = () => document.cookie.includes(`${SIGNED_IN_COOKIE}=1`);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  location.pathname = '/goal';
  router.push.mockClear();
  restarts.count = 0;
  left.count = 0;
  restarts.refuse = false;
  portStore.setApi(async () => json({ error: 'not found' }, 404));
  portStore.set(neverReady());
  hint(false);
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  document.documentElement.style.overflow = '';
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
});

describe.each(['en', 'pt'] as const)('a sign-in service that never loads, in %s', (lang) => {
  const t = dictionary(lang);

  it('leaves the bar an empty box for a moment only: then "Sign in" and the chain switcher, for good', async () => {
    const host = await shell(lang);
    await later(WAY_IN_MS - 1);
    expect(way(host)).toBeNull();
    expect(control(host).querySelector('button')).toBeNull();
    await later(1);
    expect(way(host)?.textContent).toBe(t.shell.signIn);
    // the visitor's controls, not an account's: the chain they look at, and no account menu
    expect(control(host).querySelector('[data-ui="chain-switch"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
    // and it stays, however long the service takes
    await later(20 * SLOW_MS);
    expect(way(host)?.textContent).toBe(t.shell.signIn);
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
    // nothing was started again by itself
    expect(restarts.count).toBe(0);
  });

  it('opens a sign-in screen that says the service has not answered, with a working "Try again"', async () => {
    const host = await shell(lang);
    await later(WAY_IN_MS);
    await click(way(host) as HTMLElement);
    const box = dialog() as HTMLElement;
    expect(box).not.toBeNull();
    const said = find(box, '[data-ui="sign-in-silent"]');
    expect(said.textContent).toContain(t.signIn.silent.body);
    expect(find(said, '[data-ui="sign-in-silent-why"]').textContent).toBe(t.signIn.silent.blocked);
    // not the wait with no end, and no button that could do nothing
    expect(box.textContent).not.toContain(t.signIn.loading);
    expect(box.textContent).not.toContain(t.signIn.passkey.continue);
    const again = find(said, '[data-act="sign-in-again"]');
    expect(again.textContent).toBe(t.shell.slow.again);
    await click(again);
    // the wallet provider is started again, with no reload
    expect(restarts.count).toBe(1);
    expect(find(box, '[data-ui="sign-in-trying"]').textContent).toBe(t.shell.slow.trying);
    expect(box.querySelector('[data-act="sign-in-again"]')).toBeNull();
    // and offered again after its wait, twice the first: nothing is hammered
    await later(2 * SLOW_MS - 1);
    expect(box.querySelector('[data-act="sign-in-again"]')).toBeNull();
    await later(1);
    expect(box.querySelector('[data-act="sign-in-again"]')).not.toBeNull();
    expect(restarts.count).toBe(1);
  });

  it('says the device is offline when the browser says so', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    const host = await shell(lang);
    await later(WAY_IN_MS);
    await click(way(host) as HTMLElement);
    expect(find(dialog() as HTMLElement, '[data-ui="sign-in-silent-why"]').textContent).toBe(
      t.signIn.silent.offline,
    );
  });

  it('says sign-in is slow beside the way in after a quarter of a minute, and in the phone’s sheet with "Try again"', async () => {
    const host = await shell(lang);
    await later(SLOW_MS - 1);
    expect(host.querySelector('[data-ui="account-slow"]')).toBeNull();
    await later(1);
    const said = find(control(host), '[data-ui="account-slow"]');
    expect(said.textContent).toBe(t.shell.slow.title);
    expect(said.getAttribute('role')).toBe('status');
    expect(way(host)?.textContent).toBe(t.shell.signIn);
    // the phone's sheet says which side, with the way to try again and no "Sign out" for nobody
    const block = find(host, '[data-ui="sign-in-slow"]');
    expect(block.getAttribute('data-side')).toBe('service');
    expect(block.textContent).toContain(t.shell.slow.service);
    expect(block.querySelector('[data-act="sign-in-again"]')).not.toBeNull();
    expect(host.textContent).not.toContain(t.shell.signOut);
  });

  it('is as if it had loaded at once when it loads late: signed out, the two ways in', async () => {
    const host = await shell(lang);
    await later(WAY_IN_MS);
    await click(way(host) as HTMLElement);
    expect(dialog()?.querySelector('[data-ui="sign-in-silent"]')).not.toBeNull();
    await act(async () => portStore.set(fakePort()));
    const box = dialog() as HTMLElement;
    expect(box.querySelector('[data-ui="sign-in-silent"]')).toBeNull();
    expect(box.textContent).toContain(t.signIn.passkey.continue);
    expect(way(host)?.textContent).toBe(t.shell.signIn);
    await later(20 * SLOW_MS);
    expect(host.querySelector('[data-ui="account-slow"]')).toBeNull();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
  });

  it('never shows "Sign in" to someone the hint says was signed in: a neutral box, then that sign-in is slow, then their account', async () => {
    portStore.setApi(async (path) =>
      path === '/v1/me'
        ? json({
            userId: 'did:privy:test',
            wallets: EMBEDDED,
            chain: 'solana',
            chainSource: 'picked',
            chainOptions: ['solana', 'robinhood'],
          })
        : json({ error: 'not found' }, 404),
    );
    // a reload by someone signed in, on a slow connection
    hint(true);
    const host = await shell(lang);
    await later(WAY_IN_MS);
    expect(way(host)).toBeNull();
    await later(SLOW_MS - WAY_IN_MS - 1);
    // nothing yet: no way in that would flip to their account a moment later
    expect(way(host)).toBeNull();
    expect(control(host).querySelector('button')).toBeNull();
    await later(1);
    // then their account's control says sign-in is slow, with "Try again" and "Sign out" in it
    expect(way(host)).toBeNull();
    const button = find(host, '[data-ui="account-menu-button"]');
    expect(button.textContent).toBe(t.shell.slow.title);
    await click(button);
    const menu = find(host, '[data-ui="account-menu"]');
    expect(find(menu, '[data-ui="sign-in-slow"] [data-act="sign-in-again"]').textContent).toBe(
      t.shell.slow.again,
    );
    expect(find(menu, '[data-ui="sign-out"]').textContent).toBe(t.shell.signOut);
    // and when the service loads, it is their account
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await later(0);
    expect(way(host)).toBeNull();
    expect(find(host, '[data-ui="account-menu-button"]').getAttribute('data-chain')).toBe('solana');
  });

  it('lets that person out though the service cannot be reached: the hint goes, and the visitor’s way in is there at once', async () => {
    const signOut = vi.fn(() => new Promise<void>(() => {}));
    portStore.set({ ...neverReady(), signOut });
    // order records this browser kept: theirs, and one of somebody else who used this computer
    keepOrder(recordOf());
    keepOrder(recordOf('solana', { orderId: OTHERS_ORDER, userId: 'did:privy:other' }));
    // and a vault conversation of each
    const talk = (userId: string) =>
      `tf-vault-conversation:2:${encodeURIComponent(userId)}:solana:testnet:vault-1:sandbox`;
    window.localStorage.setItem(talk(USER), '{"revision":0,"transcript":[]}');
    window.localStorage.setItem(talk('did:privy:other'), '{"revision":0,"transcript":[]}');
    hint(true);
    const host = await shell(lang);
    await later(SLOW_MS);
    await click(find(host, '[data-ui="account-menu-button"]'));
    await click(find(host, '[data-ui="account-menu"] [data-ui="sign-out"]'));
    // nobody to sign out at a service that names nobody: it is not asked, and nothing hangs
    expect(signOut).not.toHaveBeenCalled();
    expect(hinted()).toBe(false);
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
    expect(way(host)?.textContent).toBe(t.shell.signIn);
    // nobody is known, so every order record in the browser went with the press, whoever's it was
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    expect(recallOrder(OTHERS_ORDER, 'did:privy:other')).toBeNull();
    expect(window.localStorage.getItem(talk(USER))).toBeNull();
    expect(window.localStorage.getItem(talk('did:privy:other'))).toBeNull();
    // and the wallet provider is told: from now on it hands out no port that names a person until
    // the service says they are out (features/wallet/left-here.events.test.ts)
    expect(left.count).toBe(1);
  });

  it('is the person’s account when it loads late for someone with no hint', async () => {
    portStore.setApi(async (path) =>
      path === '/v1/me'
        ? json({
            userId: 'did:privy:test',
            wallets: EMBEDDED,
            chain: 'solana',
            chainSource: 'picked',
            chainOptions: ['solana', 'robinhood'],
          })
        : json({ error: 'not found' }, 404),
    );
    const host = await shell(lang);
    await later(SLOW_MS);
    expect(way(host)).not.toBeNull();
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await later(0);
    expect(way(host)).toBeNull();
    expect(find(host, '[data-ui="account-menu-button"]').getAttribute('data-chain')).toBe('solana');
    expect(host.querySelector('[data-ui="account-slow"]')).toBeNull();
  });

  it('keeps the account control for someone signed in whose provider, started again, names nobody for a while', async () => {
    portStore.set(fakePort({ status: 'loading', userId: 'did:privy:test' }));
    const host = await shell(lang);
    await later(SLOW_MS);
    await click(find(host, '[data-ui="account-menu-button"]'));
    await click(find(host, '[data-ui="account-menu"] [data-act="sign-in-again"]'));
    expect(restarts.count).toBe(1);
    // the new provider knows nobody yet, for longer than a visitor waits for "Sign in"
    await act(async () => portStore.set(neverReady()));
    await later(WAY_IN_MS + 1);
    expect(way(host)).toBeNull();
    expect(find(host, '[data-ui="account-menu-button"]').textContent).toBe(t.shell.slow.title);
    await later(SLOW_MS);
    expect(way(host)).toBeNull();
    expect(host.querySelector('[data-ui="account-menu-button"]')).not.toBeNull();
  });
});

describe('a sign-in service that loads in time', () => {
  it('never shows the visitor’s controls to someone it then says is signed in', async () => {
    const host = await shell('en');
    await later(WAY_IN_MS - 1);
    await act(async () => portStore.set(fakePort({ status: 'loading', userId: 'did:privy:test' })));
    await later(SLOW_MS - 1);
    // known to be signed in: the account control, as before, and never "Sign in"
    expect(way(host)).toBeNull();
    expect(host.querySelector('[data-ui="account-menu-button"]')).not.toBeNull();
  });

  it('lets a visitor switch the chain they look at while the service is silent', async () => {
    const host = await shell('en');
    await later(WAY_IN_MS);
    const button = find(control(host), '[data-ui="chain-switch"] button');
    expect(button.textContent).toContain('Solana');
  });
});

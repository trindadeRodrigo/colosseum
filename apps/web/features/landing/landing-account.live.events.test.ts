// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage, inShell } from '../account/test/screen';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location, router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { LandingBar } from './LandingBar';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// One account control on every page with a bar (Thom, Oct 9): the landing's bar, with the wallet
// loaded, draws what the product's bar draws, state for state; and signing in on the landing makes
// the bar the person's with no reload, as signing out gives "Sign in" back.

const en = dictionary('en');
const person = {
  userId: 'did:privy:test',
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: ['solana', 'robinhood'],
};
const landing = async (hinted: boolean) => {
  location.pathname = '/';
  const host = await mount(
    inLanguage('en', createElement(LandingBar, { lang: 'en', signedIn: hinted })),
  );
  for (let i = 0; i < 3; i += 1) await settle(10);
  return host;
};
const app = async () => {
  location.pathname = '/goal';
  const host = await mount(inShell('en', 'auto', createElement('p', null, 'page')));
  await settle(10);
  return host;
};
const control = (host: HTMLElement) => find(host, '[data-ui="account-control"]');
/** A control as drawn, without what differs by design: ids, and the way in's weight and address. */
function drawn(host: HTMLElement): string {
  const copy = control(host).cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const name of ['id', 'aria-labelledby', 'aria-describedby', 'aria-controls'])
      if (el.hasAttribute(name)) el.setAttribute(name, '');
    if (el.getAttribute('data-ui') === 'sign-in-button') {
      el.removeAttribute('href');
      el.removeAttribute('class');
    }
  }
  return copy.outerHTML;
}

beforeEach(() => {
  router.push.mockClear();
  portStore.setApi(async (path) =>
    path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404),
  );
  portStore.set(fakePort());
  // biome-ignore lint/suspicious/noDocumentCookie: the test starts from no hint
  document.cookie = 'tf-in=; max-age=0; path=/';
});
afterEach(async () => {
  await unmountAll();
  document.documentElement.style.overflow = '';
});

describe('the landing’s account control, with the wallet loaded', () => {
  it.each([
    ['not known yet', () => fakePort({ status: 'loading', userId: 'did:privy:test' }), 'loading'],
    ['signed out', () => fakePort(), 'signed-out'],
    ['signed in', () => signedInPort(EMBEDDED), 'signed-in'],
  ] as const)('draws what the product’s bar draws, %s', async (_, port, state) => {
    portStore.set(port());
    const onLanding = await landing(true);
    expect(control(onLanding).getAttribute('data-state')).toBe(state);
    const there = drawn(onLanding);
    await unmountAll();
    portStore.set(port());
    const inApp = await app();
    expect(control(inApp).getAttribute('data-state')).toBe(state);
    expect(there).toBe(drawn(inApp));
  });

  it('differs signed out only in weight and in where it comes back to', async () => {
    const onLanding = await landing(true);
    const way = find<HTMLAnchorElement>(control(onLanding), 'a');
    // outlined beside the hero's filled action; the product's is the bar's one primary
    expect(way.className).not.toContain('bg-primary');
    expect(way.getAttribute('href')).toBe('/sign-in');
    await unmountAll();
    const inApp = await app();
    const theirs = find<HTMLAnchorElement>(control(inApp), 'a');
    expect(theirs.className).toContain('bg-primary');
    expect(theirs.getAttribute('href')).toBe('/sign-in?next=/goal');
    expect(theirs.textContent).toBe(way.textContent);
  });

  it('has no "Open the app" in the bar, in any state', async () => {
    for (const port of [fakePort(), signedInPort(EMBEDDED)]) {
      portStore.set(port);
      const host = await landing(true);
      expect(host.textContent).not.toMatch(/Open the app|Go to app/);
      await unmountAll();
    }
  });

  it('signs in from the landing and stays there: the chip with no reload, then "Sign in" again after a sign-out', async () => {
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set(
      fakePort({
        signIn: vi.fn(async () => {
          portStore.set(signedInPort(EMBEDDED, { signOut }));
        }),
      }),
    );
    const host = await landing(false);
    const way = find<HTMLAnchorElement>(control(host), 'a');
    expect(way.textContent).toBe(en.shell.signIn);
    await click(way);
    for (let i = 0; i < 3; i += 1) await settle(10);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const passkey = [...dialog.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(en.signIn.passkey.continue),
    ) as HTMLElement;
    await click(passkey);
    await settle(10);
    // the dialog closes on the landing, which is not left
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    const chip = find(host, '[data-ui="account-menu-button"]');
    expect(chip.getAttribute('data-chain')).toBe('solana');
    expect(chip.textContent).toContain('So11…1112');
    expect(host.querySelector('a[href^="/sign-in"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
    // and out again, from the chip's menu
    await click(chip);
    const out = find(host, '[data-ui="account-menu"] [data-ui="sign-out"]');
    out.focus();
    await click(out);
    await act(async () => {});
    await settle(10);
    expect(signOut).toHaveBeenCalledTimes(1);
    const again = find<HTMLAnchorElement>(control(host), 'a');
    expect(again.textContent).toBe(en.shell.signIn);
    expect(document.activeElement).toBe(again);
    expect(find(host, '[data-ui="account-said"]').textContent).toBe(en.shell.signedOut);
  });
});

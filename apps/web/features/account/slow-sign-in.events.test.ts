// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNav } from '../../components/shell/AppNav';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang, SIGNED_IN_COOKIE } from '../../i18n';
import { keepOrder, recallOrder } from '../order/order-record';
import { recallPlan, rememberPlan } from '../order/plan-store';
import { ORDER_ID, PLAN_ID, planOn, recordOf, USER } from '../order/test/fixtures';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore, restarts } from '../wallet/test/mock-provider';
import { SLOW_MS } from './AccountProvider';
import type { Person } from './person';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Someone signed in is never left waiting with no word, and slowness is never the control's label
// (Thom, Oct 9: the bar's account control read "Sign-in is slow"). The control keeps its loading
// look; after half a minute the help is under it: which side is slow, "Try again" and "Sign out".
// Nothing is asked again by itself, and each "Try again" waits twice as long as the one before.

const person: Person = {
  userId: 'did:privy:test',
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: ['solana', 'robinhood'],
};
/** Signed in, as the sign-in service knows, with the wallets not handed over. */
const walletsLoading = () => fakePort({ status: 'loading', userId: 'did:privy:test' });

/** GET /v1/me, answered when the test says: until then our server is silent. */
function server() {
  const asked: ((res: Response) => void)[] = [];
  portStore.setApi((path) =>
    path === '/v1/me'
      ? new Promise<Response>((resolve) => asked.push(resolve))
      : Promise.resolve(json({ error: 'no' }, 404)),
  );
  return {
    asked,
    answer: () =>
      act(async () => {
        for (const resolve of asked) resolve(json(person));
      }),
  };
}

const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** The bar: its account control keeps its loading look, and the help under it says which side. */
const page = (lang: Lang) => mount(withAccount(lang, createElement(AppNav)));
const frame = (host: HTMLElement) => find(host, '[data-ui="account-control"]');
const control = (host: HTMLElement) => find(host, '[data-ui="account-menu-button"]');
const said = (host: HTMLElement) => find(host, '[data-ui="account-said"]').textContent;
/** The help under the bar's control. */
const SAID = '[data-ui="account-control"] [data-ui="sign-in-slow"]';
const AGAIN = `${SAID} [data-act="sign-in-again"]`;
const trying = (host: HTMLElement) => find(host, AGAIN).getAttribute('aria-busy') === 'true';
/** What the control can be pressed by, or read as: never the slowness. */
const labels = (host: HTMLElement) =>
  [
    ...frame(host).querySelectorAll(
      ':scope > div > a, :scope > div > button, [data-ui="account"] > button',
    ),
  ].map((el) => el.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  // no hint of an earlier sign-in from the test before
  // biome-ignore lint/suspicious/noDocumentCookie: the test starts from no hint
  document.cookie = `${SIGNED_IN_COOKIE}=; max-age=0; path=/`;
  window.localStorage.clear();
  restarts.count = 0;
  restarts.refuse = false;
  portStore.set(fakePort());
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe.each(['en', 'pt'] as const)('a sign-in that is slow, in %s', (lang) => {
  const t = dictionary(lang);

  it('keeps the loading look, and offers help under it after half a minute, not before', async () => {
    server();
    portStore.set(walletsLoading());
    const host = await page(lang);
    // the chip's still boxes, in a button that says nothing of slowness: it opens the way out
    expect(frame(host).getAttribute('data-state')).toBe('loading');
    expect(control(host).getAttribute('aria-busy')).toBe('true');
    expect(control(host).textContent).toBe(t.shell.account);
    expect(find(host, '[data-ui="account-placeholder"]').getAttribute('data-shape')).toBe(
      'account',
    );
    expect(said(host)).toBe('');
    await later(400);
    // said once, politely, and it stays the same words for the whole wait
    expect(said(host)).toBe(t.shell.accountLoading);
    expect(find(host, '[data-ui="account-said"]').getAttribute('role')).toBe('status');
    await later(SLOW_MS - 401);
    expect(said(host)).toBe(t.shell.accountLoading);
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    // "Sign out" is there from the start, in the button's menu, with nothing else
    await click(control(host));
    expect(find(host, '[data-ui="account-menu"]').textContent).toBe(t.shell.signOut);
    await click(control(host));

    await later(1);
    // the box is still the box; the help says which side, with "Try again" and "Sign out"
    expect(frame(host).getAttribute('data-state')).toBe('loading');
    expect(host.querySelector('[data-ui="account-placeholder"]')).not.toBeNull();
    const help = find(host, SAID);
    expect(help.getAttribute('data-side')).toBe('wallets');
    expect(help.textContent).toContain(t.shell.slow.wallets);
    expect(find(help, '[data-act="sign-in-again"]').textContent).toContain(t.shell.slow.again);
    expect(find(help, '[data-act="sign-out"]').textContent).toContain(t.shell.signOut);
    expect(said(host)).toBe(t.shell.slow.title);
    // slowness is no control's label, and the old words are nowhere
    expect(labels(host)).toEqual([t.shell.account]);
    expect(host.textContent).not.toMatch(/Sign-in is slow|O login está lento/);
    // nothing was asked again by itself
    expect(restarts.count).toBe(0);
  });

  it('reads the wallets again on "Try again", waits twice as long before offering it again, and recovers', async () => {
    const api = server();
    portStore.set(walletsLoading());
    const host = await page(lang);
    await later(SLOW_MS);
    const again = find(host, AGAIN);
    again.focus();
    await click(again);
    // the wallet provider starts again: no reload, and our server is not asked before there is a wallet
    expect(restarts.count).toBe(1);
    expect(api.asked).toHaveLength(0);
    // as it starts, it knows nobody yet: the help stays, and the control keeps its loading look
    await act(async () => portStore.set(fakePort({ status: 'loading' })));
    expect(host.querySelector('[data-ui="account-placeholder"]')).not.toBeNull();
    // the button keeps its place and its focus while it tries, with its label changed
    expect(find(host, AGAIN)).toBe(again);
    expect(trying(host)).toBe(true);
    expect(again.textContent).toContain(t.shell.slow.trying);
    expect(document.activeElement).toBe(again);
    // a press while it tries does nothing
    await click(again);
    expect(restarts.count).toBe(1);
    // a sign-in service that asked for fewer requests is left alone: twice the wait, not the same
    await later(SLOW_MS);
    expect(trying(host)).toBe(true);
    expect(restarts.count).toBe(1);
    await later(SLOW_MS);
    expect(trying(host)).toBe(false);

    // the wallets come, and our server answers: the chain and the address, and no help
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await api.answer();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(frame(host).getAttribute('data-state')).toBe('signed-in');
    expect(control(host).getAttribute('data-chain')).toBe('solana');
    expect(control(host).textContent).toContain('So11…1112');
    // focus was in the help, which is gone: it is on the control that took its place
    expect(document.activeElement).toBe(control(host));
    expect(said(host)).toBe('');
  });

  it('does not start the wallets again while a step of an order is being signed, and says what to do', async () => {
    server();
    portStore.set(walletsLoading());
    const host = await page(lang);
    await later(SLOW_MS);
    restarts.refuse = true;
    await click(find(host, AGAIN));
    expect(restarts.count).toBe(0);
    expect(find(host, `${SAID} [data-ui="sign-in-held"]`).textContent).toBe(t.shell.slow.held);
    expect(find(host, `${SAID} [data-ui="sign-in-held"]`).getAttribute('role')).toBe('alert');
    // the button is still there, with no longer wait counted for a press that did nothing
    expect(trying(host)).toBe(false);
    restarts.refuse = false;
    await click(find(host, AGAIN));
    expect(restarts.count).toBe(1);
    expect(host.querySelector('[data-ui="sign-in-held"]')).toBeNull();
    expect(trying(host)).toBe(true);
  });

  it('says our server is the slow side when the wallets are there, asks it again, and recovers', async () => {
    const api = server();
    portStore.set(signedInPort(EMBEDDED));
    const host = await page(lang);
    await later(SLOW_MS);
    expect(api.asked).toHaveLength(1);
    const help = find(host, SAID);
    expect(help.getAttribute('data-side')).toBe('server');
    expect(help.textContent).toContain(t.shell.slow.server);
    // the first press asks our server alone
    await click(find(host, AGAIN));
    expect(api.asked).toHaveLength(2);
    expect(restarts.count).toBe(0);
    expect(trying(host)).toBe(true);
    // the second, after its longer wait, starts the wallet provider again too: the token comes from it
    await later(2 * SLOW_MS);
    await click(find(host, AGAIN));
    expect(restarts.count).toBe(1);
    // and our server is not asked with the old provider's tokens: only once the new one is ready
    expect(api.asked).toHaveLength(2);
    expect(trying(host)).toBe(true);
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    expect(api.asked).toHaveLength(3);

    await api.answer();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(control(host).getAttribute('data-chain')).toBe('solana');
  });

  it('signs out from the help: "Sign in" takes its place, with focus, and a screen reader is told', async () => {
    server();
    const signOut = vi.fn(async () => {
      portStore.set(fakePort());
    });
    portStore.set({ ...walletsLoading(), signOut });
    const host = await page(lang);
    await later(SLOW_MS);
    const out = find(host, `${SAID} [data-act="sign-out"]`);
    out.focus();
    await click(out);
    await later(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(frame(host).getAttribute('data-state')).toBe('signed-out');
    const link = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    expect(link.textContent).toBe(t.shell.signIn);
    expect(document.activeElement).toBe(link);
    expect(said(host)).toBe(t.shell.signedOut);
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
  });

  it('says so in the help when signing out did not work, and keeps the help', async () => {
    server();
    const signOut = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    portStore.set({ ...walletsLoading(), signOut });
    const host = await page(lang);
    await later(SLOW_MS);
    await click(find(host, `${SAID} [data-act="sign-out"]`));
    await later(0);
    expect(find(host, `${SAID} [role="alert"]`).textContent).toBe(t.shell.signOutFailed);
    expect(frame(host).getAttribute('data-state')).toBe('loading');
  });
});

describe('a sign-in that is slow', () => {
  it.each([
    ['nobody: the person signed out meanwhile', () => fakePort()],
    ['another person', () => signedInPort(EMBEDDED, { userId: 'did:privy:other' })],
  ])(
    'forgets the plans and the order records when the wallets come back with %s',
    async (_, port) => {
      server();
      // a plan and an order's record this browser kept for the person
      rememberPlan(planOn());
      keepOrder(recordOf());
      portStore.set(walletsLoading());
      const host = await page('en');
      await later(SLOW_MS);
      await click(find(host, AGAIN));
      // kept while nobody is known to have left: the provider loads again and names nobody
      await act(async () => portStore.set(fakePort({ status: 'loading' })));
      expect(recallOrder(ORDER_ID, USER)?.orderId).toBe(ORDER_ID);
      expect(recallPlan(PLAN_ID, USER)).not.toBeNull();
      await act(async () => portStore.set(port()));
      await later(0);
      // the plans and the order records kept for the person who was here are forgotten
      expect(recallOrder(ORDER_ID, USER)).toBeNull();
      expect(recallPlan(PLAN_ID, USER)).toBeNull();
    },
  );

  it('gives someone not known to be signed in the visitor’s way in, never the account control (bar-never-empty.events.test.ts)', async () => {
    server();
    portStore.set(fakePort({ status: 'loading' }));
    const host = await page('en');
    await later(10 * SLOW_MS);
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
    expect(host.querySelector('header a[href^="/sign-in"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
  });

  it('is not said to someone who was ready in time', async () => {
    const api = server();
    portStore.set(signedInPort(EMBEDDED));
    const host = await page('en');
    await later(SLOW_MS - 1);
    await api.answer();
    await later(10 * SLOW_MS);
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(control(host).getAttribute('data-chain')).toBe('solana');
  });
});

// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNav } from '../../components/shell/AppNav';
import { click, find, mount, press, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import { GOAL_DRAFT } from '../goal/draft';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { InvestScreen } from '../invest/InvestScreen';
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

// Someone signed in is never left waiting with no word (Thom's preview, Oct 6: the bar said only "Your
// wallet" and the goal's sheet stayed on "Reading where your plan lives…"). After a quarter of a
// minute the bar and the Invest screen say sign-in is slow and which side, with "Try again" and "Sign out".
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
      : Promise.resolve(path === '/goals' ? json(READ_IN_DOLLARS) : json({ error: 'no' }, 404)),
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
/** The bar and the Invest screen, with a goal said: the screen says how the sign-in stands. */
async function page(lang: Lang) {
  const host = await mount(
    withAccount(lang, [
      createElement(AppNav, { key: 'bar' }),
      createElement(InvestScreen, { key: 'goal' }),
    ]),
  );
  const box = find<HTMLTextAreaElement>(host, 'textarea');
  await type(box, 'Grow forty thousand for an apartment by June 2028');
  await press(box, 'Enter');
  await later(0);
  return host;
}
const control = (host: HTMLElement) => find(host, '[data-ui="account-menu-button"]');
/** Where the Invest screen says how the sign-in stands, while it is not ready; empty once it is. */
const facts = (host: HTMLElement) =>
  host.querySelector('[data-ui="invest-account"]') ?? document.createElement('span');
/** The notice on the sheet, and its two ways on. */
const SAID = '[data-ui="invest-account"] [data-ui="sign-in-slow"]';
const AGAIN = `${SAID} [data-act="sign-in-again"]`;
const TRYING = `${SAID} [data-ui="sign-in-trying"]`;

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
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

  it('says so after a quarter of a minute when the wallets have not come, and not before', async () => {
    server();
    portStore.set(walletsLoading());
    const host = await page(lang);
    await later(SLOW_MS - 1);
    expect(control(host).textContent).toBe(t.shell.account);
    expect(facts(host).textContent).toContain(t.chain.reading);
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();

    await later(1);
    // the bar says it, to a screen reader too, and the sheet says which side with the two ways on
    expect(control(host).textContent).toBe(t.shell.slow.title);
    expect(find(host, '[data-ui="chain-said"]').textContent).toBe(t.shell.slow.title);
    expect(facts(host).textContent).not.toContain(t.chain.reading);
    const said = find(host, SAID);
    expect(said.getAttribute('data-side')).toBe('wallets');
    expect(said.textContent).toContain(t.shell.slow.wallets);
    expect(find(said, '[data-act="sign-in-again"]').textContent).toBe(t.shell.slow.again);
    expect(find(said, '[data-act="sign-in-leave"]').textContent).toBe(t.shell.signOut);
    // the bar's menu says the same, above its own "Sign out"
    await click(control(host));
    const menu = find(host, '[data-ui="account-menu"]');
    expect(find(menu, '[data-ui="sign-in-slow"]').textContent).toContain(t.shell.slow.wallets);
    expect(find(menu, '[data-ui="sign-out"]').textContent).toBe(t.shell.signOut);
    // nothing was asked again by itself
    expect(restarts.count).toBe(0);
  });

  it('reads the wallets again on "Try again", waits twice as long before offering it again, and recovers', async () => {
    const api = server();
    portStore.set(walletsLoading());
    const host = await page(lang);
    await later(SLOW_MS);
    await click(find(host, AGAIN));
    // the wallet provider starts again: no reload, and our server is not asked before there is a wallet
    expect(restarts.count).toBe(1);
    expect(api.asked).toHaveLength(0);
    // as it starts, it knows nobody yet: the person is still told, and the bar keeps its control
    await act(async () => portStore.set(fakePort({ status: 'loading' })));
    expect(control(host).textContent).toBe(t.shell.slow.title);
    expect(find(host, TRYING).textContent).toBe(t.shell.slow.trying);
    expect(host.querySelector(AGAIN)).toBeNull();
    // and what they typed is still theirs, on the page and in the tab
    expect(find(host, '[data-ui="invest-turns"] [data-who="person"]').textContent).toContain(
      'forty thousand',
    );
    expect(window.sessionStorage.getItem(GOAL_DRAFT)).toContain('forty thousand');
    // a sign-in service that asked for fewer requests is left alone: twice the wait, not the same
    await later(SLOW_MS);
    expect(host.querySelector(AGAIN)).toBeNull();
    expect(restarts.count).toBe(1);
    await later(SLOW_MS);
    expect(host.querySelector(AGAIN)).not.toBeNull();

    // the wallets come, and our server answers: the chain and the address, and no notice
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await api.answer();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(control(host).getAttribute('data-chain')).toBe('solana');
    expect(control(host).textContent).toContain('So11…1112');
    expect(facts(host).textContent).not.toContain(t.chain.reading);
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
    expect(host.querySelector(TRYING)).toBeNull();
    restarts.refuse = false;
    await click(find(host, AGAIN));
    expect(restarts.count).toBe(1);
    expect(host.querySelector('[data-ui="sign-in-held"]')).toBeNull();
    expect(find(host, TRYING).textContent).toBe(t.shell.slow.trying);
  });

  it('says our server is the slow side when the wallets are there, asks it again, and recovers', async () => {
    const api = server();
    portStore.set(signedInPort(EMBEDDED));
    const host = await page(lang);
    await later(SLOW_MS);
    expect(api.asked).toHaveLength(1);
    const said = find(host, SAID);
    expect(said.getAttribute('data-side')).toBe('server');
    expect(said.textContent).toContain(t.shell.slow.server);
    // the first press asks our server alone
    await click(find(host, AGAIN));
    expect(api.asked).toHaveLength(2);
    expect(restarts.count).toBe(0);
    expect(find(host, TRYING).textContent).toBe(t.shell.slow.trying);
    // the second, after its longer wait, starts the wallet provider again too: the token comes from it
    await later(2 * SLOW_MS);
    await click(find(host, AGAIN));
    expect(restarts.count).toBe(1);
    // and our server is not asked with the old provider's tokens: only once the new one is ready
    expect(api.asked).toHaveLength(2);
    expect(find(host, TRYING).textContent).toBe(t.shell.slow.trying);
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    expect(api.asked).toHaveLength(3);

    await api.answer();
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(control(host).getAttribute('data-chain')).toBe('solana');
  });
});

describe('a sign-in that is slow', () => {
  it('lets the person out from the sheet', async () => {
    server();
    const signOut = vi.fn(() => Promise.resolve());
    portStore.set({ ...walletsLoading(), signOut });
    const host = await page('en');
    await later(SLOW_MS);
    await click(find(host, `${SAID} [data-act="sign-in-leave"]`));
    expect(signOut).toHaveBeenCalledTimes(1);
    await act(async () => portStore.set(fakePort()));
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
  });

  it.each([
    ['nobody: the person signed out meanwhile', () => fakePort()],
    ['another person', () => signedInPort(EMBEDDED, { userId: 'did:privy:other' })],
  ])(
    'forgets the goal on the page and its draft when the wallets come back with %s',
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
      const typed = () =>
        host.querySelector('[data-ui="invest-turns"] [data-who="person"]')?.textContent ?? '';
      expect(typed()).toContain('forty thousand');
      expect(recallOrder(ORDER_ID, USER)?.orderId).toBe(ORDER_ID);
      expect(recallPlan(PLAN_ID, USER)).not.toBeNull();
      await act(async () => portStore.set(port()));
      await later(0);
      expect(typed()).toBe('');
      expect(host.querySelector('[data-ui="pane-facts"]')).toBeNull();
      expect(window.sessionStorage.getItem(GOAL_DRAFT) ?? '').not.toContain('forty thousand');
      // and so are the plans and the order records kept for the person who was here
      expect(recallOrder(ORDER_ID, USER)).toBeNull();
      expect(recallPlan(PLAN_ID, USER)).toBeNull();
    },
  );

  it('is not said to someone who is not known to be signed in, however long the wallet loads', async () => {
    server();
    portStore.set(fakePort({ status: 'loading' }));
    const host = await page('en');
    await later(10 * SLOW_MS);
    expect(host.querySelector('[data-ui="sign-in-slow"]')).toBeNull();
    expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
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

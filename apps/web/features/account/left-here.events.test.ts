// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNav } from '../../components/shell/AppNav';
import { find, mount, unmountAll } from '../../components/ui/test/dom';
import { dictionary, SIGNED_IN_COOKIE } from '../../i18n';
import { OrderScreen } from '../order/OrderScreen';
import { keepOrder, recallOrder } from '../order/order-record';
import { ORDER_ID, orderOn, recordOf, USER } from '../order/test/fixtures';
import { VAULT, vaultOf } from '../shared/test/fixtures';
import { VaultScreen } from '../shared/VaultScreen';
import { WithdrawScreen } from '../shared/WithdrawScreen';
import type { WebWalletPort } from '../wallet/port';
import { useSigningPort } from '../wallet/signing';
import { EMBEDDED, fakePort, signedInPort } from '../wallet/test/fake-port';
import {
  SIGN_OUT_RETRY_MS,
  SIGN_OUT_WAIT_MS,
  useLeaveHere,
  useWalletPort,
  WalletProvider,
} from '../wallet/WalletProvider';
import { WAY_IN_MS } from './AccountProvider';
import { withAccount } from './test/screen';

// "Sign out" pressed while the sign-in service could not be reached leaves a mark (`tf-left`). From
// then until the service itself says nobody is signed in, the real wallet provider hands no consumer
// a port that names a person, signs, or carries their tokens: a shared computer, walked away from,
// whose service then loads with the session still there. Here the provider is the real one, the
// bridge under it reports what a test says, and the screens that gate on the port alone are mounted
// in that window: the order, the withdrawal, and a vault's page.

const bridge = vi.hoisted(() => ({ onPort: null as null | ((port: unknown) => void) }));
vi.mock('next/dynamic', () => ({
  default: () => (props: { onPort: (port: unknown) => void }) => {
    bridge.onPort = props.onPort;
    return null;
  },
}));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

type Asked = { path: string; authorization: string | null };
const asked: Asked[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Our server, as the real `useApiFetch` reaches it: what was asked, and with whose tokens. */
function server() {
  asked.length = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    asked.push({ path: url.pathname, authorization: headers.get('authorization') });
    if (url.pathname === '/v1/me')
      return json({
        userId: USER,
        wallets: EMBEDDED,
        chain: 'solana',
        chainSource: 'picked',
        chainOptions: ['solana', 'robinhood'],
      });
    if (url.pathname === `/v1/orders/${ORDER_ID}`) return json(orderOn());
    if (url.pathname === `/v1/vaults/solana/${VAULT}`)
      return json({
        chain: 'solana',
        name: 'Solana',
        mode: 'live',
        provenance: 'sandbox',
        vault: {
          ...vaultOf({ cash: { asset: 'solana:usdc', raw: '5', multiplier: '1', display: '5' } }),
          provenance: 'sandbox',
        },
        prices: [],
        disclaimer: 'd',
      });
    return json({ error: 'not found' }, 404);
  });
}

/** The service's own port for the person whose session is still there. */
const theirs = (signOut: () => Promise<void>) =>
  signedInPort(EMBEDDED, {
    userId: USER,
    signOut,
    authHeaders: async () => ({ authorization: 'Bearer the-person', 'privy-id-token': 'theirs' }),
  });

const seen: {
  screen?: ReturnType<typeof useWalletPort>;
  whole?: WebWalletPort;
  leave?: () => void;
} = {};
const Probe = () => {
  seen.screen = useWalletPort();
  seen.whole = useSigningPort();
  seen.leave = useLeaveHere();
  return null;
};
const page = (children: ReactNode[]) =>
  mount(
    createElement(
      WalletProvider,
      null,
      createElement(Probe, { key: 'probe' }),
      withAccount('en', children),
    ),
  );
const screens = () => [
  createElement(OrderScreen, { key: 'order', id: ORDER_ID }),
  createElement(WithdrawScreen, { key: 'withdraw', chain: 'solana', address: VAULT }),
  createElement(VaultScreen, { key: 'vault', chain: 'solana', address: VAULT }),
];
const later = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const report = (port: WebWalletPort) => act(async () => bridge.onPort?.(port));
const marked = () => window.localStorage.getItem('tf-left') === '1';
const withTokens = () => asked.filter((a) => a.authorization !== null);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
  server();
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('signed out here while the sign-in service could not be reached', () => {
  it('hands no screen and no signer the person the service then names: nothing of theirs is drawn, asked for or signed', async () => {
    // the mark from the press, found by the page as it opens; a record another tab kept meanwhile
    window.localStorage.setItem('tf-left', '1');
    keepOrder(recordOf());
    const signOut = vi.fn(() => new Promise<void>(() => {}));
    const host = await page(screens());
    await later(0);
    // the service loads at last, with the session still there
    await report(theirs(signOut));
    await later(5_000);

    // it is asked to sign them out, once
    expect(signOut).toHaveBeenCalledTimes(1);
    // every consumer sees the wallet still loading, and nobody
    expect(seen.screen?.status).toBe('loading');
    expect(seen.screen?.userId).toBeNull();
    expect(seen.screen?.accounts).toEqual([]);
    expect(seen.whole?.status).toBe('loading');
    expect(seen.whole?.userId).toBeNull();
    // the signer signs nothing, and carries no token
    await expect(seen.whole?.sign('solana', [])).rejects.toThrow(/still loading/);
    await expect(seen.whole?.send('solana', {} as never)).rejects.toThrow(/still loading/);
    await expect(seen.whole?.signMessage('solana', 'x')).rejects.toThrow(/still loading/);
    expect(await seen.whole?.authHeaders()).toEqual({});
    // no request went out with their tokens, and none for their order or for who they are
    expect(withTokens()).toEqual([]);
    expect(asked.map((a) => a.path)).not.toContain(`/v1/orders/${ORDER_ID}`);
    expect(asked.map((a) => a.path)).not.toContain('/v1/me');
    // no order drawn, no button that signs or withdraws
    expect(host.querySelector('[data-ui="order-screen"]')).toBeNull();
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    // a vault's page is public, and is drawn; the owner's links are not
    expect(host.querySelector('[data-ui="vault-screen"]')).not.toBeNull();
    expect(host.querySelector('[data-ui="vault-withdraw"]')).toBeNull();
    expect(host.querySelector('a[href*="/add"]')).toBeNull();
    expect(host.textContent).not.toContain('So11…1112');
    expect(marked()).toBe(true);
  });

  it('is the same from the press itself, with no reload between', async () => {
    const signOut = vi.fn(() => new Promise<void>(() => {}));
    await page([]);
    await later(0);
    await act(async () => seen.leave?.());
    expect(marked()).toBe(true);
    await report(theirs(signOut));
    await later(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(seen.screen?.userId).toBeNull();
    expect(seen.whole?.status).toBe('loading');
  });

  it('tries the sign-out again after a refusal, each wait twice the one before, and never in between', async () => {
    window.localStorage.setItem('tf-left', '1');
    const signOut = vi.fn(async () => {
      throw new Error('the sign-in service did not answer');
    });
    await page([]);
    await later(0);
    await report(theirs(signOut));
    await later(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    await later(SIGN_OUT_RETRY_MS - 1);
    expect(signOut).toHaveBeenCalledTimes(1);
    await later(1);
    expect(signOut).toHaveBeenCalledTimes(2);
    // the service reporting again does not bring the next try forward
    await report(theirs(signOut));
    await later(2 * SIGN_OUT_RETRY_MS - 1);
    expect(signOut).toHaveBeenCalledTimes(2);
    await later(1);
    expect(signOut).toHaveBeenCalledTimes(3);
    // and through all of it nobody is handed out
    expect(seen.screen?.userId).toBeNull();
    expect(withTokens()).toEqual([]);
    expect(marked()).toBe(true);
  });

  it('lets go of the mark when the service says nobody is signed in, and a sign-in after that is as any other', async () => {
    window.localStorage.setItem('tf-left', '1');
    keepOrder(recordOf());
    const signOut = vi.fn(async () => {});
    const host = await page(screens());
    await later(0);
    await report(theirs(signOut));
    await later(0);
    expect(seen.screen?.userId).toBeNull();
    // the service: they are out
    await report(fakePort());
    await later(0);
    expect(marked()).toBe(false);
    expect(seen.screen?.status).toBe('signed-out');
    // and what this browser kept under their id since the press (another tab of theirs) is gone:
    // the id is known now, from the service
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    // they sign in again and make the order's record anew: their port, their order, their tokens
    keepOrder(recordOf());
    await report(theirs(signOut));
    await later(0);
    await later(0);
    expect(seen.screen?.userId).toBe(USER);
    expect(seen.whole?.userId).toBe(USER);
    expect(find(host, '[data-ui="order-screen"]')).not.toBeNull();
    expect(asked).toContainEqual({
      path: `/v1/orders/${ORDER_ID}`,
      authorization: 'Bearer the-person',
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing back when there is no mark, or from a port that names nobody', async () => {
    const signOut = vi.fn(async () => {});
    await page([]);
    await later(0);
    await report(theirs(signOut));
    await later(0);
    expect(seen.screen?.userId).toBe(USER);
    expect(signOut).not.toHaveBeenCalled();
    await unmountAll();
    window.localStorage.setItem('tf-left', '1');
    await page([]);
    await later(0);
    const loading = fakePort({ status: 'loading' });
    await report(loading);
    expect(seen.whole).toBe(loading);
    expect(marked()).toBe(true);
  });

  it('leaves another person’s records alone when the service says the one it named is out', async () => {
    window.localStorage.setItem('tf-left', '1');
    const OTHERS = '44444444-4444-4444-8444-444444444444';
    keepOrder(recordOf('solana', { orderId: OTHERS, userId: 'did:privy:other' }));
    keepOrder(recordOf());
    await page([]);
    await later(0);
    await report(theirs(vi.fn(async () => {})));
    await report(fakePort());
    await later(0);
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    expect(recallOrder(OTHERS, 'did:privy:other')).not.toBeNull();
  });

  it('is learnt at once by a tab left open on the person’s account, when another tab makes the press', async () => {
    const signOut = vi.fn(() => new Promise<void>(() => {}));
    keepOrder(recordOf());
    const host = await page(screens());
    await later(0);
    await report(theirs(signOut));
    await later(0);
    await later(0);
    // this tab is theirs, and open on their order
    expect(seen.screen?.userId).toBe(USER);
    expect(host.querySelector('[data-ui="order-screen"]')).not.toBeNull();
    // the press, in another tab of this browser
    await act(async () => {
      window.localStorage.setItem('tf-left', '1');
      window.dispatchEvent(new StorageEvent('storage', { key: 'tf-left', newValue: '1' }));
    });
    await later(0);
    expect(seen.screen?.userId).toBeNull();
    expect(seen.whole?.status).toBe('loading');
    await expect(seen.whole?.sign('solana', [])).rejects.toThrow(/still loading/);
    expect(host.querySelector('[data-ui="order-screen"]')).toBeNull();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('is not let go of because another tab let go: this tab keeps the person back, and keeps trying, until its own service says they are out', async () => {
    let refuse = true;
    const signOut = vi.fn(async () => {
      if (refuse) throw new Error('the sign-in service did not answer');
    });
    await page([]);
    await later(0);
    await report(theirs(signOut));
    await act(async () => {
      window.localStorage.setItem('tf-left', '1');
      window.dispatchEvent(new StorageEvent('storage', { key: 'tf-left', newValue: '1' }));
    });
    await later(0);
    expect(seen.screen?.userId).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(1);
    // the other tab's service says they are out, and that tab clears the mark
    await act(async () => {
      window.localStorage.removeItem('tf-left');
      window.dispatchEvent(new StorageEvent('storage', { key: 'tf-left', newValue: null }));
    });
    await later(0);
    // this tab's service still names them: nothing is handed out, and its own sign-out is tried again
    expect(seen.screen?.userId).toBeNull();
    expect(seen.whole?.status).toBe('loading');
    refuse = false;
    await later(SIGN_OUT_RETRY_MS);
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(seen.screen?.userId).toBeNull();
    // let go only on this tab's own service saying they are out
    await report(fakePort());
    await later(0);
    expect(seen.screen?.status).toBe('signed-out');
    await report(theirs(signOut));
    await later(0);
    expect(seen.screen?.userId).toBe(USER);
  });

  it('takes nothing from the late answer of a sign-out whose wait ran out', async () => {
    window.localStorage.setItem('tf-left', '1');
    const answers: (() => void)[] = [];
    const signOut = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    await page([]);
    await later(0);
    await report(theirs(signOut));
    await later(SIGN_OUT_WAIT_MS);
    // counted as refused: its answer, when it comes, is not a sign-out done
    await act(async () => answers[0]?.());
    await later(0);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(seen.screen?.userId).toBeNull();
    expect(marked()).toBe(true);
    // the next try comes at its own time, no sooner for the late answer
    await later(SIGN_OUT_RETRY_MS - 1);
    expect(signOut).toHaveBeenCalledTimes(1);
    await later(1);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('counts a sign-out that never answers as refused once its wait is over, and tries again', async () => {
    window.localStorage.setItem('tf-left', '1');
    const signOut = vi.fn(() => new Promise<void>(() => {}));
    await page([]);
    await later(0);
    await report(theirs(signOut));
    await later(SIGN_OUT_WAIT_MS - 1);
    expect(signOut).toHaveBeenCalledTimes(1);
    await later(1 + SIGN_OUT_RETRY_MS - 1);
    expect(signOut).toHaveBeenCalledTimes(1);
    await later(1);
    expect(signOut).toHaveBeenCalledTimes(2);
    // still nobody handed out, and the mark still there
    expect(seen.screen?.userId).toBeNull();
    expect(marked()).toBe(true);
  });

  it.each(['en', 'pt'] as const)(
    'shows the bar’s way in through the window, never the account, and leaves the signed-in hint off, in %s',
    async (lang) => {
      const t = dictionary(lang);
      // biome-ignore lint/suspicious/noDocumentCookie: the test starts from no hint, as the press left it
      document.cookie = `${SIGNED_IN_COOKIE}=; max-age=0; path=/`;
      window.localStorage.setItem('tf-left', '1');
      const host = await mount(
        createElement(
          WalletProvider,
          null,
          createElement(Probe, { key: 'probe' }),
          withAccount(lang, createElement(AppNav)),
        ),
      );
      await later(0);
      // the service loads with their session, ready, wallets and all
      await report(theirs(vi.fn(() => new Promise<void>(() => {}))));
      await later(WAY_IN_MS);
      expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
      expect(host.querySelector('[data-ui="account-address"]')).toBeNull();
      expect(find(host, '[data-ui="account-control"] a[href^="/sign-in"]').textContent).toBe(
        t.shell.signIn,
      );
      // "Portfolio" is a signed-in person's link
      expect(host.querySelector('a[href="/monitor"]')).toBeNull();
      expect(document.cookie).not.toContain(`${SIGNED_IN_COOKIE}=1`);
      await later(60_000);
      expect(host.querySelector('[data-ui="account-menu-button"]')).toBeNull();
      expect(document.cookie).not.toContain(`${SIGNED_IN_COOKIE}=1`);
    },
  );
});

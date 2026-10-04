// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { all, render, ui } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { toWalletError } from './errors';
import { SignIn } from './SignIn';
import type { SignInFailure } from './sign-in-view';
import { fakePort } from './test/fake-port';
import { portStore } from './test/mock-provider';

vi.mock('./WalletProvider', () => import('./test/mock-provider'));

// The two ways in, with real clicks: what each button asks the port for, and what a person reads when
// it fails. Nothing a wallet or a provider throws reaches the page.

const FOUND = [
  { id: 'solana:Phantom', name: 'Phantom', family: 'solana' as const },
  { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' as const },
];
const en = dictionary('en').signIn;

beforeEach(() => portStore.set(fakePort({ found: FOUND })));
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
});

const screen = (lang: Lang = 'en', onSignedIn?: () => void) =>
  mount(inLanguage(lang, createElement(SignIn, { onSignedIn })));
const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));
  if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}`);
  return found[0] as HTMLButtonElement;
};
const alert = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? null;

/** What a wallet or the provider throws, as the port hands it on. */
const privy = (code: string, message: string) =>
  toWalletError(Object.assign(new Error(message), { privyErrorCode: code }));
const THROWN = {
  off: privy('disallowed_login_method', 'Login with passkey not allowed'),
  closed: privy('passkey_not_allowed', 'Passkey request timed out or rejected by user.'),
  unknownPasskey: privy('user_does_not_exist', 'User does not exist'),
  noWebAuthn: toWalletError(new Error('WebAuthn is not supported in this browser')),
  refused: toWalletError(
    Object.assign(new Error('User denied message signature.'), { code: 4001 }),
  ),
  silent: toWalletError(new Error('disconnected')),
  tooMany: privy('too_many_requests', 'Too many requests'),
  offline: toWalletError(new TypeError('Failed to fetch')),
  strange: toWalletError(new Error('TypeError: Cannot read properties of undefined (reading x)')),
};

describe('the sign-in panel: two ways in', () => {
  it('offers a passkey, to create or to use, and the wallets found in the browser', async () => {
    const host = await screen();
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Passkey',
      'Wallet',
    ]);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      // each button holds its label and, hidden, the label it takes while it waits
      `${en.passkey.create}${en.passkey.waiting}`,
      `${en.passkey.use}${en.passkey.waiting}`,
      `Phantom · Solana${en.wallet.waiting}`,
      `MetaMask · Ethereum${en.wallet.waiting}`,
    ]);
    // one primary on the view
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(find(host, '[data-variant="primary"]').textContent).toContain(en.passkey.create);
    // the list of wallets is named for a screen reader
    expect(find(host, 'ul').getAttribute('aria-label')).toBe(en.wallet.found);
  });

  it('creates a passkey and uses one with two different calls', async () => {
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', onSignedIn);
    await click(button(host, en.passkey.create));
    await click(button(host, en.passkey.use));
    expect(signIn.mock.calls).toEqual([['passkey', { create: true }], ['passkey']]);
    expect(onSignedIn).toHaveBeenCalledTimes(2);
  });

  it('signs in with the wallet that was pressed, and no other', async () => {
    const signIn = vi.fn(async () => {});
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, 'MetaMask'));
    expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'evm:io.metamask' }]]);
  });

  it('says so when no wallet is in the browser, and still offers the passkey', async () => {
    portStore.set(fakePort({ found: [] }));
    const host = await screen();
    expect(host.textContent).toContain(en.wallet.none);
    expect(host.querySelectorAll('button')).toHaveLength(2);
  });

  it('changes the label of the button that is waiting, with no spinner, and asks only once', async () => {
    let finish: () => void = () => {};
    const signIn = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    const create = button(host, en.passkey.create);
    await click(create);
    expect(create.getAttribute('aria-busy')).toBe('true');
    // the waiting label is the one a screen reader meets now
    const [resting, waiting] = [...create.querySelectorAll('span > span')];
    expect(resting?.getAttribute('aria-hidden')).toBe('true');
    expect(waiting?.getAttribute('aria-hidden')).toBeNull();
    expect(waiting?.textContent).toBe(en.passkey.waiting);
    // the other ways in are set aside while one is in flight, and a second press asks nothing
    for (const other of [button(host, en.passkey.use), button(host, 'Phantom')])
      expect(other.getAttribute('aria-disabled')).toBe('true');
    await click(create);
    await click(button(host, 'Phantom'));
    expect(signIn).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(create.getAttribute('aria-busy')).toBeNull();
  });
});

describe('the sign-in panel: every failure is a sentence a person can act on', () => {
  const CASES: Array<[string, unknown, string, SignInFailure]> = [
    [
      'passkeys are not enabled for the app (Privy’s 403), creating',
      THROWN.off,
      'create',
      'passkeyOff',
    ],
    ['passkeys are not enabled for the app (Privy’s 403), using', THROWN.off, 'use', 'passkeyOff'],
    [
      'the passkey prompt is cancelled while creating',
      THROWN.closed,
      'create',
      'passkeyNotCreated',
    ],
    ['the passkey prompt is cancelled while using', THROWN.closed, 'use', 'passkeyNotUsed'],
    ['the passkey is one nobody is known by', THROWN.unknownPasskey, 'use', 'passkeyUnknown'],
    ['the browser has no passkeys', THROWN.noWebAuthn, 'create', 'passkeyUnsupported'],
    ['the wallet refuses', THROWN.refused, 'wallet', 'walletRefused'],
    ['the wallet does not answer', THROWN.silent, 'wallet', 'walletSilent'],
    ['wallet sign-in is not enabled for the app', THROWN.off, 'wallet', 'walletOff'],
    ['the provider asks for fewer requests', THROWN.tooMany, 'use', 'tooMany'],
    ['the provider cannot be reached', THROWN.offline, 'wallet', 'offline'],
    ['something nobody foresaw is thrown', THROWN.strange, 'create', 'other'],
  ];

  describe.each(['en', 'pt'] as const)('in %s', (lang) => {
    const t = dictionary(lang).signIn;
    it.each(CASES)('when %s', async (_, thrown, which, key) => {
      const signIn = vi.fn(async () => {
        throw thrown;
      });
      const onSignedIn = vi.fn();
      portStore.set(fakePort({ found: FOUND, signIn }));
      const host = await screen(lang, onSignedIn);
      await click(
        button(
          host,
          which === 'create' ? t.passkey.create : which === 'use' ? t.passkey.use : 'MetaMask',
        ),
      );
      expect(alert(host)).toBe(t.failure[key]);
      // never what was thrown
      const raw = (thrown as Error).message;
      expect(host.textContent).not.toContain(raw);
      expect(host.textContent).not.toMatch(/TypeError|undefined|403|privy/i);
      expect(onSignedIn).not.toHaveBeenCalled();
      // and the way in is still there to try again
      expect(host.querySelectorAll('button')).toHaveLength(4);
    });
  });

  it('gives each failure a sentence of its own, that says what to do', () => {
    for (const lang of ['en', 'pt'] as const) {
      const all = Object.values(dictionary(lang).signIn.failure);
      expect(new Set(all).size).toBe(all.length);
      for (const sentence of all) expect(sentence.split('. ').length).toBeGreaterThan(1);
    }
  });

  it('takes the sentence away when the person tries again', async () => {
    let fail = true;
    const signIn = vi.fn(async () => {
      if (fail) throw THROWN.closed;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, en.passkey.use));
    expect(alert(host)).toBe(en.failure.passkeyNotUsed);
    fail = false;
    await click(button(host, en.passkey.create));
    expect(alert(host)).toBeNull();
  });
});

describe('the sign-in panel: when sign-in is off', () => {
  const DOWN =
    "the API at localhost:3001 cannot be reached, so its networks cannot be checked against this app's";

  it('says the server is not answering and that the page will update, and offers no way in', async () => {
    portStore.set(fakePort({ found: FOUND, problem: DOWN, problemKind: 'api' }));
    const host = await screen();
    expect(find(host, '[data-state="off"]').getAttribute('role')).toBe('status');
    expect(host.textContent).toContain(en.off.api);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    // it comes back by itself when the API answers
    portStore.set(fakePort({ found: FOUND }));
    await settle();
    expect(host.querySelectorAll('button')).toHaveLength(4);
  });

  it('says this copy is not set up, in words a person can use, for every other reason', async () => {
    portStore.set(
      fakePort({ problem: 'NEXT_PUBLIC_PRIVY_APP_ID is not set', problemKind: 'setup' }),
    );
    const host = await screen('pt');
    expect(host.textContent).toContain(dictionary('pt').signIn.off.setup);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows the detail to the team under the development server, and to nobody in a build', async () => {
    portStore.set(fakePort({ problem: DOWN, problemKind: 'api' }));
    const dev = await screen();
    expect(dev.textContent).toContain(`${en.off.detail}: ${DOWN}`);
    vi.stubEnv('NODE_ENV', 'production');
    const built = await screen();
    expect(built.textContent).toContain(en.off.api);
    expect(built.textContent).not.toContain(DOWN);
    expect(built.textContent).not.toContain('localhost');
  });

  it('says it is loading, in words, while the wallet loads', async () => {
    portStore.set(fakePort({ status: 'loading' }));
    const host = await screen();
    expect(find(host, '[role="status"]').textContent).toBe(en.loading);
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('the sign-in panel: the throwaway wallet of development', () => {
  it('carries the hatch and the word MOCK on both ways in, and no hatch without the word', () => {
    portStore.set(fakePort({ found: FOUND, test: true }));
    const page = render(createElement(SignIn));
    expect(hatchProblems(page)).toEqual([]);
    expect(all(page, ui('mock-plate'))).toHaveLength(2);
    expect(all(page, ui('hatch-band'))).toHaveLength(2);
    // a real wallet draws neither
    portStore.set(fakePort({ found: FOUND }));
    const real = render(createElement(SignIn));
    expect(hatchProblems(real)).toEqual([]);
    expect(all(real, (el) => ui('hatch-band')(el) || ui('mock-plate')(el))).toEqual([]);
  });

  it('says the words a screen reader hears after MOCK in the language of the page', async () => {
    portStore.set(fakePort({ found: FOUND, test: true }));
    for (const lang of ['en', 'pt'] as const) {
      const host = await screen(lang);
      const plates = [...host.querySelectorAll('.tf-mock-plate')].map((p) => p.textContent);
      expect(plates).toEqual(Array(2).fill(`MOCK${dictionary(lang).shell.mockAnnounce}`));
      await unmountAll();
    }
  });
});

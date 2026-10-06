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

/** Opens the list of wallets found in the browser. */
const openList = async (host: HTMLElement) => click(button(host, en.wallet.connect));

describe('the sign-in panel: two ways in, one button each', () => {
  it('offers "Continue with a passkey" and "Connect a wallet", the passkey the one primary', async () => {
    const host = await screen();
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Passkey',
      'Wallet',
    ]);
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      // each button holds its label and, hidden, the label it takes while it waits
      `${en.passkey.continue}${en.passkey.waiting}`,
      en.wallet.connect,
    ]);
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    expect(find(host, '[data-variant="primary"]').textContent).toContain(en.passkey.continue);
    // the list is not shown until it is asked for
    const connect = button(host, en.wallet.connect);
    expect(connect.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-ui="wallet-list"]')).toBeNull();
  });

  it('signs in with a passkey this device has, in one call', async () => {
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', onSignedIn);
    await click(button(host, en.passkey.continue));
    expect(signIn.mock.calls).toEqual([['passkey']]);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the prompt is closed (or timed out, or the device has none)', 'closed', 'passkeyNotUsed'],
    ['the one it has is unknown here', 'unknownPasskey', 'passkeyUnknown'],
    ['Privy has not registered it', 'notRegistered', 'passkeyNotRegistered'],
  ] as const)(
    'makes none when %s: it says why, and offers a button that makes one',
    async (_, what, key) => {
      const thrown = {
        closed: THROWN.closed,
        unknownPasskey: THROWN.unknownPasskey,
        notRegistered: privy('passkey_not_registered', 'Passkey not registered'),
      }[what];
      const signIn = vi.fn(async (_m: string, choice?: { create?: boolean }) => {
        if (!choice?.create) throw thrown;
      });
      const onSignedIn = vi.fn();
      portStore.set(fakePort({ found: FOUND, signIn }));
      const host = await screen('en', onSignedIn);
      await click(button(host, en.passkey.continue));
      // one call, and nothing made
      expect(signIn.mock.calls).toEqual([['passkey']]);
      expect(onSignedIn).not.toHaveBeenCalled();
      expect(alert(host)).toBe(en.failure[key]);
      // the one way to make one: a secondary button of its own (its own gesture, as Safari wants), not
      // a second primary
      const create = find(find(host, '[data-ui="create-new-passkey"]'), 'button');
      expect(create.getAttribute('data-variant')).toBe('secondary');
      expect(create.textContent).toContain(en.passkey.createNew);
      expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
      await click(create);
      expect(signIn.mock.calls).toEqual([['passkey'], ['passkey', { create: true }]]);
      expect(onSignedIn).toHaveBeenCalledTimes(1);
      expect(alert(host)).toBeNull();
      expect(host.querySelector('[data-ui="create-new-passkey"]')).toBeNull();
    },
  );

  it('says a closed prompt in words that point to another device and a phone, and never to a new passkey', () => {
    for (const lang of ['en', 'pt'] as const) {
      const sentence = dictionary(lang).signIn.failure.passkeyNotUsed;
      expect(sentence).toMatch(lang === 'en' ? /another device/ : /outro aparelho/);
      expect(sentence).toMatch(lang === 'en' ? /use a phone/ : /usar um celular/);
      expect(sentence).not.toMatch(/create|crie/i);
    }
  });

  it('never gives "Create a new passkey" as the fix: the offer says first that it is a new, empty wallet', async () => {
    for (const lang of ['en', 'pt'] as const) {
      const t = dictionary(lang).signIn;
      // no failure sentence of a passkey tells the person to make one
      for (const key of [
        'passkeyNotUsed',
        'passkeyNotAccepted',
        'passkeyUnknown',
        'passkeyNotRegistered',
      ] as const)
        expect(t.failure[key], key).not.toMatch(/create|crie|criar/i);
      portStore.set(
        fakePort({
          found: FOUND,
          signIn: vi.fn(async () => {
            throw THROWN.strange;
          }),
        }),
      );
      const host = await screen(lang);
      await click(button(host, t.passkey.continue));
      expect(alert(host)).toBe(t.failure.passkeyNotAccepted);
      expect(alert(host)).not.toBe(t.failure.other);
      const offer = find(host, '[data-ui="create-new-passkey"]');
      // the warning comes before the button
      expect(offer.firstElementChild?.textContent).toBe(t.passkey.createWarning);
      expect(t.passkey.createWarning).toMatch(lang === 'en' ? /new, empty wallet/ : /nova e vazia/);
      expect(find(offer, 'button').className).not.toContain('bg-primary');
      await unmountAll();
    }
  });

  it('says so when the prompt to make one is closed too, makes nothing, and offers it again', async () => {
    const signIn = vi.fn(async () => {
      throw THROWN.closed;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, en.passkey.continue));
    await click(find(find(host, '[data-ui="create-new-passkey"]'), 'button'));
    expect(alert(host)).toBe(en.failure.passkeyNotCreated);
    expect(host.querySelector('[data-ui="create-new-passkey"]')).not.toBeNull();
  });

  it('offers no new passkey where none can be made, nor after a wallet failed', async () => {
    for (const thrown of [THROWN.off, THROWN.noWebAuthn]) {
      portStore.set(
        fakePort({
          found: FOUND,
          signIn: vi.fn(async () => {
            throw thrown;
          }),
        }),
      );
      const host = await screen();
      await click(button(host, en.passkey.continue));
      expect(host.querySelector('[data-ui="create-new-passkey"]')).toBeNull();
      await unmountAll();
    }
    portStore.set(
      fakePort({
        found: FOUND,
        signIn: vi.fn(async () => {
          throw THROWN.refused;
        }),
      }),
    );
    const host = await screen();
    await openList(host);
    await click(button(host, 'MetaMask'));
    expect(host.querySelector('[data-ui="create-new-passkey"]')).toBeNull();
  });

  it('makes none when using one failed for another reason, and says that reason', async () => {
    for (const [thrown, key] of [
      [THROWN.off, 'passkeyOff'],
      [THROWN.tooMany, 'tooMany'],
      [THROWN.noWebAuthn, 'passkeyUnsupported'],
    ] as const) {
      const signIn = vi.fn(async () => {
        throw thrown;
      });
      portStore.set(fakePort({ found: FOUND, signIn }));
      const host = await screen();
      await click(button(host, en.passkey.continue));
      expect(signIn.mock.calls).toEqual([['passkey']]);
      expect(alert(host)).toBe(en.failure[key]);
      await unmountAll();
    }
  });

  it('lists the wallets found, one entry each with its own icon, and signs in with the one pressed', async () => {
    const signIn = vi.fn(async () => {});
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
    portStore.set(
      fakePort({
        found: [
          { id: 'solana:Phantom', name: 'Phantom', family: 'solana', icon },
          { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' },
        ],
        signIn,
      }),
    );
    const host = await screen();
    await openList(host);
    expect(button(host, en.wallet.connect).getAttribute('aria-expanded')).toBe('true');
    const list = find(host, '[data-ui="wallet-list"]');
    expect(list.getAttribute('aria-label')).toBe(en.wallet.found);
    expect([...list.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      `MetaMask${en.wallet.waiting}`,
      `Phantom${en.wallet.waiting}`,
    ]);
    // no chain in a wallet's name: the family is the wallet's own
    expect(list.textContent).not.toMatch(/Solana|Ethereum/);
    expect(find(list, 'img').getAttribute('src')).toBe(icon);
    expect(find(list, 'img').getAttribute('alt')).toBe('');
    await click(button(host, 'MetaMask'));
    expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'evm:io.metamask' }]]);
  });

  it('asks which chain for a wallet that signs on both, and signs in on that one', async () => {
    const signIn = vi.fn(async () => {});
    portStore.set(
      fakePort({
        found: [
          { id: 'solana:Phantom', name: 'Phantom', family: 'solana' },
          { id: 'evm:app.phantom', name: 'Phantom', family: 'evm' },
        ],
        signIn,
      }),
    );
    const host = await screen();
    await openList(host);
    expect(host.querySelectorAll('[data-ui="wallet-list"] li')).toHaveLength(1);
    await click(button(host, 'Phantom'));
    expect(signIn).not.toHaveBeenCalled();
    const chains = find(host, '[data-ui="wallet-chains"]');
    expect(chains.getAttribute('role')).toBe('group');
    expect(chains.textContent).toContain(en.wallet.both('Phantom'));
    // someone signed in before is told to choose what they chose then
    expect(chains.textContent).toContain(en.wallet.before);
    expect([...chains.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      `Solana${en.wallet.waiting}`,
      `Robinhood Chain${en.wallet.waiting}`,
    ]);
    await click(button(host, 'Robinhood Chain'));
    expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'evm:app.phantom' }]]);
  });

  it('asks nothing when only one of the wallet’s chains is on: that is its chain', async () => {
    const signIn = vi.fn(async () => {});
    const base = fakePort();
    portStore.set(
      fakePort({
        found: [
          { id: 'solana:Phantom', name: 'Phantom', family: 'solana' },
          { id: 'evm:app.phantom', name: 'Phantom', family: 'evm' },
        ],
        signIn,
        network: (chain) => {
          const n = base.network(chain);
          return n && chain === 'robinhood' ? { ...n, on: false } : n;
        },
      }),
    );
    const host = await screen();
    await openList(host);
    await click(button(host, 'Phantom'));
    expect(host.querySelector('[data-ui="wallet-chains"]')).toBeNull();
    expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'solana:Phantom' }]]);
  });

  it('shows a wallet whose every chain is off as unusable, and says why', async () => {
    const signIn = vi.fn(async () => {});
    const base = fakePort();
    portStore.set(
      fakePort({
        found: [{ id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' }],
        signIn,
        network: (chain) => {
          const n = base.network(chain);
          return n && chain === 'robinhood' ? { ...n, on: false } : n;
        },
      }),
    );
    const host = await screen();
    await openList(host);
    const metamask = button(host, 'MetaMask');
    expect(metamask.getAttribute('aria-disabled')).toBe('true');
    expect(find(host, '[data-ui="wallet-off"]').textContent).toBe(en.wallet.off('MetaMask'));
    await click(metamask);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('says so when no wallet is in the browser, and points to the passkey', async () => {
    portStore.set(fakePort({ found: [] }));
    const host = await screen();
    await openList(host);
    expect(find(host, '[data-ui="wallet-none"]').textContent).toBe(en.wallet.none);
    expect(en.wallet.none).toContain('passkey');
    expect(host.querySelectorAll('button')).toHaveLength(2);
  });

  it('changes the label of the button that is waiting, with no spinner, and asks only once', async () => {
    let finish: () => void = () => {};
    const signIn = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await openList(host);
    const passkey = button(host, en.passkey.continue);
    await click(passkey);
    expect(passkey.getAttribute('aria-busy')).toBe('true');
    // the waiting label is the one a screen reader meets now
    const [resting, waiting] = [...passkey.querySelectorAll('span > span')];
    expect(resting?.getAttribute('aria-hidden')).toBe('true');
    expect(waiting?.getAttribute('aria-hidden')).toBeNull();
    expect(waiting?.textContent).toBe(en.passkey.waiting);
    // the other ways in are set aside while one is in flight, and a second press asks nothing
    for (const other of [button(host, 'Phantom'), button(host, en.wallet.connect)])
      expect(other.getAttribute('aria-disabled')).toBe('true');
    await click(passkey);
    await click(button(host, 'Phantom'));
    expect(signIn).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(passkey.getAttribute('aria-busy')).toBeNull();
  });
});

describe('the sign-in panel: every failure is a sentence a person can act on', () => {
  // A passkey unknown here is then made; a failure is said for what was tried last. A closed prompt
  // makes nothing. The port here throws the same thing every time it is called.
  const CASES: Array<[string, unknown, 'passkey' | 'wallet', SignInFailure]> = [
    ['passkeys are not enabled for the app (Privy’s 403)', THROWN.off, 'passkey', 'passkeyOff'],
    ['the prompt is closed', THROWN.closed, 'passkey', 'passkeyNotUsed'],
    ['the passkey is one nobody is known by', THROWN.unknownPasskey, 'passkey', 'passkeyUnknown'],
    ['the browser has no passkeys', THROWN.noWebAuthn, 'passkey', 'passkeyUnsupported'],
    ['the wallet refuses', THROWN.refused, 'wallet', 'walletRefused'],
    ['the wallet does not answer', THROWN.silent, 'wallet', 'walletSilent'],
    ['wallet sign-in is not enabled for the app', THROWN.off, 'wallet', 'walletOff'],
    ['the provider asks for fewer requests', THROWN.tooMany, 'passkey', 'tooMany'],
    ['the provider cannot be reached', THROWN.offline, 'wallet', 'offline'],
    // with a passkey, a failure nobody foresaw is said as what it is: no passkey was taken
    ['something nobody foresaw is thrown', THROWN.strange, 'passkey', 'passkeyNotAccepted'],
    ['something nobody foresaw is thrown by a wallet', THROWN.strange, 'wallet', 'other'],
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
      if (which === 'wallet') {
        await click(button(host, t.wallet.connect));
        await click(button(host, 'MetaMask'));
      } else await click(button(host, t.passkey.continue));
      expect(alert(host)).toBe(t.failure[key]);
      // never what was thrown
      const raw = (thrown as Error).message;
      expect(host.textContent).not.toContain(raw);
      expect(host.textContent).not.toMatch(/TypeError|undefined|403|privy/i);
      expect(onSignedIn).not.toHaveBeenCalled();
      // and the way in is still there to try again
      expect(button(host, t.passkey.continue).getAttribute('aria-disabled')).toBeNull();
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
    await click(button(host, en.passkey.continue));
    expect(alert(host)).toBe(en.failure.passkeyNotUsed);
    fail = false;
    await click(button(host, en.passkey.continue));
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
    expect(host.querySelectorAll('button')).toHaveLength(2);
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
  it('carries the hatch and a quiet line on both ways in, and no hatch without it', () => {
    portStore.set(fakePort({ found: FOUND, test: true }));
    const page = render(createElement(SignIn));
    expect(hatchProblems(page)).toEqual([]);
    expect(all(page, ui('sample-note'))).toHaveLength(2);
    expect(all(page, ui('hatch-band'))).toHaveLength(2);
    // a real wallet draws neither
    portStore.set(fakePort({ found: FOUND }));
    const real = render(createElement(SignIn));
    expect(hatchProblems(real)).toEqual([]);
    expect(all(real, (el) => ui('hatch-band')(el) || ui('sample-note')(el))).toEqual([]);
  });

  it('says the quiet line in the language of the page', async () => {
    portStore.set(fakePort({ found: FOUND, test: true }));
    for (const lang of ['en', 'pt'] as const) {
      const host = await screen(lang);
      const lines = [...host.querySelectorAll('[data-ui="sample-note"]')].map((p) => p.textContent);
      expect(lines).toEqual(Array(2).fill(dictionary(lang).shell.mockAnnounce));
      expect(host.textContent).not.toContain('MOCK');
      await unmountAll();
    }
  });
});

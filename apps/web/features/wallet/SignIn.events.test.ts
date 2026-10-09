// @vitest-environment happy-dom
import { act, createElement } from 'react';
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

// The ways in, with real clicks: what each button asks the port for, and what a person reads after
// it. A new person's button and a returning person's are a pair of equal standing; a closed passkey
// prompt is a calm note, a real failure an alert; the wallets are one list with no name twice.
// Nothing a wallet or a provider throws reaches the page.

const FOUND = [
  { id: 'solana:Phantom', name: 'Phantom', family: 'solana' as const },
  { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' as const },
];
const en = dictionary('en').signIn;

/** Each look at the clock is a second later: a prompt was open for a person's time before it answered. */
const aPersonsTime = () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 1_000;
    return now;
  });
};
/** The clock stands still: what answers, answers at once, with no prompt behind it. */
const atOnce = () => vi.spyOn(Date, 'now').mockImplementation(() => 0);

beforeEach(() => {
  window.localStorage.clear();
  portStore.set(fakePort({ found: FOUND }));
  aPersonsTime();
});
afterEach(async () => {
  await unmountAll();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const screen = (lang: Lang = 'en', onSignedIn?: () => void) =>
  mount(inLanguage(lang, createElement(SignIn, { onSignedIn })));
const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));
  if (found.length !== 1) throw new Error(`expected one button "${label}", found ${found.length}`);
  return found[0] as HTMLButtonElement;
};
const alert = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? null;
/** The calm note after a passkey prompt that was closed. */
const note = (host: HTMLElement) =>
  host.querySelector('[data-ui="sign-in-note"]')?.textContent || null;

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

const create = (host: HTMLElement) => find(host, '[data-act="passkey-create"]');
const use = (host: HTMLElement) => find(host, '[data-act="passkey-continue"]');
const rows = (host: HTMLElement) => [
  ...find(host, '[data-ui="wallet-list"]').querySelectorAll<HTMLElement>('button[data-wallet]'),
];

describe('the sign-in panel: someone new and someone who has a passkey, as a pair', () => {
  it('opens with the two passkey buttons at the top of the passkey side, the new one first, a line under each', async () => {
    const host = await screen();
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Passkey',
      'Wallet',
    ]);
    const pair = find(host, '[data-ui="passkey-pair"]');
    expect([...pair.querySelectorAll('button')].map((b) => b.getAttribute('data-act'))).toEqual([
      'passkey-create',
      'passkey-continue',
    ]);
    expect(create(host).textContent).toContain(en.passkey.create);
    expect(use(host).textContent).toContain(en.passkey.continue);
    // each is described by its line
    const line = (button: HTMLElement) =>
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(line(create(host))).toBe(en.passkey.createNote);
    expect(line(use(host))).toBe(en.passkey.continueNote);
    // the pair is the first thing in the card: nothing to read before the choices
    expect(pair.previousElementSibling).toBeNull();
    // and in the order of the keys: new, returning, the wallets
    const order = [...host.querySelectorAll('button')].map(
      (b) => b.getAttribute('data-act') ?? b.getAttribute('data-wallet'),
    );
    expect(order).toEqual(['passkey-create', 'passkey-continue', 'metamask', 'phantom']);
  });

  it('draws them as equals when nothing is known about this device: same weight, same width, no primary', async () => {
    const host = await screen();
    expect(find(host, '[data-ui="passkey-pair"]').getAttribute('data-leads')).toBe('neither');
    expect(create(host).getAttribute('data-variant')).toBe('secondary');
    expect(use(host).getAttribute('data-variant')).toBe('secondary');
    expect(create(host).className).toBe(use(host).className);
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
  });

  it('leads with "Use my passkey" once a passkey has signed in on this browser, and never with two primaries', async () => {
    const signIn = vi.fn(async () => {});
    portStore.set(fakePort({ found: FOUND, signIn }));
    const first = await screen();
    await click(use(first));
    await unmountAll();
    // the next time the screen opens here, the device is known to have had one
    const host = await screen();
    expect(find(host, '[data-ui="passkey-pair"]').getAttribute('data-leads')).toBe('continue');
    expect(use(host).getAttribute('data-variant')).toBe('primary');
    expect(create(host).getAttribute('data-variant')).toBe('secondary');
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    // the order does not move
    expect(
      create(host).compareDocumentPosition(use(host)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps nothing about the device when the sign-in was with a wallet, or failed', async () => {
    let fail = true;
    const signIn = vi.fn(async (method: string) => {
      if (method === 'passkey' && fail) throw THROWN.closed;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(use(host));
    await click(button(host, 'MetaMask'));
    fail = false;
    await unmountAll();
    const again = await screen();
    expect(find(again, '[data-ui="passkey-pair"]').getAttribute('data-leads')).toBe('neither');
  });

  it('a new person creates: one call that makes a passkey, with what it opens said beside the button before the press', async () => {
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', onSignedIn);
    // the warning is on the screen from the start, right under the button that makes one
    const said = find(host, '[data-ui="passkey-create-note"]');
    expect(said.textContent).toMatch(/new, empty wallet/);
    // a second account, said as that, not only as a wallet
    expect(said.textContent).toMatch(/new account/);
    expect(said.textContent).toMatch(/doesn’t open an account you already have/);
    expect(create(host).nextElementSibling).toBe(said);
    await click(create(host));
    expect(signIn.mock.calls).toEqual([['passkey', { create: true }]]);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(alert(host)).toBeNull();
    expect(note(host)).toBeNull();
  });

  it('a returning person continues: one call that uses a passkey, and none is made', async () => {
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', onSignedIn);
    await click(use(host));
    expect(signIn.mock.calls).toEqual([['passkey']]);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('says an empty or closed prompt calmly, pointing at the other button, and makes nothing by itself', async () => {
    const signIn = vi.fn(async (_m: string, choice?: { create?: boolean }) => {
      if (!choice?.create) throw THROWN.closed;
    });
    const onSignedIn = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', onSignedIn);
    await click(use(host));
    // one call, nothing made, nobody signed in
    expect(signIn.mock.calls).toEqual([['passkey']]);
    expect(onSignedIn).not.toHaveBeenCalled();
    // a note, not an alert: no red, no failure mark. The region was there, empty, before the press
    expect(alert(host)).toBeNull();
    const said = find(host, '[data-ui="sign-in-note"]');
    expect(said.getAttribute('role')).toBe('status');
    expect(said.textContent).toBe(en.failure.passkeyNotUsed);
    expect(said.className).not.toContain('text-destructive');
    expect(said.querySelector('svg')).toBeNull();
    // in the passkey card, under the pair it points at
    expect(find(host, '[data-ui="passkey-pair"]').parentElement?.contains(said)).toBe(true);
    // the other button is there to press, and makes one in its own gesture
    await click(create(host));
    expect(signIn.mock.calls).toEqual([['passkey'], ['passkey', { create: true }]]);
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(note(host)).toBeNull();
  });

  it('keeps the note’s region on the page from the start, empty, and fills it', async () => {
    portStore.set(
      fakePort({
        found: FOUND,
        signIn: vi.fn(async () => {
          throw THROWN.closed;
        }),
      }),
    );
    const host = await screen();
    const region = find(host, '[data-ui="sign-in-note"]');
    expect([region.getAttribute('role'), region.textContent]).toEqual(['status', '']);
    await click(use(host));
    // the same element, now with its words
    expect(find(host, '[data-ui="sign-in-note"]')).toBe(region);
    expect(region.textContent).toBe(en.failure.passkeyNotUsed);
  });

  it('says a closed prompt in words about finding the passkey the person has, and never about making one', () => {
    // read by exactly the person whose passkey is on another device: a word about a new passkey
    // there sends them to a second account (review of #87, restored after the review of #209)
    for (const lang of ['en', 'pt'] as const) {
      const sentence = dictionary(lang).signIn.failure.passkeyNotUsed;
      expect(sentence).toMatch(lang === 'en' ? /another device/ : /outro aparelho/);
      expect(sentence).toMatch(lang === 'en' ? /use a phone/ : /usar um celular/);
      expect(sentence).toMatch(lang === 'en' ? /password manager/ : /gerenciador de senhas/);
      expect(sentence).not.toMatch(/create|crie|criar|new passkey|nova/i);
    }
    // no sentence of a failed passkey sends someone who has an account to make a new one
    for (const key of [
      'passkeyNotUsed',
      'passkeyUnknown',
      'passkeyNotRegistered',
      'passkeyNotAccepted',
    ] as const)
      for (const words of [en, dictionary('pt').signIn])
        expect(words.failure[key]).not.toMatch(/create|crie|criar/i);
  });

  it('says a refusal with no prompt behind it as a failure, not as a closed prompt', async () => {
    // a frame with no leave to use passkeys, or a browser that lost the press, is refused with the
    // same error as a closed prompt, at once: nobody closed anything
    atOnce();
    const signIn = vi.fn(async () => {
      throw THROWN.closed;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(use(host));
    expect(note(host)).toBeNull();
    expect(find(host, '[data-ui="sign-in-failure"]').textContent).toBe(
      en.failure.passkeyNotAccepted,
    );
    await click(create(host));
    expect(note(host)).toBeNull();
    expect(find(host, '[data-ui="sign-in-failure"]').textContent).toBe(en.failure.other);
    expect(en.failure.other).not.toMatch(/prompt was closed/);
  });

  it.each([
    ['a browser with no passkeys', () => vi.stubGlobal('PublicKeyCredential', undefined)],
    [
      'a frame not allowed to use them',
      () =>
        Object.defineProperty(document, 'permissionsPolicy', {
          value: { allowsFeature: () => false },
          configurable: true,
        }),
    ],
  ])(
    'shows the pair unavailable in %s, with the reason once, and asks for no passkey',
    async (_, take) => {
      take();
      try {
        const signIn = vi.fn(async () => {});
        portStore.set(fakePort({ found: FOUND, signIn }));
        const host = await screen();
        for (const button of [create(host), use(host)]) {
          expect(button.getAttribute('aria-disabled')).toBe('true');
          await click(button);
        }
        // nothing was asked for, so nothing fails in red on every press
        expect(signIn).not.toHaveBeenCalled();
        expect(alert(host)).toBeNull();
        expect(find(host, '[data-ui="passkey-unavailable"]').textContent).toBe(
          en.passkey.unavailable,
        );
        expect(host.querySelectorAll('[data-ui="passkey-unavailable"]')).toHaveLength(1);
        expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
        // the wallets are still a way in
        await click(button(host, 'MetaMask'));
        expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'evm:io.metamask' }]]);
      } finally {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(document, 'permissionsPolicy');
      }
    },
  );

  it('says a closed prompt to make one calmly too, and makes nothing', async () => {
    const signIn = vi.fn(async () => {
      throw THROWN.closed;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(create(host));
    expect(alert(host)).toBeNull();
    expect(note(host)).toBe(en.failure.passkeyNotCreated);
    // both buttons are there to try again
    expect(create(host).getAttribute('aria-disabled')).toBeNull();
    expect(use(host).getAttribute('aria-disabled')).toBeNull();
  });

  it.each([
    ['the one it has is unknown here', THROWN.unknownPasskey, 'passkeyUnknown'],
    ['Privy has not registered it', privy('passkey_not_registered', 'x'), 'passkeyNotRegistered'],
    ['passkeys are off for the app', THROWN.off, 'passkeyOff'],
    ['too many tries', THROWN.tooMany, 'tooMany'],
    ['the browser has no passkeys', THROWN.noWebAuthn, 'passkeyUnsupported'],
  ] as const)(
    'says a real failure as an alert, in red, when %s, and makes nothing',
    async (_, thrown, key) => {
      const signIn = vi.fn(async () => {
        throw thrown;
      });
      portStore.set(fakePort({ found: FOUND, signIn }));
      const host = await screen();
      await click(use(host));
      expect(signIn.mock.calls).toEqual([['passkey']]);
      const said = find(host, '[data-ui="sign-in-failure"]');
      expect(said.getAttribute('role')).toBe('alert');
      expect(said.textContent).toBe(en.failure[key]);
      expect(said.className).toContain('text-destructive');
      expect(note(host)).toBeNull();
    },
  );

  it('keeps what a passkey is behind a disclosure, closed at first', async () => {
    const host = await screen();
    const what = find<HTMLDetailsElement>(host, '[data-ui="passkey-what"]');
    expect(what.open).toBe(false);
    expect(find(what, 'summary').textContent).toBe(en.passkey.what);
    expect(what.textContent).toContain(en.passkey.body);
    // and no paragraph stands between a card's title and its choices
    for (const card of host.querySelectorAll('section'))
      expect(card.querySelector('h2 ~ p, [data-ui="card-body"] > p:first-child')).toBeNull();
  });
});

describe('the sign-in panel: the wallets as one list', () => {
  it('lists the wallets found at once, one entry each with its own icon and where its plan lives, and signs in with the one pressed', async () => {
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
    // no button to open it: the list is the wallet side
    const list = find(host, '[data-ui="wallet-list"]');
    expect(list.getAttribute('aria-label')).toBe(en.wallet.found);
    expect(rows(host).map((b) => b.getAttribute('data-wallet'))).toEqual(['metamask', 'phantom']);
    // each row says where a plan made with it lives, from the wallet's family, and asks for no switch
    expect(rows(host).map((b) => find(b, '[data-ui="wallet-lives"]').textContent)).toEqual([
      en.wallet.lives('Robinhood Chain'),
      en.wallet.lives('Solana'),
    ]);
    expect(list.textContent).not.toMatch(/switch|Ethereum/i);
    expect(find(list, 'img').getAttribute('src')).toBe(icon);
    expect(find(list, 'img').getAttribute('alt')).toBe('');
    await click(button(host, 'MetaMask'));
    expect(signIn.mock.calls).toEqual([['wallet', { wallet: 'evm:io.metamask' }]]);
  });

  it('shows MetaMask once when it announces a Solana wallet and an EVM one', async () => {
    portStore.set(
      fakePort({
        found: [
          { id: 'solana:Backpack', name: 'Backpack', family: 'solana' },
          { id: 'solana:MetaMask', name: 'MetaMask', family: 'solana' },
          { id: 'solana:Phantom', name: 'Phantom', family: 'solana' },
          { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' },
        ],
      }),
    );
    const host = await screen();
    const names = rows(host).map((b) => find(b, '[data-ui="wallet-name"]').textContent);
    expect(names).toEqual(['Backpack', 'MetaMask', 'Phantom']);
    expect(new Set(names).size).toBe(names.length);
    expect(find(button(host, 'MetaMask'), '[data-ui="wallet-lives"]').textContent).toBe(
      en.wallet.livesEither('Solana', 'Robinhood Chain'),
    );
    expect(host.querySelector('[data-ui="wallet-twin"]')).toBeNull();
  });

  it('tells two different installs with one name apart by their own ids', async () => {
    portStore.set(
      fakePort({
        found: [
          { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' },
          { id: 'evm:xyz.other', name: 'MetaMask', family: 'evm' },
        ],
      }),
    );
    const host = await screen();
    expect(
      rows(host)
        .map((b) => find(b, '[data-ui="wallet-twin"]').textContent)
        .sort(),
    ).toEqual(['io.metamask', 'xyz.other']);
  });

  it('says what to do about a wallet not listed in a quiet disclosure under the list, not as a wallet', async () => {
    const signIn = vi.fn(async () => {});
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    const other = find<HTMLDetailsElement>(host, '[data-ui="wallet-other"]');
    // words under the list: not a row of it, not a button, no icon
    const list = find(host, '[data-ui="wallet-list"]');
    expect(list.contains(other)).toBe(false);
    expect(list.nextElementSibling).toBe(other);
    expect(other.querySelector('button, img, [data-ui="wallet-name"]')).toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(rows(host).length);
    expect(other.open).toBe(false);
    expect(find(other, 'summary').textContent).toBe(en.wallet.other);
    expect(find(other, '[data-ui="wallet-other-body"]').textContent).toBe(en.wallet.otherBody);
    await click(find(other, 'summary'));
    expect(signIn).not.toHaveBeenCalled();
  });

  it('asks which chain for a wallet that signs on both, signs in on that one, and leads back to the list', async () => {
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
    expect(rows(host)).toHaveLength(1);
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
      en.wallet.back,
    ]);
    // back to the list, and in again
    await click(find(host, '[data-act="wallet-back"]'));
    expect(host.querySelector('[data-ui="wallet-chains"]')).toBeNull();
    await click(button(host, 'Phantom'));
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
    expect(find(button(host, 'Phantom'), '[data-ui="wallet-lives"]').textContent).toBe(
      en.wallet.lives('Solana'),
    );
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
    const metamask = button(host, 'MetaMask');
    expect(metamask.getAttribute('aria-disabled')).toBe('true');
    expect(metamask.querySelector('[data-ui="wallet-lives"]')).toBeNull();
    expect(find(host, '[data-ui="wallet-off"]').textContent).toBe(en.wallet.off('MetaMask'));
    await click(metamask);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('says so when no wallet is in the browser, and keeps the disclosure, which points to the passkey', async () => {
    portStore.set(fakePort({ found: [] }));
    const host = await screen();
    expect(find(host, '[data-ui="wallet-none"]').textContent).toBe(en.wallet.none);
    expect(rows(host)).toHaveLength(0);
    expect(en.wallet.otherBody).toContain('passkey');
    expect([...host.querySelectorAll('button')].map((b) => b.getAttribute('data-act'))).toEqual([
      'passkey-create',
      'passkey-continue',
    ]);
    expect(host.querySelector('[data-ui="wallet-other"]')).not.toBeNull();
  });

  it('says a wallet’s failure in the wallet card, as an alert', async () => {
    portStore.set(
      fakePort({
        found: FOUND,
        signIn: vi.fn(async () => {
          throw THROWN.refused;
        }),
      }),
    );
    const host = await screen();
    await click(button(host, 'MetaMask'));
    const said = find(host, '[data-ui="sign-in-failure"]');
    expect(said.textContent).toBe(en.failure.walletRefused);
    expect(find(host, '[data-ui="wallet-list"]').parentElement?.contains(said)).toBe(true);
    expect(find(host, '[data-ui="passkey-pair"]').parentElement?.contains(said)).toBe(false);
  });
});

describe('the sign-in panel: while a prompt or a connection is in flight', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const later = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('changes the label of the button that is waiting, shows the loader with its words after 400ms, and sets the others aside', async () => {
    let finish: () => void = () => {};
    const signIn = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    const passkey = use(host);
    await click(passkey);
    expect(passkey.getAttribute('aria-busy')).toBe('true');
    // the waiting label is the one a screen reader meets now
    const [resting, waiting] = [...passkey.querySelectorAll('span > span')];
    expect(resting?.getAttribute('aria-hidden')).toBe('true');
    expect(waiting?.getAttribute('aria-hidden')).toBeNull();
    expect(waiting?.textContent).toBe(en.passkey.waiting);
    // a short wait shows no loader; a longer one shows the lattice with its words, as a status
    expect(host.querySelector('[data-ui="sign-in-waiting"]')).toBeNull();
    await later(400);
    const loader = find(host, '[data-ui="sign-in-waiting"]');
    expect(loader.getAttribute('role')).toBe('status');
    expect(loader.textContent).toBe(en.passkey.waiting);
    expect(loader.querySelector('[data-ui="lattice-loader"]')).not.toBeNull();
    expect(find(host, '[data-ui="passkey-pair"]').parentElement?.contains(loader)).toBe(true);
    // every other way in is set aside while one is in flight, and a second press asks nothing
    for (const other of [create(host), button(host, 'Phantom'), button(host, 'MetaMask')])
      expect(other.getAttribute('aria-disabled')).toBe('true');
    await click(passkey);
    await click(create(host));
    await click(button(host, 'Phantom'));
    expect(signIn).toHaveBeenCalledTimes(1);
    finish();
    await later(0);
    expect(passkey.getAttribute('aria-busy')).toBeNull();
    expect(host.querySelector('[data-ui="sign-in-waiting"]')).toBeNull();
    expect(create(host).getAttribute('aria-disabled')).toBeNull();
  });

  it('shows the wallet’s loader in the wallet card while a wallet connects', async () => {
    const signIn = vi.fn(() => new Promise<void>(() => {}));
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, 'MetaMask'));
    await later(400);
    const loader = find(host, '[data-ui="sign-in-waiting"]');
    expect(loader.textContent).toBe(en.wallet.waiting);
    expect(find(host, '[data-ui="wallet-list"]').parentElement?.contains(loader)).toBe(true);
    for (const other of [create(host), use(host), button(host, 'Phantom')])
      expect(other.getAttribute('aria-disabled')).toBe('true');
  });

  it('says nothing of a refusal that comes after the panel was closed with the prompt open', async () => {
    let fail: (e: unknown) => void = () => {};
    const signIn = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const onFailed = vi.fn();
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await mount(inLanguage('en', createElement(SignIn, { onFailed })));
    await click(use(host));
    // the dialog is closed: the panel is gone while the prompt is still open
    await unmountAll();
    fail(THROWN.closed);
    await later(0);
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe('the sign-in panel: every failure is a sentence a person can act on', () => {
  // A passkey unknown here is then made; a failure is said for what was tried last. A closed prompt
  // makes nothing. The port here throws the same thing every time it is called.
  const CASES: Array<[string, unknown, 'passkey' | 'wallet', SignInFailure]> = [
    ['passkeys are not enabled for the app (Privy’s 403)', THROWN.off, 'passkey', 'passkeyOff'],
    ['the passkey is one nobody is known by', THROWN.unknownPasskey, 'passkey', 'passkeyUnknown'],
    ['the browser has no passkeys', THROWN.noWebAuthn, 'passkey', 'passkeyUnsupported'],
    ['the wallet refuses', THROWN.refused, 'wallet', 'walletRefused'],
    ['the wallet does not answer', THROWN.silent, 'wallet', 'walletSilent'],
    ['wallet sign-in is not enabled for the app', THROWN.off, 'wallet', 'walletOff'],
    ['the provider asks for fewer requests', THROWN.tooMany, 'passkey', 'tooMany'],
    ['the provider cannot be reached', THROWN.offline, 'wallet', 'offline'],
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
      if (which === 'wallet') await click(button(host, 'MetaMask'));
      else await click(button(host, t.passkey.continue));
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
      if (fail) throw THROWN.unknownPasskey;
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, en.passkey.continue));
    expect(alert(host)).toBe(en.failure.passkeyUnknown);
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

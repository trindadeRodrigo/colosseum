// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { GOAL_HANDOFF } from '../goal/draft';
import { toWalletError } from '../wallet/errors';
import {
  EMBEDDED,
  EVM,
  fakePort,
  json,
  METAMASK,
  PHANTOM,
  SOLANA,
  signedInPort,
} from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import type { Person } from './person';
import { SignInScreen } from './SignInScreen';
import { withAccount } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Sign-in as a screen. Nobody is asked for a chain (gate CHAIN-SWITCH): a person who connected a wallet
// starts on its chain; one who made their wallets here starts on the chain they were looking at, which
// the API stores. Here the API is a double with the shapes of GET /v1/me and PUT /v1/me/chain.

const en = dictionary('en');
const FOUND = [
  { id: 'solana:Phantom', name: 'Phantom', family: 'solana' as const },
  { id: 'evm:io.metamask', name: 'MetaMask', family: 'evm' as const },
];

/** The API's side of a person: what it stored, and every call made to it. */
function api(start: Person) {
  let person = start;
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let answer: ((path: string, init?: RequestInit) => Response | null) | null = null;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const forced = answer?.(path, init);
    if (forced) return forced;
    if (path === '/v1/me' && method === 'GET') return json(person);
    if (path === '/v1/me/chain' && method === 'PUT') {
      const { chain } = JSON.parse(String(init?.body));
      if (!person.chainOptions.includes(chain))
        return json({ error: 'no wallet signs there', code: 'NO_WALLET_FOR_CHAIN' }, 409);
      if (person.chain !== chain) person = { ...person, chain, chainSource: 'picked' };
      return json(person);
    }
    return json({ error: 'not found' }, 404);
  });
  return {
    calls,
    count: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path).length,
    /** Answers the next calls with this, in place of the double's own answer. */
    force(next: typeof answer) {
      answer = next;
    },
    stored: () => person,
    /** As if another device or tab had written it. */
    store(next: Person) {
      person = next;
    },
  };
}

const made = (over: Partial<Person> = {}): Person => ({
  userId: 'did:privy:test',
  wallets: EMBEDDED,
  chain: null,
  chainSource: null,
  chainOptions: ['solana', 'robinhood'],
  ...over,
});
const connected = (wallets = PHANTOM, chain: Person['chain'] = 'solana'): Person => ({
  userId: 'did:privy:test',
  wallets,
  chain,
  chainSource: 'wallet',
  chainOptions: [...new Set(wallets.map((w) => (w.family === 'solana' ? 'solana' : 'robinhood')))],
});

const screen = (lang: Lang = 'en', next?: string) =>
  mount(withAccount(lang, createElement(SignInScreen, { next })));
/** The one button or link that says exactly this; failing that, the one that holds it. */
const button = (host: HTMLElement, label: string) => {
  const every = [...host.querySelectorAll<HTMLElement>('button, a')];
  const exact = every.filter((b) => b.textContent === label);
  const found = exact.length ? exact : every.filter((b) => b.textContent?.includes(label));
  if (found.length !== 1) throw new Error(`expected one "${label}", found ${found.length}`);
  return found[0] as HTMLElement;
};
/** Connects a wallet as a person does: the wallet in the list, which is there from the start. */
const connectWith = async (host: HTMLElement, name: string) => {
  await click(button(host, name));
};
const state = (host: HTMLElement) =>
  find(host, '[data-ui="sign-in-screen"]').getAttribute('data-account');
const alert = (host: HTMLElement) => host.querySelector('[role="alert"]')?.textContent ?? null;

/** A sign-in that works: the port becomes the signed-in one, as the provider would make it. */
const signsInAs = (accounts: typeof EMBEDDED) =>
  vi.fn(async () => {
    portStore.set(signedInPort(accounts));
  });

beforeEach(() => {
  portStore.set(fakePort({ found: FOUND }));
  router.replace.mockClear();
  // the chain this browser was last on: each test starts where nobody has chosen
  window.localStorage.removeItem('tf-chain');
});
afterEach(unmountAll);

describe('a person who creates a wallet in the app', () => {
  it('is not asked for a chain: starts on the one they were looking at, and lands where they were headed', async () => {
    const server = api(made());
    const signIn = signsInAs(EMBEDDED);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');

    await click(button(host, en.signIn.passkey.continue));
    await settle();
    // "Use my passkey": a passkey this device has, and none is made (SIGN-IN-PAIR)
    expect(signIn).toHaveBeenCalledWith('passkey');
    // no question: the chain they were looking at (Solana, where nobody has chosen) is stored
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
    expect(state(host)).toBe('ready');
    expect(router.replace).toHaveBeenCalledWith('/goal');
  });

  it('starts on Robinhood Chain when that is the chain they were looking at', async () => {
    window.localStorage.setItem('tf-chain', 'robinhood');
    try {
      const server = api(made());
      portStore.set(signedInPort(EMBEDDED));
      const host = await screen();
      await settle();
      expect(server.stored().chain).toBe('robinhood');
      expect(host.textContent).toContain(en.chain.is.picked('Robinhood Chain'));
    } finally {
      window.localStorage.clear();
    }
  });

  it('is stored once: a later visit and a second device read the chain, and store nothing', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED));
    await screen();
    await settle();
    await unmountAll();
    for (const visit of ['a later visit', 'a second device']) {
      const again = await screen();
      await settle();
      expect(state(again), visit).toBe('ready');
      expect(again.textContent).toContain(en.chain.is.picked('Solana'));
      await unmountAll();
    }
    expect(server.count('PUT', '/v1/me/chain')).toBe(1);
  });

  it('shows and uses the wallet of the current chain alone', async () => {
    api(made({ chain: 'solana', chainSource: 'picked' }));
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(SOLANA);
    expect(host.textContent).not.toContain(EVM);
    expect(host.textContent).not.toContain('0x20…0498');
    // a person who arrived signed in is not moved on by the page: they asked to see it
    expect(router.replace).not.toHaveBeenCalled();
    expect(button(host, en.signIn.done.next).getAttribute('href')).toBe('/goal');
  });

  it('starts on the one chain a wallet of theirs signs on', async () => {
    window.localStorage.setItem('tf-chain', 'robinhood');
    try {
      const solanaOnly = EMBEDDED.filter((w) => w.family === 'solana');
      const server = api(made({ wallets: solanaOnly, chainOptions: ['solana'] }));
      portStore.set(signedInPort(solanaOnly));
      await screen();
      await settle();
      expect(server.stored().chain).toBe('solana');
    } finally {
      window.localStorage.clear();
    }
  });

  it('is told, in Portuguese too, where new plans are built', async () => {
    api(made());
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen('pt');
    await settle();
    expect(host.textContent).toContain(dictionary('pt').chain.is.picked('Solana'));
  });
});

describe('a person who connects an outside wallet', () => {
  it.each([
    ['a Solana wallet', 'Phantom', PHANTOM, 'solana', 'Solana'],
    [
      'an EVM wallet, which means Robinhood Chain',
      'MetaMask',
      METAMASK,
      'robinhood',
      'Robinhood Chain',
    ],
  ] as const)(
    'starts on its chain, and stores nothing: %s',
    async (_, name, accounts, chain, chainName) => {
      const server = api(connected(accounts, chain));
      const signIn = signsInAs(accounts);
      portStore.set(fakePort({ found: FOUND, signIn }));
      const host = await screen('en', '/goal');
      await connectWith(host, name);
      await settle();
      expect(host.querySelector('[role="group"]')).toBeNull();
      expect(signIn).toHaveBeenCalledWith('wallet', {
        wallet: FOUND.find((w) => w.name === name)?.id,
      });
      expect(host.textContent).toContain(en.chain.is.wallet(chainName));
      expect(server.count('PUT', '/v1/me/chain')).toBe(0);
      expect(router.replace).toHaveBeenCalledWith('/goal');
    },
  );

  it('with wallets of both families linked, starts on the chain they were looking at', async () => {
    const both = [...PHANTOM, ...METAMASK];
    const server = api({ ...made({ wallets: both }), chainOptions: ['solana', 'robinhood'] });
    portStore.set(signedInPort(both));
    const host = await screen();
    await settle();
    expect(server.stored().chain).toBe('solana');
    expect(host.textContent).toContain(en.chain.is.picked('Solana'));
    expect(host.textContent).not.toContain(EVM);
  });
});

describe('a chain our server has switched off', () => {
  /** A signed-in passkey person, with these chains off on the server. */
  const withOff = (...off: string[]) =>
    signedInPort(EMBEDDED, {
      network: (chain) => {
        const network = fakePort().network(chain);
        return network && { ...network, on: !off.includes(chain) };
      },
    });

  it('is not started on: the person starts on a chain that is on', async () => {
    const server = api(made());
    portStore.set(withOff('solana'));
    const host = await screen();
    await settle();
    expect(server.stored().chain).toBe('robinhood');
    expect(state(host)).toBe('ready');
  });

  it('stores nothing when every chain is off, and says so', async () => {
    const server = api(made());
    portStore.set(withOff('solana', 'robinhood'));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('unknown');
    expect(host.textContent).toContain(en.chain.unknown.off);
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
  });
});

describe('when the chain they start on cannot be stored', () => {
  it('says the server did not answer, stores nothing, and stores it when asked again', async () => {
    const server = api(made());
    server.force((path) => (path === '/v1/me/chain' ? json({}, 503) : null));
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('unknown');
    expect(host.textContent).toContain(en.chain.unknown.body);
    expect(server.stored().chain).toBeNull();
    server.force(null);
    await click(button(host, en.chain.unknown.retry));
    await settle();
    expect(state(host)).toBe('ready');
    expect(server.stored().chain).toBe('solana');
  });

  it('has a sentence for a sign-in that ran out, a missing identity token and a busy server', async () => {
    for (const [status, error, sentence] of [
      [401, 'sign in first', en.chain.unknown.signedOut],
      [401, 'sign in first: no identity token was sent', en.chain.unknown.noIdentity],
      [429, 'slow down', en.shell.slowDown],
      // the server does not take that chain for these wallets: not that it did not answer
      [409, 'no wallet you signed in with signs on Solana', en.chain.unknown.refused],
      [422, 'Solana is not a chain you can pick', en.chain.unknown.refused],
    ] as const) {
      const server = api(made());
      server.force((path) => (path === '/v1/me/chain' ? json({ error }, status) : null));
      portStore.set(signedInPort(EMBEDDED));
      const host = await screen();
      await settle();
      expect(state(host), error).toBe('unknown');
      expect(host.textContent, error).toContain(sentence);
      expect(host.textContent).not.toContain('"error"');
      await unmountAll();
    }
  });
});

describe('when the API does not say where the plan lives', () => {
  it('assumes nothing, says so, and asks again when told to', async () => {
    const server = api(made());
    server.force((path) => (path === '/v1/me' ? json({ error: 'not found' }, 404) : null));
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('unknown');
    expect(state(host)).not.toBe('ready');
    expect(host.textContent).toContain(en.chain.unknown.body);
    server.force(null);
    await click(button(host, en.chain.unknown.retry));
    await settle();
    expect(server.count('GET', '/v1/me')).toBe(2);
    expect(state(host)).toBe('ready');
  });

  it('tells a sign-in the server no longer knows to sign out and in again, and does not offer to ask again', async () => {
    const server = api(made());
    server.force((path) => (path === '/v1/me' ? json({ error: 'sign in first' }, 401) : null));
    const signOut = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    portStore.set(signedInPort(EMBEDDED, { signOut }));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('unknown');
    expect(host.textContent).toContain(en.chain.unknown.signedOut);
    expect(host.textContent).not.toContain(en.chain.unknown.body);
    expect(host.textContent).not.toContain(en.chain.unknown.retry);
    await click(button(host, en.shell.signOut));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('says the sign-in service gave no identity token, and offers to ask again, not to sign out', async () => {
    const server = api(made());
    server.force((path) =>
      path === '/v1/me' ? json({ error: 'sign in first: no identity token was sent' }, 401) : null,
    );
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('unknown');
    expect(host.textContent).toContain(en.chain.unknown.noIdentity);
    expect(host.textContent).not.toContain(en.chain.unknown.signedOut);
    server.force(null);
    await click(button(host, en.chain.unknown.retry));
    await settle();
    expect(state(host)).toBe('ready');
  });

  it('tells someone the server asked to slow down to wait, and asks again when told to', async () => {
    const server = api(made());
    server.force((path) => (path === '/v1/me' ? json({ error: 'slow down' }, 429) : null));
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.shell.slowDown);
    expect(host.textContent).not.toContain(en.chain.unknown.body);
    server.force(null);
    await click(button(host, en.chain.unknown.retry));
    await settle();
    expect(state(host)).toBe('ready');
  });

  it('says a signed-in person with no wallet has no chain, and makes the wallet when asked', async () => {
    const server = api(made({ wallets: [], chainOptions: [] }));
    const ensureWallets = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(toWalletError(new Error('the wallet could not be made')))
      .mockResolvedValue(undefined);
    portStore.set(signedInPort([], { ensureWallets }));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('no-wallet');
    expect(host.textContent).toContain(en.chain.noWallet);
    await click(button(host, en.signIn.done.retryWallet));
    await settle();
    expect(alert(host)).toBe(en.signIn.failure.walletNotMade);
    // A wallet that was not made is not a reason to ask the API again.
    expect(server.count('GET', '/v1/me')).toBe(1);
    // Made this time, and the API is asked again, whether or not the browser's list of wallets moved.
    server.store(made());
    await click(button(host, en.signIn.done.retryWallet));
    await settle();
    expect(ensureWallets).toHaveBeenCalledTimes(2);
    expect(alert(host)).toBeNull();
    expect(server.count('GET', '/v1/me')).toBe(2);
    expect(state(host)).toBe('ready');
  });
});

describe('a passkey sign-in whose wallets are not both there yet', () => {
  const owed = (walletsOwed: 'making' | 'failed', over = {}) =>
    fakePort({
      status: 'loading',
      userId: 'did:privy:test',
      // one of the two is made: the half a person must never be asked a chain with
      accounts: EMBEDDED.filter((w) => w.family === 'solana'),
      walletsOwed,
      ...over,
    });

  it('says the wallet is being made, and asks nothing, while one is on its way', async () => {
    const server = api(made({ chainOptions: ['solana'] }));
    portStore.set(owed('making'));
    const host = await screen();
    await settle();
    expect(find(host, 'h1').textContent).toBe(en.signIn.done.title);
    expect(host.textContent).toContain(en.signIn.passkey.making);
    expect(state(host)).not.toBe('ready');
    expect(host.querySelector('[data-ui="sign-in"]')).toBeNull();
    // the API is not asked which chains may be picked while it would see one wallet
    expect(server.count('GET', '/v1/me')).toBe(0);
  });

  it('gives a way forward when one could not be made: make it again, or sign out', async () => {
    const server = api(made({ chainOptions: ['solana'] }));
    const ensureWallets = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const signOut = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    portStore.set(owed('failed', { ensureWallets, signOut }));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('no-wallet');
    expect(host.textContent).toContain(en.signIn.failure.walletNotMade);
    // never the pick, and the API is still not asked: one option would be an irreversible question
    expect(state(host)).not.toBe('ready');
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(server.count('GET', '/v1/me')).toBe(0);

    await click(button(host, en.signIn.done.retryWallet));
    expect(ensureWallets).toHaveBeenCalledTimes(1);
    await click(button(host, en.shell.signOut));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('says it again, as an alert, when making it fails once more', async () => {
    api(made());
    const ensureWallets = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(toWalletError(new Error('the wallet could not be made')));
    portStore.set(owed('failed', { ensureWallets }));
    const host = await screen();
    await settle();
    expect(alert(host)).toBeNull();
    await click(button(host, en.signIn.done.retryWallet));
    await settle();
    expect(alert(host)).toBe(en.signIn.failure.walletNotMade);
  });

  it('starts on a chain once both are there', async () => {
    const server = api(made());
    portStore.set(owed('making'));
    const host = await screen();
    await settle();
    expect(state(host)).not.toBe('ready');
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await settle();
    expect(state(host)).toBe('ready');
    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
  });
});

describe('one person after another in the same browser', () => {
  it('does not show the first person’s chain to the second while theirs is being read', async () => {
    const first = made({ chain: 'solana', chainSource: 'picked', chainOptions: [] });
    const server = api(first);
    portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:first' }));
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.chain.is.picked('Solana'));

    // the first signs out and a second person signs in: the API is slow to say who they are
    let answer: (res: Response) => void = () => {};
    server.force((path) =>
      path === '/v1/me' ? (new Promise<Response>((resolve) => (answer = resolve)) as never) : null,
    );
    portStore.set(fakePort({ found: FOUND }));
    await settle();
    portStore.set(signedInPort(METAMASK, { userId: 'did:privy:second' }));
    await settle();
    expect(state(host)).toBe('loading');
    expect(host.textContent).not.toContain('Solana');
    expect(host.textContent).toContain(en.chain.reading);

    answer(json(connected(METAMASK, 'robinhood')));
    await settle();
    expect(state(host)).toBe('ready');
    expect(host.textContent).toContain(en.chain.is.wallet('Robinhood Chain'));
    expect(host.textContent).not.toContain(SOLANA);
  });

  it('does not let a late answer about the first person’s chain stand in for the second', async () => {
    const server = api(made());
    // the first person's chain is on its way to the API
    let stored: (res: Response) => void = () => {};
    server.force((path) =>
      path === '/v1/me/chain'
        ? (new Promise<Response>((resolve) => (stored = resolve)) as never)
        : null,
    );
    portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:first' }));
    const host = await screen();
    await settle();
    expect(server.count('PUT', '/v1/me/chain')).toBe(1);
    // a second person signs in before it answers
    server.store(connected(METAMASK, 'robinhood'));
    await act(async () => portStore.set(signedInPort(METAMASK, { userId: 'did:privy:second' })));
    await settle();
    expect(host.textContent).toContain(en.chain.is.wallet('Robinhood Chain'));
    // the first person's answer arrives now: it is not the second person's
    await act(async () => stored(json(made({ chain: 'solana', chainSource: 'picked' }))));
    await settle();
    expect(state(host)).toBe('ready');
    expect(host.textContent).toContain(en.chain.is.wallet('Robinhood Chain'));
    expect(host.textContent).not.toContain(en.chain.is.picked('Solana'));
  });
});

describe('what this browser kept for a person', () => {
  afterEach(() => window.sessionStorage.clear());

  it('is forgotten when they sign out, on whatever page they do it', async () => {
    api(connected());
    portStore.set(signedInPort(PHANTOM));
    await screen();
    await settle();
    // the plans this browser kept for them: the server has them for the next sign-in
    window.localStorage.setItem('tf-plan:some-plan', '{}');
    window.localStorage.setItem('tf-plans', '["some-plan"]');
    // their order records go too; another person's stay, and so does the trust acceptance
    const me = signedInPort(PHANTOM).userId as string;
    const order = (userId: string) =>
      JSON.stringify({
        orderId: 'o',
        userId,
        proposalId: 'p',
        chain: 'solana',
        amountUsd: 10,
        lines: [],
        approved: null,
      });
    window.localStorage.setItem('tf-order:mine', order(me).replace('"o"', '"mine"'));
    window.localStorage.setItem(
      'tf-order:theirs',
      order('someone-else').replace('"o"', '"theirs"'),
    );
    window.localStorage.setItem(`tf-trust:${me}`, '{"textVersion":"x"}');
    // and their private vault conversations; another person's stay
    const talk = (userId: string) =>
      `tf-vault-conversation:2:${encodeURIComponent(userId)}:solana:testnet:vault-1:sandbox`;
    window.localStorage.setItem(talk(me), '{"revision":0,"transcript":[]}');
    window.localStorage.setItem(talk('someone-else'), '{"revision":0,"transcript":[]}');
    await act(async () => portStore.set(fakePort({ found: FOUND })));
    await settle();
    expect(window.localStorage.getItem('tf-plan:some-plan')).toBeNull();
    expect(window.localStorage.getItem('tf-plans')).toBeNull();
    expect(window.localStorage.getItem('tf-order:mine')).toBeNull();
    expect(window.localStorage.getItem('tf-order:theirs')).not.toBeNull();
    expect(window.localStorage.getItem(`tf-trust:${me}`)).not.toBeNull();
    expect(window.localStorage.getItem(talk(me))).toBeNull();
    expect(window.localStorage.getItem(talk('someone-else'))).not.toBeNull();
    window.localStorage.clear();
  });

  it('keeps the words handed from the landing when someone signed out goes on to sign in', async () => {
    const words = 'Grow $40,000 for an apartment';
    window.sessionStorage.setItem(GOAL_HANDOFF, words);
    api(connected());
    portStore.set(fakePort({ found: FOUND, signIn: signsInAs(PHANTOM) }));
    const host = await screen('en', '/goal');
    await connectWith(host, 'Phantom');
    await settle();
    expect(state(host)).toBe('ready');
    expect(window.sessionStorage.getItem(GOAL_HANDOFF)).toBe(words);
  });
});

describe('the screen itself', () => {
  it('shows the two ways in to someone signed out, under one heading', async () => {
    api(made());
    const host = await screen();
    expect(find(host, 'h1').textContent).toBe(en.signIn.title);
    expect(host.textContent).toContain(en.signIn.lead);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(find(host, '[data-ui="sign-in"]').getAttribute('data-state')).toBe('ready');
    // one heading, one sentence, then the choices (Thom, Oct 9)
    const head = find(host, '[data-ui="sign-in-screen"] > header');
    expect(head.querySelectorAll('p')).toHaveLength(1);
    expect(en.signIn.lead.split('. ')).toHaveLength(1);
    expect(head.nextElementSibling?.nextElementSibling).toBe(find(host, '[data-ui="sign-in"]'));
  });

  it('takes someone new on from "Create a passkey": one made, the wallet read, then where they were headed', async () => {
    const server = api(made());
    const signIn = signsInAs(EMBEDDED);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    await click(find(host, '[data-act="passkey-create"]'));
    await settle();
    expect(signIn.mock.calls).toEqual([['passkey', { create: true }]]);
    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
    expect(state(host)).toBe('ready');
    expect(router.replace).toHaveBeenCalledWith('/goal');
  });

  it('says a wallet is being made while the port loads after a passkey sign-in', async () => {
    api(made());
    const signIn = vi.fn(async () => {
      portStore.set(fakePort({ status: 'loading' }));
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, en.signIn.passkey.continue));
    await settle();
    expect(find(host, '[data-ui="lattice-status"]').textContent).toBe(en.signIn.passkey.making);
    portStore.set(signedInPort(EMBEDDED));
    await settle();
    expect(state(host)).toBe('ready');
  });

  it('goes on only to a page of this app', async () => {
    api(connected());
    const signIn = signsInAs(PHANTOM);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    await connectWith(host, 'Phantom');
    await settle();
    expect(router.replace.mock.calls).toEqual([['/goal']]);
  });
});

describe('where focus goes, and what a screen reader is told, when the screen changes', () => {
  const said = (host: HTMLElement) => find(host, '[data-ui="sign-in-said"]').textContent;
  const stage = (host: HTMLElement) => find(host, '[data-ui="sign-in-stage"]');
  const heading = (host: HTMLElement) => find(host, 'h1');
  /** Presses it as a person does: it has focus first. */
  const pressing = async (el: HTMLElement) => {
    el.focus();
    await click(el);
    await settle();
  };

  it('goes to where new plans are built after a sign-in, and says it', async () => {
    api(made());
    portStore.set(fakePort({ found: FOUND, signIn: signsInAs(EMBEDDED) }));
    const host = await screen('en', '/goal');
    await pressing(button(host, en.signIn.passkey.continue));
    expect(state(host)).toBe('ready');
    // the button that was pressed is gone: focus is on what took its place, not on the page
    expect(document.activeElement).toBe(stage(host));
    expect(document.activeElement).not.toBe(document.body);
    expect(stage(host).textContent).toContain(en.chain.is.picked('Solana'));
    expect(said(host)).toBe(en.chain.is.picked('Solana'));
  });

  it('rests on the heading while the wallet is made, then goes to where new plans are built', async () => {
    api(made());
    const signIn = vi.fn(async () => {
      portStore.set(
        fakePort({ status: 'loading', userId: 'did:privy:test', walletsOwed: 'making' }),
      );
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await pressing(button(host, en.signIn.passkey.continue));
    expect(document.activeElement).toBe(heading(host));
    expect(heading(host).textContent).toBe(en.signIn.done.title);
    expect(said(host)).toBe(`${en.signIn.done.title} ${en.signIn.passkey.making}`);
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await settle();
    expect(state(host)).toBe('ready');
    expect(document.activeElement).toBe(stage(host));
    expect(said(host)).toBe(en.chain.is.picked('Solana'));
  });

  it('goes to what the answer brought after "Ask again"', async () => {
    const server = api(made());
    server.force((path) => (path === '/v1/me' ? json({}, 503) : null));
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    server.force(null);
    await pressing(button(host, en.chain.unknown.retry));
    expect(state(host)).toBe('ready');
    expect(document.activeElement).toBe(stage(host));
    expect(said(host)).toBe(en.chain.is.picked('Solana'));
  });

  it('goes to the heading after signing out from the screen, and says the person is out', async () => {
    api(made());
    const signOut = vi.fn(async () => {
      portStore.set(fakePort({ found: FOUND }));
    });
    portStore.set(
      fakePort({ status: 'loading', userId: 'did:privy:test', walletsOwed: 'failed', signOut }),
    );
    const host = await screen();
    await settle();
    await pressing(button(host, en.shell.signOut));
    expect(heading(host).textContent).toBe(en.signIn.title);
    expect(document.activeElement).toBe(heading(host));
    expect(said(host)).toBe(en.shell.signedOut);
  });

  it('says so when signing out from the screen did not work, and leaves the person where they were', async () => {
    api(made());
    const signOut = vi.fn(async () => {
      throw toWalletError(new Error('Failed to fetch'));
    });
    portStore.set(
      fakePort({ status: 'loading', userId: 'did:privy:test', walletsOwed: 'failed', signOut }),
    );
    const host = await screen();
    await settle();
    await pressing(button(host, en.shell.signOut));
    expect(alert(host)).toBe(en.shell.signOutFailed);
    expect(state(host)).toBe('no-wallet');
  });

  it('moves no focus when the page only loads: nobody pressed anything', async () => {
    api(made());
    portStore.set(fakePort({ status: 'loading' }));
    const host = await screen();
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await settle();
    expect(state(host)).toBe('ready');
    expect(document.activeElement).toBe(document.body);
    expect(said(host)).toBe('');
  });
});

describe('the throwaway wallet of development', () => {
  it('keeps its chain in the page, stores nothing on the API, and says sample with its hatch', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED, { test: true }, 'mock'));
    const host = await screen();
    await settle();
    expect(state(host)).toBe('ready');
    expect(host.textContent).toContain(en.chain.is.picked('Solana'));
    expect(server.calls).toEqual([]);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    expect(host.querySelectorAll('[data-ui="sample-note"]').length).toBeGreaterThan(0);
  });

  it('says that it is sample in Portuguese on a Portuguese page', async () => {
    api(made());
    portStore.set(signedInPort(EMBEDDED, { test: true }, 'mock'));
    const pt = dictionary('pt');
    const host = await screen('pt');
    await settle();
    // the card that says where new plans are built, marked sample
    expect(host.querySelectorAll('[data-ui="sample-note"]').length).toBeGreaterThan(0);
    for (const line of host.querySelectorAll('[data-ui="sample-note"]'))
      expect(line.textContent?.startsWith(pt.shell.mockAnnounce)).toBe(true);
    for (const glyph of host.querySelectorAll('[data-ui="sample-glyph"][aria-label]'))
      expect(glyph.getAttribute('aria-label')).toBe(pt.shell.sampleFigure);
    expect(host.textContent).not.toContain('Sample figures');
  });

  it('says in words beside its name that a chain is a test network, or the sample chain, with no hatched glyph', async () => {
    for (const [provenance, words] of [
      ['sandbox', en.shell.testNetworkLine],
      ['mock', en.shell.sample],
    ] as const) {
      api(connected());
      portStore.set(signedInPort(PHANTOM, {}, provenance));
      const host = await screen();
      await settle();
      const name = find(host, '[data-ui="chain-name"]');
      expect(name.textContent).toContain('Solana');
      // the chain is named and no figure is beside it: words, and the chain's own logo (Thom, Oct 9)
      expect(name.querySelectorAll('[data-ui="sample-glyph"]')).toHaveLength(0);
      expect(find(name, '[data-ui="chain-how"]').textContent).toBe(words);
      expect(find(name, '[data-ui="chain-logo"]').getAttribute('alt')).toBe('');
      expect(name.textContent).not.toContain('MOCK');
      expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
      await unmountAll();
    }
    // a live chain carries no mark
    api(connected());
    portStore.set(signedInPort(PHANTOM, {}, 'live'));
    const live = await screen();
    await settle();
    expect(live.querySelectorAll('.tf-mock-plate, .tf-hatch')).toHaveLength(0);
    expect(live.querySelector('[data-ui="chain-how"]')).toBeNull();
  });
});

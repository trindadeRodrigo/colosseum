// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
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

// Sign-in as a screen, and the one question it asks (gate CHAIN-PICK): a person who made their wallet
// here chooses the chain their plan lives on, once; a person who connected a wallet is never asked.
// The API stores the choice. Here it is a double with the shapes of GET /v1/me and PUT /v1/me/chain.

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
      if (person.chain && person.chain !== chain) return json({ error: 'picked once' }, 409);
      if (!person.chain && !person.chainOptions.includes(chain))
        return json({ error: 'not a chain you can pick' }, 422);
      person = { ...person, chain, chainSource: person.chainSource ?? 'picked', chainOptions: [] };
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
  chainOptions: [],
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
const asks = (host: HTMLElement) => host.textContent?.includes(en.chain.pick.title) ?? false;
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
});
afterEach(unmountAll);

describe('a person who creates a wallet in the app', () => {
  it('is asked once for the chain, told what it means, and lands where they were headed', async () => {
    const server = api(made());
    const signIn = signsInAs(EMBEDDED);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    expect(asks(host)).toBe(false);

    await click(button(host, en.signIn.passkey.create));
    await settle();
    expect(signIn).toHaveBeenCalledWith('passkey', { create: true });
    expect(asks(host)).toBe(true);
    // what the choice means, and that it stands
    expect(host.textContent).toContain(`${en.chain.pick.asked.made} ${en.chain.pick.body}`);
    expect(host.textContent).toContain(en.chain.pick.warning);
    // the two chains, as toggle buttons in a named group, each with the wallet the plan would use
    const group = find(host, '[role="group"]');
    expect(group.getAttribute('aria-label')).toBe(en.chain.pick.group);
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Solana',
      'Robinhood Chain',
    ]);
    expect(group.textContent).toContain('So11…1112');
    expect(group.textContent).toContain('0x20…0498');
    // nothing is stored, and nobody is moved on, before the person chooses
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
    expect(router.replace).not.toHaveBeenCalled();

    await click(button(host, 'Solana'));
    expect(button(host, 'Solana').getAttribute('aria-pressed')).toBe('true');
    expect(button(host, 'Robinhood Chain').getAttribute('aria-pressed')).toBe('false');
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();

    expect(server.calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/v1/me/chain', body: { chain: 'solana' } },
    ]);
    expect(asks(host)).toBe(false);
    expect(state(host)).toBe('ready');
    expect(router.replace).toHaveBeenCalledWith('/goal');
  });

  it('is not asked again: not on a later visit, and not on a second device', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED));
    const first = await screen();
    await settle();
    expect(asks(first)).toBe(true);
    await click(button(first, 'Robinhood Chain'));
    await click(button(first, en.chain.pick.confirm('Robinhood Chain')));
    await settle();
    expect(asks(first)).toBe(false);
    await unmountAll();

    // the same person, a new page: the API says where the plan lives
    for (const visit of ['a later visit', 'a second device']) {
      const again = await screen();
      await settle();
      expect(asks(again), visit).toBe(false);
      expect(state(again), visit).toBe('ready');
      expect(again.textContent).toContain(en.chain.is.picked('Robinhood Chain'));
      await unmountAll();
    }
    expect(server.count('PUT', '/v1/me/chain')).toBe(1);
    expect(server.stored().chain).toBe('robinhood');
  });

  it('shows and uses the wallet of the chosen chain alone', async () => {
    api(made({ chain: 'solana', chainSource: 'picked', chainOptions: [] }));
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

  it('cannot confirm before choosing, and is told why', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    const confirm = button(host, en.chain.pick.confirmNone);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    const why = document.getElementById(confirm.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toBe(en.chain.pick.why);
    await click(confirm);
    await settle();
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
    expect(asks(host)).toBe(true);
  });

  it('is asked even when there is one chain to choose: the choice cannot be undone', async () => {
    const solanaOnly = EMBEDDED.filter((w) => w.family === 'solana');
    const server = api(made({ wallets: solanaOnly, chainOptions: ['solana'] }));
    portStore.set(signedInPort(solanaOnly));
    const host = await screen();
    await settle();
    expect([...find(host, '[role="group"]').querySelectorAll('button')]).toHaveLength(1);
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
  });

  it('is told, in Portuguese too, what the choice means', async () => {
    api(made());
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen('pt');
    await settle();
    const pt = dictionary('pt').chain.pick;
    for (const sentence of [pt.title, pt.asked.made, pt.body, pt.warning, pt.confirmNone])
      expect(host.textContent).toContain(sentence);
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
  ] as const)('is never asked: %s', async (_, name, accounts, chain, chainName) => {
    const server = api(connected(accounts, chain));
    const signIn = signsInAs(accounts);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    const seen: boolean[] = [asks(host)];
    await click(button(host, name));
    seen.push(asks(host));
    await settle();
    seen.push(asks(host));
    expect(seen).toEqual([false, false, false]);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(signIn).toHaveBeenCalledWith('wallet', {
      wallet: FOUND.find((w) => w.name === name)?.id,
    });
    expect(host.textContent).toContain(en.chain.is.wallet(chainName));
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
    expect(router.replace).toHaveBeenCalledWith('/goal');
  });

  it('is asked with wallets of both families linked, and is not told they made a wallet here', async () => {
    const both = [...PHANTOM, ...METAMASK];
    const server = api({ ...made({ wallets: both }), chainOptions: ['solana', 'robinhood'] });
    portStore.set(signedInPort(both));
    const host = await screen();
    await settle();
    expect(asks(host)).toBe(true);
    expect(host.textContent).toContain(`${en.chain.pick.asked.connected} ${en.chain.pick.body}`);
    expect(host.textContent).not.toContain(en.chain.pick.asked.made);
    await click(button(host, 'Robinhood Chain'));
    await click(button(host, en.chain.pick.confirm('Robinhood Chain')));
    await settle();
    expect(server.stored().chain).toBe('robinhood');
    expect(host.textContent).toContain(en.chain.is.picked('Robinhood Chain'));
    expect(host.textContent).not.toContain(SOLANA);
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

  it('is not offered, and the screen says why it is not there', async () => {
    const server = api(made());
    portStore.set(withOff('robinhood'));
    const host = await screen();
    await settle();
    expect(asks(host)).toBe(true);
    expect(
      [...find(host, '[role="group"]').querySelectorAll('button')].map((b) => b.textContent),
    ).toEqual(['Solana']);
    expect(find(host, '[data-ui="chain-off"]').textContent).toBe(
      en.chain.pick.off('Robinhood Chain'),
    );
    await click(button(host, 'Solana'));
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(server.stored().chain).toBe('solana');
  });

  it('leaves nothing to choose when every chain is off, and says so', async () => {
    const server = api(made());
    portStore.set(withOff('solana', 'robinhood'));
    const host = await screen();
    await settle();
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="chain-off"]')).toHaveLength(2);
    expect(host.textContent).toContain(en.chain.pick.noneOn);
    expect(host.textContent).not.toContain(en.chain.pick.confirmNone);
    expect(server.count('PUT', '/v1/me/chain')).toBe(0);
  });
});

describe('when the choice cannot be stored', () => {
  const choosing = async (server: ReturnType<typeof api>) => {
    portStore.set(signedInPort(EMBEDDED));
    const host = await screen();
    await settle();
    await click(button(host, 'Solana'));
    return { host, server };
  };

  it('says the server did not answer, keeps the choice, and stores nothing', async () => {
    const { host, server } = await choosing(api(made()));
    server.force((path) => (path === '/v1/me/chain' ? json({}, 503) : null));
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(alert(host)).toBe(en.chain.failure.unreachable);
    expect(asks(host)).toBe(true);
    expect(button(host, 'Solana').getAttribute('aria-pressed')).toBe('true');
    expect(server.stored().chain).toBeNull();
    // and it works when the server answers again
    server.force(null);
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(asks(host)).toBe(false);
    expect(server.stored().chain).toBe('solana');
  });

  it('says the plan already lives elsewhere when another device chose first, and shows where', async () => {
    const { host, server } = await choosing(api(made()));
    server.store(made({ chain: 'robinhood', chainSource: 'picked', chainOptions: [] }));
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    // the API refused (409); the person is read again, and the page says where the plan does live:
    // the stored chain, not the one just tried
    expect(server.count('GET', '/v1/me')).toBe(2);
    expect(asks(host)).toBe(false);
    expect(alert(host)).toBe(en.chain.failure.taken('Robinhood Chain', 'Solana'));
    expect(alert(host)).not.toContain('lives on Solana');
    expect(server.stored().chain).toBe('robinhood');
    // only the wallet of the chain the plan lives on, and the way on is the person's to take
    expect(host.textContent).toContain(EVM);
    expect(host.textContent).not.toContain(SOLANA);
    expect(button(host, en.signIn.done.next).getAttribute('href')).toBe('/goal');
  });

  it('does not move that person on by itself: they read why their choice was not kept', async () => {
    const server = api(made());
    const signIn = signsInAs(EMBEDDED);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    await click(button(host, en.signIn.passkey.create));
    await settle();
    await click(button(host, 'Solana'));
    server.store(made({ chain: 'robinhood', chainSource: 'picked', chainOptions: [] }));
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(state(host)).toBe('ready');
    expect(alert(host)).toBe(en.chain.failure.taken('Robinhood Chain', 'Solana'));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('says the choice was not kept even when the server cannot say which chain was', async () => {
    const { host, server } = await choosing(api(made()));
    server.force((path, init) =>
      path === '/v1/me/chain'
        ? json({ error: 'picked once' }, 409)
        : path === '/v1/me' && (init?.method ?? 'GET') === 'GET'
          ? json({}, 503)
          : null,
    );
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(state(host)).toBe('unknown');
    expect(alert(host)).toBe(en.chain.failure.takenUnknown('Solana'));
    expect(host.textContent).toContain(en.chain.unknown.body);
  });

  it('has a sentence for a chain that is not offered, a sign-in that ran out and a server that is busy', async () => {
    for (const [status, sentence] of [
      [422, en.chain.failure.notOffered],
      [401, en.chain.failure.signedOut],
      [429, en.shell.slowDown],
    ] as const) {
      const { host, server } = await choosing(api(made()));
      server.force((path) => (path === '/v1/me/chain' ? json({ error: 'no' }, status) : null));
      await click(button(host, en.chain.pick.confirm('Solana')));
      await settle();
      expect(alert(host), String(status)).toBe(sentence);
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
    expect(asks(host)).toBe(false);
    expect(host.textContent).toContain(en.chain.unknown.body);
    server.force(null);
    await click(button(host, en.chain.unknown.retry));
    await settle();
    expect(server.count('GET', '/v1/me')).toBe(2);
    expect(asks(host)).toBe(true);
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
    expect(asks(host)).toBe(true);
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
    expect(asks(host)).toBe(true);
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
    expect(asks(host)).toBe(false);
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
    expect(asks(host)).toBe(false);
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

  it('asks for the chain once both are there', async () => {
    api(made());
    portStore.set(owed('making'));
    const host = await screen();
    await settle();
    expect(asks(host)).toBe(false);
    await act(async () => portStore.set(signedInPort(EMBEDDED)));
    await settle();
    expect(asks(host)).toBe(true);
    expect([...find(host, '[role="group"]').querySelectorAll('button')]).toHaveLength(2);
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

  it('does not let a late answer about the first person’s choice stand in for the second', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:first' }));
    const host = await screen();
    await settle();
    // the first person's choice is on its way to the API
    let stored: (res: Response) => void = () => {};
    server.force((path) =>
      path === '/v1/me/chain'
        ? (new Promise<Response>((resolve) => (stored = resolve)) as never)
        : null,
    );
    await click(button(host, 'Solana'));
    await click(button(host, en.chain.pick.confirm('Solana')));
    // a second person signs in before it answers
    server.store(connected(METAMASK, 'robinhood'));
    await act(async () => portStore.set(signedInPort(METAMASK, { userId: 'did:privy:second' })));
    await settle();
    expect(host.textContent).toContain(en.chain.is.wallet('Robinhood Chain'));
    // the first person's answer arrives now: it is not the second person's
    await act(async () =>
      stored(json(made({ chain: 'solana', chainSource: 'picked', chainOptions: [] }))),
    );
    await settle();
    expect(state(host)).toBe('ready');
    expect(host.textContent).toContain(en.chain.is.wallet('Robinhood Chain'));
    expect(host.textContent).not.toContain(en.chain.is.picked('Solana'));
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
  });

  it('says a wallet is being made while the port loads after a passkey sign-in', async () => {
    api(made());
    const signIn = vi.fn(async () => {
      portStore.set(fakePort({ status: 'loading' }));
    });
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen();
    await click(button(host, en.signIn.passkey.create));
    await settle();
    expect(find(host, '[role="status"]').textContent).toBe(en.signIn.passkey.making);
    portStore.set(signedInPort(EMBEDDED));
    await settle();
    expect(asks(host)).toBe(true);
  });

  it('goes on only to a page of this app', async () => {
    api(connected());
    const signIn = signsInAs(PHANTOM);
    portStore.set(fakePort({ found: FOUND, signIn }));
    const host = await screen('en', '/goal');
    await click(button(host, 'Phantom'));
    await settle();
    expect(router.replace.mock.calls).toEqual([['/goal']]);
  });
});

describe('the throwaway wallet of development', () => {
  it('keeps its choice in the page, stores nothing on the API, and says MOCK with its hatch', async () => {
    const server = api(made());
    portStore.set(signedInPort(EMBEDDED, { test: true }, 'mock'));
    const host = await screen();
    await settle();
    expect(asks(host)).toBe(true);
    expect(host.textContent).toContain(en.chain.pick.mock);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    expect(host.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
    await click(button(host, 'Solana'));
    await click(button(host, en.chain.pick.confirm('Solana')));
    await settle();
    expect(state(host)).toBe('ready');
    expect(server.calls).toEqual([]);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    expect(host.querySelectorAll('.tf-mock-plate').length).toBeGreaterThan(0);
  });

  it('says the words a screen reader hears after MOCK in Portuguese on a Portuguese page', async () => {
    api(made());
    portStore.set(signedInPort(EMBEDDED, { test: true }, 'mock'));
    const pt = dictionary('pt');
    const host = await screen('pt');
    await settle();
    // the pick
    expect(find(host, '.tf-mock-plate').textContent).toBe(`MOCK${pt.shell.mockAnnounce}`);
    await click(button(host, 'Solana'));
    await click(button(host, pt.chain.pick.confirm('Solana')));
    await settle();
    // and the card that says where the plan lives
    for (const plate of host.querySelectorAll('.tf-mock-plate'))
      expect(plate.textContent).toBe(`MOCK${pt.shell.mockAnnounce}`);
    expect(host.textContent).not.toContain('sample data');
  });

  it('marks a chain on a test network, and one the API runs on the mock, beside its name', async () => {
    for (const [provenance, words] of [
      ['sandbox', true],
      ['mock', false],
    ] as const) {
      api(connected());
      portStore.set(signedInPort(PHANTOM, {}, provenance));
      const host = await screen();
      await settle();
      const name = find(host, '[data-ui="chain-name"]');
      expect(name.textContent).toContain('Solana');
      expect(name.querySelectorAll('.tf-mock-plate')).toHaveLength(1);
      expect(name.textContent?.includes(en.shell.testNetwork)).toBe(words);
      expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
      await unmountAll();
    }
    // a live chain carries no mark
    api(connected());
    portStore.set(signedInPort(PHANTOM, {}, 'live'));
    const live = await screen();
    await settle();
    expect(live.querySelectorAll('.tf-mock-plate, .tf-hatch')).toHaveLength(0);
  });
});

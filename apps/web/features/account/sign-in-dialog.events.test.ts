// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { toWalletError } from '../wallet/errors';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location, router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import type { Person } from './person';
import { inShellWithSignIn } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Sign-in as a dialog over the page (SIGN-IN-FLOW): any link to /sign-in opens it, it holds the same
// panel, it is a modal a keyboard and a screen reader can use, and once the person is signed in and
// their chain known it closes, leaving them where they were, or taking them on to where the action
// that asked for sign-in leads.

const en = dictionary('en');

let person: Person = {
  userId: 'did:privy:test',
  wallets: EMBEDDED,
  chain: null,
  chainSource: null,
  chainOptions: ['solana', 'robinhood'],
};

/** A page with the action that asks for sign-in, as the guarded screens draw it. */
const page = () =>
  createElement('a', { href: '/sign-in?next=/orders/o1', 'data-ui': 'page-action' }, 'Buy');

const shell = () => mount(inShellWithSignIn('en', 'auto', page()));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (root: ParentNode, label: string) => {
  const found = [...root.querySelectorAll<HTMLElement>('button')].filter((b) =>
    b.textContent?.includes(label),
  );
  if (found.length !== 1) throw new Error(`expected one "${label}", found ${found.length}`);
  return found[0] as HTMLElement;
};

beforeEach(() => {
  window.localStorage.removeItem('tf-passkey');
  // a prompt is open for a person's time before it answers
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 1_000;
    return now;
  });
  location.pathname = '/goal';
  router.push.mockClear();
  router.replace.mockClear();
  person = { ...person, chain: null, chainSource: null, chainOptions: ['solana', 'robinhood'] };
  portStore.setApi(async (path, init) => {
    if (path === '/v1/me' && (init?.method ?? 'GET') === 'GET') return json(person);
    if (path === '/v1/me/chain') {
      const { chain } = JSON.parse(String(init?.body));
      person = { ...person, chain, chainSource: 'picked', chainOptions: [] };
      return json(person);
    }
    return json({ error: 'not found' }, 404);
  });
  portStore.set(
    fakePort({
      signIn: vi.fn(async () => {
        portStore.set(signedInPort(EMBEDDED));
      }),
    }),
  );
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  document.documentElement.style.overflow = '';
});

describe('the sign-in dialog', () => {
  it('opens over the page from the bar’s "Sign in", as a modal named by its title', async () => {
    const host = await shell();
    const trigger = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    trigger.focus();
    await click(trigger);
    const box = dialog();
    expect(box).not.toBeNull();
    expect(box?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(en.signIn.title);
    // the same panel: the passkey pair, the wallets, and the disclaimer
    expect(button(box as HTMLElement, en.signIn.passkey.create)).toBeTruthy();
    expect(button(box as HTMLElement, en.signIn.passkey.continue)).toBeTruthy();
    expect(box?.querySelector('[data-ui="wallet-other"]')).not.toBeNull();
    expect(box?.querySelector('[data-ui="disclaimer"]')).not.toBeNull();
    // the page stays: no navigation, and nothing behind can be reached or scrolled
    expect(router.push).not.toHaveBeenCalled();
    expect(find(host, '[data-ui="app-shell"]').closest('[inert]')).not.toBeNull();
    expect(box?.closest('[inert]')).toBeNull();
    expect(document.documentElement.style.overflow).toBe('hidden');
    // the page keeps its scrollbar's room, so nothing behind shifts sideways
    expect(document.documentElement.style.scrollbarGutter).toBe('stable');
    // focus is in the dialog, on its heading: never on a way in. The keys then go new, returning,
    // the wallets, and "Close" last, though it is drawn at the top
    expect(document.activeElement).toBe(title);
    const order = [...(box as HTMLElement).querySelectorAll('button')].map(
      (b) => b.getAttribute('data-act') ?? b.getAttribute('aria-label'),
    );
    expect(order).toEqual(['passkey-create', 'passkey-continue', en.signIn.close]);
  });

  it.each([
    ['nothing is known about this browser', false],
    ['a passkey has signed in here before, and "Use my passkey" leads', true],
  ])(
    'starts nothing on Enter when it opens: no passkey is made or used, when %s',
    async (_, seen) => {
      if (seen) window.localStorage.setItem('tf-passkey', '1');
      const signIn = vi.fn(async () => {});
      portStore.set(fakePort({ signIn }));
      const host = await shell();
      const trigger = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
      trigger.focus();
      await click(trigger);
      const box = dialog() as HTMLElement;
      expect(find(box, '[data-ui="passkey-pair"]').getAttribute('data-leads')).toBe(
        seen ? 'continue' : 'neither',
      );
      // focus rests on the heading, which does nothing: not on "Create a passkey", the first button
      const focused = document.activeElement as HTMLElement;
      expect(focused.tagName).toBe('H2');
      expect(focused.id).toBe(box.getAttribute('aria-labelledby'));
      expect(focused).not.toBe(find(box, '[data-act="passkey-create"]'));
      for (const type of ['keydown', 'keyup'] as const)
        await fire(
          focused,
          new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true }),
        );
      // an Enter that reached a button would have clicked it
      if (focused instanceof HTMLButtonElement) await click(focused);
      expect(signIn).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      // back from the heading is the last control, inside the dialog
      await press(focused, 'Tab', { shiftKey: true });
      expect(document.activeElement).toBe(find(box, `button[aria-label="${en.signIn.close}"]`));
    },
  );

  it('closes with Escape, the scrim and its close button, and gives focus back to what opened it', async () => {
    const host = await shell();
    const trigger = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    for (const close of ['escape', 'scrim', 'button'] as const) {
      trigger.focus();
      await click(trigger);
      const box = dialog() as HTMLElement;
      if (close === 'escape') await press(box, 'Escape');
      else if (close === 'scrim')
        await click(document.querySelector('[data-ui="sign-in-scrim"]') as Element);
      else await click(find(box, `button[aria-label="${en.signIn.close}"]`));
      expect(dialog(), close).toBeNull();
      expect(document.activeElement, close).toBe(trigger);
      expect(find(host, '[data-ui="app-shell"]').closest('[inert]'), close).toBeNull();
      expect(document.documentElement.style.overflow, close).toBe('');
    }
  });

  it('keeps Tab inside it, going round from the last control to the first and back', async () => {
    const host = await shell();
    await click(find(host, 'header a[href^="/sign-in"]'));
    const box = dialog() as HTMLElement;
    const controls = [...box.querySelectorAll<HTMLElement>('button, a[href]')];
    const [first, last] = [
      controls[0] as HTMLElement,
      controls[controls.length - 1] as HTMLElement,
    ];
    last.focus();
    await press(last, 'Tab');
    expect(document.activeElement).toBe(first);
    await press(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes once the person is signed in and their chain known, and the action carries on', async () => {
    const host = await shell();
    const action = find<HTMLAnchorElement>(host, '[data-ui="page-action"]');
    await click(action);
    const box = dialog() as HTMLElement;
    await click(button(box, en.signIn.passkey.continue));
    await settle();
    // a wallet made here: nothing is asked, the chain they were looking at is stored (CHAIN-SWITCH)
    expect(dialog()).toBeNull();
    // on to the order the action was for
    expect(router.push.mock.calls).toEqual([['/orders/o1']]);
  });

  it('leaves the person on the page when the sign-in was asked for by the bar', async () => {
    person = { ...person, chain: 'solana', chainSource: 'picked', chainOptions: [] };
    const host = await shell();
    await click(find(host, 'header a[href^="/sign-in"]'));
    await click(button(dialog() as HTMLElement, en.signIn.passkey.continue));
    await settle();
    expect(dialog()).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    // the bar is theirs with no reload: the chip in place of "Sign in", and focus on it, since what
    // opened the dialog is gone
    expect(host.querySelector('header a[href^="/sign-in"]')).toBeNull();
    const chip = find(host, '[data-ui="account-menu-button"]');
    expect(chip.hasAttribute('data-ready')).toBe(true);
    expect(document.activeElement).toBe(chip);
  });

  it('leaves "Sign in" usable after a sign-in that was cancelled, with a plain line saying so', async () => {
    const closed = toWalletError(
      Object.assign(new Error('Passkey request timed out or rejected by user.'), {
        privyErrorCode: 'passkey_not_allowed',
      }),
    );
    let fails = true;
    portStore.set(
      fakePort({
        signIn: vi.fn(async () => {
          if (fails) throw closed;
          portStore.set(signedInPort(EMBEDDED));
        }),
      }),
    );
    person = { ...person, chain: 'solana', chainSource: 'picked', chainOptions: [] };
    const host = await shell();
    const way = find<HTMLAnchorElement>(host, 'header a[href^="/sign-in"]');
    await click(way);
    await click(button(dialog() as HTMLElement, en.signIn.passkey.continue));
    await settle();
    // what happened, in the dialog, which stays: a calm line, not an error; nobody is signed in
    expect(find(dialog() as HTMLElement, '[data-ui="sign-in-note"]').textContent).toBe(
      en.signIn.failure.passkeyNotUsed,
    );
    expect((dialog() as HTMLElement).querySelector('[role="alert"]')).toBeNull();
    expect(find(host, '[data-ui="account-control"]').getAttribute('data-state')).toBe('signed-out');
    // closed, the bar's button is the same one, with focus back on it, and it works again
    await press(dialog() as HTMLElement, 'Escape');
    expect(find(host, 'header a[href^="/sign-in"]')).toBe(way);
    expect(document.activeElement).toBe(way);
    fails = false;
    await click(way);
    await click(button(dialog() as HTMLElement, en.signIn.passkey.continue));
    await settle();
    expect(dialog()).toBeNull();
    expect(find(host, '[data-ui="account-menu-button"]').hasAttribute('data-ready')).toBe(true);
  });

  it('closes with Escape after the chain question replaced the wallet list, focus on the question', async () => {
    portStore.set(
      fakePort({
        found: [
          { id: 'test:solana', name: 'Throwaway wallet', family: 'solana' },
          { id: 'test:evm', name: 'Throwaway wallet', family: 'evm' },
        ],
      }),
    );
    const host = await shell();
    await click(find(host, 'header a[href^="/sign-in"]'));
    const box = dialog() as HTMLElement;
    await click(button(box, 'Throwaway wallet'));
    // the wallet pressed is gone: focus is on the question that took its place, not on the page
    const chains = find(box, '[data-ui="wallet-chains"]');
    expect(document.activeElement).toBe(chains);
    // and Escape closes the dialog even from <body>
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await press(document.body, 'Escape');
    expect(dialog()).toBeNull();
  });

  it('opened while signed in, shows where they are, and its link closes it and carries on', async () => {
    person = { ...person, chain: 'solana', chainSource: 'picked', chainOptions: [] };
    portStore.set(signedInPort(EMBEDDED));
    const host = await shell();
    await settle();
    await click(find<HTMLAnchorElement>(host, '[data-ui="page-action"]'));
    await settle();
    const box = dialog() as HTMLElement;
    // nothing was done here, so it does not close by itself: the person reads where they are
    expect(box.textContent).toContain(en.chain.is.picked('Solana'));
    const on = [...box.querySelectorAll<HTMLElement>('a, button')].find(
      (el) => el.textContent === en.signIn.done.next,
    );
    expect(on?.tagName).toBe('BUTTON');
    await click(on as HTMLElement);
    expect(dialog()).toBeNull();
    expect(router.push.mock.calls).toEqual([['/orders/o1']]);
  });

  it('opened while signed in with no chain yet, starts them on one, and its link carries on', async () => {
    portStore.set(signedInPort(EMBEDDED));
    const host = await shell();
    await settle();
    await click(find<HTMLAnchorElement>(host, '[data-ui="page-action"]'));
    await settle();
    const box = dialog() as HTMLElement;
    // nobody is asked (CHAIN-SWITCH): the chain they were looking at is stored
    expect(person.chain).toBe('solana');
    expect(box.textContent).toContain(en.chain.is.picked('Solana'));
    await click(button(box, en.signIn.done.next));
    expect(dialog()).toBeNull();
    expect(router.push.mock.calls).toEqual([['/orders/o1']]);
  });

  it('is not opened on the sign-in page itself, which is the panel already', async () => {
    location.pathname = '/sign-in';
    const host = await shell();
    const here = find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]');
    await fire(here, new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(dialog()).toBeNull();
  });
});

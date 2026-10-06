// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
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
  document.documentElement.style.overflow = '';
});

describe('the sign-in dialog', () => {
  it('opens over the page from the bar’s "Sign in", as a modal named by its title', async () => {
    const host = await shell();
    const trigger = find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]');
    trigger.focus();
    await click(trigger);
    const box = dialog();
    expect(box).not.toBeNull();
    expect(box?.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe(en.signIn.title);
    // the same panel: one passkey button, one wallet button, and the disclaimer
    expect(button(box as HTMLElement, en.signIn.passkey.continue)).toBeTruthy();
    expect(button(box as HTMLElement, en.signIn.wallet.connect)).toBeTruthy();
    expect(box?.querySelector('[data-ui="disclaimer"]')).not.toBeNull();
    // the page stays: no navigation, and nothing behind can be reached or scrolled
    expect(router.push).not.toHaveBeenCalled();
    expect(find(host, '[data-ui="app-shell"]').closest('[inert]')).not.toBeNull();
    expect(box?.closest('[inert]')).toBeNull();
    expect(document.documentElement.style.overflow).toBe('hidden');
    // the page keeps its scrollbar's room, so nothing behind shifts sideways
    expect(document.documentElement.style.scrollbarGutter).toBe('stable');
    // focus is in the dialog
    expect(box?.contains(document.activeElement)).toBe(true);
  });

  it('closes with Escape, the scrim and its close button, and gives focus back to what opened it', async () => {
    const host = await shell();
    const trigger = find<HTMLAnchorElement>(host, 'header a[href="/sign-in"]');
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
    await click(find(host, 'header a[href="/sign-in"]'));
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
    await click(find(host, 'header a[href="/sign-in"]'));
    await click(button(dialog() as HTMLElement, en.signIn.passkey.continue));
    await settle();
    expect(dialog()).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
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
    await click(find(host, 'header a[href="/sign-in"]'));
    const box = dialog() as HTMLElement;
    await click(button(box, en.signIn.wallet.connect));
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

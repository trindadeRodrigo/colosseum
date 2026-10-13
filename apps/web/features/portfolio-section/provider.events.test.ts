// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { EXPOSURE_PATH, HISTORY_PATH, PLANS_PATH, REBALANCES_PATH } from './api';
import { REBALANCES_ASKED } from './PortfolioProvider';
import { held, serve } from './test/api';
import { history, plans, RH_SILENT, SOL_GROW, SOL_INCOME } from './test/fixtures';
import { GatePage, inSection, OwnHistory, Probe } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The section's provider with real events: who is signed in decides what is asked, each route is asked
// once for that person and again on "Read again", a route that fails leaves the others their answers,
// and an answer is shown only to the person it was read for. Then the gate every page stands on: one
// sentence for each state, in both languages.

const en = portfolioDictionary('en');
const ROUTES = [PLANS_PATH, EXPOSURE_PATH, REBALANCES_PATH] as const;

const probe = async () => {
  const host = await mount(inSection('en', createElement(Probe)));
  await settle();
  return host;
};
const state = (host: HTMLElement) => {
  const el = find(host, '[data-ui="probe"]');
  return {
    person: el.getAttribute('data-person'),
    plans: el.getAttribute('data-plans'),
    exposure: el.getAttribute('data-exposure'),
    rebalances: el.getAttribute('data-rebalances'),
    busy: el.getAttribute('data-busy'),
  };
};
const signIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, over));
const shown = (host: HTMLElement) => find(host, '[data-ui="probe-plans"]').textContent ?? '';
const text = (host: HTMLElement) => host.textContent ?? '';

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio';
  portStore.set(fakePort());
});
afterEach(unmountAll);

describe('the reads of the portfolio section', () => {
  it('asks nothing of the API for someone signed out', async () => {
    const server = serve(portStore);
    const host = await probe();
    expect(state(host)).toEqual({
      person: 'signed-out',
      plans: 'idle',
      exposure: 'idle',
      rebalances: 'idle',
      busy: 'false',
    });
    for (const route of ROUTES) expect(server.to(route)).toEqual([]);
  });

  it('asks nothing while the wallet is still loading, or while a sign-in is owed its wallets', async () => {
    const server = serve(portStore);
    portStore.set(fakePort({ status: 'loading' }));
    const host = await probe();
    expect(state(host).person).toBe('loading');
    // a passkey sign-in whose wallets are still being made: the person is known, and nothing is asked
    await act(async () => portStore.set(fakePort({ status: 'loading', userId: 'did:privy:test' })));
    await settle();
    expect(state(host)).toMatchObject({ person: 'loading', plans: 'idle' });
    for (const route of ROUTES) expect(server.to(route)).toEqual([]);
    // the wallets are there: now it reads
    await act(async () => signIn());
    await settle();
    expect(state(host)).toMatchObject({ person: 'signed-in', plans: 'read' });
  });

  it('asks each of the three routes once for the person, every vault and the most entries', async () => {
    const server = serve(portStore);
    signIn();
    const host = await probe();
    expect(server.to(PLANS_PATH)).toEqual([PLANS_PATH]);
    expect(server.to(EXPOSURE_PATH)).toEqual([EXPOSURE_PATH]);
    expect(server.to(REBALANCES_PATH)).toEqual([`${REBALANCES_PATH}?limit=${REBALANCES_ASKED}`]);
    // the history is a plan's page's own to ask for
    expect(server.to(HISTORY_PATH)).toEqual([]);
    expect(state(host)).toEqual({
      person: 'signed-in',
      plans: 'read',
      exposure: 'read',
      rebalances: 'read',
      busy: 'false',
    });
    expect(shown(host)).toContain(SOL_GROW);
    // drawing again asks nothing again
    await settle(20);
    for (const route of ROUTES) expect(server.to(route)).toHaveLength(1);
  });

  it('says it is reading until the answers land', async () => {
    const pending = held();
    serve(portStore, { plans: pending.answer });
    signIn();
    const host = await probe();
    expect(state(host)).toMatchObject({ plans: 'reading', exposure: 'read', busy: 'true' });
    await act(async () => pending.release(json(plans())));
    await settle();
    expect(state(host)).toMatchObject({ plans: 'read', busy: 'false' });
  });

  it.each([
    ['plans', 'unavailable', () => json({ error: 'Route not found' }, 404)],
    ['exposure', 'busy', () => json({ error: 'slow down' }, 429)],
    ['rebalances', 'unreachable', () => Promise.reject(new TypeError('fetch failed'))],
    ['plans', 'signed-out', () => json({ error: 'sign in first' }, 401)],
    ['exposure', 'no-identity', () => json({ error: 'no identity token was sent' }, 401)],
    ['rebalances', 'unreadable', () => json({ chains: 'nope' })],
  ] as const)(
    'leaves the other reads their answers when %s fails as %s',
    async (route, kind, answer) => {
      serve(
        portStore,
        route === 'plans'
          ? { plans: answer }
          : route === 'exposure'
            ? { exposure: answer }
            : { rebalances: answer },
      );
      signIn();
      const host = await probe();
      const now = state(host);
      for (const other of ['plans', 'exposure', 'rebalances'] as const)
        expect(now[other], other).toBe(other === route ? kind : 'read');
      expect(now.busy).toBe('false');
    },
  );

  it('asks all three afresh on "Read again", and keeps the last answer on the screen meanwhile', async () => {
    const server = serve(portStore);
    signIn();
    const host = await probe();
    const pending = held();
    serve(portStore, { plans: pending.answer });
    await click(find(host, '[data-action="again"]'));
    await settle();
    // the plans are on their way again, and the answer read before is still shown
    expect(pending.asked()).toBe(1);
    expect(state(host)).toMatchObject({ plans: 'read', busy: 'true' });
    expect(shown(host)).toContain(SOL_GROW);
    const fewer = plans({ address: SOL_INCOME });
    await act(async () => pending.release(json(fewer)));
    await settle();
    expect(state(host)).toMatchObject({ plans: 'read', busy: 'false' });
    expect(shown(host)).toBe(SOL_INCOME);
    // the first round asked each route once
    for (const route of ROUTES) expect(server.to(route)).toHaveLength(1);
  });

  it('drops an answer that lands after the person signed out', async () => {
    const pending = held();
    serve(portStore, { plans: pending.answer });
    signIn();
    const host = await probe();
    expect(state(host).plans).toBe('reading');
    await act(async () => portStore.set(fakePort()));
    expect(state(host)).toMatchObject({ person: 'signed-out', plans: 'idle', busy: 'false' });
    await act(async () => pending.release(json(plans())));
    await settle();
    expect(state(host)).toMatchObject({ person: 'signed-out', plans: 'idle' });
    expect(shown(host)).toBe('');
  });

  it('shows a person only the answer read for them, when another signs in while a read is on its way', async () => {
    const pending = held();
    const server = serve(portStore, { plans: pending.answer });
    signIn();
    const host = await probe();
    expect(pending.asked()).toBe(1);
    // another person signs in on this browser before the first read lands
    await act(async () => portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:other' })));
    await settle();
    expect(pending.asked()).toBe(2);
    expect(server.to(EXPOSURE_PATH)).toHaveLength(2);
    // the first person's plans land late: they are not shown to the second
    await act(async () => pending.release(json(plans())));
    await settle();
    expect(state(host).plans).toBe('reading');
    expect(shown(host)).toBe('');
    // the second person's own answer is
    await act(async () => pending.release(json(plans({ address: RH_SILENT }))));
    await settle();
    expect(state(host).plans).toBe('read');
    expect(shown(host)).toBe(RH_SILENT);
  });

  it('never shows the second person the first one’s answer, even one that had landed', async () => {
    serve(portStore);
    signIn();
    const host = await probe();
    expect(shown(host)).toContain(SOL_GROW);
    const pending = held();
    serve(portStore, {
      plans: pending.answer,
      exposure: pending.answer,
      rebalances: pending.answer,
    });
    await act(async () => portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:other' })));
    await settle();
    expect(state(host)).toMatchObject({ plans: 'reading', exposure: 'reading' });
    expect(shown(host)).toBe('');
  });
});

describe('a read of a page’s own', () => {
  const own = (host: HTMLElement) => find(host, '[data-ui="own-read"]');
  const mountOwn = async (address: string | null) => {
    const host = await mount(inSection('en', createElement(OwnHistory, { address })));
    await settle();
    return host;
  };

  it('asks for the signed-in person, once, with its own query', async () => {
    const server = serve(portStore);
    signIn();
    const host = await mountOwn(SOL_INCOME);
    expect(server.to(HISTORY_PATH)).toEqual([`${HISTORY_PATH}?address=${SOL_INCOME}&step=1d`]);
    expect(own(host).getAttribute('data-kind')).toBe('read');
    expect(own(host).textContent).toBe(SOL_INCOME);
  });

  it('asks nothing for someone signed out, and nothing when nothing is asked', async () => {
    const server = serve(portStore);
    const out = await mountOwn(SOL_INCOME);
    expect(own(out).getAttribute('data-kind')).toBe('idle');
    await unmountAll();
    signIn();
    const none = await mountOwn(null);
    expect(own(none).getAttribute('data-kind')).toBe('idle');
    expect(server.to(HISTORY_PATH)).toEqual([]);
  });

  it('is asked again with the section’s reads, and an answer for another vault is dropped', async () => {
    const pending = held();
    const server = serve(portStore, { history: pending.answer });
    signIn();
    const host = await mount(
      inSection(
        'en',
        createElement(
          'div',
          null,
          createElement(Probe),
          createElement(OwnHistory, { address: SOL_INCOME }),
        ),
      ),
    );
    await settle();
    expect(own(host).getAttribute('data-kind')).toBe('reading');
    expect(server.to(HISTORY_PATH)).toHaveLength(1);
    // "Read again" asks for it afresh too
    await click(find(host, '[data-action="again"]'));
    await settle();
    expect(server.to(HISTORY_PATH)).toHaveLength(2);
    // the first round's answer lands after the second was asked: it is not the one shown
    await act(async () => pending.release(json(history({ address: SOL_GROW }))));
    await settle();
    expect(own(host).getAttribute('data-kind')).toBe('reading');
    await act(async () => pending.release(json(history({ address: SOL_INCOME }))));
    await settle();
    expect(own(host).textContent).toBe(SOL_INCOME);
  });
});

describe('the gate every page of the section stands on', () => {
  const gate = async (lang: Lang = 'en') => {
    const host = await mount(inSection(lang, createElement(GatePage)));
    await settle();
    return host;
  };

  it.each(['en', 'pt'] as const)(
    'asks someone signed out to sign in, and leads back to the page they were on (%s)',
    async (lang) => {
      const server = serve(portStore);
      location.pathname = '/portfolio/rebalancing';
      const host = await gate(lang);
      expect(text(host)).toContain(portfolioDictionary(lang).shell.signedOut);
      const link = find<HTMLAnchorElement>(host, 'a');
      expect(link.textContent).toBe(dictionary(lang).shell.signIn);
      expect(link.getAttribute('href')).toBe('/sign-in?next=/portfolio/rebalancing');
      expect(server.to(PLANS_PATH)).toEqual([]);
    },
  );

  it('waits in words while the plans are read, with no figure in their place', async () => {
    const pending = held();
    serve(portStore, { plans: pending.answer });
    signIn();
    const host = await gate();
    const wait = find(host, '[data-ui="waiting"]');
    expect(wait.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[data-ui="figure"]')).toBeNull();
    await settle(450);
    expect(find(wait, '[role="status"]').textContent).toContain(en.shell.reading);
    await act(async () => pending.release(json(plans())));
    await settle();
    expect(host.querySelector('[data-ui="waiting"]')).toBeNull();
    expect(find(host, '[data-ui="gate-read"]').textContent).toBe('solana robinhood');
  });

  it.each(['en', 'pt'] as const)('says each failure in its own sentence (%s)', async (lang) => {
    const words = portfolioDictionary(lang).shell.failure;
    for (const [answer, sentence, again] of [
      [() => json({ error: 'Route not found' }, 404), words.unavailable, false],
      [() => json({ error: 'slow down' }, 429), dictionary(lang).shell.slowDown, true],
      [() => Promise.reject(new TypeError('fetch failed')), words.unreachable, true],
      [() => json({ chains: 'nope' }), words.unreadable, true],
      [() => json({ error: 'sign in first' }, 401), words.signedOut, false],
      [() => json({ error: 'no identity token was sent' }, 401), words.noIdentity, true],
      [() => json({ error: 'not an address' }, 400), words.refused, false],
    ] as const) {
      serve(portStore, { plans: answer });
      signIn();
      const host = await gate(lang);
      expect(text(host)).toContain(sentence);
      expect(host.querySelector('[data-ui="gate-read"]')).toBeNull();
      expect(host.querySelector('[data-ui="figure"]')).toBeNull();
      // a read that may go through next time offers to ask again; never as the primary action
      const button = host.querySelector('[data-action="read-again"]');
      expect(button !== null, sentence).toBe(again);
      if (button) expect(button.getAttribute('data-variant')).toBe('secondary');
      await unmountAll();
    }
  });

  it('tells the throwaway wallet it has no account, not to sign in again, when a real API refuses it', async () => {
    for (const answer of [
      () => json({ error: 'sign in first' }, 401),
      () => json({ error: 'no identity token was sent' }, 401),
    ]) {
      serve(portStore, { plans: answer });
      signIn({ test: true, userId: 'test:So111111' });
      const host = await gate();
      expect(text(host)).toContain(en.shell.failure.throwaway);
      expect(text(host)).not.toContain(en.shell.failure.signedOut);
      await unmountAll();
    }
  });

  it.each(['en', 'pt'] as const)(
    'says a chain that is switched off in a sentence, never as a zero, and shows the others (%s)',
    async (lang) => {
      serve(portStore);
      signIn();
      const host = await gate(lang);
      const out = find(host, '[data-ui="chains-out"]');
      expect(out.querySelectorAll('li')).toHaveLength(1);
      const status = find(out, '[data-ui="status"]');
      expect(status.textContent).toBe(dictionary(lang).portfolio.chainOff('Base'));
      // nothing is known to be wrong: watch, with its shape
      expect(status.getAttribute('data-status')).toBe('watch');
      expect(status.querySelector('svg')).not.toBeNull();
      // the chains that were read are shown all the same
      expect(find(host, '[data-ui="gate-read"]').textContent).toBe('solana robinhood');
    },
  );

  it('offers to read again for a chain that may answer next time, and reads again', async () => {
    const out = (retryable: boolean) => {
      const answer = plans();
      return {
        ...answer,
        unavailable: answer.unavailable.map((u) => ({ ...u, retryable })),
      };
    };
    let retryable = true;
    const server = serve(portStore, { plans: () => json(out(retryable)) });
    signIn();
    const host = await gate();
    expect(find(host, '[data-ui="chains-out"] [data-ui="status"]').textContent).toBe(
      dictionary('en').portfolio.chainOut('Base'),
    );
    const [again] = host.querySelectorAll('[data-action="read-again"]');
    expect(again?.textContent).toContain(en.shell.again);
    retryable = false;
    await click(again as Element);
    await settle();
    expect(server.to(PLANS_PATH)).toHaveLength(2);
    expect(find(host, '[data-ui="chains-out"] [data-ui="status"]').textContent).toBe(
      dictionary('en').portfolio.chainOff('Base'),
    );
  });
});

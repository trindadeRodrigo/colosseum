// @vitest-environment happy-dom
import { type OrderDetail, TRUST_STATUS } from '@colosseum/schemas';
import type { ExecutionResult, ExecutorDeps } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { chainOf, portfolioOf, vault } from '../portfolio/test/portfolio';
import { EMBEDDED, json, PHANTOM, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { holds } from '../wallet/test/mock-signing';
import { BuyScreen } from './BuyScreen';
import { Invest } from './Invest';
import type { InvestProgress } from './invest-words';
import { recallOrder, trustAccepted } from './order-record';
import { rememberPlan } from './plan-store';
import { basketOfPlan } from './readiness';
import {
  LEG_CREATE,
  LEG_SWAP,
  ORDER_ID,
  orderOn,
  PLAN_ID,
  planOn,
  serverKeepsPlans,
  USER,
} from './test/fixtures';

// Investing with one press (gate INVEST-ONE-PRESS), with real events against a double of the API. Only
// `execute` of the SDK is a double: each test scripts what the executor would answer, step by step,
// and reads what it was handed. What decides a signature (the web's order check, the guard, the
// record of what was signed) is the order screen's and the runner's, as on the order's own page.

type Script = (order: OrderDetail, deps: ExecutorDeps) => Promise<ExecutionResult>;
const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
  script: null as Script | null,
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return run.script
      ? run.script(order, deps)
      : Promise.resolve({ status: 'done', order: { ...order, status: 'done' } });
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');

type Call = { method: string; path: string; body?: unknown };

const funding = (ok: boolean) => ({
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: ok ? '50000000' : '0',
    needRaw: '10000000',
    missingRaw: ok ? '0' : '10000000',
    source: 'devnet RPC',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    method: 'getTokenAccountBalance',
    provenance: 'sandbox',
  },
  gas: {
    symbol: 'SOL',
    decimals: 9,
    haveRaw: '1000000000',
    needRaw: '20000000',
    missingRaw: '0',
    source: 'devnet RPC',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    method: 'getBalance',
    provenance: 'sandbox',
  },
  steps: 2,
  newVault: true,
  testFunds: true,
  ok,
});

function api(o: { funded?: boolean; order?: () => OrderDetail; finishes?: boolean } = {}) {
  const calls: Call[] = [];
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  let funded = o.funded ?? true;
  portStore.setApi(
    serverKeepsPlans(async (path, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/v1/me') return json(person);
      if (path.startsWith('/v1/funding?')) return json(funding(funded));
      if (path === '/v1/testnet/fund') {
        funded = true;
        return json({ error: 'nothing is missing' }, 409);
      }
      if (path === '/v1/orders' && method === 'POST') return json(o.order?.() ?? orderOn());
      if (path === `/v1/orders/${ORDER_ID}`) return json(o.order?.() ?? orderOn());
      // whether this server finishes buys: asked with something that is no order's id
      if (path.endsWith('/continue'))
        return o.finishes ? json({ error: 'the id is not a uuid' }, 400) : json({}, 404);
      if (path === '/v1/portfolio')
        return json(
          portfolioOf(chainOf([vault({ basketId: basketOfPlan(PLAN_ID), address: MY_VAULT })])),
        );
      return json({ error: 'not found' }, 404);
    }),
  );
  return {
    calls,
    to: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)),
    placed: () => calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST'),
  };
}

const MY_VAULT = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
const PRESS = '[data-ui="invest-card"] [data-variant="primary"]';
const label = (el: Element) =>
  el.querySelector('.grid > span:not([aria-hidden])')?.textContent ?? el.textContent;
const pressable = (host: HTMLElement) => find(host, PRESS).getAttribute('aria-disabled') === null;

/** The buy screen for $10, once the wallet is read and the order is made and shown. */
const buy = async () => {
  const host = await mount(withAccount('en', createElement(BuyScreen, { id: PLAN_ID })));
  await settle();
  await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
  await settle(350);
  await settle(450);
  await settle();
  return host;
};
const tick = (host: HTMLElement) =>
  click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));

/** The order with these steps standing as said. */
const standing = (order: OrderDetail, status: Record<string, string>): OrderDetail =>
  ({
    ...order,
    legs: order.legs.map((l) =>
      status[l.id] ? { ...l, status: status[l.id], txId: `sig-${l.seq}` } : l,
    ),
  }) as OrderDetail;

/** A promise the test settles when it wants the executor to go on. */
function gate<T>() {
  let open: (value: T) => void = () => {};
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** The browser's locks, as `navigator.locks` gives them: one holder per name, `ifAvailable` honoured. */
function installLocks() {
  const held = new Set<string>();
  const locks = {
    async request(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: { name: string } | null) => unknown,
    ) {
      if (held.has(name)) return options.ifAvailable ? callback(null) : undefined;
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

beforeEach(() => {
  installLocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  run.calls.length = 0;
  run.script = null;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  rememberPlan(planOn());
});
afterEach(unmountAll);

describe('investing with one press, with the passkey wallet', () => {
  it('shows the order on the card before the press: each trade, the least it may receive, the fee and the test network', async () => {
    const server = api();
    const host = await buy();
    // the order is made as soon as the wallet holds the amount: no press, no other page
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    const card = find(host, '[data-ui="invest-card"]');
    const steps = [...card.querySelectorAll('[data-ui="order-step"]')].map((s) => s.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('10 USDC');
    // the trade in plain words: what is spent, on what, and the least it may receive
    expect(steps[1]).toContain(en.order.review.spend('6 USDC', 'SPYx'));
    expect(steps[1]).toContain(en.order.review.atLeastWhole('0.0099 SPYx'));
    expect(find(card, '[data-ui="invest-fee"]').textContent).toBe(en.invest.fee.none);
    expect(find(card, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    // who signs, said once before the press: the passkey wallet, with no other window
    expect(find(card, '[data-ui="invest-signing"]').textContent).toBe(en.invest.signs.passkey(2));
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
    // the wallet holds what it needs: nothing about funds is shown
    expect(card.querySelector('[data-ui="funding-step"]')).toBeNull();
    // nothing was signed, and nothing is asked of the wallet, before the press
    expect(run.calls).toEqual([]);
    expect(recallOrder(ORDER_ID, USER)?.approved).toBeNull();
  });

  it('one press approves the order as shown and runs every step, saying where it is', async () => {
    api();
    const first = gate<void>();
    const second = gate<void>();
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'signing' } as never);
      await first.wait;
      const deposited = standing(order, { [LEG_CREATE]: 'confirmed' });
      deps.onEvent?.({ order: deposited, legId: LEG_SWAP, phase: 'signing' } as never);
      await second.wait;
      const all = standing(deposited, { [LEG_SWAP]: 'confirmed' });
      return { status: 'done', order: { ...all, status: 'done' } };
    };
    const progress: InvestProgress[] = [];
    const done: unknown[] = [];
    const host = await mount(
      withAccount(
        'en',
        createElement(Invest, {
          of: { plan: PLAN_ID },
          amount: 10,
          onProgress: (p) => progress.push(p),
          onDone: (d) => done.push(d),
        }),
      ),
    );
    await settle(350);
    await settle(450);
    await settle();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // one run, of the order exactly as the card showed it, held to the plan the person read
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order).toEqual(orderOn());
    expect(recallOrder(ORDER_ID, USER)?.approved?.order).toEqual(orderOn());
    expect(run.calls[0]?.deps.plan).toMatchObject({
      basketId: basketOfPlan(PLAN_ID),
      autoFollow: false,
    });
    expect(holds.open).toBe(1);
    expect(find(host, '[data-ui="invest-progress"]').textContent).toContain(
      en.invest.progress.line(null, en.invest.progress.depositing, 1, 2),
    );
    first.open();
    await settle();
    expect(find(host, '[data-ui="invest-progress"]').textContent).toContain(
      'Deposit confirmed · Buying SPYx · 2 of 2',
    );
    second.open();
    await settle();
    await settle();
    expect(find(host, '[data-ui="order-status"]').textContent).toContain(
      en.order.outcome.done('Solana'),
    );
    expect(holds.open).toBe(0);
    // the host is told: the press, each step, and the vault the money is in
    expect(progress.map((p) => [p.step, p.of])).toEqual([
      [0, 0],
      [1, 2],
      [2, 2],
    ]);
    expect(done).toEqual([{ orderId: ORDER_ID, vault: MY_VAULT }]);
    // one signing run in all: nothing is asked of the wallet twice
    expect(run.calls).toHaveLength(1);
  });

  it('the trust notice is on the card the first time, holds the press, and is kept only at the press', async () => {
    api();
    const host = await buy();
    const notice = find(host, '[data-ui="trust-notice"]');
    expect(notice.textContent).toContain(en.trust.unaudited);
    expect(notice.textContent).toContain(en.trust.admin(TRUST_STATUS.admin.solana as string));
    // the order is here to read, and cannot be pressed
    expect(pressable(host)).toBe(false);
    expect(host.textContent).toContain(en.buy.blocked.trust);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toEqual([]);
    // ticked, and still not kept: looking is not accepting
    await tick(host);
    expect(pressable(host)).toBe(true);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(false);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    // kept for a plan's own vault, whose short points leave the keeper's limits out: a buy the
    // keeper may trade asks again
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(true);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion)).toBe(false);
    await unmountAll();

    // the next buy: not asked again, and still there to read
    run.calls.length = 0;
    const again = await buy();
    expect(again.querySelector('[data-ui="trust-notice"] input[type="checkbox"]')).toBeNull();
    expect(find(again, '[data-ui="trust-kept"]').textContent).toContain(en.trust.short.title);
    expect(pressable(again)).toBe(true);
  });

  it('shows funds only when the wallet is short: what is missing, test funds, and no order until it is there', async () => {
    const server = api({ funded: false });
    const host = await buy();
    const funds = find(host, '[data-ui="funding-step"]');
    expect(funds.textContent).toContain('10 USDC');
    expect(host.textContent).toContain(en.buy.blocked.funding);
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
    expect(pressable(host)).toBe(false);
    // no order is made for a wallet that cannot pay for it, and nothing is run
    expect(server.placed()).toEqual([]);
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    // what the amount buys is still said, from the plan
    expect(
      [...host.querySelectorAll('[data-ui="invest-card"] table caption')].map((c) => c.textContent),
    ).toContain(en.invest.buying);
    expect(find(host, '[data-ui="invest-card"]').textContent).toContain('SPYx');
    // on a test network our server can send what is missing
    const ask = [...funds.querySelectorAll('button')].find(
      (b) => label(b) === en.buy.funding.testFunds,
    );
    expect(ask).toBeTruthy();
    await click(ask as HTMLElement);
    await settle(350);
    await settle(450);
    await settle();
    expect(server.to('/v1/testnet/fund')).toHaveLength(1);
    // the wallet holds it now: the funds are gone from the card and the order is there
    expect(host.querySelector('[data-ui="funding-step"]')).toBeNull();
    expect(server.placed()).toHaveLength(1);
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
  });
});

describe('the card while the wallet is read', () => {
  it('keeps what is on it in place: the notice ticked before the read is still ticked after it, and after a second read', async () => {
    // A card labelled as a sample draws its contents inside another element: a label that waited
    // for the funding read would make everything on the card again, and drop what was ticked (#150).
    api({ funded: false });
    const host = await mount(withAccount('en', createElement(BuyScreen, { id: PLAN_ID })));
    await settle();
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    const box = () =>
      find<HTMLInputElement>(host, '[data-ui="trust-notice"] input[type="checkbox"]');
    const before = box();
    await click(before);
    expect(before.checked).toBe(true);
    // the first read of the wallet arrives, and says it is a test network
    await settle(350);
    await settle();
    expect(find(host, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    expect(box()).toBe(before);
    expect(box().checked).toBe(true);
    // and it is read again, as "Get test funds" does
    const ask = [...host.querySelectorAll('button')].find(
      (b) => label(b) === en.buy.funding.testFunds,
    );
    await click(ask as HTMLElement);
    await settle(350);
    await settle();
    expect(box()).toBe(before);
    expect(box().checked).toBe(true);
  });
});

describe('investing with a wallet of the person’s own', () => {
  it('says before the press that the wallet confirms each step in its own window, and runs the same order', async () => {
    portStore.set(signedInPort(PHANTOM, { userId: USER }));
    api();
    const host = await buy();
    expect(find(host, '[data-ui="invest-signing"]').textContent).toBe(en.invest.signs.wallet(2));
    expect(host.textContent).not.toContain(en.invest.signs.passkey(2));
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // the same run through the same runner: the executor asks the wallet once for each step
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order).toEqual(orderOn());
    expect(run.calls[0]?.deps.signer).toBe(portStore.get());
  });
});

describe('a sequence that stops', () => {
  it('stops between steps when asked: the step under way is finished, and the same order goes on later', async () => {
    api();
    const first = gate<void>();
    const stopped: unknown[] = [];
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'landing' } as never);
      await first.wait;
      const deposited = standing(order, { [LEG_CREATE]: 'confirmed' });
      // the executor looks at the signal before it begins the next step
      if (deps.signal?.aborted)
        return { status: 'waiting', order: deposited, legId: LEG_SWAP, why: 'stopped' } as never;
      return { status: 'done', order: { ...deposited, status: 'done' } };
    };
    const host = await mount(
      withAccount(
        'en',
        createElement(Invest, {
          of: { plan: PLAN_ID },
          amount: 10,
          onStopped: (s) => stopped.push(s),
        }),
      ),
    );
    await settle(350);
    await settle(450);
    await settle();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    const stop = [...host.querySelectorAll('button')].find((b) => label(b) === en.invest.stop);
    expect(stop).toBeTruthy();
    expect(run.calls[0]?.deps.signal?.aborted).toBe(false);
    await click(stop as HTMLElement);
    expect(run.calls[0]?.deps.signal?.aborted).toBe(true);
    expect(find(host, '[data-ui="invest-stopping"]').textContent).toBe(en.invest.stopping);
    first.open();
    await settle();
    await settle();
    // what landed and what did not, in one sentence
    expect(find(host, '[data-ui="invest-landed"]').textContent).toBe(
      en.invest.stopped.some('the deposit', 'SPYx'),
    );
    expect(stopped).toEqual([{ orderId: ORDER_ID }]);
    // the same order goes on from where it is: no new order, no second deposit
    run.script = null;
    expect(label(find(host, PRESS))).toBe(en.order.resume('$10'));
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.order).toEqual(orderOn());
  });

  it('a step that fails after the deposit: says what landed, offers to finish the buy, and signs nothing more by itself', async () => {
    const server = api({ finishes: true });
    run.script = async (order) => {
      const failed = standing(order, { [LEG_CREATE]: 'confirmed', [LEG_SWAP]: 'failed' });
      return {
        status: 'failed',
        order: { ...failed, status: 'failed' },
        legId: LEG_SWAP,
        error: { code: 'PriceMoved', message: 'the price moved', retryable: false },
      } as never;
    };
    const host = await buy();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    await settle();
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(find(host, '[data-ui="invest-landed"]').textContent).toBe(
      en.invest.stopped.some('the deposit', 'SPYx'),
    );
    expect(host.textContent).toContain(en.order.outcome.failed(2));
    // the deposit is in the vault: finishing the buy with it is offered first (#155), then a new order
    const offered = [...find(host, '[data-ui="order-stopped"]').querySelectorAll('button')].map(
      (b) => label(b),
    );
    expect(offered).toEqual([en.order.outcome.finish, en.order.outcome.newOrder]);
    expect(server.calls.filter((c) => c.path.endsWith('/continue'))).toHaveLength(1);
    // nothing runs again unless the person asks
    await settle(600);
    expect(run.calls).toHaveLength(1);
    expect(server.placed()).toHaveLength(1);
  });

  it('a new order after a stop is made in the card, reviewed again, and pressed again', async () => {
    const server = api();
    run.script = async (order) =>
      ({
        status: 'refused',
        order,
        legId: LEG_SWAP,
        refusal: { code: 'minimum', message: 'the minimum is lower than the review showed' },
      }) as never;
    const host = await buy();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    await settle();
    expect(find(host, '[data-ui="invest-landed"]').textContent).toBe(en.invest.stopped.nothing);
    const again = [...host.querySelectorAll('button')].find(
      (b) => label(b) === en.order.outcome.newOrder,
    );
    expect(again).toBeTruthy();
    await click(again as HTMLElement);
    await settle(450);
    await settle();
    // a second order, shown again with its own minimums, and not run until it is pressed
    expect(server.placed()).toHaveLength(2);
    expect(run.calls).toHaveLength(1);
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
    expect(pressable(host)).toBe(true);
  });
});

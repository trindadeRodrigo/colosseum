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

/**
 * The fixtures' $10 order under another id, the n-th order a card made, and for another amount: every
 * raw figure of it scaled, as our server plans the same plan for more money.
 */
const orderNo = (n: number, amountUsd = 10): OrderDetail => {
  const order = orderOn();
  const id = n === 0 ? order.id : `00000000-0000-4000-8000-00000000000${n}`;
  const scaled = (raw: string) => ((BigInt(raw) * BigInt(amountUsd)) / 10n).toString();
  return {
    ...order,
    id,
    approvalUrl: `/orders/${id}`,
    ...(order.depositRaw ? { depositRaw: scaled(order.depositRaw) } : {}),
    legs: order.legs.map((leg) => ({
      ...leg,
      orderId: id,
      ...(leg.cashRaw ? { cashRaw: scaled(leg.cashRaw) } : {}),
      trades: leg.trades.map((t) => ({ ...t, amountInRaw: scaled(t.amountInRaw) })),
      expected: leg.expected.map((e) => ({
        ...e,
        inRaw: scaled(e.inRaw),
        outRaw: scaled(e.outRaw),
        minOutRaw: scaled(e.minOutRaw),
      })),
    })),
  };
};

function api(
  o: {
    funded?: boolean;
    order?: () => OrderDetail;
    finishes?: boolean;
    /** Each POST makes another order, as the server does. Default: the same one every time. */
    distinct?: boolean;
    /** A plan our server keeps that this tab did not build: one of a goal's three candidates. */
    candidate?: string;
    /** How long the first order is open for, from when it is made. Default: the fixtures' time, long past. */
    openFor?: number;
  } = {},
) {
  const calls: Call[] = [];
  const kept = new Map<string, OrderDetail>();
  let made = 0;
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
      if (o.candidate && path === `/v1/baskets/${o.candidate}`)
        return json({
          id: o.candidate,
          proposal: { ...planOn().proposal, candidate: 'spread' },
          fromLink: false,
        });
      if (path.startsWith('/v1/funding?')) return json(funding(funded));
      if (path === '/v1/testnet/fund') {
        funded = true;
        return json({ error: 'nothing is missing' }, 409);
      }
      if (path === '/v1/orders' && method === 'POST') {
        const asked = (JSON.parse(String(init?.body)) as { amountUsd: number }).amountUsd;
        const base = o.order?.() ?? orderNo(o.distinct ? made : 0, o.distinct ? asked : 10);
        const order =
          o.openFor === undefined || made > 0
            ? base
            : { ...base, expiresAt: Math.floor((Date.now() + o.openFor) / 1000) };
        made += 1;
        kept.set(order.id, order);
        return json(order);
      }
      if (path.startsWith('/v1/orders/') && method === 'GET' && !path.endsWith('/continue')) {
        const order = kept.get(path.slice('/v1/orders/'.length));
        return order ? json(order) : json({ error: 'not found' }, 404);
      }
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
    /** Our server's copy of an order, changed after the card read it. */
    change: (id: string, to: (order: OrderDetail) => OrderDetail) => {
      const order = kept.get(id);
      if (order) kept.set(id, to(order));
    },
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
  await settle(1050);
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
    await settle(1050);
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
    await settle(1050);
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

describe('investing in a picked candidate', () => {
  it('buys the candidate by its own id: the plan is read from our server by it, and the order and the vault are that plan’s', async () => {
    // Each of a goal's three candidates is stored as a plan with its own id (gate THREE-PLANS): the
    // one the person picked is what the card is handed, and nothing of the other two.
    const CANDIDATE = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
    window.localStorage.clear();
    const server = api({ candidate: CANDIDATE });
    const host = await mount(
      withAccount('en', createElement(Invest, { of: { plan: CANDIDATE }, amount: 10 })),
    );
    await settle();
    await settle(350);
    await settle(1050);
    await settle();
    expect(server.to(`/v1/baskets/${CANDIDATE}`)).toHaveLength(1);
    expect(server.to('/v1/funding').at(-1)?.path).toContain(`proposalId=${CANDIDATE}`);
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: CANDIDATE },
    ]);
    expect(recallOrder(ORDER_ID, USER)).toMatchObject({ proposalId: CANDIDATE, amountUsd: 10 });
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // the guard is held to the vault this candidate's id gives, and to its lines
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toMatchObject({ basketId: basketOfPlan(CANDIDATE) });
    expect(basketOfPlan(CANDIDATE)).not.toBe(basketOfPlan(PLAN_ID));
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
    await settle(1050);
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
    await settle(1050);
    await settle();
    // a second order, shown again with its own minimums, and not run until it is pressed
    expect(server.placed()).toHaveLength(2);
    expect(run.calls).toHaveLength(1);
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
    // said to be new, and held for a moment so its figures can be read before they are approved
    expect(find(host, '[data-ui="invest-updated"]').textContent).toBe(en.invest.updated);
    expect(pressable(host)).toBe(false);
    expect(host.textContent).toContain(en.invest.updatedHold);
    await settle(1550);
    expect(pressable(host)).toBe(true);
  });
});

describe('the orders a card makes before the press', () => {
  const amountOf = (host: HTMLElement) =>
    find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
  const bodies = (server: ReturnType<typeof api>) =>
    server.placed().map((c) => (c.body as { amountUsd: number }).amountUsd);
  const still = async () => {
    await settle(350);
    await settle(1050);
    await settle();
  };

  it('makes none while the amount is being typed, and one once it has been still', async () => {
    const server = api({ distinct: true });
    const host = await mount(withAccount('en', createElement(BuyScreen, { id: PLAN_ID })));
    await settle();
    // typed key by key, each a valid amount, faster than the card waits
    for (const text of ['1', '10', '100', '10']) {
      await type(amountOf(host), text);
      await settle(200);
    }
    expect(server.placed()).toEqual([]);
    await still();
    expect(bodies(server)).toEqual([10]);
    // and it is reused while the amount and the plan are the same: a later look makes no other
    await settle(1500);
    expect(bodies(server)).toEqual([10]);
  });

  it('keeps one order at a time: a new amount makes another, and the one before is forgotten here', async () => {
    const server = api({ distinct: true });
    const host = await buy();
    expect(bodies(server)).toEqual([10]);
    expect(recallOrder(orderNo(0).id, USER)).not.toBeNull();
    await type(amountOf(host), '20');
    // at once the card shows no order: the one for $10 is not there to press for $20
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    await still();
    expect(bodies(server)).toEqual([10, 20]);
    expect(recallOrder(orderNo(0).id, USER)).toBeNull();
    expect(recallOrder(orderNo(1).id, USER)).toMatchObject({ amountUsd: 20, approved: null });
  });

  it('forgets an order nobody pressed when the person leaves, and keeps one that was pressed', async () => {
    api({ distinct: true });
    await buy();
    expect(recallOrder(ORDER_ID, USER)).not.toBeNull();
    await unmountAll();
    expect(recallOrder(ORDER_ID, USER)).toBeNull();

    api({ distinct: true });
    const again = await buy();
    await tick(again);
    await click(find(again, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    await unmountAll();
    expect(recallOrder(ORDER_ID, USER)?.approved?.order.id).toBe(ORDER_ID);
  });

  it('makes few by itself: after that the person asks for the prices', async () => {
    const server = api({ distinct: true });
    const host = await buy();
    for (const text of ['11', '12', '13']) {
      await type(amountOf(host), text);
      await still();
    }
    expect(bodies(server)).toEqual([10, 11, 12, 13]);
    await type(amountOf(host), '14');
    await still();
    // no fifth by itself
    expect(bodies(server)).toEqual([10, 11, 12, 13]);
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    const ask = [...host.querySelectorAll('button')].find((b) => label(b) === en.invest.again);
    expect(ask).toBeTruthy();
    await click(ask as HTMLElement);
    await still();
    expect(bodies(server)).toEqual([10, 11, 12, 13, 14]);
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
  }, 20_000);
});

describe('an order that takes another’s place before the press', () => {
  const amountOf = (host: HTMLElement) =>
    find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
  const still = async () => {
    await settle(350);
    await settle(1050);
    await settle();
  };

  it('the amount changed: the press is for the new order alone, said to be new and held until it can be read', async () => {
    const server = api({ distinct: true });
    const host = await buy();
    await tick(host);
    expect(pressable(host)).toBe(true);
    await type(amountOf(host), '20');
    // nothing of the $10 order is left to press while the $20 one is made
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    expect(pressable(host)).toBe(false);
    await still();
    expect(server.placed()).toHaveLength(2);
    expect(find(host, '[data-ui="invest-updated"]').textContent).toBe(en.invest.updated);
    // a press in the moment it appears does nothing
    expect(pressable(host)).toBe(false);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toEqual([]);
    await settle(1550);
    expect(pressable(host)).toBe(true);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    // the order for $20 as it was shown, and nothing of the one for $10
    expect(run.calls[0]?.order).toEqual(orderNo(1, 20));
    expect(recallOrder(orderNo(1).id, USER)?.amountUsd).toBe(20);
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
  });

  it('the order ran out: it leaves the card, no other is made by itself, and one the person asks for is held until it can be read', async () => {
    const server = api({ distinct: true, openFor: 2_500 });
    const host = await buy();
    await tick(host);
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    // its time passes with nobody pressing
    await settle(2_600);
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    expect(find(host, '[data-ui="invest-old"]').textContent).toBe(en.invest.old);
    expect(pressable(host)).toBe(false);
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    // and none is made again, however long the card is left
    await settle(1_600);
    expect(server.placed()).toHaveLength(1);
    const ask = [...host.querySelectorAll('button')].find((b) => label(b) === en.invest.again);
    await click(ask as HTMLElement);
    await settle(1050);
    await settle();
    expect(server.placed()).toHaveLength(2);
    expect(host.querySelector('[data-ui="invest-old"]')).toBeNull();
    expect(find(host, '[data-ui="invest-updated"]').textContent).toBe(en.invest.updated);
    expect(pressable(host)).toBe(false);
    // the press is the new order's, once it can have been read
    await settle(1550);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order.id).toBe(orderNo(1).id);
  }, 20_000);

  it('makes no order in a tab nobody is looking at: it is made when the tab is seen', async () => {
    const server = api({ distinct: true });
    const visible = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    visible('hidden');
    try {
      const host = await buy();
      await settle(500);
      expect(server.placed()).toEqual([]);
      expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
      visible('visible');
      // the tab is seen: the card takes that in, then waits its moment as for any amount
      await settle();
      await settle(1050);
      await settle();
      expect(server.placed()).toHaveLength(1);
      expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    } finally {
      visible('visible');
    }
  });
});

describe('what the press approves', () => {
  it('is the order as the card showed it, whatever our server says of that order afterwards', async () => {
    const server = api();
    const host = await buy();
    const shown = find(host, '[data-ui="invest-steps"]').textContent;
    expect(shown).toContain(en.order.review.atLeastWhole('0.0099 SPYx'));
    // the server's copy changes under the card: a lower minimum for the same trade
    server.change(ORDER_ID, (order) => ({ ...orderOn('solana', '500000'), id: order.id }));
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // the card did not read it again, and what it handed the runner is what it showed
    expect(server.calls.filter((c) => c.path === `/v1/orders/${ORDER_ID}`)).toHaveLength(1);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order).toEqual(orderOn());
    expect(run.calls[0]?.order.legs[1]?.expected[0]?.minOutRaw).toBe('990000');
    expect(recallOrder(ORDER_ID, USER)?.approved?.order).toEqual(orderOn());
    expect(find(host, '[data-ui="invest-steps"]').textContent).toContain(
      en.order.review.atLeastWhole('0.0099 SPYx'),
    );
  });

  it('an order that ran out before the press is not signed for: the card says so and offers a new one', async () => {
    const server = api({ distinct: true });
    // as the executor answers for an order past its time: nothing was built, nothing signed
    run.script = async (order) => ({ status: 'expired', order: { ...order, status: 'expired' } });
    const host = await buy();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    await settle();
    expect(find(host, '[data-ui="order-status"]').textContent).toContain(en.order.outcome.expired);
    expect(find(host, '[data-ui="invest-landed"]').textContent).toBe(en.invest.stopped.nothing);
    // a new order is asked for, shown with its own figures, and pressed again: never run by itself
    const again = [...host.querySelectorAll('button')].find(
      (b) => label(b) === en.order.outcome.newOrder,
    );
    await click(again as HTMLElement);
    await settle(1050);
    await settle();
    expect(server.placed()).toHaveLength(2);
    expect(run.calls).toHaveLength(1);
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
  });
});

describe('when the trust notice is accepted', () => {
  it('not by a press that could not start: this browser cannot hold an order to one tab', async () => {
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
    api();
    const host = await buy();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toEqual([]);
    expect(host.textContent).toContain(en.order.outcome.notRunnable['no-lock']);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(false);
  });

  it('not by a press the guard refused before any step', async () => {
    api();
    run.script = async (order) =>
      ({
        status: 'refused',
        order,
        legId: null,
        refusal: { code: 'order', message: 'the order is not the one reviewed' },
      }) as never;
    const host = await buy();
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(false);
  });

  it('as the first step begins, and once', async () => {
    api();
    const hold = gate<void>();
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'building' } as never);
      await hold.wait;
      return { status: 'done', order: { ...order, status: 'done' } };
    };
    const host = await buy();
    await tick(host);
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(false);
    await click(find(host, PRESS));
    await settle();
    expect(trustAccepted(USER, TRUST_STATUS.textVersion, false)).toBe(true);
    hold.open();
    await settle();
  });
});

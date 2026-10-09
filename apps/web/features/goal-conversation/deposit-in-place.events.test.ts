// @vitest-environment happy-dom
import type { MixReview, OrderDetail } from '@colosseum/schemas';
import type { ExecutionResult, ExecutorDeps } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, fire, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { CHECK_MS } from '../mix/DepositStep';
import { recallOrder } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import {
  LEG_CREATE,
  LEG_SWAP,
  ORDER_ID,
  orderOn,
  PLAN_ID,
  planOn,
  serverKeepsPlans,
  USER,
} from '../order/test/fixtures';
import { chainOf, portfolioOf, vault } from '../portfolio/test/portfolio';
import { preview } from '../vault-conversation/test/fixtures';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { holds } from '../wallet/test/mock-signing';
import { goalConversationKey } from './GoalConversation';
import { GoalHome } from './GoalHome';

// The deposit signed in place on /goal (gate DEPOSIT-IN-PLACE), with real events against a double of
// the API. Only `execute` of the SDK is a double, as in the invest card's own tests: what decides a
// signature (the order check, the guard, the record of what was approved) is the order screen's and
// the runner's, unchanged. Each state of the pane is read here: ready, signing, a failed step, a quote
// that ran out, done, and the same order taken up again after the page is opened again.

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
const MY_VAULT = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
const REPLY = '/v1/conversations/solana/goal/reply';
const ACCEPT = '/v1/conversations/solana/goal/accept';
const POINTER = `${goalConversationKey(USER, 'solana', 'sandbox')}:deposit`;
const stamp = {
  source: 'fixture',
  fetchedAt: '2026-10-05T12:00:00.000Z',
  method: 'test',
  provenance: 'sandbox' as const,
};

/** The server's review of the preview's two lines at the amount asked, with nothing to tick. */
const review = (body: { amountUsd: number; goal: string; risk: string }): MixReview =>
  ({
    chain: 'solana',
    origin: 'model',
    goal: body.goal,
    risk: body.risk,
    amountUsd: body.amountUsd,
    lines: [
      {
        assetId: 'solana:usdc',
        symbol: 'USDC',
        cls: 'cash',
        weightBps: 6000,
        amountUsd: body.amountUsd * 0.6,
        price: null,
        exitCeiling: null,
      },
      {
        assetId: 'solana:gldx',
        symbol: 'tGLDx',
        cls: 'gold',
        weightBps: 4000,
        amountUsd: body.amountUsd * 0.4,
        price: { usdPerToken: '20', ...stamp },
        exitCeiling: { usd: 1200, measured: true, ...stamp },
      },
    ],
    targets: [{ asset: 'solana:gldx', weightBps: 4000 }],
    cashBps: 6000,
    warnings: [],
    unconfirmed: [],
    reviewHash: 'ab'.repeat(32),
    provenance: 'sandbox',
    disclaimer: 'Test disclaimer',
  }) as MixReview;

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

type Call = { method: string; path: string; body?: Record<string, unknown> };

function api(o: { funded?: boolean; openFor?: number; hold?: Promise<void> } = {}) {
  const calls: Call[] = [];
  const kept = new Map<string, OrderDetail>();
  let made = 0;
  let replies = 0;
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  portStore.setApi(
    serverKeepsPlans(async (path, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (path === '/v1/me') return json(person);
      if (path === REPLY) {
        replies += 1;
        // the second reply waits for the test, so a reply can be on its way while the pane is open
        if (replies > 1 && o.hold) await o.hold;
        return json({
          version: 1,
          chain: 'solana',
          messageId: body.messageId,
          message: 'Here is a draft.',
          question: null,
          proposal: preview,
          goal: 'grow',
          risk: 'high',
        });
      }
      if (path === ACCEPT)
        return json(
          body.confirm
            ? {
                status: 'stored',
                review: review(body),
                proposalId: PLAN_ID,
                proposal: planOn().proposal,
              }
            : { status: 'review', review: review(body) },
        );
      if (path.startsWith('/v1/funding?')) return json(funding(o.funded ?? true));
      if (path === '/v1/orders' && method === 'POST') {
        const base = orderOn();
        const id = made === 0 ? base.id : `00000000-0000-4000-8000-00000000000${made}`;
        const order: OrderDetail = {
          ...base,
          id,
          approvalUrl: `/orders/${id}`,
          legs: base.legs.map((leg) => ({ ...leg, orderId: id })),
          ...(o.openFor !== undefined && made === 0
            ? { expiresAt: Math.floor((Date.now() + o.openFor) / 1000) }
            : {}),
        };
        made += 1;
        kept.set(order.id, order);
        return json(order);
      }
      if (path.startsWith('/v1/orders/') && method === 'GET' && !path.endsWith('/continue')) {
        const order = kept.get(path.slice('/v1/orders/'.length));
        return order ? json(order) : json({ error: 'not found' }, 404);
      }
      if (path.endsWith('/continue')) return json({}, 404);
      if (path === '/v1/portfolio')
        return json(
          portfolioOf(chainOf([vault({ basketId: basketOfPlan(PLAN_ID), address: MY_VAULT })])),
        );
      return json({ error: 'not found' }, 404);
    }),
  );
  return {
    calls,
    placed: () => calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST'),
    /** Our server's copy of an order, as it stands after steps landed. */
    change: (id: string, to: (order: OrderDetail) => OrderDetail) => {
      const order = kept.get(id);
      if (order) kept.set(id, to(order));
    },
  };
}

const standing = (order: OrderDetail, status: Record<string, string>): OrderDetail =>
  ({
    ...order,
    legs: order.legs.map((l) =>
      status[l.id] ? { ...l, status: status[l.id], txId: `sig-${l.seq}` } : l,
    ),
  }) as OrderDetail;

function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

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

const PRESS = '[data-ui="invest-card"] [data-variant="primary"]';
const label = (el: Element) =>
  el.querySelector('.grid > span:not([aria-hidden])')?.textContent ?? el.textContent;
const pane = (host: HTMLElement) => find(host, '[data-ui="deposit-sign"]');
const box = (host: HTMLElement) => find<HTMLTextAreaElement>(host, 'textarea');
const named = (host: ParentNode, name: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => label(b) === name);
  if (!button) throw new Error(`no button named ${name}`);
  return button;
};
const show = async () => {
  const host = await mount(withAccount('en', createElement(GoalHome)));
  await settle();
  return host;
};
const say = async (host: HTMLElement, words: string) => {
  await type(box(host), words);
  await click(find(host, '[data-ui="composer-send"]'));
  await settle();
};
/** From the conversation to the confirmed review: the steps to sign are on the pane, unpressed. */
async function toSteps(host: HTMLElement) {
  await say(host, 'Gold and cash, to grow, at high risk');
  await click(find(host, '[data-action="deposit"]'));
  await type(find<HTMLInputElement>(host, '[data-ui="amount-large"] input'), '10');
  await settle(CHECK_MS + 50);
  await click(find(host, '[data-action="deposit-review"]'));
  await settle();
  await click(find(host, '[data-action="mix-confirm"]'));
  await settle();
  // the wallet is read, then the order is made for the amount
  await settle(350);
  await settle(1050);
  await settle();
}
const tick = (host: HTMLElement) =>
  click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));

beforeEach(() => {
  installLocks();
  window.history.replaceState(null, '', '/goal');
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  run.calls.length = 0;
  run.script = null;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the deposit signed in place on /goal', () => {
  it('shows the steps to sign in the same pane, with everything the plan’s own page shows, and the amount as a fact', async () => {
    const server = api();
    const host = await show();
    await toSteps(host);
    const sign = pane(host);
    expect(sign.getAttribute('data-state')).toBe('ready');
    expect(document.activeElement?.textContent).toBe(en.mix.deposit.signing.title);
    // the amount is the one typed on the deposit step: said, with the way back, and never asked again
    const amount = find(sign, '[data-ui="deposit-sign-amount"]');
    expect(amount.textContent).toContain(en.mix.deposit.signing.amount);
    expect(amount.textContent).toContain('$10');
    expect(sign.querySelector('input[inputmode="decimal"]')).toBeNull();
    // the order our server made for the stored plan, at that amount
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'buy', owner: { solana: SOLANA }, amountUsd: 10, proposalId: PLAN_ID },
    ]);
    // what the plan's own page shows before the press, all of it here
    expect(find(sign, '[data-ui="data-note"]').textContent).toBe(
      en.buy.steps.note.testNetwork('Solana'),
    );
    expect(find(sign, '[data-ui="trust-notice"]').textContent).toContain(en.trust.unaudited);
    const steps = [...sign.querySelectorAll('[data-ui="order-step"]')].map((s) => s.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain(`${en.order.step(1)} · ${en.order.kind.create_vault}`);
    expect(steps[0]).toContain('10 USDC');
    // a step that swaps is headed by what it receives, and says exactly what it does
    expect(steps[1]).toContain(`${en.order.step(2)} · SPYx`);
    expect(steps[1]).toContain(en.order.review.spend('6 USDC', 'SPYx'));
    expect(steps[1]).toContain(en.order.review.atLeastWhole('0.0099 SPYx'));
    expect(sign.textContent).toContain(en.order.review.deposit);
    expect(sign.textContent).toContain(en.order.review.steps);
    expect(sign.textContent).toContain(en.order.review.expires);
    expect(find(sign, '[data-ui="invest-signing"]').textContent).toBe(en.invest.signs.passkey(2));
    expect(label(find(host, PRESS))).toBe(en.invest.press('$10'));
    // held by the notice, and nothing asked of the wallet before the press
    expect(find(host, PRESS).getAttribute('aria-disabled')).toBe('true');
    expect(run.calls).toEqual([]);
    expect(recallOrder(ORDER_ID, USER)?.approved).toBeNull();
    // the conversation is still the person's, and nothing is kept for a reload: nothing is approved
    expect(box(host).disabled).toBe(false);
    expect(localStorage.getItem(POINTER)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    // "Change" leads back to the amount on the deposit step, and the unsigned order is dropped
    await click(named(sign, en.mix.deposit.signing.change));
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(find<HTMLInputElement>(host, '[data-ui="amount-large"] input').value).toBe('10');
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
  });

  it('signs every step there: the box waits and says why, the progress is said, and the end leads to the vault', async () => {
    api();
    const first = gate();
    const second = gate();
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'signing' } as never);
      await first.wait;
      const deposited = standing(order, { [LEG_CREATE]: 'confirmed' });
      deps.onEvent?.({ order: deposited, legId: LEG_SWAP, phase: 'signing' } as never);
      await second.wait;
      const all = standing(deposited, { [LEG_SWAP]: 'confirmed' });
      return { status: 'done', order: { ...all, status: 'done' } };
    };
    const host = await show();
    await toSteps(host);
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // one run, of the order exactly as the pane showed it
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.order).toEqual(orderOn());
    expect(holds.open).toBe(1);
    expect(pane(host).getAttribute('data-state')).toBe('signing');
    expect(find(host, '[data-ui="invest-progress"]').textContent).toContain(
      en.invest.progress.line(null, en.invest.progress.depositing, 1, 2),
    );
    // the amount is no longer changed, the box is inert and says why, and the deposit is kept
    expect(pane(host).textContent).not.toContain(en.mix.deposit.signing.change);
    expect(box(host).disabled).toBe(true);
    expect(find(host, '[data-ui="goal-chat"]').textContent).toContain(
      en.goal.explore.deposit.signing,
    );
    expect(JSON.parse(localStorage.getItem(POINTER) ?? '{}')).toEqual({
      planId: PLAN_ID,
      orderId: ORDER_ID,
      amountUsd: 10,
    });
    first.open();
    await settle();
    expect(find(host, '[data-ui="invest-progress"]').textContent).toContain(
      en.invest.progress.line(
        en.invest.progress.deposited,
        en.invest.progress.buying('SPYx'),
        2,
        2,
      ),
    );
    second.open();
    await settle();
    await settle();
    await settle();
    expect(holds.open).toBe(0);
    const sign = pane(host);
    expect(sign.getAttribute('data-state')).toBe('done');
    expect(find(host, '[data-ui="order-status"]').textContent).toContain(
      en.order.outcome.done('Solana'),
    );
    // what was sent is linked, step by step
    expect(sign.querySelectorAll('[data-ui="order-step"] a')).toHaveLength(2);
    // one way on, to the vault's own page; the card draws no link of its own
    const open = find<HTMLAnchorElement>(sign, '[data-action="open-vault"]');
    expect(open.textContent).toBe(en.mix.deposit.signing.openVault);
    expect(open.getAttribute('href')).toBe(`/vaults/solana/${MY_VAULT}`);
    expect(sign.querySelector('[data-ui="order-next"]')).toBeNull();
    // the conversation is the person's again, and nobody was sent anywhere
    expect(box(host).disabled).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(run.calls).toHaveLength(1);
  });

  it('a step that fails: says what landed, never sends it again, and the box waits until the deposit is left', async () => {
    const server = api();
    run.script = async (order) => {
      const failed = standing(order, { [LEG_CREATE]: 'confirmed', [LEG_SWAP]: 'failed' });
      return {
        status: 'failed',
        order: { ...failed, status: 'failed' },
        legId: LEG_SWAP,
        error: { code: 'PriceMoved', message: 'the price moved', retryable: false },
      } as never;
    };
    const host = await show();
    await toSteps(host);
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    await settle();
    await settle();
    const sign = pane(host);
    expect(sign.getAttribute('data-state')).toBe('approved');
    expect(find(sign, '[data-ui="invest-landed"]').textContent).toBe(
      en.invest.stopped.some('the deposit', 'SPYx'),
    );
    expect(sign.textContent).toContain(en.order.outcome.failed(2));
    expect(find(sign, '[data-ui="order-step"][data-status="failed"]').textContent).toContain(
      en.order.notRetried,
    );
    // nothing runs again by itself, and no other order is made
    await settle(600);
    expect(run.calls).toHaveLength(1);
    expect(server.placed()).toHaveLength(1);
    // the box still waits, and says how to get it back
    expect(box(host).disabled).toBe(true);
    expect(find(host, '[data-ui="goal-chat"]').textContent).toContain(en.goal.explore.deposit.open);
    await click(find(sign, '[data-action="leave-deposit"]'));
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(box(host).disabled).toBe(false);
    expect(localStorage.getItem(POINTER)).toBeNull();
    // the order itself is kept: its own page has the rest
    expect(recallOrder(ORDER_ID, USER)?.approved).not.toBeNull();
  });

  it('a quote that runs out before the press: said, with a fresh check on asking and none by itself', async () => {
    const server = api({ openFor: 2_500 });
    const host = await show();
    await toSteps(host);
    expect(pane(host).querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    await settle(2_600);
    expect(pane(host).querySelector('[data-ui="order-step"]')).toBeNull();
    expect(find(host, '[data-ui="invest-old"]').textContent).toBe(en.invest.old);
    await settle(1_200);
    expect(server.placed()).toHaveLength(1);
    await click(named(pane(host), en.invest.again));
    await settle(1050);
    await settle();
    expect(server.placed()).toHaveLength(2);
    expect(pane(host).querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    expect(run.calls).toEqual([]);
  }, 20_000);

  it('opened again in the middle of signing: the same order, its steps where they were, and no second deposit', async () => {
    const server = api();
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'signing' } as never);
      const deposited = standing(order, { [LEG_CREATE]: 'confirmed' });
      deps.onEvent?.({ order: deposited, legId: LEG_SWAP, phase: 'signing' } as never);
      return { status: 'waiting', order: deposited, legId: LEG_SWAP, why: 'stopped' } as never;
    };
    const host = await show();
    await toSteps(host);
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    await settle();
    // our server has the deposit confirmed; the page is lost and opened again
    server.change(ORDER_ID, (order) => standing(order, { [LEG_CREATE]: 'confirmed' }));
    await unmountAll();
    const again = await show();
    await settle();
    await settle();
    const sign = pane(again);
    expect(sign.getAttribute('data-state')).toBe('approved');
    expect(sign.textContent).toContain(en.mix.deposit.signing.resumed);
    expect(find(sign, '[data-ui="deposit-sign-amount"]').textContent).toContain('$10');
    const steps = [...sign.querySelectorAll('[data-ui="order-step"]')];
    expect(steps.map((s) => s.getAttribute('data-status'))).toEqual(['confirmed', 'planned']);
    // no other order, and nothing read of the wallet for one: the deposit is not made twice
    expect(server.placed()).toHaveLength(1);
    expect(label(find(again, PRESS))).toBe(en.order.resume('$10'));
    expect(box(again).disabled).toBe(true);
    // the same approved order goes on from where it is
    run.script = async (order) => {
      const all = standing(order, { [LEG_CREATE]: 'confirmed', [LEG_SWAP]: 'confirmed' });
      return { status: 'done', order: { ...all, status: 'done' } };
    };
    await click(find(again, PRESS));
    await settle();
    await settle();
    await settle();
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.order).toEqual(orderOn());
    expect(pane(again).getAttribute('data-state')).toBe('done');
    expect(find(again, '[data-action="open-vault"]').getAttribute('href')).toBe(
      `/vaults/solana/${MY_VAULT}`,
    );
    expect(server.placed()).toHaveLength(1);
  });

  it('takes up nothing a reload cannot stand on: ids with no approved order of this person’s are dropped', async () => {
    api();
    const key = goalConversationKey(USER, 'solana', 'sandbox');
    localStorage.setItem(
      key,
      JSON.stringify({ revision: 0, transcript: [{ id: 'a', who: 'person', text: 'Gold' }] }),
    );
    localStorage.setItem(
      POINTER,
      JSON.stringify({ planId: PLAN_ID, orderId: ORDER_ID, amountUsd: 10 }),
    );
    const host = await show();
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(localStorage.getItem(POINTER)).toBeNull();
    expect(box(host).disabled).toBe(false);
  });

  it('asks before a deposit that is open is left: "Start over" and the picker', async () => {
    api();
    const stop = gate();
    run.script = async (order, deps) => {
      deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'signing' } as never);
      await stop.wait;
      return { status: 'waiting', order, legId: LEG_CREATE, why: 'stopped' } as never;
    };
    const host = await show();
    await toSteps(host);
    await tick(host);
    await click(find(host, PRESS));
    await settle();
    // the picker: another conversation is asked for twice
    const picker = find<HTMLSelectElement>(host, '[data-ui="goal-picker"]');
    picker.value = 'new';
    await fire(picker, new Event('change', { bubbles: true }));
    let ask = find(host, '[data-ui="leave-deposit"]');
    expect(ask.getAttribute('role')).toBe('alertdialog');
    expect(document.activeElement).toBe(find(ask, '[data-action="stay"]'));
    await click(find(ask, '[data-action="stay"]'));
    expect(host.querySelector('[data-ui="leave-deposit"]')).toBeNull();
    expect(pane(host).getAttribute('data-state')).toBe('signing');
    // "Start over": asked, and the step under way is said
    await click(named(host, en.talk.startOver));
    ask = find(host, '[data-ui="leave-deposit"]');
    expect(ask.textContent).toContain(en.goal.explore.deposit.leaveSigning);
    expect(pane(host).getAttribute('data-state')).toBe('signing');
    await click(find(ask, '[data-action="leave"]'));
    await settle();
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(host.querySelector('[data-ui="goal-empty-preview"]')).not.toBeNull();
    expect(localStorage.getItem(POINTER)).toBeNull();
    // the run was told to stop between steps, and the approved order is kept for its own page
    expect(run.calls[0]?.deps.signal?.aborted).toBe(true);
    expect(recallOrder(ORDER_ID, USER)?.approved).not.toBeNull();
    stop.open();
    await settle();
  });

  it('holds the press while a reply is on its way, so no proposal can take the pane from under a step', async () => {
    const reply = gate();
    api({ hold: reply.wait });
    const host = await show();
    await toSteps(host);
    await tick(host);
    await type(box(host), 'more gold');
    await click(find(host, '[data-ui="composer-send"]'));
    const sign = pane(host);
    expect(find(sign, '[data-ui="deposit-sign-waiting"]').textContent).toBe(
      en.mix.deposit.blocked.reply,
    );
    expect(find(sign, PRESS).closest('[inert]')).not.toBeNull();
    expect(run.calls).toEqual([]);
    reply.open();
    await settle();
    // the reply's proposal is read as a preview first: the unsigned order goes with the pane
    expect(host.querySelector('[data-ui="deposit-sign"]')).toBeNull();
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
  });
});

// @vitest-environment happy-dom
import { DISCLAIMER, type OrderDetail } from '@colosseum/schemas';
import {
  basketIdOfLinkedPlan,
  basketIdOfPlan,
  deploymentsOf,
  type ExecutionResult,
  type ExecutorDeps,
  GuardRefusal,
} from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonClass } from '../../components/ui/button-class';
import { CHAIN_NAMES } from '../../components/ui/ChainBadge';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { OrderScreen } from './OrderScreen';
import { recallOrder } from './order-record';
import { doneOrder, LEG_SWAP, ORDER_ID, orderOn, PLAN_ID, recordOf, USER } from './test/fixtures';

// The order screen with real events, on the real runner (run-order.ts) and the real deployments of
// packages/sdk. Only `execute` is a double: it answers what each test needs and records what it was
// handed, so these tests see exactly what the screen gives the executor, and what it shows for each
// answer. The executor itself, with the real guard on real bytes, is tested in packages/sdk and on the
// mock chain end to end (apps/web/e2e).

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
  answer: (async () => {
    throw new Error('no answer set');
  }) as (order: OrderDetail, deps: ExecutorDeps) => Promise<ExecutionResult>,
}));

vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return run.answer(order, deps);
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');

/** The browser's locks, as `navigator.locks` gives them: one holder per name, `ifAvailable` honoured. */
function installLocks() {
  const held = new Set<string>();
  const locks = {
    async request(
      name: string,
      options: { ifAvailable?: boolean },
      work: (lock: { name: string } | null) => Promise<unknown>,
    ) {
      if (held.has(name)) {
        if (options.ifAvailable) return work(null);
        throw new Error('this double only takes ifAvailable');
      }
      held.add(name);
      try {
        return await work({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

const person = (chain: 'solana' | 'robinhood' | 'base'): Person => ({
  userId: USER,
  wallets: EMBEDDED,
  chain,
  chainSource: 'picked',
  chainOptions: [],
});

/** The API: GET /v1/me, and GET /v1/orders/{id} with the order given. */
function api(order: OrderDetail, chain: 'solana' | 'robinhood' | 'base' = 'solana') {
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json(person(chain));
    if (path === `/v1/orders/${ORDER_ID}`) return json(order);
    return json({ error: 'not found' }, 404);
  });
}

function seed(record = recordOf()) {
  window.localStorage.setItem(`tf-order:${ORDER_ID}`, JSON.stringify(record));
}

const screen = async () => {
  const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
  await settle();
  await settle();
  return host;
};
/** The view's one primary action: the button, or the link styled as one. */
const primary = (host: HTMLElement) =>
  (host.querySelector<HTMLElement>('[data-variant="primary"]') ??
    [...host.querySelectorAll<HTMLElement>('a')].find((a) =>
      a.className.includes(buttonClass({ variant: 'primary' })),
    )) as HTMLElement;
/** What a button says at rest: a busy button holds both labels and hides the one not in use. */
const label = (el: HTMLElement) =>
  el.querySelector('.grid > span:not([aria-hidden])')?.textContent ?? el.textContent;
const status = (host: HTMLElement) =>
  host.querySelector('[data-ui="order-status"]')?.textContent ?? '';

beforeEach(() => {
  window.localStorage.clear();
  run.calls.length = 0;
  installLocks();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the review', () => {
  it('shows every step with what it spends and the least each trade receives, and one button that names the amount', async () => {
    api(orderOn());
    seed();
    const host = await screen();
    expect(host.querySelector('h1')?.textContent).toBe(en.order.review.title);
    const steps = [...host.querySelectorAll('[data-ui="order-step"]')].map((s) => s.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain(en.order.kind.create_vault);
    // in whole units, with the symbols the test network's deploy recorded
    expect(steps[0]).toContain('10 tUSDC');
    expect(steps[1]).toContain(en.order.review.spend('6 tUSDC', 'tSPYx'));
    expect(steps[1]).toContain(en.order.review.atLeastWhole('0.0099 tSPYx'));
    expect(steps[1]).toContain(en.order.review.under('1%'));
    expect(label(primary(host))).toBe(en.order.signAndBuy('$10'));
    // on a test network: the hatch and one quiet line that says so, never the word MOCK
    expect(host.textContent).not.toContain('MOCK');
    expect(host.querySelector('[data-ui="sample-note"]')?.textContent).toBe(
      `${en.shell.mockAnnounce} · ${en.shell.testNetwork}`,
    );
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    expect(run.calls).toHaveLength(0);
  });

  it('hands the executor the order exactly as shown, and what the README lists beside it', async () => {
    api(orderOn());
    seed();
    run.answer = async (order) => ({ status: 'done', order: doneOrder() ?? order });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(1);
    const [{ order, deps }] = run.calls as [{ order: OrderDetail; deps: ExecutorDeps }];
    expect(order).toEqual(orderOn());
    // the signer is the whole port, which the screen itself never holds
    expect(deps.signer).toBe(portStore.get());
    // the deployments are the ones packages/sdk loaded from the test network's committed file
    expect(deps.deployments).toEqual(deploymentsOf('testnet'));
    expect(deps.plan).toEqual({
      basketId: basketIdOfPlan(PLAN_ID),
      targets: [
        { asset: 'solana:spyx', weightBps: 6000 },
        { asset: 'solana:gldx', weightBps: 3500 },
      ],
      autoFollow: false,
    });
    expect(deps.consents).toEqual([]);
    expect(deps.approvedAgain).toBeUndefined();
    // what is signed is kept in local storage, under the executor's own key
    deps.signed.set('k', { times: 1, chain: 'solana', messageHash: 'h', proof: null });
    expect(JSON.parse(window.localStorage.getItem('tf-signed:k') ?? 'null')).toMatchObject({
      times: 1,
    });
    // and the order the person approved is kept, so a reload runs the same one
    expect(recallOrder(ORDER_ID, USER)?.approved?.order).toEqual(orderOn());
  });

  it('names the buyer’s own vault for a plan made from a link, never the one the link gives', async () => {
    api(orderOn());
    seed({ ...recordOf(), linked: true });
    run.answer = async (order) => ({ status: 'done', order: doneOrder() ?? order });
    const host = await screen();
    await click(primary(host));
    await settle();
    const [{ deps }] = run.calls as [{ order: OrderDetail; deps: ExecutorDeps }];
    // the number the API gives this buyer's vault (gate AGENT-LINK): from the plan and the person
    expect(deps.plan.basketId).toBe(basketIdOfLinkedPlan(PLAN_ID, USER));
    expect(deps.plan.basketId).not.toBe(basketIdOfPlan(PLAN_ID));
    expect(deps.plan.basketId).not.toBe(basketIdOfLinkedPlan(PLAN_ID, 'did:privy:someone-else'));
  });

  it('takes the vault’s number from the order when it is one this app works out, and no other', async () => {
    // the order states the buyer's own number for a plan made from a link: it is used, whatever this
    // browser kept about the plan
    api({ ...orderOn(), basketId: basketIdOfLinkedPlan(PLAN_ID, USER) });
    seed();
    run.answer = async (order) => ({ status: 'done', order: doneOrder() ?? order });
    let host = await screen();
    await click(primary(host));
    await settle();
    const [{ deps }] = run.calls as [{ order: OrderDetail; deps: ExecutorDeps }];
    expect(deps.plan.basketId).toBe(basketIdOfLinkedPlan(PLAN_ID, USER));
    await unmountAll();
    window.localStorage.clear();
    run.calls.length = 0;
    // a number that is neither the plan's nor this person's own is not signed for, and for a plan this
    // browser kept as one from a link, the plan's shared number is not either
    for (const [basketId, record] of [
      [basketIdOfLinkedPlan(PLAN_ID, 'did:privy:someone-else'), recordOf()],
      ['42', recordOf()],
      [basketIdOfPlan(PLAN_ID), { ...recordOf(), linked: true as const }],
    ] as const) {
      api({ ...orderOn(), basketId });
      seed(record);
      host = await screen();
      await click(primary(host));
      await settle();
      expect(run.calls).toHaveLength(0);
      expect(host.textContent).toContain(en.order.outcome.notRunnable['plan-mismatch']);
      await unmountAll();
      window.localStorage.clear();
    }
  });

  it('shows each confirmed step with its explorer link once the order is done', async () => {
    api(orderOn());
    seed();
    run.answer = async () => ({ status: 'done', order: doneOrder() });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(status(host)).toBe(en.order.outcome.done('Solana'));
    // the links are built from this app's own chain table: devnet's explorer, whatever the API sent
    const links = [
      ...host.querySelectorAll('[data-ui="order-step"] a[href^="https://solscan.io/"]'),
    ];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://solscan.io/tx/sig0?cluster=devnet',
      'https://solscan.io/tx/sig1?cluster=devnet',
    ]);
    expect(host.querySelector('a[href^="https://explorer.example/"]')).toBeNull();
    // and his activity lines, beside the disclaimer: one per step that reached the chain, each with
    // its link
    const activity = find(host, '[data-ui="activity-panel"]');
    const lines = [...activity.querySelectorAll('[data-ui="execution-list"] li')];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.getAttribute('data-status')).toBe('confirmed');
      expect(line.querySelector('a[href^="https://solscan.io/tx/"]')).not.toBeNull();
    }
    expect(find(activity, '[data-ui="disclaimer"]').textContent).toContain(DISCLAIMER.en);
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
  });
});

describe('an order that does not move what the person asked for', () => {
  /** The review's hostile answer: a buy of $40, and an order that deposits 40,000 dollars of cash. */
  function hostile(): OrderDetail {
    const order = orderOn();
    return {
      ...order,
      depositRaw: '40000000000',
      legs: order.legs.map((leg) =>
        leg.cashRaw === undefined ? leg : { ...leg, cashRaw: '40000000000' },
      ),
    };
  }

  it('shows the deposit the order states, in committed units, and offers nothing to sign', async () => {
    api(hostile());
    seed(recordOf('solana', { amountUsd: 40 }));
    const host = await screen();
    expect(host.querySelector('[data-ui="stat"]')?.textContent).toContain('40,000 tUSDC');
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(host.textContent).not.toContain(en.order.signAndBuy('$40'));
    expect(find(host, '[role="alert"]').textContent).toBe(en.order.mismatch.deposit);
    expect(run.calls).toHaveLength(0);
  });

  it('reads every amount with the deployment file’s decimals, whatever decimals the answer states', async () => {
    // an answer that says its tokens have 9 decimals: 10,000,000 raw tUSDC would read as 0.01 with them
    const order = orderOn();
    const says9 = {
      ...order,
      decimals: 9,
      cashDecimals: 9,
      legs: order.legs.map((leg) => ({
        ...leg,
        decimals: 9,
        ...(leg.kind === 'swap'
          ? { trades: leg.trades.map((t) => ({ ...t, decimals: 9, outDecimals: 9 })) }
          : {}),
      })),
    } as OrderDetail;
    api(says9);
    seed();
    const host = await screen();
    const steps = [...host.querySelectorAll('[data-ui="order-step"]')].map((s) => s.textContent);
    expect(steps[0]).toContain('10 tUSDC');
    expect(steps[1]).toContain(en.order.review.spend('6 tUSDC', 'tSPYx'));
    expect(steps[1]).toContain(en.order.review.atLeastWhole('0.0099 tSPYx'));
    expect(host.querySelector('[data-ui="stat"]')?.textContent).toContain('10 tUSDC');
    expect(label(primary(host))).toBe(en.order.signAndBuy('$10'));
  });

  it('runs nothing after a reload either, whatever was kept as approved', async () => {
    api(hostile());
    seed(
      recordOf('solana', {
        amountUsd: 40,
        approved: { order: hostile(), consents: [], at: '2026-10-05T12:00:00Z' },
      }),
    );
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(run.calls).toHaveLength(0);
  });

  it('offers nothing when a step moves more cash than the deposit', async () => {
    const order = orderOn();
    const greedy = {
      ...order,
      legs: order.legs.map((leg) =>
        leg.kind === 'swap'
          ? { ...leg, trades: leg.trades.map((t) => ({ ...t, amountInRaw: '20000000' })) }
          : leg,
      ),
    };
    api(greedy);
    seed();
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(en.order.mismatch.steps);
  });
});

describe('what the executor answers', () => {
  it('says why a step the guard refused was not signed, and offers a new order', async () => {
    api(orderOn());
    seed();
    run.answer = async (order) => ({
      status: 'refused',
      order,
      legId: LEG_SWAP,
      refusal: new GuardRefusal(
        'minimum',
        'the least the trade pays out is not the step’s',
        LEG_SWAP,
      ),
    });
    const host = await screen();
    await click(primary(host));
    await settle();
    const said = status(host);
    expect(said).toContain(en.order.outcome.refused(2));
    expect(said).toContain(en.order.outcome.refusedWhy.moved);
    expect(said).toContain(en.order.outcome.check('minimum'));
    // the region that says it is read out as it changes
    expect(host.querySelector('[data-ui="order-status"]')?.getAttribute('aria-live')).toBe(
      'polite',
    );
    const next = primary(host);
    expect(label(next)).toBe(en.order.outcome.newOrder);
    expect(next.getAttribute('href')).toBe(`/plan/${PLAN_ID}/buy`);
  });

  it('asks again after needs_review, and hands that answer back only once the person approves', async () => {
    api(orderOn());
    seed();
    run.answer = async (order) => ({
      status: 'needs_review',
      order,
      legId: LEG_SWAP,
      signedTimes: 1,
      why: 'unproven',
    });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(status(host)).toContain(en.order.outcome.needsReview(2, 1));
    expect(run.calls[0]?.deps.approvedAgain).toBeUndefined();
    expect(label(primary(host))).toBe(en.order.outcome.approveAgain(2));
    run.answer = async () => ({ status: 'done', order: doneOrder() });
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.deps.approvedAgain).toEqual({ legId: LEG_SWAP, signedTimes: 1 });
    // the same order as the first time, not a fresh read of it
    expect(run.calls[1]?.order).toEqual(run.calls[0]?.order);
  });

  it('lets the person try again after the wallet declined, with no approval carried over', async () => {
    api(orderOn());
    seed();
    run.answer = async (order) => ({
      status: 'cancelled',
      order,
      legId: LEG_SWAP,
      wallet: { code: 'rejected', message: 'no' },
    });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(status(host)).toContain(en.order.outcome.cancelled(2));
    expect(label(primary(host))).toBe(en.order.outcome.tryAgain);
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]?.deps.approvedAgain).toBeUndefined();
  });

  it('says a reverted step is not sent again', async () => {
    api(orderOn());
    seed();
    run.answer = async (order) => ({ status: 'failed', order, legId: LEG_SWAP, error: null });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(status(host)).toContain(en.order.outcome.failed(2));
    expect(label(primary(host))).toBe(en.order.outcome.newOrder);
  });
});

describe('one run of an order at a time', () => {
  it('runs nothing in a second tab while the first is running the same order', async () => {
    api(orderOn());
    seed();
    let finish: (r: ExecutionResult) => void = () => {};
    run.answer = () =>
      new Promise((done) => {
        finish = done;
      });
    const first = await screen();
    const second = await screen();
    await click(primary(first));
    await settle();
    // the first is busy: its button says so and is still the same button
    expect(primary(first).getAttribute('aria-busy')).toBe('true');
    await click(primary(second));
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(status(second)).toBe(en.order.outcome.elsewhere);
    finish({ status: 'done', order: doneOrder() });
    await settle();
    expect(status(first)).toBe(en.order.outcome.done('Solana'));
  });

  it('signs nothing in a browser that cannot keep an order to one tab', async () => {
    api(orderOn());
    seed();
    Object.defineProperty(window.navigator, 'locks', { value: undefined, configurable: true });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(0);
    expect(status(host)).toContain(en.order.outcome.notRunnable['no-lock']);
  });
});

describe('what a run is handed after a reload', () => {
  it('is the order the person approved, whatever the API answers now', async () => {
    const approved = orderOn();
    seed(
      recordOf('solana', {
        approved: { order: approved, consents: [], at: '2026-10-05T12:00:00Z' },
      }),
    );
    // the API now answers with another minimum for the same step
    api(orderOn('solana', '1'));
    run.answer = async () => ({ status: 'done', order: doneOrder() });
    const host = await screen();
    expect(label(primary(host))).toBe(en.order.resume('$10'));
    await click(primary(host));
    await settle();
    expect(run.calls[0]?.order).toEqual(approved);
  });

  it('says the order was made elsewhere, and signs nothing, when this browser does not have its plan', async () => {
    api(orderOn());
    const host = await screen();
    expect(host.textContent).toContain(en.order.elsewhere);
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
  });
});

describe('a buy on Robinhood Chain', () => {
  it('reviews the approval of the deposit, then the create that buys, in the record’s units', async () => {
    api(orderOn('robinhood'), 'robinhood');
    seed(recordOf('robinhood'));
    const host = await screen();
    const steps = [...host.querySelectorAll('[data-ui="order-step"]')].map((s) => s.textContent);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain(en.order.kind.approve);
    expect(steps[0]).toContain('10 tUSDG');
    expect(steps[1]).toContain(en.order.kind.create_vault);
    expect(steps[1]).toContain('10 tUSDG');
    expect(steps[1]).toContain(en.order.review.spend('6 tUSDG', 'tSPY'));
    expect(label(primary(host))).toBe(en.order.signAndBuy('$10'));
    expect(host.textContent).toContain(en.shell.testNetwork);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(run.calls).toHaveLength(0);
  });

  it('hands the executor the order as shown and the test network’s deployment, Robinhood Chain in it', async () => {
    api(orderOn('robinhood'), 'robinhood');
    seed(recordOf('robinhood'));
    // an API that names mainnet's explorer for each step: the links are the test network's all the same
    const done = doneOrder('robinhood');
    run.answer = async () => ({
      status: 'done',
      order: {
        ...done,
        legs: done.legs.map((l) => ({
          ...l,
          explorerUrl: `https://explorer.chain.robinhood.com/tx/${l.txId}`,
        })),
      },
    });
    const host = await screen();
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(1);
    const [{ order, deps }] = run.calls as [{ order: OrderDetail; deps: ExecutorDeps }];
    expect(order).toEqual(orderOn('robinhood'));
    expect(deps.deployments).toEqual(deploymentsOf('testnet'));
    expect(deps.deployments.robinhood?.family).toBe('evm');
    expect(deps.plan).toEqual({
      basketId: basketIdOfPlan(PLAN_ID),
      targets: [
        { asset: 'robinhood:tspy', weightBps: 6000 },
        { asset: 'robinhood:tgld', weightBps: 3500 },
      ],
      autoFollow: false,
    });
    // done, with each step's link on the test network's explorer
    expect(status(host)).toBe(en.order.outcome.done('Robinhood Chain'));
    const links = [
      ...host.querySelectorAll(
        '[data-ui="order-step"] a[href^="https://explorer.testnet.chain.robinhood.com/tx/"]',
      ),
    ];
    expect(links).toHaveLength(2);
    expect(host.querySelector('a[href^="https://explorer.chain.robinhood.com/"]')).toBeNull();
  });
});

describe('a chain that is not ready', () => {
  it('signs nothing on a chain whose deployment is not committed, and says so', async () => {
    window.localStorage.clear();
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    api(orderOn('base'), 'base');
    seed(recordOf('base'));
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(run.calls).toHaveLength(0);
    expect(find(host, '[role="alert"]').textContent).toBe(
      en.order.outcome.notRunnable['no-deployment']('Base'),
    );
  });
});

describe.each([
  ['solana', 'Solscan'],
  ['robinhood', 'Robinhood explorer'],
] as const)('the chain of an order on %s', (chain, explorer) => {
  it('is badged once, over the review, and a Robinhood order never says USDC', async () => {
    api(orderOn(chain), chain);
    seed(recordOf(chain));
    const host = await screen();
    const badges = [...host.querySelectorAll('[data-ui="chain-badge"]')];
    expect(badges.map((b) => b.getAttribute('data-chain'))).toEqual([chain]);
    expect(badges.map((b) => b.textContent)).toEqual([CHAIN_NAMES[chain]]);
    // over the page, and not again in the head of its steps (CHAIN-EVERYWHERE, as amended)
    expect(find(host, 'header [data-ui="chain-badge"]')).toBeTruthy();
    expect(host.querySelector('[data-ui="card-header"] [data-ui="chain-badge"]')).toBeNull();
    if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
  });

  it('names the explorer beside each step’s link, and badges each line of the activity', async () => {
    api(orderOn(chain), chain);
    seed(recordOf(chain));
    run.answer = async () => ({ status: 'done', order: doneOrder(chain) });
    const host = await screen();
    await click(primary(host));
    await settle();
    const names = [...host.querySelectorAll('[data-ui="explorer-name"]')].map((n) => n.textContent);
    // a link per step, and a line per step in the activity
    expect(names).toHaveLength(4);
    expect(new Set(names)).toEqual(new Set([explorer]));
    const lines = [...host.querySelectorAll('[data-ui="execution-list"] li')];
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(line.querySelector('[data-ui="chain-badge"]')?.getAttribute('data-chain')).toBe(chain);
    if (chain === 'robinhood') expect(host.textContent).not.toMatch(/usdc/i);
  });
});

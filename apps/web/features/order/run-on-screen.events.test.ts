// @vitest-environment happy-dom
import { type OrderDetail, TRUST_STATUS } from '@colosseum/schemas';
import type { ExecutionResult, ExecutorDeps } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, fakePort, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { Invest } from './Invest';
import { OrderScreen } from './OrderScreen';
import {
  LEG_CREATE,
  LEG_SWAP,
  ORDER_ID,
  orderOn,
  PLAN_ID,
  planOn,
  recordOf,
  serverKeepsPlans,
  USER,
} from './test/fixtures';

// A run is only ever under way with its steps on the screen (the first blocker of #167's review).
// Real events on the real order screen, card and runner; only `execute` is a double, so each test
// reads the signal the executor was handed: set, the executor asks the wallet for nothing more
// (packages/sdk/src/executor/execute.test.ts, "asked to stop while a step is ..."). The API handed
// to the screens changes with the wallet's port, as the real provider's does (`useApiFetch`), so a
// wallet that reports again reads the order again here too.

type Script = (order: OrderDetail, deps: ExecutorDeps) => Promise<ExecutionResult>;
const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
  script: null as Script | null,
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return (run.script as Script)(order, deps);
  },
}));
vi.mock('../wallet/WalletProvider', async () => {
  const double = await import('../wallet/test/mock-provider');
  const { useCallback } = await import('react');
  return {
    ...double,
    useApiFetch: () => {
      const port = double.useWalletPort();
      // biome-ignore lint/correctness/useExhaustiveDependencies: a new function for each port, as in WalletProvider.tsx
      return useCallback<typeof double.portStore.api>(
        (path, init) => double.portStore.api(path, init),
        [port],
      );
    },
  };
});
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

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

/** A promise the test settles when it wants the executor to go on. */
function gate() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const standing = (order: OrderDetail, status: Record<string, string>): OrderDetail =>
  ({
    ...order,
    legs: order.legs.map((l) =>
      status[l.id] ? { ...l, status: status[l.id], txId: `sig-${l.seq}` } : l,
    ),
  }) as OrderDetail;

/**
 * The executor's double: the deposit is under way until the test lets it land, then it stops if it
 * was asked to, as the real one does, and goes on to the trade if it was not.
 */
function depositing() {
  const landed = gate();
  const signed: string[] = [];
  run.script = async (order, deps) => {
    signed.push(LEG_CREATE);
    deps.onEvent?.({ order, legId: LEG_CREATE, phase: 'landing' } as never);
    await landed.wait;
    const deposited = standing(order, { [LEG_CREATE]: 'confirmed' });
    if (deps.signal?.aborted)
      return { status: 'waiting', order: deposited, legId: LEG_SWAP, why: 'stopped' } as never;
    signed.push(LEG_SWAP);
    return {
      status: 'done',
      order: { ...standing(deposited, { [LEG_SWAP]: 'confirmed' }), status: 'done' },
    };
  };
  return { landed, signed };
}

const signal = () => run.calls[0]?.deps.signal;
const steps = (host: HTMLElement) => host.querySelectorAll('[data-ui="order-step"]').length;

beforeEach(() => {
  installLocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  run.calls.length = 0;
  run.script = null;
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  window.localStorage.setItem(
    `tf-trust:${USER}`,
    JSON.stringify({ textVersion: TRUST_STATUS.textVersion, keeperShown: true }),
  );
});
afterEach(unmountAll);

describe('the order’s own page, while its steps run', () => {
  const PRESS = '[data-ui="order-screen"] [data-variant="primary"]';
  /** How the order is answered: changed by a test to an API that is down. */
  let order: () => Response | Promise<Response>;
  const page = async () => {
    order = () => json(orderOn());
    let reads = 0;
    portStore.setApi(async (path) => {
      if (path === '/v1/me') return json(person);
      if (path === `/v1/orders/${ORDER_ID}`) {
        reads += 1;
        return order();
      }
      return json({ message: `Route ${path} not found`, error: 'Not Found' }, 404);
    });
    window.localStorage.setItem(`tf-order:${ORDER_ID}`, JSON.stringify(recordOf()));
    const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
    await settle();
    await settle();
    return { host, reads: () => reads };
  };

  it('stays on the screen, and is not stopped, when the wallet reports again and the order is read again', async () => {
    const { landed, signed } = depositing();
    const { host, reads } = await page();
    await click(find(host, PRESS));
    await settle();
    expect(steps(host)).toBe(2);
    const before = reads();
    const answered = gate();
    order = () => answered.wait.then(() => json(orderOn()));
    // the same person, the same wallets: the wallet's service reported once more
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    await settle();
    // while the order is read again, and once it is: the steps and the busy press are still there
    expect(reads()).toBe(before + 1);
    expect(steps(host)).toBe(2);
    expect(find(host, PRESS).getAttribute('aria-busy')).toBe('true');
    answered.open();
    await settle();
    expect(steps(host)).toBe(2);
    expect(find(host, PRESS).getAttribute('aria-busy')).toBe('true');
    expect(signal()?.aborted).toBe(false);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE, LEG_SWAP]);
  });

  it('stays on the screen when that second read fails: an API that is down takes no running order off it', async () => {
    const { landed, signed } = depositing();
    const { host } = await page();
    await click(find(host, PRESS));
    await settle();
    order = () => json({ error: 'down' }, 503);
    portStore.set(signedInPort(EMBEDDED, { userId: USER }));
    await settle();
    await settle();
    expect(steps(host)).toBe(2);
    expect(host.textContent).not.toContain(en.order.failure.unreachable);
    expect(signal()?.aborted).toBe(false);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE, LEG_SWAP]);
  });

  it('is stopped when the person signs out: the steps are gone from the screen, and the next is not signed', async () => {
    const { landed, signed } = depositing();
    const { host } = await page();
    await click(find(host, PRESS));
    await settle();
    expect(signal()?.aborted).toBe(false);
    portStore.set(fakePort());
    await settle();
    expect(steps(host)).toBe(0);
    expect(signal()?.aborted).toBe(true);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE]);
    expect(run.calls).toHaveLength(1);
  });

  it('is stopped while the wallet is read again and names nobody', async () => {
    const { landed, signed } = depositing();
    const { host } = await page();
    await click(find(host, PRESS));
    await settle();
    portStore.set(fakePort({ status: 'loading', userId: USER }));
    await settle();
    expect(steps(host)).toBe(0);
    expect(signal()?.aborted).toBe(true);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE]);
  });

  it('is stopped when another person is signed in: their browser has no record of approving it', async () => {
    const { landed, signed } = depositing();
    const { host } = await page();
    await click(find(host, PRESS));
    await settle();
    portStore.set(signedInPort(EMBEDDED, { userId: 'did:privy:other' }));
    await settle();
    await settle();
    expect(steps(host)).toBe(0);
    expect(signal()?.aborted).toBe(true);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE]);
  });

  it('runs once however often the busy press is pressed', async () => {
    const { landed, signed } = depositing();
    const { host } = await page();
    await click(find(host, PRESS));
    await settle();
    await click(find(host, PRESS));
    await click(find(host, PRESS));
    await settle();
    expect(run.calls).toHaveLength(1);
    landed.open();
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(signed).toEqual([LEG_CREATE, LEG_SWAP]);
  });
});

describe('the invest card inside another screen, while its steps run', () => {
  const PRESS = '[data-ui="invest-card"] [data-variant="primary"]';
  const funding = {
    chain: 'solana',
    name: 'Solana',
    mode: 'live',
    provenance: 'sandbox',
    wallet: EMBEDDED.find((a) => a.family === 'solana')?.address,
    cash: {
      asset: 'solana:usdc',
      symbol: 'USDC',
      decimals: 6,
      haveRaw: '50000000',
      needRaw: '10000000',
      missingRaw: '0',
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
    ok: true,
  };
  const card = async () => {
    const { rememberPlan } = await import('./plan-store');
    rememberPlan(planOn());
    const placed: unknown[] = [];
    portStore.setApi(
      serverKeepsPlans(async (path, init) => {
        const method = init?.method ?? 'GET';
        if (path === '/v1/me') return json(person);
        if (path.startsWith('/v1/funding?')) return json(funding);
        if (path === '/v1/orders' && method === 'POST') {
          placed.push(JSON.parse(String(init?.body)));
          return json(orderOn());
        }
        if (path === `/v1/orders/${ORDER_ID}`) return json(orderOn());
        return json({ error: 'not found' }, 404);
      }),
    );
    const told: string[] = [];
    const host = await mount(
      withAccount(
        'en',
        createElement(Invest, {
          of: { plan: PLAN_ID },
          amount: 10,
          onProgress: (p) => told.push(`progress ${p.step}/${p.of}`),
          onDone: () => told.push('done'),
          onStopped: (s) => told.push(`stopped ${s.orderId}`),
        }),
      ),
    );
    await settle(350);
    await settle(1050);
    await settle();
    return { host, told, placed };
  };

  it('tells its host the buy stopped when the card goes mid-run, once, and the next step is not signed', async () => {
    const { landed, signed } = depositing();
    const { host, told } = await card();
    await click(find(host, PRESS));
    await settle();
    expect(told).toEqual(['progress 0/0', 'progress 1/2']);
    // the screen that holds the card goes: another page, a plan that is no longer there
    await unmountAll();
    expect(signal()?.aborted).toBe(true);
    expect(told).toEqual(['progress 0/0', 'progress 1/2', `stopped ${ORDER_ID}`]);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE]);
    expect(told).toEqual(['progress 0/0', 'progress 1/2', `stopped ${ORDER_ID}`]);
  });

  it('says nothing more to its host when the card goes after the run has ended', async () => {
    const { landed } = depositing();
    const { host, told } = await card();
    await click(find(host, PRESS));
    await settle();
    landed.open();
    await settle();
    await settle();
    expect(told.at(-1)).toBe('done');
    const all = [...told];
    await unmountAll();
    expect(told).toEqual(all);
  });

  it('is stopped, and its host told, when the person signs out mid-run; no other order is made for nobody', async () => {
    const { landed, signed } = depositing();
    const { host, told, placed } = await card();
    await click(find(host, PRESS));
    await settle();
    portStore.set(fakePort());
    await settle();
    await settle(1400);
    expect(host.querySelector('[data-ui="order-step"]')).toBeNull();
    expect(signal()?.aborted).toBe(true);
    expect(told.at(-1)).toBe(`stopped ${ORDER_ID}`);
    landed.open();
    await settle();
    expect(signed).toEqual([LEG_CREATE]);
    expect(placed).toHaveLength(1);
    expect(run.calls).toHaveLength(1);
  });
});

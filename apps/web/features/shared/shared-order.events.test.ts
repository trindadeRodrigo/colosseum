// @vitest-environment happy-dom
import type { OrderDetail } from '@colosseum/schemas';
import { basketIdOfPlan, type ExecutionResult, type ExecutorDeps } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { OrderScreen } from '../order/OrderScreen';
import type { OrderRecord } from '../order/order-record';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import type { SharedTerms } from './terms';
import {
  FAMILY_ID,
  familyBuyOrder,
  followOrder,
  ORDER_ID,
  publishOrder,
  RECIPE,
  SLUG,
  USER,
  VAULT,
  WEIGHTS,
} from './test/fixtures';

// The order screen with an order about a shared portfolio (WEB-4), on the real runner: only `execute`
// is a double, which records what it is handed. The guard's terms are the ones the screen that made
// the order kept (terms.ts): the publish form's id, text and weights, the version and weights a follow
// read. Never the order the API answered: an order whose shape or trades are not those terms is shown
// and not offered for signing.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
}));

vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    return Promise.resolve({ status: 'done', order } as unknown as ExecutionResult);
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');

function installLocks() {
  const locks = {
    request: async (
      _name: string,
      _options: object,
      work: (lock: { name: string }) => Promise<unknown>,
    ) => work({ name: 'order' }),
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(order: OrderDetail) {
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json(person);
    if (path === `/v1/orders/${ORDER_ID}`) return json(order);
    return json({ error: 'not found' }, 404);
  });
}

function seed(terms: SharedTerms, amountUsd = 0) {
  const record: OrderRecord = {
    orderId: ORDER_ID,
    userId: USER,
    proposalId: '',
    chain: 'solana',
    amountUsd,
    lines: [],
    terms,
    approved: null,
  };
  window.localStorage.setItem(`tf-order:${ORDER_ID}`, JSON.stringify(record));
}

const screen = async () => {
  const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
  await settle();
  await settle();
  return host;
};
const primary = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-variant="primary"]') as HTMLElement;
const tick = async (host: HTMLElement) => {
  for (const box of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    await click(box);
};

const PUBLISH: SharedTerms = {
  kind: 'publish',
  action: 'publish',
  familyId: FAMILY_ID,
  components: WEIGHTS,
  text: {
    slug: SLUG,
    name: 'Three <b>of</b> the largest',
    copy: 'See https://x.invalid',
    kind: 'index',
  },
  version: 1,
};
const FAMILY: SharedTerms = {
  kind: 'family',
  slug: SLUG,
  familyId: FAMILY_ID,
  follow: { recipeOnchainId: RECIPE, version: 2 },
  targets: WEIGHTS,
  source: 'chain',
};
const FOLLOW: SharedTerms = {
  kind: 'follow',
  slug: SLUG,
  familyId: FAMILY_ID,
  vault: VAULT,
  basketId: '42',
  follow: { recipeOnchainId: RECIPE, version: 2 },
  autoFollow: true,
  source: 'api',
};

beforeEach(() => {
  window.localStorage.clear();
  run.calls.length = 0;
  installLocks();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('a publish on the order screen', () => {
  it('shows the form’s text as text, asks the consent, and hands the executor the form’s terms', async () => {
    api(publishOrder());
    seed(PUBLISH);
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.publishTitle}"]`);
    // the creator's words are text: no element and no link are made of them
    expect(review.textContent).toContain('Three <b>of</b> the largest');
    expect(review.querySelector('b')).toBeNull();
    expect(review.querySelector('a')).toBeNull();
    expect(review.textContent).toContain(FAMILY_ID);
    // no deposit is shown for an order that deposits nothing
    expect(host.textContent).not.toContain(en.order.review.deposit);
    expect(primary(host).textContent).toContain(en.order.shared.signPublish);
    expect(primary(host).getAttribute('aria-disabled')).toBe('true');
    await tick(host);
    await click(primary(host));
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '0',
      publish: {
        action: 'publish',
        familyId: FAMILY_ID,
        components: WEIGHTS,
        text: PUBLISH.kind === 'publish' ? PUBLISH.text : null,
        version: 1,
      },
    });
    expect(run.calls[0]?.deps.consents).toEqual(['publish']);
  });

  it('offers nothing to sign when the order has a step the publish does not call for', async () => {
    api(
      publishOrder([
        {
          id: '99999999-9999-4999-8999-999999999999',
          orderId: ORDER_ID,
          chain: 'solana',
          seq: 1,
          kind: 'set_auto_follow',
          signer: 'owner',
          description: 'server text',
          trades: [],
          expected: [],
          status: 'planned',
          attempt: 0,
          txId: null,
          explorerUrl: null,
          validUntil: null,
          error: null,
          trigger: 'manual',
          provenance: 'sandbox',
        },
      ]),
    );
    seed(PUBLISH);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });
});

describe('a buy that follows a shared portfolio, on the order screen', () => {
  it('holds the trades to the weights read, and hands the executor the version followed', async () => {
    api(familyBuyOrder());
    seed(FAMILY, 10);
    const host = await screen();
    expect(find(host, `[aria-label="${en.order.shared.followTitle}"]`).textContent).toContain(SLUG);
    await click(primary(host));
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: basketIdOfPlan(FAMILY_ID),
      follow: { recipeOnchainId: RECIPE, version: 2 },
      autoFollow: false,
    });
  });

  it('offers nothing to sign when the API spends the deposit on other weights', async () => {
    api(familyBuyOrder(['5000000', '2500000', '2500000']));
    seed(FAMILY, 10);
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.trades);
    expect(run.calls).toHaveLength(0);
  });
});

describe('a follow by a vault, on the order screen', () => {
  it('hands the executor the vault’s plan number, the version and the switch, with both consents', async () => {
    api(followOrder(['accept_version', 'set_auto_follow']));
    seed(FOLLOW);
    const host = await screen();
    expect(host.textContent).toContain(en.shared.check.notChecked);
    expect(primary(host).textContent).toContain(en.order.shared.signFollow);
    await tick(host);
    await click(primary(host));
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      follow: { recipeOnchainId: RECIPE, version: 2 },
      autoFollow: true,
    });
    expect(run.calls[0]?.deps.consents).toEqual(['new_asset', 'auto_follow_on']);
  });

  it('offers nothing to sign when the order accepts a version the screen did not ask for', async () => {
    api(followOrder(['accept_version', 'set_auto_follow']));
    seed({ ...FOLLOW, follow: null });
    const host = await screen();
    expect(host.querySelector('[data-variant="primary"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
  });
});

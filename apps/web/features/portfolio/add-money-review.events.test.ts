// @vitest-environment happy-dom
import type { OrderDetail } from '@colosseum/schemas';
import { solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { OrderScreen } from '../order/OrderScreen';
import { keepOrder, recallOrder } from '../order/order-record';
import { assetsOn, ORDER_ID, orderOn, recordOf, USER } from '../order/test/fixtures';
import type { SharedTerms } from '../shared/terms';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The review of an order that adds money to a vault (the order screen, with the record the add screen
// kept): what it is held to is shown, an add held to our server's targets says so over the button, and
// an order that is not an add is shown and never offered for signing.

const en = dictionary('en');
const { spy } = assetsOn('solana');
const VAULT = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '7');
const terms: Extract<SharedTerms, { kind: 'vault' }> = {
  kind: 'vault',
  vault: VAULT,
  basketId: '7',
  targets: [{ asset: spy, weightBps: 6000 }],
  keeper: false,
  source: 'api',
};

function addOrder(legs?: (order: OrderDetail) => unknown[]): OrderDetail {
  const order = orderOn();
  const add = {
    ...order,
    basketId: '7',
    legs: order.legs.map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l)),
  } as OrderDetail;
  return legs ? ({ ...add, legs: legs(add) } as OrderDetail) : add;
}

async function review(order: OrderDetail, held: typeof terms) {
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  portStore.setApi(async (path) => {
    if (path === '/v1/me') return json(person);
    if (path === `/v1/orders/${ORDER_ID}`) return json(order);
    return json({ error: 'not found' }, 404);
  });
  keepOrder(recordOf('solana', { proposalId: '', lines: [], terms: held }));
  const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
  await settle();
  await settle();
  return host;
}
const primary = (host: HTMLElement) => host.querySelector('[data-variant="primary"]');

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the review of an add of money to a vault', () => {
  it('says on its own line over the button that the targets were not checked against the chain', async () => {
    const host = await review(addOrder(), terms);
    const line = find(host, '[data-ui="not-checked"]');
    expect(line.textContent).toContain(en.shared.check.notChecked);
    expect(line.textContent).toContain(en.portfolio.add.source.notRead('Solana'));
    // body text at its medium weight, not the small print of the card above
    expect(line.className).toContain('text-body ');
    expect(line.className).toContain('font-medium');
    expect(line.className).not.toContain('text-body-sm');
    // and it is the line directly above the button that signs
    const button = primary(host);
    expect(button).not.toBeNull();
    expect(line.nextElementSibling).toBe(button);
    // the card of what the order is held to names the vault and its targets
    expect(host.textContent).toContain(VAULT);
    expect(host.textContent).toContain(en.order.shared.addTitle);
  });

  it('says nothing of the kind for targets this app read from the chain', async () => {
    const host = await review(addOrder(), { ...terms, source: 'chain' });
    expect(host.querySelector('[data-ui="not-checked"]')).toBeNull();
    expect(primary(host)).not.toBeNull();
    expect(find(host, '[data-ui="source-mark"]').textContent).toContain(
      en.portfolio.add.source.read('Solana'),
    );
  });

  it('shows and never offers an order with a withdrawal beside the deposit, or with other weights', async () => {
    const withdrawing = addOrder((add) => {
      const [deposit] = add.legs;
      return [
        ...add.legs,
        {
          ...deposit,
          id: '44444444-4444-4444-8444-444444444444',
          seq: 9,
          kind: 'withdraw',
          cashRaw: undefined,
          trades: [],
          expected: [],
        },
      ];
    });
    const host = await review(withdrawing, terms);
    expect(primary(host)).toBeNull();
    expect(host.querySelector('[data-ui="not-checked"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toContain(en.order.mismatch.shape);
    await unmountAll();
    window.localStorage.clear();
    const other = await review(addOrder(), {
      ...terms,
      targets: [{ asset: spy, weightBps: 5000 }],
    });
    expect(primary(other)).toBeNull();
    expect(find(other, '[role="alert"]').textContent).toContain(en.order.mismatch.trades);
  });

  it('offers to finish an add that stopped after its deposit, and holds the next order to the same vault', async () => {
    const NEXT_ID = '99999999-9999-4999-8999-999999999999';
    const add = addOrder();
    const stopped = {
      ...add,
      legs: add.legs.map((l) =>
        l.kind === 'swap'
          ? { ...l, status: 'failed' as const }
          : { ...l, status: 'confirmed' as const, txId: '5'.repeat(64) },
      ),
    } as OrderDetail;
    const { depositRaw: _, ...rest } = add;
    const next = {
      ...rest,
      id: NEXT_ID,
      approvalUrl: `/orders/${NEXT_ID}`,
      continues: ORDER_ID,
      legs: add.legs
        .filter((l) => l.kind === 'swap')
        .map((l) => ({ ...l, orderId: NEXT_ID, seq: 0 })),
    };
    const person: Person = {
      userId: USER,
      wallets: EMBEDDED,
      chain: 'solana',
      chainSource: 'picked',
      chainOptions: [],
    };
    portStore.setApi(async (path, init) => {
      if (path === '/v1/me') return json(person);
      if (path === `/v1/orders/${ORDER_ID}`) return json(stopped);
      if (path === `/v1/orders/${NEXT_ID}`) return json(next);
      if (path === `/v1/orders/${ORDER_ID}/continue`) return json(next);
      if (init?.method === 'POST') return json({ error: 'params/id must be a uuid' }, 400);
      return json({ error: 'not found' }, 404);
    });
    keepOrder(
      recordOf('solana', {
        proposalId: '',
        lines: [],
        terms,
        approved: { order: add, consents: [], at: '2026-10-05T12:00:00Z' },
      }),
    );
    router.push.mockClear();
    const host = await mount(withAccount('en', createElement(OrderScreen, { id: ORDER_ID })));
    await settle();
    await settle();
    const button = find(host, '[data-ui="order-stopped"] button');
    expect(button.textContent).toContain(en.order.outcome.finish);
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(1);
    await click(button);
    await settle();
    expect(router.push).toHaveBeenCalledWith(`/orders/${NEXT_ID}`);
    const kept = recallOrder(NEXT_ID, USER);
    // the same vault, through the same terms, and the trades the add left
    expect(kept?.terms).toEqual(terms);
    expect(kept?.continues).toEqual({
      orderId: ORDER_ID,
      trades: add.legs.flatMap((l) => l.trades),
    });
    // and its review can be signed: no deposit, the swap alone
    await unmountAll();
    const review = await mount(withAccount('en', createElement(OrderScreen, { id: NEXT_ID })));
    await settle();
    await settle();
    expect(review.querySelector('[role="alert"]')).toBeNull();
    expect(find(review, '[data-ui="order-continues"]').textContent).toBe(
      en.order.review.continuesLead,
    );
    expect(review.querySelector('button[data-variant="primary"]')).not.toBeNull();
  });
});

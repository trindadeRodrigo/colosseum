// @vitest-environment happy-dom
import type { OrderDetail } from '@colosseum/schemas';
import { solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { OrderScreen } from '../order/OrderScreen';
import { keepOrder } from '../order/order-record';
import { assetsOn, ORDER_ID, orderOn, recordOf, USER } from '../order/test/fixtures';
import type { SharedTerms } from '../shared/terms';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
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
});

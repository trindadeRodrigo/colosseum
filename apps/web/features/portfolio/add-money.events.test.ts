// @vitest-environment happy-dom
import type { OrderDetail } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { checkVaultAdd } from '../order/order-check';
import { isBuy, recallOrder } from '../order/order-record';
import { planTermsOf } from '../order/run-order';
import { assetsOn, ORDER_ID, orderOn, USER } from '../order/test/fixtures';
import { unitsFor } from '../order/units';
import { readTerms, type SharedTerms } from '../shared/terms';
import { EMBEDDED, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { AddMoneyScreen, targetsOfVault } from './AddMoneyScreen';
import { PORTFOLIO_PATH } from './portfolio';
import { chainOf, portfolioBody, SECOND_VAULT, VAULT, vault } from './test/portfolio';
import { VaultActions } from './VaultActions';
import { ownVault, readName, sameAddress } from './vault-name';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Several vaults, and more money into one (add money): the order an add is held to before anything is
// offered for signing, the screen that makes it, and a vault's name. The API is a double: GET /v1/me,
// GET /v1/portfolio, GET /v1/funding, POST /v1/orders and PUT /v1/vaults/{chain}/{address}/name.

const en = dictionary('en');
const units = unitsFor('solana', false);
const { spy } = assetsOn('solana');

/** The $10 buy of the fixtures as an add: its first step deposits into a vault that is there. */
function addOrder(over: Partial<OrderDetail> = {}): OrderDetail {
  const order = orderOn();
  return {
    ...order,
    basketId: '7',
    legs: order.legs.map((l) => (l.kind === 'create_vault' ? { ...l, kind: 'deposit' } : l)),
    ...over,
  } as OrderDetail;
}
const terms: Extract<SharedTerms, { kind: 'vault' }> = {
  kind: 'vault',
  vault: VAULT,
  basketId: '7',
  targets: [{ asset: spy, weightBps: 6000 }],
};

describe('an order that adds money to a vault, before it is offered for signing', () => {
  it('passes when it deposits the amount once into the vault chosen and trades to its targets', () => {
    expect(checkVaultAdd(addOrder(), 10, units, terms)).toEqual({
      ok: true,
      depositRaw: 10_000_000n,
      decimals: 6,
    });
  });

  it('refuses one that opens a vault, deposits twice, or deposits nothing', () => {
    expect(checkVaultAdd({ ...addOrder(), legs: orderOn().legs }, 10, units, terms)).toEqual({
      ok: false,
      why: 'shape',
    });
    const add = addOrder();
    const [deposit] = add.legs;
    if (!deposit) throw new Error('a deposit');
    const twice = { ...add, legs: [...add.legs, { ...deposit, id: 'again', seq: 9 }] };
    expect(checkVaultAdd(twice, 10, units, terms)).toEqual({ ok: false, why: 'shape' });
    const none = { ...add, legs: add.legs.filter((l) => l.kind !== 'deposit') };
    expect(checkVaultAdd(none, 10, units, terms)).toEqual({ ok: false, why: 'shape' });
  });

  it('refuses one that states another vault’s number', () => {
    expect(checkVaultAdd(addOrder({ basketId: '8' }), 10, units, terms)).toEqual({
      ok: false,
      why: 'shape',
    });
  });

  it('refuses an amount changed after the review, and trades to other weights than the vault’s', () => {
    const add = addOrder();
    const more = {
      ...add,
      depositRaw: '40000000000',
      legs: add.legs.map((l) => (l.cashRaw ? { ...l, cashRaw: '40000000000' } : l)),
    };
    expect(checkVaultAdd(more, 10, units, terms)).toEqual({ ok: false, why: 'deposit' });
    expect(checkVaultAdd(add, 10, units, { ...terms, targets: [] })).toEqual({
      ok: false,
      why: 'trades',
    });
    expect(
      checkVaultAdd(add, 10, units, { ...terms, targets: [{ asset: spy, weightBps: 5000 }] }),
    ).toEqual({ ok: false, why: 'trades' });
    expect(
      checkVaultAdd(add, 10, units, {
        ...terms,
        targets: [{ asset: 'solana:gldx', weightBps: 6000 }],
      }),
    ).toEqual({ ok: false, why: 'trades' });
  });

  it('is a buy, kept and read back with its terms, and the guard is handed the vault’s number alone', () => {
    expect(isBuy({ terms })).toBe(true);
    expect(readTerms(JSON.parse(JSON.stringify(terms)))).toEqual(terms);
    expect(readTerms({ ...terms, targets: [] })).toEqual({ ...terms, targets: [] });
    for (const bad of [
      { ...terms, basketId: 'seven' },
      { ...terms, vault: '' },
      { ...terms, targets: [{ asset: spy, weightBps: -1 }] },
      { ...terms, targets: undefined },
    ])
      expect(readTerms(bad)).toBeNull();
    expect(planTermsOf(terms)).toEqual({ basketId: '7' });
  });
});

describe('a vault’s targets and its name', () => {
  it('buys the targets in the portfolio’s order, leaving out what has none', () => {
    const [a, b] = vault().positions;
    if (!a || !b) throw new Error('two positions');
    expect(targetsOfVault(vault({ positions: [a, { ...b, targetBps: 0 }] }))).toEqual([
      { asset: 'solana:usdy', weightBps: 6000 },
    ]);
  });

  it('takes a name of 1 to 60 characters of plain text, trimmed', () => {
    expect(readName('  House fund  ')).toBe('House fund');
    expect(readName('<b>bold</b>')).toBe('<b>bold</b>');
    expect(readName('   ')).toBeNull();
    expect(readName('a'.repeat(61))).toBeNull();
    expect(readName('line\nbreak')).toBeNull();
    expect(readName('zero​width')).toBeNull();
  });

  it('finds a vault among the person’s own only on its chain, an EVM address in any case', () => {
    const chains = [chainOf([vault(), vault({ address: SECOND_VAULT, basketId: '8' })])];
    expect(ownVault(chains, 'solana', SECOND_VAULT)?.vault.basketId).toBe('8');
    expect(ownVault(chains, 'robinhood', VAULT)).toBeNull();
    expect(ownVault(chains, 'solana', VAULT.toLowerCase())).toBeNull();
    expect(sameAddress('robinhood', '0xAbC', '0xabc')).toBe(true);
  });
});

type Call = { method: string; path: string; body?: unknown };

const funding = {
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  wallet: SOLANA,
  cash: {
    asset: 'solana:usdc',
    symbol: 'USDC',
    decimals: 6,
    haveRaw: '50000000000',
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
  newVault: false,
  ok: true,
};

function api(
  o: { vaults?: ReturnType<typeof vault>[]; rename?: (body: unknown) => Response } = {},
) {
  const calls: Call[] = [];
  const person: Person = {
    userId: USER,
    wallets: EMBEDDED,
    chain: 'solana',
    chainSource: 'picked',
    chainOptions: [],
  };
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (path === '/v1/me') return json(person);
    if (path === PORTFOLIO_PATH)
      return json(
        portfolioBody(
          chainOf(o.vaults ?? [vault(), vault({ address: SECOND_VAULT, basketId: '8' })]),
        ),
      );
    if (path.startsWith('/v1/funding?')) return json(funding);
    if (path === '/v1/orders' && method === 'POST') return json(addOrder({ basketId: '8' }));
    if (path.endsWith('/name') && method === 'PUT')
      return o.rename
        ? o.rename(body)
        : json({ chain: 'solana', address: VAULT, name: (body as { name: unknown }).name });
    return json({ error: 'not found' }, 404);
  });
  return { calls, to: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)) };
}

const add = async (address: string, chain = 'solana') => {
  const host = await mount(withAccount('en', createElement(AddMoneyScreen, { chain, address })));
  await settle();
  await settle();
  return host;
};
const SIGN = '[data-step="review"] [data-variant="primary"]';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  router.push.mockClear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the add-money screen', () => {
  it('reads the funding for the vault chosen, makes the order naming it, and keeps what it is held to', async () => {
    const server = api();
    const host = await add(SECOND_VAULT);
    expect(find(host, 'h1').textContent).toBe(en.portfolio.add.title);
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(350);
    const [asked] = server.to('/v1/funding?');
    const query = new URLSearchParams(asked?.path.split('?')[1]);
    expect(Object.fromEntries(query)).toEqual({
      amountUsd: '10',
      vault: SECOND_VAULT,
      vaultChain: 'solana',
      wallet: SOLANA,
    });
    await click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));
    expect(find(host, 'section[data-step="review"]').textContent).toContain(
      en.portfolio.add.reviewLead('$10', 'Solana'),
    );
    await click(find(host, SIGN));
    await settle();
    expect(server.to('/v1/orders').map((c) => c.body)).toEqual([
      {
        type: 'buy',
        owner: { solana: SOLANA },
        amountUsd: 10,
        vault: { chain: 'solana', address: SECOND_VAULT },
      },
    ]);
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
    expect(recallOrder(ORDER_ID, USER)).toMatchObject({
      proposalId: '',
      chain: 'solana',
      amountUsd: 10,
      approved: null,
      terms: {
        kind: 'vault',
        vault: SECOND_VAULT,
        basketId: '8',
        targets: [
          { asset: 'solana:usdy', weightBps: 6000 },
          { asset: 'solana:paxg', weightBps: 1500 },
        ],
      },
    });
  });

  it('offers nothing for a vault that is not among the person’s own, and asks the server nothing about it', async () => {
    const server = api({ vaults: [vault()] });
    const host = await add(SECOND_VAULT);
    expect(host.textContent).toContain(en.portfolio.add.missing);
    expect(host.querySelector('[data-ui="buy-steps"]')).toBeNull();
    expect(server.to('/v1/funding?')).toEqual([]);
    expect(server.to('/v1/orders')).toEqual([]);
    // nor for the same address named on another chain
    await unmountAll();
    const other = await add(VAULT, 'robinhood');
    expect(other.textContent).toContain(en.portfolio.add.missing);
  });

  it('asks nothing of a wallet that does not own the vault', async () => {
    const server = api({ vaults: [vault({ owner: SECOND_VAULT })] });
    const host = await add(VAULT);
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await settle(350);
    expect(server.to('/v1/funding?')).toEqual([]);
    expect(find(host, SIGN).getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain('This vault belongs to another wallet of yours');
  });
});

describe('a vault’s actions', () => {
  const actions = async (v = vault(), onRenamed = vi.fn()) => {
    const host = await mount(
      withAccount(
        'en',
        createElement(VaultActions, { chain: chainOf([v]), vault: v, joined: null, onRenamed }),
      ),
    );
    await settle();
    return { host, onRenamed };
  };
  const rename = (host: HTMLElement) => find(host, '[data-action="rename"]');

  it('links to the add-money page of this vault, and calls a vault with no name by its chain', async () => {
    api();
    const { host } = await actions();
    expect(find(host, '[data-ui="vault-add-money"]').getAttribute('href')).toBe(
      `/vaults/solana/${VAULT}/add`,
    );
    expect(find(host, '[data-ui="vault-name"]').textContent).toBe(
      en.portfolio.actions.unnamed('Solana'),
    );
  });

  it('saves a name trimmed, shows it as text, and has the portfolio read again', async () => {
    const server = api();
    const { host, onRenamed } = await actions();
    await click(rename(host));
    await type(
      find<HTMLInputElement>(host, '[data-ui="vault-rename-form"] input'),
      '  <i>Rent</i> ',
    );
    await click(find(host, '[data-ui="vault-rename-form"] [data-variant="primary"]'));
    await settle();
    expect(server.to(`/v1/vaults/solana/${VAULT}/name`).map((c) => [c.method, c.body])).toEqual([
      ['PUT', { name: '<i>Rent</i>' }],
    ]);
    const name = find(host, '[data-ui="vault-name"]');
    expect(name.textContent).toBe('<i>Rent</i>');
    expect(name.querySelector('i')).toBeNull();
    expect(onRenamed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-ui="vault-rename-form"]')).toBeNull();
  });

  it('sends nothing for a name that is not one, and says what the server refused', async () => {
    const server = api({ rename: () => json({ error: 'no vault' }, 404) });
    const { host, onRenamed } = await actions(vault({ name: 'Rent' }));
    expect(find(host, '[data-ui="vault-name"]').textContent).toBe('Rent');
    await click(rename(host));
    const input = find<HTMLInputElement>(host, '[data-ui="vault-rename-form"] input');
    expect(input.value).toBe('Rent');
    expect(input.maxLength).toBe(60);
    await type(input, 'zero\u200bwidth');
    const save = find(host, '[data-ui="vault-rename-form"] [data-variant="primary"]');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    await click(save);
    expect(server.to('/v1/vaults/')).toEqual([]);
    await type(input, 'Holiday');
    await click(find(host, '[data-ui="vault-rename-form"] [data-variant="primary"]'));
    await settle();
    expect(host.textContent).toContain(en.portfolio.actions.failure.notYours);
    expect(find(host, '[data-ui="vault-name"]').textContent).toBe('Rent');
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('takes the name off with null', async () => {
    const server = api();
    const { host } = await actions(vault({ name: 'Rent' }));
    await click(rename(host));
    const clear = [...host.querySelectorAll('[data-ui="vault-rename-form"] button')].find(
      (b) => b.textContent === en.portfolio.actions.clear,
    );
    if (!clear) throw new Error('the clear button');
    await click(clear);
    await settle();
    expect(server.to('/v1/vaults/').map((c) => c.body)).toEqual([{ name: null }]);
    expect(find(host, '[data-ui="vault-name"]').textContent).toBe(
      en.portfolio.actions.unnamed('Solana'),
    );
  });
});

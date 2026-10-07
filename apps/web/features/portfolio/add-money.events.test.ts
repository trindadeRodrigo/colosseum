// @vitest-environment happy-dom
import { DISCLAIMER, type OrderDetail } from '@colosseum/schemas';
import { solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { inShell, withAccount } from '../account/test/screen';
import { checkDeposit, checkVaultAdd } from '../order/order-check';
import { isBuy, recallOrder } from '../order/order-record';
import { basketOfPlan } from '../order/readiness';
import { planTermsOf } from '../order/run-order';
import {
  assetsOn,
  ORDER_ID,
  orderOn,
  PLAN_ID,
  planOn,
  recordOf,
  USER,
} from '../order/test/fixtures';
import { unitsFor } from '../order/units';
import { readTerms, type SharedTerms } from '../shared/terms';
import { VaultScreen } from '../shared/VaultScreen';
import { EMBEDDED, fakePort, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { AddMoneyScreen, targetsOfVault } from './AddMoneyScreen';
import { MonitorScreen } from './MonitorScreen';
import { PORTFOLIO_PATH } from './portfolio';
import { chainOf, portfolioBody, vault as vaultFixture } from './test/portfolio';
import { VaultActions } from './VaultActions';
import { dueOf, goalOfVault, putInto } from './vault-goal';
import { ownVault, readName, sameAddress } from './vault-name';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
// the card draws the order's own screen, which holds the runner: nothing here presses it
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// Several vaults, and more money into one (add money): the order an add is held to before anything is
// offered for signing, the screen that makes it, and a vault's name. The API is a double: GET /v1/me,
// GET /v1/portfolio, GET /v1/funding, POST /v1/orders and PUT /v1/vaults/{chain}/{address}/name.

const en = dictionary('en');
// The vaults of the tests' wallet for plans 7 and 8, as this app derives them: an add is offered only
// for an address that is the vault of the signing wallet for the number our server names.
const PROGRAM = '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW';
const VAULT = solanaVaultAddress(PROGRAM, SOLANA, '7');
const SECOND_VAULT = solanaVaultAddress(PROGRAM, SOLANA, '8');
const vault = (over: Parameters<typeof vaultFixture>[0] = {}) =>
  vaultFixture({ address: VAULT, ...over });
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
  keeper: false,
  source: 'api',
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

  it('refuses a new vault opened beside the one deposit', () => {
    const add = addOrder();
    const [deposit] = add.legs;
    if (!deposit) throw new Error('a deposit');
    // everything else about it is right: one deposit of the amount, the trades at the targets
    const opened = {
      ...add,
      legs: [
        { ...deposit, id: 'open', seq: 9, kind: 'create_vault', cashRaw: undefined },
        ...add.legs,
      ],
    } as OrderDetail;
    expect(checkDeposit(opened, 10, units).ok).toBe(true);
    expect(checkVaultAdd(opened, 10, units, terms)).toEqual({ ok: false, why: 'shape' });
  });

  it.each([
    'withdraw',
    'set_targets',
    'set_auto_follow',
    'accept_version',
    'publish',
    'adopt_version',
    'keeper_leg',
    'create_vault',
  ] as const)('refuses a %s step beside the deposit and the swaps', (kind) => {
    const add = addOrder();
    const [deposit] = add.legs;
    if (!deposit) throw new Error('a deposit');
    const extra = { ...deposit, id: 'extra', seq: 9, kind, cashRaw: undefined, trades: [] };
    for (const legs of [
      [...add.legs, extra],
      [extra, ...add.legs],
    ])
      expect(checkVaultAdd({ ...add, legs } as OrderDetail, 10, units, terms), kind).toEqual({
        ok: false,
        why: 'shape',
      });
  });

  it('takes one approval before the deposit, as an EVM chain needs, and no second one', () => {
    const add = addOrder();
    const [deposit] = add.legs;
    if (!deposit) throw new Error('a deposit');
    const approve = { ...deposit, id: 'approve', seq: -1, kind: 'approve', trades: [] };
    const approved = { ...add, legs: [approve, ...add.legs] } as OrderDetail;
    expect(checkVaultAdd(approved, 10, units, terms).ok).toBe(true);
    const twice = { ...add, legs: [approve, { ...approve, id: 'again' }, ...add.legs] };
    expect(checkVaultAdd(twice as OrderDetail, 10, units, terms)).toEqual({
      ok: false,
      why: 'shape',
    });
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

  it('refuses a trade into an asset outside the targets, and a share off by one unit', () => {
    const add = addOrder();
    const withTrades = (trades: { sell: string; buy: string; amountInRaw: string }[]) => ({
      ...add,
      legs: add.legs.map((l) => (l.kind === 'swap' ? { ...l, trades } : l)),
    });
    const cash = 'solana:usdc';
    // the vault's one target is bought, and so is a token the vault has no target on
    const beside = withTrades([
      { sell: cash, buy: spy, amountInRaw: '6000000' },
      { sell: cash, buy: 'solana:nvdax', amountInRaw: '1000000' },
    ]);
    expect(checkVaultAdd(beside, 10, units, terms)).toEqual({ ok: false, why: 'trades' });
    // the whole invested share goes to a token outside the targets
    const instead = withTrades([{ sell: cash, buy: 'solana:nvdax', amountInRaw: '6000000' }]);
    expect(checkVaultAdd(instead, 10, units, terms)).toEqual({ ok: false, why: 'trades' });
    // 60% of $10 is 6,000,000 units: one more or one fewer is not that share
    for (const amountInRaw of ['6000001', '5999999', '0'])
      expect(
        checkVaultAdd(withTrades([{ sell: cash, buy: spy, amountInRaw }]), 10, units, terms),
        amountInRaw,
      ).toEqual({ ok: false, why: 'trades' });
    // two targets: the shares swapped between them are each off
    const two = {
      ...terms,
      targets: [
        { asset: spy, weightBps: 4000 },
        { asset: 'solana:nvdax', weightBps: 2000 },
      ],
    };
    const right = withTrades([
      { sell: cash, buy: spy, amountInRaw: '4000000' },
      { sell: cash, buy: 'solana:nvdax', amountInRaw: '2000000' },
    ]);
    expect(checkVaultAdd(right, 10, units, two).ok).toBe(true);
    const swapped = withTrades([
      { sell: cash, buy: spy, amountInRaw: '2000000' },
      { sell: cash, buy: 'solana:nvdax', amountInRaw: '4000000' },
    ]);
    expect(checkVaultAdd(swapped, 10, units, two)).toEqual({ ok: false, why: 'trades' });
    // an add to a vault with auto-follow on is the deposit alone: a swap step is refused, with a
    // trade or with none
    const keeper = { ...terms, targets: [], keeper: true };
    expect(checkVaultAdd(add, 10, units, keeper)).toEqual({ ok: false, why: 'shape' });
    expect(checkVaultAdd(withTrades([]), 10, units, keeper)).toEqual({ ok: false, why: 'shape' });
    const depositOnly = { ...add, legs: add.legs.filter((l) => l.kind !== 'swap') };
    expect(checkVaultAdd(depositOnly, 10, units, keeper).ok).toBe(true);
    // and with auto-follow off and targets, the deposit alone leaves the targets unbought
    expect(checkVaultAdd(depositOnly, 10, units, terms)).toEqual({ ok: false, why: 'trades' });
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
      { ...terms, source: 'somewhere' },
      { ...terms, keeper: undefined },
      // auto-follow on: the add is the deposit alone, so it names no target
      { ...terms, keeper: true },
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
          chainOf(
            o.vaults ?? [
              vault(),
              vault({ address: SECOND_VAULT, basketId: '8', autoFollow: false }),
            ],
          ),
        ),
      );
    if (path.startsWith('/v1/funding?')) return json(funding);
    // the vault's public page: the same answer for anybody
    if (path === `/v1/vaults/solana/${VAULT}`)
      return json({
        chain: 'solana',
        name: 'Solana devnet',
        mode: 'live',
        provenance: 'sandbox',
        vault: vault(),
        prices: [],
        disclaimer: 'd',
      });
    if (path === '/v1/orders' && method === 'POST') return json(addOrder({ basketId: '8' }));
    // the order the card shows, read back by its id
    if (path === `/v1/orders/${ORDER_ID}`) return json(addOrder({ basketId: '8' }));
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
/** The card's one button: "Invest $X", held until there is an order to press. */
const SIGN = '[data-ui="invest-card"] [data-variant="primary"]';
/** Long enough for the wallet to be read and the order made for the amount. */
const made = async () => {
  await settle(350);
  await settle(450);
  await settle();
};
const posted = (server: ReturnType<typeof api>) =>
  server.to('/v1/orders').filter((c) => c.method === 'POST');

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
    await made();
    // the order is made for the card with no press, and the review is on this page
    expect(posted(server).map((c) => c.body)).toEqual([
      {
        type: 'buy',
        owner: { solana: SOLANA },
        amountUsd: 10,
        vault: { chain: 'solana', address: SECOND_VAULT },
      },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    // This double answers the fixtures' order, which buys another asset than this vault's targets:
    // the card says so and offers no press at all, ticked or not (order-check.ts, `checkVaultAdd`).
    await click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));
    expect(host.querySelector(SIGN)).toBeNull();
    expect(find(host, '[data-ui="invest-card"] [role="alert"]').textContent).toBe(
      en.order.mismatch.trades,
    );
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
        keeper: false,
        // this app has no node of its own here: the targets are our server's, and said to be
        source: 'api',
      },
    });
    expect(find(host, '[data-ui="source-mark"]').textContent).toContain(
      en.portfolio.add.source.notRead('Solana'),
    );
  });

  it('for a vault with auto-follow on: says the keeper invests it, and holds the add to the deposit alone', async () => {
    api();
    // the fixtures' first vault has auto-follow on, and a newer version of what it follows waits
    const host = await add(VAULT);
    expect(find(host, '[data-ui="add-keeper"]').textContent).toBe(en.portfolio.add.keeper);
    expect(host.querySelector('[data-ui="add-newer-version"]')).toBeNull();
    await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
    await made();
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'vault',
      vault: VAULT,
      basketId: '7',
      targets: [],
      keeper: true,
      source: 'api',
    });
  });

  it('says in one line when the portfolio the vault follows has a newer version', async () => {
    api({
      vaults: [
        vault({
          autoFollow: false,
          recipeOnchainId: 'recipe',
          pending: { version: 4, effectiveAt: 1_791_300_000, newAssets: [] },
        }),
      ],
    });
    const host = await add(VAULT);
    expect(find(host, '[data-ui="add-newer-version"]').textContent).toBe(
      en.portfolio.add.newerVersion(4),
    );
    expect(host.querySelector('[data-ui="add-keeper"]')).toBeNull();
  });

  it('reads the amount in the page’s language: "10.555" is no amount in English, and 10,555 in Portuguese', async () => {
    const server = api();
    const host = await add(SECOND_VAULT);
    const input = find<HTMLInputElement>(host, 'input[inputmode="decimal"]');
    await type(input, '10.555');
    await settle(350);
    expect(host.textContent).toContain(en.buy.blocked.amount);
    expect(server.to('/v1/funding?')).toEqual([]);
    await type(input, '10,555');
    await settle(350);
    expect(server.to('/v1/funding?').at(-1)?.path).toContain('amountUsd=10555');
    await unmountAll();

    const pt = dictionary('pt');
    const inPortuguese = api();
    const page = await mount(
      withAccount('pt', createElement(AddMoneyScreen, { chain: 'solana', address: SECOND_VAULT })),
    );
    await settle();
    await settle();
    const field = find<HTMLInputElement>(page, 'input[inputmode="decimal"]');
    await type(field, '10,555');
    await settle(350);
    expect(page.textContent).toContain(pt.buy.blocked.amount);
    expect(inPortuguese.to('/v1/funding?')).toEqual([]);
    await type(field, '10.555');
    await settle(350);
    expect(inPortuguese.to('/v1/funding?').at(-1)?.path).toContain('amountUsd=10555');
  });

  it('with no node to read: still refuses an address or a plan number that is not the wallet’s vault', async () => {
    // our server files the vault of plan 8 under number 9, and another address under number 8
    for (const lie of [
      vault({ address: SECOND_VAULT, basketId: '9', autoFollow: false }),
      vault({
        address: solanaVaultAddress(PROGRAM, SOLANA, '99'),
        basketId: '8',
        autoFollow: false,
      }),
    ]) {
      const server = api({ vaults: [lie] });
      const host = await add(lie.address);
      await type(find<HTMLInputElement>(host, 'input[inputmode="decimal"]'), '10');
      await made();
      await click(find(host, '[data-ui="trust-notice"] input[type="checkbox"]'));
      const mark = find(host, '[data-ui="source-mark"]');
      expect(mark.textContent).toContain(en.portfolio.add.source.failed('Solana'));
      expect(mark.className).toContain('text-destructive');
      const button = find(host, SIGN);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      await click(button);
      await settle();
      expect(server.to('/v1/orders')).toEqual([]);
      await unmountAll();
    }
  });

  it('carries the disclaimer once, in the shell’s foot, in both languages', async () => {
    for (const lang of ['en', 'pt'] as const) {
      api();
      const host = await mount(
        inShell(lang, 'auto', createElement(AddMoneyScreen, { chain: 'solana', address: VAULT })),
      );
      await settle();
      await settle();
      expect(find(host, 'h1').textContent).toBe(dictionary(lang).portfolio.add.title);
      expect(host.querySelector('main [data-ui="disclaimer"]')).toBeNull();
      const all = [...host.querySelectorAll('[data-ui="disclaimer"]')];
      expect(all).toHaveLength(1);
      expect(all[0]?.textContent).toContain(DISCLAIMER[lang]);
      await unmountAll();
    }
  });

  it('offers nothing for a vault that is not among the person’s own, and asks the server nothing about it', async () => {
    const server = api({ vaults: [vault()] });
    const host = await add(SECOND_VAULT);
    expect(host.textContent).toContain(en.portfolio.add.missing);
    expect(host.querySelector('[data-ui="invest-card"]')).toBeNull();
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
    await made();
    expect(server.to('/v1/funding?')).toEqual([]);
    expect(server.to('/v1/orders')).toEqual([]);
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

describe('the monitor, with the vaults’ actions', () => {
  const monitor = async () => {
    const host = await mount(withAccount('en', createElement(MonitorScreen)));
    await settle();
    await settle();
    return host;
  };

  it('offers each vault its own actions, a new plan always, and one total for the chain’s vaults', async () => {
    api();
    const host = await monitor();
    const blocks = [...host.querySelectorAll('[data-ui="vault"]')];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => find(b, '[data-ui="vault-add-money"]').getAttribute('href'))).toEqual([
      `/vaults/solana/${VAULT}/add`,
      `/vaults/solana/${SECOND_VAULT}/add`,
    ]);
    for (const block of blocks) expect(find(block, '[data-action="rename"]')).toBeTruthy();
    const fresh = find(host, '[data-ui="new-plan"]');
    expect([fresh.textContent, fresh.getAttribute('href')]).toEqual([
      en.portfolio.actions.newPlan,
      '/goal',
    ]);
    // two vaults of $1,040 on the one chain: their sum, said as that chain's, with its pin
    const total = find(host, '[data-ui="chain-total"]');
    expect(total.textContent).toContain(en.portfolio.group.worth(2, 'Solana'));
    expect(total.textContent).toContain('$2,080.00');
    expect(find(total, '[data-ui="pin"]')).toBeTruthy();
    expect(host.querySelector('[data-ui="across-chains"]')).toBeNull();
  });

  it('adds nothing up for one vault, and still offers a new plan', async () => {
    api({ vaults: [vault()] });
    const host = await monitor();
    expect(host.querySelector('[data-ui="chain-total"]')).toBeNull();
    expect(host.querySelectorAll('[data-ui="vault-actions"]')).toHaveLength(1);
    expect(find(host, '[data-ui="new-plan"]').getAttribute('href')).toBe('/goal');
  });
});

describe('a vault’s own page, which anybody can open', () => {
  const page = async () => {
    const host = await mount(
      withAccount('en', createElement(VaultScreen, { chain: 'solana', address: VAULT })),
    );
    for (let i = 0; i < 4; i += 1) await settle(50);
    return host;
  };

  it('offers its owner the actions', async () => {
    api({ vaults: [vault({ name: 'Rent' })] });
    const host = await page();
    expect(find(host, '[data-ui="vault-name"]').textContent).toBe('Rent');
    expect(find(host, '[data-ui="vault-add-money"]').getAttribute('href')).toBe(
      `/vaults/solana/${VAULT}/add`,
    );
  });

  it('offers a visitor none, and shows them no name', async () => {
    // signed in, with a vault of their own that is not this one
    api({ vaults: [vault({ address: SECOND_VAULT, basketId: '8', name: 'Mine' })] });
    const host = await page();
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.title);
    expect(host.querySelector('[data-ui="vault-actions"]')).toBeNull();
    expect(host.querySelector('[data-ui="vault-add-money"]')).toBeNull();
    expect(host.textContent).not.toContain('Mine');
  });

  it('offers a signed-out reader none, and asks the server for no portfolio', async () => {
    const server = api({ vaults: [vault({ name: 'Rent' })] });
    portStore.set(fakePort());
    const host = await page();
    expect(find(host, 'h1').textContent).toBe(en.shared.vault.title);
    expect(host.querySelector('[data-ui="vault-actions"]')).toBeNull();
    expect(host.textContent).not.toContain('Rent');
    expect(server.to(PORTFOLIO_PATH)).toEqual([]);
  });
});

describe('a vault’s goal, once money is added', () => {
  const goal = (placedAt: string) => ({
    sheet: planOn().proposal.sheet,
    card: planOn().proposal.card,
    verdict: null,
    placedAt,
  });
  const mine = vault({ basketId: basketOfPlan(PLAN_ID) });
  const bought = recordOf('solana', { orderId: 'first', goal: goal('2026-10-01T00:00:00.000Z') });
  // the add as this browser keeps it: no plan beside it, the vault's number in its terms
  const added = recordOf('solana', {
    orderId: 'second',
    proposalId: '',
    lines: [],
    amountUsd: 50,
    terms: { ...terms, basketId: mine.basketId },
    // the goal the server's list gives the add, dated when the add was made
    goal: goal('2027-03-01T00:00:00.000Z'),
  });

  it('counts its date from the first buy: an add never moves it', () => {
    const alone = goalOfVault(mine, [bought]);
    const after = goalOfVault(mine, [added, bought]);
    expect(after?.record.orderId).toBe('first');
    expect(after && dueOf(after.goal).toISOString()).toBe(alone && dueOf(alone.goal).toISOString());
    expect(after && dueOf(after.goal).toISOString()).toBe('2029-10-01T00:00:00.000Z');
  });

  it('counts the add in what was put in, and joins it to no other vault', () => {
    expect(putInto(mine, [added, bought], new Set(['first', 'second']))).toBe(60);
    expect(putInto(vault({ basketId: '999' }), [added, bought], new Set(['second']))).toBeNull();
  });
});

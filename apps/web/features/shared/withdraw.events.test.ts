// @vitest-environment happy-dom
import type { OrderDetail, VaultView } from '@colosseum/schemas';
import { type ExecutionResult, type ExecutorDeps, solanaVaultAddress } from '@colosseum/sdk';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, type, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { OrderScreen } from '../order/OrderScreen';
import { type OrderRecord, recallOrder } from '../order/order-record';
import { EMBEDDED, fakePort, json, SOLANA, signedInPort } from '../wallet/test/fake-port';
import { router } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { readTerms, type SharedTerms } from './terms';
import { CREATOR, ORDER_ID, USER, vaultOf, withdrawOrder } from './test/fixtures';
import { WithdrawScreen } from './WithdrawScreen';

// A withdrawal in the browser (WITHDRAW), with real events against a double of the API: the screen
// that chooses and reviews what leaves a vault, for its owner only, and the order screen that is handed
// those terms. Only `execute` is a double: it records what the guard would be held to. What the order
// may sign is what the person reviewed, never the order the API answered.

const run = vi.hoisted(() => ({
  calls: [] as { order: OrderDetail; deps: ExecutorDeps }[],
}));
vi.mock('@colosseum/sdk', async (original) => ({
  ...(await original<typeof import('@colosseum/sdk')>()),
  execute: (order: OrderDetail, deps: ExecutorDeps) => {
    run.calls.push({ order, deps });
    // As the executor answers once every step has confirmed: the order, done.
    return Promise.resolve({
      status: 'done',
      order: { ...order, status: 'done' },
    } as unknown as ExecutionResult);
  },
}));
vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('../wallet/signing', () => import('../wallet/test/mock-signing'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

const en = dictionary('en');
const w = en.withdraw;

/** The vault of the fake port's wallet for plan 42, as the guard derives it on Solana's test network. */
const MY_VAULT = solanaVaultAddress('529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW', SOLANA, '42');
const CASH = 'solana:usdc';
const SPYX = 'solana:spyx';
const holding = (asset: string, raw: string) => ({ asset, raw, multiplier: '1', display: raw });
/** 600 USDC and 2.5 SPYx. */
const holdingVault = (over: Partial<VaultView> = {}) =>
  vaultOf({
    address: MY_VAULT,
    cash: holding(CASH, '600000000'),
    positions: [
      {
        ...holding(SPYX, '250000000'),
        targetBps: 4_000,
        lastKeeperAt: null,
        valueUsd: '400',
        weightBps: 4_000,
        driftBps: 0,
      },
    ] as VaultView['positions'],
    valueUsd: '1000',
    ...over,
  });

type Call = { method: string; path: string; body?: unknown };
const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};

function api(o: { vault?: VaultView | null; order?: () => Response | OrderDetail } = {}) {
  const calls: Call[] = [];
  const vault = o.vault === undefined ? holdingVault() : o.vault;
  portStore.setApi(async (path, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/v1/me') return json(person);
    if (path.startsWith('/v1/vaults/solana/'))
      return vault
        ? json({
            chain: 'solana',
            name: 'Solana',
            mode: 'live',
            provenance: 'sandbox',
            vault: { ...vault, provenance: 'sandbox' },
            prices: [],
            disclaimer: 'the disclaimer',
          })
        : json({ error: 'no vault at that address' }, 404);
    if (path === '/v1/orders' && method === 'POST') {
      const answer = o.order?.() ?? withdrawOrder([[item(CASH, null, '600000000')]]);
      return answer instanceof Response ? answer : json(answer);
    }
    if (path === `/v1/orders/${ORDER_ID}`)
      return json(o.order?.() ?? withdrawOrder([[item(CASH, null, '600000000')]]));
    return json({ error: 'not found' }, 404);
  });
  return {
    calls,
    placed: () => calls.filter((c) => c.path === '/v1/orders' && c.method === 'POST'),
  };
}
/** A token as a review keeps it: with the multiplier its amounts are shown with. */
const term = (asset: string, amountRaw: string | null, heldRaw: string, multiplier = '1') => ({
  asset,
  amountRaw,
  heldRaw,
  multiplier,
});
/** A token as a step of an order carries it. */
const item = (asset: string, amountRaw: string | null, heldRaw: string) => ({
  asset,
  amountRaw,
  heldRaw,
});

const show = async () => {
  const host = await mount(
    withAccount('en', createElement(WithdrawScreen, { chain: 'solana', address: MY_VAULT })),
  );
  await settle();
  await settle();
  return host;
};
const step = (host: HTMLElement, id: string) =>
  find(host, `[data-ui="withdraw-step"][data-step="${id}"]`);
const panel = (host: HTMLElement, id: string) =>
  find(
    host,
    `#${CSS.escape(find(step(host, id), 'h2 button').getAttribute('aria-controls') ?? '')}`,
  );
const primary = (host: HTMLElement, id: string) =>
  find(panel(host, id), ':scope > div > [data-variant="primary"]');
const radio = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (r) => r.closest('label')?.textContent === label,
  ) as HTMLInputElement;
const pick = (host: HTMLElement, asset: string) =>
  find(host, `[data-ui="withdraw-picks"] li[data-asset="${asset}"]`);

/** From the choice to the order: Continue, the confirmation ticked, Continue, the button. */
async function through(host: HTMLElement) {
  await click(primary(host, 'what'));
  await click(find(panel(host, 'check'), 'input[type="checkbox"]'));
  await click(primary(host, 'check'));
  await click(primary(host, 'confirm'));
  await settle();
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  run.calls.length = 0;
  router.push.mockClear();
  Object.defineProperty(window.navigator, 'locks', {
    value: {
      request: async (_n: string, _o: object, work: (lock: { name: string }) => Promise<unknown>) =>
        work({ name: 'order' }),
    },
    configurable: true,
  });
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
});
afterEach(unmountAll);

describe('the withdraw screen', () => {
  it('is the owner’s alone: anybody else’s vault, or none, offers nothing', async () => {
    const server = api({ vault: holdingVault({ owner: CREATOR }) });
    const theirs = await show();
    expect(theirs.textContent).toContain(w.notYours);
    expect(theirs.querySelector('[data-ui="withdraw-steps"]')).toBeNull();
    await unmountAll();
    api({ vault: null });
    expect((await show()).textContent).toContain(w.notYours);
    await unmountAll();
    // signed out: asked to sign in, and nothing is read
    portStore.set(fakePort());
    const out = await show();
    expect(out.textContent).toContain(en.plan.signedOut);
    expect(server.placed()).toEqual([]);
  });

  it('says plainly that an emptied vault is empty', async () => {
    api({ vault: holdingVault({ cash: holding(CASH, '0'), positions: [] }) });
    const host = await show();
    expect(host.textContent).toContain(w.empty);
    expect(host.querySelector('[data-ui="withdraw-steps"]')).toBeNull();
  });

  it('everything: reviews each token and the owner’s own address, then orders exactly that', async () => {
    const server = api({
      order: () =>
        withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]]),
    });
    const host = await show();
    expect(radio(host, w.what.everything).checked).toBe(true);
    await click(primary(host, 'what'));
    const review = panel(host, 'check');
    expect([...review.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      `USDC${w.check.all('600 USDC')}`,
      `SPYx${w.check.all('2.5 SPYx')}`,
    ]);
    // where it goes: the owner's own wallet, in full, and nowhere else
    expect(find(review, '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    expect(review.textContent).toContain(MY_VAULT);
    expect(review.textContent).toContain(w.check.emptied);
    expect(review.textContent).toContain(w.check.noSale);
    // not without the person's own confirmation
    expect(primary(host, 'check').getAttribute('aria-disabled')).toBe('true');
    expect(primary(host, 'confirm').getAttribute('aria-disabled')).toBe('true');
    await click(primary(host, 'confirm'));
    expect(server.placed()).toEqual([]);

    await click(find(review, 'input[type="checkbox"]'));
    await click(primary(host, 'check'));
    await click(primary(host, 'confirm'));
    await settle();
    await settle();
    expect(server.placed().map((c) => c.body)).toEqual([
      { type: 'withdraw', vaults: [MY_VAULT], sellToCash: false },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toEqual({
      kind: 'withdraw',
      vault: MY_VAULT,
      basketId: '42',
      owner: SOLANA,
      everything: true,
      items: [term(CASH, null, '600000000'), term(SPYX, null, '250000000')],
      autoFollowOff: false,
    });
    expect(router.push).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it('part of the cash: that amount, in raw units, and the rest stays', async () => {
    const server = api({ order: () => withdrawOrder([[item(CASH, '250500000', '600000000')]]) });
    const host = await show();
    await click(radio(host, w.what.some));
    // nothing chosen yet: nothing to continue with
    expect(primary(host, 'what').getAttribute('aria-disabled')).toBe('true');
    expect(host.textContent).toContain(w.what.errors.none);
    await click(find(pick(host, CASH), 'input[type="checkbox"]'));
    expect(pick(host, CASH).textContent).toContain(w.what.holds('600 USDC'));
    await type(find<HTMLInputElement>(pick(host, CASH), 'input[inputmode="decimal"]'), '250.5');
    await click(primary(host, 'what'));
    const review = panel(host, 'check');
    expect([...review.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      'USDC250.5 USDC',
    ]);
    expect(review.textContent).toContain(w.check.stays);
    expect(review.querySelector('[data-ui="withdraw-keeper"]')).toBeNull();
    await click(find(review, 'input[type="checkbox"]'));
    await click(primary(host, 'check'));
    await click(primary(host, 'confirm'));
    await settle();
    await settle();
    expect(server.placed().map((c) => c.body)).toEqual([
      {
        type: 'withdraw',
        vaults: [MY_VAULT],
        sellToCash: false,
        withdrawals: [{ asset: CASH, amountRaw: '250500000' }],
      },
    ]);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      everything: false,
      items: [term(CASH, '250500000', '600000000')],
    });
  });

  it('holds the amount to the vault: exactly the balance goes on, one unit over does not', async () => {
    api();
    const host = await show();
    await click(radio(host, w.what.some));
    await click(find(pick(host, CASH), 'input[type="checkbox"]'));
    const input = find<HTMLInputElement>(pick(host, CASH), 'input[inputmode="decimal"]');
    for (const [typed, error] of [
      ['600.000001', w.what.errors.over('600 USDC')],
      ['601', w.what.errors.over('600 USDC')],
      ['abc', w.what.errors.amount],
      ['0', w.what.errors.amount],
      ['1.0000001', w.what.errors.amount],
    ] as const) {
      await type(input, typed);
      expect(pick(host, CASH).textContent, typed).toContain(error);
      expect(primary(host, 'what').getAttribute('aria-disabled'), typed).toBe('true');
    }
    await type(input, '600');
    expect(primary(host, 'what').getAttribute('aria-disabled')).toBeNull();
    await click(primary(host, 'what'));
    expect(panel(host, 'check').querySelector('tbody tr')?.textContent).toBe('USDC600 USDC');
    // the stock token stays, so the vault is not emptied
    expect(panel(host, 'check').textContent).toContain(w.check.stays);
  });

  it('asks for the review again when what leaves changes after it was confirmed', async () => {
    api();
    const host = await show();
    await click(primary(host, 'what'));
    const box = find<HTMLInputElement>(panel(host, 'check'), 'input[type="checkbox"]');
    await click(box);
    expect(box.checked).toBe(true);
    await click(radio(host, w.what.some));
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    expect(find<HTMLInputElement>(panel(host, 'check'), 'input[type="checkbox"]').checked).toBe(
      false,
    );
    expect(panel(host, 'confirm').textContent).toContain(w.confirm.blocked.check);
  });

  it('says that automatic following stops, on a vault that has it on, whatever leaves, and orders it so', async () => {
    const server = api({
      vault: holdingVault({ autoFollow: true }),
      order: () =>
        withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]], {}, true),
    });
    const host = await show();
    await click(primary(host, 'what'));
    // everything, too: the keeper would trade what is left between the steps
    expect(find(panel(host, 'check'), '[data-ui="withdraw-keeper"]').textContent).toBe(
      w.check.autoFollow,
    );
    expect(w.check.autoFollow).toMatch(/^Automatic following stops for this vault\./);
    await click(radio(host, w.what.some));
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    expect(panel(host, 'check').querySelector('[data-ui="withdraw-keeper"]')).not.toBeNull();
    await click(radio(host, w.what.everything));
    await through(host);
    expect(server.placed()).toHaveLength(1);
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({ autoFollowOff: true });
  });

  it('says nothing of auto-follow on a vault that has it off', async () => {
    api();
    const host = await show();
    await click(primary(host, 'what'));
    expect(panel(host, 'check').querySelector('[data-ui="withdraw-keeper"]')).toBeNull();
  });

  it('shows a stock token as the portfolio does, with its multiplier, and signs exact raw units, rounded down', async () => {
    // SPYx: one token on the chain stands for 1.0057 shares. 2.5 tokens held are shown as 2.51425.
    const server = api({
      vault: holdingVault({
        positions: [
          {
            ...holding(SPYX, '250000000'),
            multiplier: '1.0057',
            display: '2.51425',
            targetBps: 4_000,
            lastKeeperAt: null,
            valueUsd: '400',
            weightBps: 4_000,
            driftBps: 0,
          },
        ] as VaultView['positions'],
      }),
      order: () => withdrawOrder([[item(SPYX, '99433230', '250000000')]]),
    });
    const host = await show();
    await click(radio(host, w.what.some));
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    expect(pick(host, SPYX).textContent).toContain(w.what.holds('2.51425 SPYx'));
    const input = find<HTMLInputElement>(pick(host, SPYX), 'input[inputmode="decimal"]');
    // more than is shown is refused, by a unit of the shown figure
    await type(input, '2.51425001');
    expect(pick(host, SPYX).textContent).toContain(w.what.errors.over('2.51425 SPYx'));
    // one share: 1 / 1.0057 of a token, rounded down, so never more than was typed
    await type(input, '1');
    await click(primary(host, 'what'));
    expect(panel(host, 'check').querySelector('tbody tr')?.textContent).toBe('SPYx0.99999999 SPYx');
    await click(find(panel(host, 'check'), 'input[type="checkbox"]'));
    await click(primary(host, 'check'));
    await click(primary(host, 'confirm'));
    await settle();
    await settle();
    expect(server.placed().at(-1)?.body).toMatchObject({
      withdrawals: [{ asset: SPYX, amountRaw: '99433230' }],
    });
    expect(recallOrder(ORDER_ID, USER)?.terms).toMatchObject({
      items: [term(SPYX, '99433230', '250000000', '1.0057')],
    });
  });

  it('the whole shown balance is the whole raw balance, whatever the rounding', async () => {
    api({
      vault: holdingVault({
        positions: [
          {
            ...holding(SPYX, '250000001'),
            multiplier: '1.0057',
            display: '2.51425001',
            targetBps: 4_000,
            lastKeeperAt: null,
            valueUsd: '400',
            weightBps: 4_000,
            driftBps: 0,
          },
        ] as VaultView['positions'],
      }),
    });
    const host = await show();
    await click(radio(host, w.what.some));
    await click(find(pick(host, SPYX), 'input[type="checkbox"]'));
    // 250000001 raw is shown as 2.51425001 (rounded down from 2.514250010057)
    expect(pick(host, SPYX).textContent).toContain(w.what.holds('2.51425001 SPYx'));
    await type(
      find<HTMLInputElement>(pick(host, SPYX), 'input[inputmode="decimal"]'),
      '2.51425001',
    );
    expect(primary(host, 'what').getAttribute('aria-disabled')).toBeNull();
    await click(primary(host, 'what'));
    // the cash stays, so the vault is not emptied; the stock token leaves in full
    expect(panel(host, 'check').querySelector('tbody tr')?.textContent).toBe('SPYx2.51425001 SPYx');
  });

  it('offers nothing for a vault it cannot hold to the person’s wallet', async () => {
    // A vault the API says is theirs under a plan number that does not lead to its address.
    const server = api({ vault: holdingVault({ basketId: '43' }) });
    const host = await show();
    await through(host);
    expect(find(panel(host, 'confirm'), '[role="alert"]').textContent).toBe(
      w.confirm.blocked.vault,
    );
    expect(server.placed()).toEqual([]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal, keeps nothing and goes nowhere', async () => {
    api({
      order: () => json({ error: 'the vault holds no solana:usdc to withdraw' }, 409),
    });
    const host = await show();
    await through(host);
    expect(find(panel(host, 'confirm'), '[role="alert"]').textContent).toBe(
      en.shared.publish.failure.said('the vault holds no solana:usdc to withdraw'),
    );
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('a withdrawal on the order screen', () => {
  const PART: SharedTerms = {
    kind: 'withdraw',
    vault: MY_VAULT,
    basketId: '42',
    owner: SOLANA,
    everything: false,
    items: [term(CASH, '250000000', '600000000'), term(SPYX, null, '250000000')],
    autoFollowOff: false,
  };
  const ALL: SharedTerms = { ...PART, everything: true, items: [term(CASH, null, '600000000')] };

  function seed(terms: SharedTerms) {
    const record: OrderRecord = {
      orderId: ORDER_ID,
      userId: USER,
      proposalId: '',
      chain: 'solana',
      amountUsd: 0,
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
  const sign = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-variant="primary"]') as HTMLElement | null;
  const asReviewed = () =>
    withdrawOrder([[item(CASH, '250000000', '600000000')], [item(SPYX, null, '250000000')]]);

  it('shows what leaves and the owner’s address, and hands the guard the reviewed tokens and amounts', async () => {
    api({ order: asReviewed });
    seed(PART);
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.withdrawTitle}"]`);
    expect([...review.querySelectorAll('tbody tr')].map((r) => r.textContent)).toEqual([
      'USDC250 USDC',
      `SPYx${w.check.all('2.5 SPYx')}`,
    ]);
    expect(find(review, '[data-ui="withdraw-to"]').textContent).toBe(SOLANA);
    expect(
      [...host.querySelectorAll('[data-ui="order-withdrawal"]')].map((l) => l.textContent),
    ).toEqual([en.order.shared.withdraws('250 USDC'), en.order.shared.withdrawsAll('2.5 SPYx')]);
    expect(host.textContent).not.toContain(en.order.review.deposit);
    expect(sign(host)?.textContent).toContain(en.order.shared.signWithdraw);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.deps.plan).toEqual({
      basketId: '42',
      withdrawals: [
        { asset: CASH, amountRaw: '250000000' },
        { asset: SPYX, amountRaw: null },
      ],
    });
    // done: what stayed is read again on the portfolio
    await settle();
    const done = find(host, '[data-ui="withdraw-done"]');
    expect(done.textContent).toContain(en.order.shared.withdrawDone);
    expect(find(done, 'a').getAttribute('href')).toBe('/monitor');
  });

  it('everything: the guard is held to the vault, and may take any token it holds to its owner', async () => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]]) });
    seed(ALL);
    const host = await screen();
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({ basketId: '42' });
  });

  it('a vault with auto-follow on: the switch off comes first, and the guard is told off and nothing else', async () => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]], {}, true) });
    seed({ ...ALL, autoFollowOff: true });
    const host = await screen();
    const review = find(host, `[aria-label="${en.order.shared.withdrawTitle}"]`);
    expect(find(review, '[data-ui="withdraw-keeper"]').textContent).toBe(
      en.order.shared.autoFollowStops,
    );
    expect(host.querySelectorAll('[data-ui="order-step"]')).toHaveLength(2);
    await click(sign(host) as HTMLElement);
    await settle();
    expect(run.calls[0]?.deps.plan).toEqual({ basketId: '42', autoFollow: false });
  });

  it.each([
    ['a switch the review did not show', false, true],
    ['no switch where the review showed one', true, false],
  ])('is not offered for signing when the order has %s', async (_name, reviewed, ordered) => {
    api({ order: () => withdrawOrder([[item(CASH, null, '600000000')]], {}, ordered) });
    seed({ ...ALL, autoFollowOff: reviewed });
    const host = await screen();
    expect(host.textContent).toContain(en.order.mismatch.withdraw);
    expect(sign(host)).toBeNull();
  });

  it('a token that could not move: its step says so, and the order is done except for it, never plainly done', async () => {
    const answered = asReviewed();
    const order = {
      ...answered,
      status: 'done',
      legs: answered.legs.map((l, i) =>
        i === 0
          ? { ...l, status: 'confirmed', txId: 'sig' }
          : {
              ...l,
              status: 'skipped',
              error: { code: 'BalanceUnreadable', message: 'frozen', retryable: false },
            },
      ),
    } as OrderDetail;
    api({ order: () => order });
    seed(PART);
    const host = await screen();
    expect(find(host, '[data-ui="order-skipped"]').textContent).toBe(
      en.order.shared.skipped('SPYx'),
    );
    expect(host.textContent).toContain(en.order.shared.doneExcept('Solana', 1));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
    expect(host.querySelectorAll('[data-ui="order-step"][data-status="skipped"]')).toHaveLength(1);
  });

  /** The reviewed order with every step confirmed on chain. */
  const confirmed = () => {
    const answered = asReviewed();
    return {
      ...answered,
      status: 'done',
      legs: answered.legs.map((l) => ({ ...l, status: 'confirmed', txId: 'sig' })),
    } as OrderDetail;
  };

  it('a token a confirmed step left behind: the vault is read again and the order is done except for it', async () => {
    // as an EVM vault's withdrawAll does: the step confirmed, and the vault still holds the token
    const server = api({ order: confirmed });
    seed(PART);
    const host = await screen();
    await settle();
    expect(server.calls.filter((c) => c.path.startsWith('/v1/vaults/solana/'))).toHaveLength(1);
    expect(host.textContent).toContain(en.order.shared.doneStayed('Solana', 'SPYx'));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
    expect(find(host, '[data-ui="withdraw-stayed"]').textContent).toBe(
      en.order.shared.stayed('SPYx'),
    );
  });

  it('is plainly done only once the vault, read again, holds none of what was to leave whole', async () => {
    api({
      order: confirmed,
      // part of the cash was taken: what is left of it is no token left behind
      vault: holdingVault({ positions: [] }),
    });
    seed(PART);
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.order.outcome.done('Solana'));
    expect(host.querySelector('[data-ui="withdraw-stayed"]')).toBeNull();
  });

  it('never says plainly done when the vault cannot be read again', async () => {
    api({ order: confirmed, vault: null });
    seed(PART);
    const host = await screen();
    await settle();
    expect(host.textContent).toContain(en.order.shared.doneUnread('Solana'));
    expect(host.textContent).not.toContain(en.order.outcome.done('Solana'));
  });

  it.each([
    [
      'a larger amount',
      () =>
        withdrawOrder([[item(CASH, '250000001', '600000000')], [item(SPYX, null, '250000000')]]),
    ],
    [
      'all of a token where part was reviewed',
      () => withdrawOrder([[item(CASH, null, '600000000')], [item(SPYX, null, '250000000')]]),
    ],
    [
      'another token',
      () =>
        withdrawOrder([[item(CASH, '250000000', '600000000')], [item('solana:qqqx', null, '1')]]),
    ],
    [
      'a token more',
      () =>
        withdrawOrder([
          [item(CASH, '250000000', '600000000')],
          [item(SPYX, null, '250000000')],
          [item('solana:qqqx', null, '1')],
        ]),
    ],
    ['a token fewer', () => withdrawOrder([[item(CASH, '250000000', '600000000')]])],
    [
      'a step that is no withdrawal',
      () => {
        const order = asReviewed();
        return {
          ...order,
          legs: order.legs.map((l, i) =>
            i === 1 ? { ...l, kind: 'set_auto_follow', withdrawals: undefined } : l,
          ),
        } as OrderDetail;
      },
    ],
    ['a deposit beside it', () => ({ ...asReviewed(), depositRaw: '1' }) as OrderDetail],
  ])(
    'is not offered for signing when the order takes %s than the review showed',
    async (_name, order) => {
      api({ order });
      seed(PART);
      const host = await screen();
      expect(host.textContent).toContain(en.order.mismatch.withdraw);
      expect(sign(host)).toBeNull();
      expect(run.calls).toEqual([]);
    },
  );
});

describe('the terms of a withdrawal, read back', () => {
  const good = {
    kind: 'withdraw',
    vault: MY_VAULT,
    basketId: '42',
    owner: SOLANA,
    everything: false,
    items: [term(CASH, '1', '2')],
    autoFollowOff: false,
  };
  it('reads what was written, and nothing that is not a withdrawal in full', () => {
    expect(readTerms(good)).toEqual(good);
    for (const bad of [
      { ...good, owner: '' },
      { ...good, basketId: 'x' },
      { ...good, items: [] },
      { ...good, items: [term(CASH, '1', '2'), term(CASH, null, '2')] },
      { ...good, items: [term(CASH, '-1', '2')] },
      { ...good, items: [{ asset: CASH, amountRaw: '1' }] },
      // everything names no amount
      { ...good, everything: true },
      { ...good, everything: 'yes' },
      { ...good, autoFollowOff: undefined },
      { ...good, items: [{ ...term(CASH, '1', '2'), multiplier: '-1' }] },
      { ...good, items: [item(CASH, '1', '2')] },
    ])
      expect(readTerms(bad), JSON.stringify(bad)).toBeNull();
  });
});

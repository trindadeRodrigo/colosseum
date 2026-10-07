// @vitest-environment happy-dom
import { deploymentsOf, GuardRefusal } from '@colosseum/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { json } from '../wallet/test/fake-port';
import { activityOf } from './activity';
import { formatBps, formatRaw, shortfallBps } from './amounts';
import { placeOrder, readFunding, readOrder } from './order-api';
import { checkDeposit, depositRawOf } from './order-check';
import { keepOrder, recallOrder } from './order-record';
import { outcomeView, refusalKind, stepOf } from './order-view';
import { recallPlan, rememberPlan } from './plan-store';
import { targetsOfPlan } from './plan-terms';
import { chainReady, deploymentsFor, explorerUrlFor, networkFor } from './readiness';
import {
  doneOrder,
  LEG_CREATE,
  LEG_SWAP,
  linesOn,
  ORDER_ID,
  orderOn,
  PLAN_ID,
  planOn,
  recordOf,
  USER,
} from './test/fixtures';
import { unitsFor } from './units';

// The pieces of the plan, buy and order screens that decide something without a screen: what a raw
// amount reads as, what a vault holds, what this browser keeps and gives back, which chains can be
// signed on, what the API's answers mean, and the sentence for every answer of the executor.

const en = dictionary('en');

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('amounts', () => {
  it('reads a raw amount with its decimals, cut and never rounded up', () => {
    expect(formatRaw('10000000', 6, 'en')).toBe('10');
    expect(formatRaw('12345678', 6, 'en')).toBe('12.345678');
    expect(formatRaw('1234567891', 9, 'en', 4)).toBe('1.2345');
    expect(formatRaw('1999999', 6, 'en', 2)).toBe('1.99');
    expect(formatRaw('1234567000000', 6, 'pt-BR')).toBe('1.234.567');
    expect(formatRaw('5', 6, 'en')).toBe('0.000005');
    expect(formatRaw('-1', 6, 'en')).toBeNull();
    expect(formatRaw('1.5', 6, 'en')).toBeNull();
  });

  it('says how far under the quote a minimum is, rounded up', () => {
    expect(shortfallBps('1000000', '990000')).toBe(100);
    // a 1% minimum cut down to a raw unit is a hair over 1%: it is the 1% the order states
    expect(shortfallBps('1000001', '990000')).toBe(100);
    expect(shortfallBps('3', '2')).toBe(3333);
    // a gap that is no tolerance's rounding is rounded up, never down: 1.005% is said as 1.01%
    expect(shortfallBps('1000000', '989950')).toBe(101);
    expect(shortfallBps('1000001', '989990')).toBe(101);
    expect(shortfallBps('100', '100')).toBe(0);
    expect(shortfallBps('0', '0')).toBeNull();
    expect(formatBps(75, 'en')).toBe('0.75%');
  });
});

describe('what a vault holds, from the plan the screen showed', () => {
  it('is every line but the cash, with an asset that comes through two lines added up', () => {
    const lines = [
      ...linesOn('solana'),
      { chain: 'solana' as const, assetId: 'solana:spyx', weightBps: 0, amountUsd: 0, reasons: [] },
      {
        chain: 'solana' as const,
        assetId: 'solana:gldx',
        viaIndex: 'gold',
        weightBps: 100,
        amountUsd: 0,
        reasons: [],
      },
    ];
    expect(targetsOfPlan(lines, 'solana', 'solana:usdc')).toEqual([
      { asset: 'solana:spyx', weightBps: 6000 },
      { asset: 'solana:gldx', weightBps: 3600 },
    ]);
  });

  it('is nothing for a plan that is all cash, and refused for a plan on another chain', () => {
    const cash = [{ ...linesOn('solana')[2], weightBps: 10_000 }] as ReturnType<typeof linesOn>;
    expect(targetsOfPlan(cash, 'solana', 'solana:usdc')).toEqual([]);
    expect(targetsOfPlan(linesOn('robinhood'), 'solana', 'solana:usdc')).toBeNull();
  });
});

describe('what this browser keeps', () => {
  it('gives a plan back to the person who built it, and to nobody else', () => {
    rememberPlan(planOn());
    expect(recallPlan(PLAN_ID, USER)?.proposal.lines).toHaveLength(3);
    expect(recallPlan(PLAN_ID, 'did:privy:someone-else')).toBeNull();
    expect(recallPlan(PLAN_ID, null)).toBeNull();
    expect(recallPlan('another', USER)).toBeNull();
    // a plan that no longer parses is not shown
    window.sessionStorage.setItem(
      `tf-plan:${PLAN_ID}`,
      JSON.stringify({ ...planOn(), proposal: {} }),
    );
    expect(recallPlan(PLAN_ID, USER)).toBeNull();
  });

  it('gives an order back with the order as approved, to its person only', () => {
    const approved = { order: orderOn(), consents: [], at: '2026-10-05T12:00:00.000Z' };
    expect(keepOrder(recordOf('solana', { approved }))).toBe(true);
    expect(recallOrder(ORDER_ID, USER)?.approved?.order).toEqual(orderOn());
    expect(recallOrder(ORDER_ID, 'did:privy:someone-else')).toBeNull();
    // an approved order that is another order's is not used
    const other = { ...approved, order: { ...orderOn(), id: PLAN_ID } };
    keepOrder(recordOf('solana', { approved: other }));
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
    // nor is a record in which anything does not read
    window.localStorage.setItem(`tf-order:${ORDER_ID}`, '{"orderId":');
    expect(recallOrder(ORDER_ID, USER)).toBeNull();
  });
});

describe('which chains can be signed on', () => {
  it('takes the deployment from the file committed for this app’s network, never the API', () => {
    // unset means the test network, and its file has Solana, and Robinhood Chain since ADE-2 deployed it
    expect(networkFor('solana', false)).toBe('testnet');
    expect(deploymentsFor('solana', false)?.solana?.family).toBe('solana');
    expect(chainReady('solana', false)).toBe(true);
    expect(networkFor('robinhood', false)).toBe('testnet');
    expect(chainReady('robinhood', false)).toBe(true);
    expect(deploymentsFor('robinhood', false)?.robinhood?.family).toBe('evm');
    // Base is deployed on no network yet: nothing is signed there
    expect(chainReady('base', false)).toBe(false);
    expect(deploymentsFor('base', false)).toBeNull();
    // on the mock both are the mock's
    expect(networkFor('robinhood', true)).toBe('mock');
    expect(deploymentsFor('robinhood', true)?.robinhood?.family).toBe('mock');
  });

  it('links a transaction on Robinhood Chain to the test network’s explorer, never mainnet’s', () => {
    const link = explorerUrlFor('robinhood', '0xab', false);
    expect(link).toBe('https://explorer.testnet.chain.robinhood.com/tx/0xab');
    expect(new URL(link ?? '').origin).not.toBe('https://explorer.chain.robinhood.com');
    // the mock's transactions are no network's: the mock's own link
    expect(explorerUrlFor('robinhood', '0xab', true)).toBe('mock://robinhood/tx/0xab');
    expect(explorerUrlFor('robinhood', null, false)).toBeNull();
  });

  it('signs nothing on mainnet, which has no deployment file', () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'mainnet');
    try {
      expect(networkFor('solana', false)).toBe('mainnet');
      expect(chainReady('solana', false)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the calls before anything is signed', () => {
  it('reads funding for this plan, amount and wallet, and nothing that is not in its shape', async () => {
    const funding = {
      chain: 'solana',
      name: 'Solana',
      mode: 'live',
      provenance: 'sandbox',
      wallet: 'So11111111111111111111111111111111111111112',
      cash: {
        asset: 'solana:usdc',
        symbol: 'USDC',
        decimals: 6,
        haveRaw: '0',
        needRaw: '10000000',
        missingRaw: '10000000',
        source: 'devnet',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'balance',
        provenance: 'sandbox',
      },
      gas: {
        symbol: 'SOL',
        decimals: 9,
        haveRaw: '0',
        needRaw: '1',
        missingRaw: '1',
        source: 'devnet',
        fetchedAt: '2026-10-05T12:00:00.000Z',
        method: 'balance',
        provenance: 'sandbox',
      },
      steps: 2,
      newVault: true,
      ok: false,
    };
    const api = vi.fn(async () => json(funding));
    const read = await readFunding(api, { proposalId: PLAN_ID, amountUsd: 10, wallet: 'W' });
    expect(read).toMatchObject({ kind: 'read', funding: { ok: false } });
    expect(api).toHaveBeenCalledWith(`/v1/funding?amountUsd=10&proposalId=${PLAN_ID}&wallet=W`);
    expect(
      await readFunding(async () => json({ ok: true }), {
        proposalId: PLAN_ID,
        amountUsd: 10,
        wallet: 'W',
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      await readFunding(async () => json({}, 429), {
        proposalId: PLAN_ID,
        amountUsd: 10,
        wallet: 'W',
      }),
    ).toEqual({ kind: 'busy' });
  });

  it('makes a buy owned by the wallet of the plan’s chain, and takes back only an order of it', async () => {
    const api = vi.fn(async () => json(orderOn()));
    const ask = {
      proposalId: PLAN_ID,
      amountUsd: 10,
      chain: 'solana' as const,
      owner: orderOn().owner.solana as string,
    };
    expect(await placeOrder(api, ask)).toEqual({ kind: 'placed', order: orderOn() });
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/orders');
    expect(JSON.parse(String(init.body))).toEqual({
      type: 'buy',
      owner: { solana: ask.owner },
      amountUsd: 10,
      proposalId: PLAN_ID,
    });
    // an order for someone else, or on another chain, is not this buy
    expect(await placeOrder(api, { ...ask, owner: 'someone' })).toEqual({ kind: 'unreadable' });
    expect(await placeOrder(async () => json(orderOn('robinhood')), { ...ask })).toEqual({
      kind: 'unreadable',
    });
  });

  it('turns each refusal into the thing the person can do about it', async () => {
    const ask = { proposalId: PLAN_ID, amountUsd: 10, chain: 'solana' as const, owner: 'x' };
    const said = (status: number, body: object = {}) =>
      placeOrder(async () => json({ error: 'e', ...body }, status), ask);
    expect(await said(409, { code: 'NOT_FUNDED' })).toEqual({ kind: 'code', code: 'NOT_FUNDED' });
    expect(await said(409, { code: 'VERSION_CHANGED' })).toEqual({
      kind: 'code',
      code: 'VERSION_CHANGED',
    });
    expect(await said(429, { code: 'RATE_LIMITED' })).toEqual({ kind: 'busy' });
    expect(await said(401)).toEqual({ kind: 'signed-out' });
    expect(await said(404)).toEqual({ kind: 'no-plan' });
    expect(await said(409)).toEqual({ kind: 'no-chain' });
    expect(await said(422)).toEqual({ kind: 'refused' });
    expect(await said(503)).toEqual({ kind: 'unreachable' });
    expect(
      await placeOrder(async () => Promise.reject(new TypeError('fetch failed')), ask),
    ).toEqual({ kind: 'unreachable' });
    expect(await readOrder(async () => json({ ...orderOn(), id: PLAN_ID }), ORDER_ID)).toEqual({
      kind: 'unreadable',
    });
  });
});

describe('what the order screen says about each answer of the executor', () => {
  const order = orderOn();
  const view = (o: Parameters<typeof outcomeView>[0]) => outcomeView(o, en, 'solana');

  it('names a step by its place in the order', () => {
    expect(stepOf(order, LEG_CREATE)).toBe(1);
    expect(stepOf(order, LEG_SWAP)).toBe(2);
  });

  it('says why the guard refused a step, and the check that failed', () => {
    const refused = view({
      status: 'refused',
      order,
      legId: LEG_SWAP,
      refusal: new GuardRefusal(
        'minimum',
        'the least the trade pays out is not the step’s',
        LEG_SWAP,
      ),
    });
    expect(refused.sentence).toBe(
      `${en.order.outcome.refused(2)} ${en.order.outcome.refusedWhy.moved}`,
    );
    expect(refused.check).toBe(en.order.outcome.check('minimum'));
    expect(refused.detail).toBe('the least the trade pays out is not the step’s');
    expect(refused.next).toEqual({ kind: 'new-order' });
    expect(refusalKind('targets')).toBe('mismatch');
    expect(refusalKind('recipient')).toBe('mismatch');
    expect(refusalKind('deployment')).toBe('setup');
    expect(refusalKind('preview')).toBe('moved');
  });

  it('asks again after needs_review, with that answer’s step and count', () => {
    const asked = view({
      status: 'needs_review',
      order,
      legId: LEG_SWAP,
      signedTimes: 1,
      why: 'unproven',
    });
    expect(asked.sentence).toBe(en.order.outcome.needsReview(2, 1));
    expect(asked.next).toEqual({ kind: 'approve-again', legId: LEG_SWAP, signedTimes: 1, step: 2 });
  });

  it('offers to run again only where the executor allows it', () => {
    const wallet = { code: 'rejected' as const, message: 'no' };
    expect(view({ status: 'cancelled', order, legId: LEG_SWAP, wallet }).next.kind).toBe('run');
    expect(view({ status: 'waiting', order, legId: LEG_SWAP, why: 'landing' }).next.kind).toBe(
      'run',
    );
    expect(
      view({ status: 'error', order, legId: null, error: { status: 500, message: 'x' } }).next.kind,
    ).toBe('run');
    // a plan that is gone is not bought by trying again: the person is told to make it again
    const gone = view({
      status: 'error',
      order,
      legId: LEG_SWAP,
      error: {
        status: 409,
        message: 'the plan this order buys is gone',
        body: { error: 'the plan this order buys is gone', code: 'PLAN_GONE' },
      },
    });
    expect([gone.sentence, gone.next.kind]).toEqual([en.order.outcome.planGone, 'none']);
    // a revert is never sent again, and an expired order is over
    expect(view({ status: 'failed', order, legId: LEG_SWAP, error: null }).next.kind).toBe(
      'new-order',
    );
    expect(view({ status: 'expired', order }).next.kind).toBe('new-order');
    expect(
      view({ status: 'blocked', order, legId: LEG_SWAP, blocking: { orderId: 'o2', legId: 'l2' } })
        .next,
    ).toEqual({ kind: 'other-order', orderId: 'o2' });
    expect(view({ status: 'done', order }).next.kind).toBe('none');
    expect(view({ status: 'elsewhere' }).sentence).toBe(en.order.outcome.elsewhere);
    expect(view({ status: 'not-runnable', why: 'no-deployment' }).sentence).toBe(
      en.order.outcome.notRunnable['no-deployment']('Solana'),
    );
  });
});

describe('an order holds the amount the person typed, in committed units', () => {
  const units = unitsFor('solana', false);

  it('reads the cash token from the deploy record, the same one the guard derives from', () => {
    expect(units?.cash).toBe(deploymentsOf('testnet').solana?.cash);
    expect(units?.tokens[units.cash]).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(units?.tokens['solana:spyx']).toEqual({ symbol: 'SPYx', decimals: 8 });
    expect(unitsFor('solana', true)?.cash).toBe(deploymentsOf('mock').solana?.cash);
    expect(unitsFor('robinhood', true)?.cash).toBe(deploymentsOf('mock').robinhood?.cash);
    // Robinhood Chain's test network: the units of its committed deployment, the names of its record
    const robinhood = unitsFor('robinhood', false);
    expect(robinhood?.cash).toBe(deploymentsOf('testnet').robinhood?.cash);
    expect(robinhood?.tokens[robinhood.cash]).toEqual({ symbol: 'tUSDG', decimals: 6 });
    expect(robinhood?.tokens['robinhood:tspy']).toEqual({ symbol: 'SPY', decimals: 18 });
    expect(unitsFor('base', false)).toBeNull();
    // the mock's dollar goes by the name of the chain it stands in for: never USDC on Robinhood Chain
    const mock = unitsFor('robinhood', true);
    expect(mock && mock.tokens[mock.cash]?.symbol).toBe('tUSDG');
    const mockSolana = unitsFor('solana', true);
    expect(mockSolana && mockSolana.tokens[mockSolana.cash]?.symbol).toBe('USDC');
  });

  it('takes every decimals from the deployment file the guard reads, and the mock’s from cashDecimals', () => {
    const testnet = deploymentsOf('testnet').solana;
    if (testnet?.family !== 'solana') throw new Error('the test network has a Solana deployment');
    const assets = Object.entries(testnet.assets);
    expect(assets.length).toBeGreaterThan(1);
    for (const [id, asset] of assets) expect(units?.tokens[id]?.decimals).toBe(asset.decimals);
    expect(Object.keys(units?.tokens ?? {}).sort()).toEqual(assets.map(([id]) => id).sort());
    for (const chain of ['solana', 'robinhood', 'base'] as const) {
      const mock = deploymentsOf('mock')[chain];
      if (mock?.family !== 'mock') throw new Error('the mock has every chain');
      expect(unitsFor(chain, true)?.tokens[mock.cash]?.decimals).toBe(mock.cashDecimals);
    }
  });

  it('passes an order that deposits the amount, and whose steps stay within it', () => {
    expect(depositRawOf(10, 6)).toBe(10_000_000n);
    expect(depositRawOf(12.34, 6)).toBe(12_340_000n);
    expect(checkDeposit(orderOn(), 10, units)).toEqual({
      ok: true,
      depositRaw: 10_000_000n,
      decimals: 6,
    });
  });

  it('refuses the review’s hostile answer: $40 typed, 40,000 dollars of cash deposited', () => {
    const order = orderOn();
    const hostile = {
      ...order,
      depositRaw: '40000000000',
      legs: order.legs.map((l) => (l.cashRaw ? { ...l, cashRaw: '40000000000' } : l)),
    };
    expect(checkDeposit(hostile, 40, units)).toEqual({ ok: false, why: 'deposit' });
    // read at the record's 6 decimals, that deposit is what a buy of $40,000 moves
    expect(checkDeposit(hostile, 40_000, units)).toEqual({
      ok: true,
      depositRaw: 40_000_000_000n,
      decimals: 6,
    });
  });

  it('refuses a step about another amount, a trade that overspends, and a chain with no units', () => {
    const order = orderOn();
    const leg = (i: number, over: object) => ({
      ...order,
      legs: order.legs.map((l, j) => (j === i ? { ...l, ...over } : l)),
    });
    expect(checkDeposit(leg(0, { cashRaw: '1' }), 10, units)).toEqual({ ok: false, why: 'steps' });
    const trade = (amountInRaw: string, sell = 'solana:usdc') =>
      leg(1, { trades: [{ sell, buy: 'solana:spyx', amountInRaw }] });
    expect(checkDeposit(trade('10000001'), 10, units)).toEqual({ ok: false, why: 'steps' });
    expect(checkDeposit(trade('1', 'solana:gldx'), 10, units)).toEqual({ ok: false, why: 'steps' });
    expect(checkDeposit({ ...order, depositRaw: undefined }, 10, units)).toEqual({
      ok: false,
      why: 'deposit',
    });
    expect(checkDeposit(order, 10, null)).toEqual({ ok: false, why: 'units' });
  });
});

describe('what reached the chain, line by line', () => {
  it.each([
    ['solana', 'Solscan'],
    ['robinhood', 'Robinhood explorer'],
  ] as const)('says the chain of every line on %s, and names its explorer', (chain, explorer) => {
    const lines = activityOf(doneOrder(chain), en, false);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.chain).toBe(chain);
      expect(line.explorer).toBe(explorer);
    }
    expect(dictionary('pt').chain.explorers[chain]).toBe(
      chain === 'solana' ? 'Solscan' : 'explorador da Robinhood',
    );
    if (chain === 'robinhood')
      expect(lines.map((line) => line.detail).join(' ')).not.toMatch(/usdc/i);
  });

  it('names Robinhood Chain’s dollar tUSDG, also where the mock’s id says usdc', () => {
    const order = doneOrder('robinhood');
    const mocked = {
      ...order,
      legs: order.legs.map((leg) => ({
        ...leg,
        trades: leg.trades.map((t) => ({ ...t, sell: 'robinhood:usdc' })),
      })),
    };
    const detail = activityOf(mocked, en, true)
      .map((line) => line.detail)
      .join(' ');
    expect(detail).toContain('tUSDG → SPY');
    expect(detail).not.toMatch(/usdc/i);
  });

  it('names each token as the review does: by its committed symbol, else by its ticker', () => {
    const detail = (order: ReturnType<typeof doneOrder>, mock: boolean) =>
      activityOf(order, en, mock)
        .map((line) => line.detail)
        .join(' ');
    expect(detail(doneOrder('solana'), false)).toContain('USDC → SPYx');
    const order = doneOrder('solana');
    const onMock = {
      ...order,
      legs: order.legs.map((leg) => ({
        ...leg,
        trades: leg.trades.map((t) => ({ ...t, buy: 'solana:spy' })),
      })),
    };
    expect(detail(onMock, true)).toContain('USDC → SPY');
  });
});

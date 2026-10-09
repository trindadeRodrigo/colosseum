import type { BasketTx, BuildLegResponse, ChainId, OrderDetail } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { type ApiDouble, apiDouble } from '../../test/api-double';
import { type MockWorld, mockChainRead, mockWorld, tampered } from '../../test/mock';
import { withRules } from '../../test/rules';
import { GUARD_CHECKS, type GuardCode } from '../guard/refusal';
import { runGuard } from '../guard/run';
import { ApiRefusal, type OrderApi } from './api';
import { type ChainRead, chainReadOf, type Fate, type RpcCall } from './chain-read';
import {
  DEFAULT_PATIENCE,
  type ExecutionEvent,
  type ExecutorDeps,
  makeExecute,
  type SignedRecord,
  type SignedStore,
  signedKey,
} from './execute';
import { execute } from './index';

vi.mock('../guard/rules', () => import('../../test/rules'));

// The executor end to end on packages/chain-mock, through an API double that follows the order routes
// (test/api-double.ts). tests/sdk-executor.test.ts runs it against the real route handlers.

type Scene = {
  w: MockWorld;
  double: ApiDouble;
  wallet: ReturnType<typeof walletOf>;
  deps: ExecutorDeps;
  events: ExecutionEvent[];
  slept: number[];
};

/** A wallet as the web's port is: it signs what it is handed and keeps no order of its own. */
function walletOf(w: MockWorld, signOnly = true) {
  const asked: BasketTx[] = [];
  return {
    asked,
    active: vi.fn((): { address: string } | null => ({ address: w.owner })),
    caps: () => ({ signOnly }),
    sign: vi.fn(async (_chain: ChainId, txs: BasketTx[]) => {
      asked.push(...txs);
      return txs.map((tx) => w.adapter.mock.sign(tx));
    }),
    send: vi.fn(async (_chain: ChainId, tx: BasketTx) => {
      asked.push(tx);
      return { txId: (await w.adapter.mock.send(tx)).txId };
    }),
  };
}

function scene(
  chain: ChainId,
  o: { signOnly?: boolean; api?: (api: OrderApi) => OrderApi } = {},
): Scene {
  const w = mockWorld(chain);
  const double = apiDouble(w);
  const wallet = walletOf(w, o.signOnly);
  const events: ExecutionEvent[] = [];
  const slept: number[] = [];
  const deps: ExecutorDeps = {
    api: o.api ? o.api(double.api) : double.api,
    signer: wallet,
    deployments: { [chain]: w.deployment },
    plan: double.plan,
    // Kept for the life of the scene, as a store that outlives the page is.
    signed: new Map<string, SignedRecord>(),
    // Time passes on the mock chain only when the executor waits.
    sleep: async (ms) => {
      slept.push(ms);
      w.adapter.mock.advance(Math.ceil(ms / 1000));
    },
    onEvent: (e) => events.push(e),
  };
  return { w, double, wallet, deps, events, slept };
}

const vaultOf = async (s: Scene) =>
  (await s.w.adapter.getVaults(s.w.owner)).find((v) => v.basketId === s.double.plan.basketId);
const statuses = (order: OrderDetail) => order.legs.map((l) => `${l.kind}:${l.status}`);

describe('the executor: an order walked to its end', () => {
  it('on Solana: the vault is opened with the cash, then one trade per transaction', async () => {
    const s = scene('solana');
    const order = await s.double.buy(1000);
    expect(order.legs.map((l) => l.kind)).toEqual(['create_vault', 'swap', 'swap', 'swap']);

    const result = await execute(order, s.deps);
    expect(result.status).toBe('done');
    expect(statuses(result.order)).toEqual([
      'create_vault:confirmed',
      'swap:confirmed',
      'swap:confirmed',
      'swap:confirmed',
    ]);
    expect(result.order.status).toBe('done');
    // One signature per step, each on the bytes the API built for that step.
    expect(s.wallet.sign).toHaveBeenCalledTimes(4);
    expect(s.wallet.asked.map((tx) => tx.legId)).toEqual(order.legs.map((l) => l.id));
    expect(s.wallet.asked.every((tx) => Object.isFrozen(tx))).toBe(true);
    // The plan keeps 5% in cash: the trades spend 950 of the 1,000 deposited.
    const vault = await vaultOf(s);
    expect(vault?.cash.raw).toBe('50000000');
    expect(vault?.positions.map((p) => p.asset).sort()).toEqual([
      'solana:gold',
      'solana:nvda',
      'solana:spy',
    ]);
    // Every step: build, guard, sign, report. Nothing is built before the step before it has settled.
    expect(s.double.calls.filter((c) => !c.startsWith('get'))).toEqual(
      order.legs.flatMap((l) => [`build ${l.id}`, `report ${l.id}`]),
    );
    const first = order.legs[0]?.id;
    expect(s.events.filter((e) => e.legId === first).map((e) => e.phase)).toEqual([
      'building',
      'checking',
      'signing',
      'reporting',
      'settled',
    ]);
  });

  it('holds every step to the minimum the order stated, though the price ticks between the order and each build', async () => {
    // A yield token's price ticks all day. The order states its minimums when it is made; each step
    // is built later, at another price, and has to carry the stated minimum or the guard refuses it.
    const s = scene('solana');
    const order = await s.double.buy(1000);
    const stated = order.legs.map((l) => l.expected.map((e) => e.minOutRaw));
    // every asset a little cheaper than when the order was made: each trade now pays out more, and a
    // minimum worked out from today's quote would be another figure
    const tick = (asset: string, usdPerToken: string) =>
      s.w.adapter.mock.setPrice(asset, usdPerToken);
    tick('solana:spy', '99.9');
    tick('solana:nvda', '49.95');
    tick('solana:gold', '199.8');
    const result = await execute(order, s.deps);
    expect(result.status).toBe('done');
    expect(statuses(result.order)).toEqual([
      'create_vault:confirmed',
      'swap:confirmed',
      'swap:confirmed',
      'swap:confirmed',
    ]);
    // what the wallet was asked to sign states the order's own minimums, to the unit
    const signed = order.legs.map((l) =>
      (s.wallet.asked.find((tx) => tx.legId === l.id)?.preview.minimums ?? []).map(
        (m) => m.minOutRaw,
      ),
    );
    expect(signed).toEqual(stated);
    expect(stated.flat().length).toBe(3);
  });

  it('builds nothing for a step whose stated minimum the price can no longer meet, and says the price moved', async () => {
    const s = scene('solana');
    const order = await s.double.buy(1000);
    // SPY costs 5% more than when the order was made: the 1% under its quote is out of reach
    s.w.adapter.mock.setPrice('solana:spy', '105');
    const result = await execute(order, s.deps);
    expect(result.status).not.toBe('done');
    expect(statuses(result.order).slice(0, 2)).toEqual(['create_vault:confirmed', 'swap:planned']);
    // the wallet was asked for the deposit alone: no swap was built at other terms, and none signed
    expect(s.wallet.asked.map((tx) => tx.legKind)).toEqual(['create_vault']);
    // and the answer carries the API's own words for it
    expect(JSON.stringify(result)).toMatch(/PriceMoved|price has moved/);
  });

  it('on an EVM chain: the vault is approved by its address, then opened with the trades inside', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(1000);
    expect(order.legs.map((l) => [l.kind, l.cashRaw, l.trades.length])).toEqual([
      ['approve', '1000000000', 0],
      ['create_vault', '1000000000', 3],
    ]);
    const result = await execute(order, s.deps);
    expect(result.status).toBe('done');
    expect(s.wallet.sign).toHaveBeenCalledTimes(2);
    expect((await vaultOf(s))?.cash.raw).toBe('50000000');

    // A second buy of the same plan: an approval for exactly the deposit, then the deposit.
    const again = await s.double.buy(250);
    expect(again.legs.map((l) => l.kind)).toEqual(['approve', 'deposit']);
    expect((await execute(again, s.deps)).status).toBe('done');
    expect(s.wallet.sign).toHaveBeenCalledTimes(4);
  });

  it('with a wallet that sends what it signs: each step is reported by its id', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(400);
    const result = await execute(order, s.deps);
    expect(result.status).toBe('done');
    expect(s.wallet.send).toHaveBeenCalledTimes(2);
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });

  it('answers done for an order that is already done, and signs nothing', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    await execute(order, s.deps);
    const calls = s.wallet.sign.mock.calls.length;
    expect((await execute(order, s.deps)).status).toBe('done');
    expect(s.wallet.sign).toHaveBeenCalledTimes(calls);
  });
});

// ---- a hostile API: at each step, a transaction that is not the step

type Lie = {
  name: string;
  /** The step kinds the lie can be told about. */
  kinds: string[];
  /** The check that refuses it. More than one where it depends on which step came before. */
  code: GuardCode[];
  tell: (honest: BasketTx, s: Scene, earlier: BasketTx | undefined) => BasketTx;
  /** The bytes are ones the wallet already signed for an earlier step. */
  replay?: true;
  /** It is about a trade, so it can only be told of a step that makes one. */
  trades?: true;
};
const LIES: Lie[] = [
  {
    name: 'moves more cash',
    kinds: ['approve', 'create_vault', 'deposit'],
    code: ['amount'],
    tell: (tx) =>
      tampered(tx, (m) => {
        const field = m.op.kind === 'create_vault' ? 'depositRaw' : 'amountRaw';
        m.op.a[field] = (BigInt(String(m.op.a[field])) * 2n).toString();
      }),
  },
  {
    name: 'approves a stranger',
    kinds: ['approve'],
    code: ['spender'],
    tell: (tx, s) =>
      tampered(tx, (m) => {
        m.op.a.spender = s.w.stranger;
      }),
  },
  {
    name: 'opens the vault for a stranger',
    kinds: ['create_vault'],
    code: ['owner'],
    tell: (tx, s) =>
      tampered(tx, (m) => {
        m.op.a.owner = s.w.stranger;
      }),
  },
  {
    name: 'switches auto-follow on',
    kinds: ['create_vault'],
    code: ['auto_follow'],
    tell: (tx) =>
      tampered(tx, (m) => {
        m.op.a.autoFollow = true;
      }),
  },
  {
    name: 'accepts less from a trade',
    trades: true,
    kinds: ['create_vault', 'deposit', 'swap'],
    code: ['minimum'],
    tell: (tx) =>
      tampered(tx, (m) => {
        m.mins = m.mins.map(() => '1');
      }),
  },
  {
    name: 'sells more in a trade',
    kinds: ['swap'],
    code: ['amount'],
    tell: (tx) =>
      tampered(tx, (m) => {
        const [trade] = m.op.a.trades as [{ amountInRaw: string }];
        trade.amountInRaw = (BigInt(trade.amountInRaw) + 1n).toString();
      }),
  },
  {
    name: "trades in a stranger's vault",
    kinds: ['deposit', 'swap'],
    code: ['vault'],
    tell: (tx, s) =>
      tampered(tx, (m) => {
        m.op.a.vault = s.w.stranger;
      }),
  },
  {
    name: 'is another operation: a withdrawal',
    kinds: ['approve', 'create_vault', 'deposit', 'swap'],
    code: ['step'],
    tell: (tx, s) =>
      tampered(tx, (m) => {
        m.op = { kind: 'withdraw', a: { vault: s.w.stranger, assets: [`${s.w.chain}:spy`] } };
      }),
  },
  {
    name: 'is signed by a stranger',
    kinds: ['approve', 'create_vault', 'deposit', 'swap'],
    code: ['signer'],
    tell: (tx, s) => ({ ...tx, signer: s.w.stranger, feePayer: undefined }),
  },
  {
    name: 'carries the bytes of the step before',
    kinds: ['create_vault', 'deposit', 'swap'],
    // Another kind of operation, or the same kind with the trade of the step before.
    code: ['step', 'asset'],
    replay: true,
    tell: (tx, _s, earlier) =>
      earlier
        ? { ...tx, payload: earlier.payload, evm: earlier.evm, messageHash: earlier.messageHash }
        : tx,
  },
];

/** The API as it is, except that one step is answered with a lie. Every other answer is honest. */
function lying(s: Scene, legId: string, lie: Lie): OrderApi {
  const honest = s.double.api;
  let earlier: BasketTx | undefined;
  return {
    ...honest,
    async buildLeg(orderId, id) {
      const built = await honest.buildLeg(orderId, id);
      if (id !== legId) {
        earlier = built.tx;
        return built;
      }
      const tx = lie.tell(built.tx, s, earlier);
      // The lie is consistent with itself: the attempt carries the hash of the bytes handed out.
      return { tx, attempt: { ...built.attempt, messageHash: tx.messageHash } };
    },
  };
}

const withoutChecks = makeExecute((input) =>
  withRules({ without: [...GUARD_CHECKS] }, () => runGuard(input)),
);

describe('the executor: a hostile API, at each step, is refused and nothing is signed', () => {
  // A second buy on the EVM chain reaches the deposit; the first reaches the create and the swaps.
  const walks: [string, ChainId, boolean][] = [
    ['a first buy on Solana', 'solana', false],
    ['a first buy on an EVM chain', 'robinhood', false],
    ['a second buy on an EVM chain', 'robinhood', true],
    ['a second buy on Solana', 'solana', true],
  ];
  for (const [walk, chain, second] of walks) {
    const kinds =
      chain === 'solana'
        ? [second ? 'deposit' : 'create_vault', 'swap', 'swap', 'swap']
        : ['approve', second ? 'deposit' : 'create_vault'];
    kinds.forEach((kind, at) => {
      for (const lie of LIES.filter((l) => l.kinds.includes(kind))) {
        if (lie.replay && at === 0) continue;
        // On Solana the create and the deposit trade nothing: the trades are steps of their own.
        if (lie.trades && chain === 'solana' && kind !== 'swap') continue;
        it(`${walk}, step ${at + 1} (${kind}): a transaction that ${lie.name}`, async () => {
          const run = async (how: typeof execute) => {
            const s = scene(chain);
            if (second)
              expect((await execute(await s.double.buy(100), s.deps)).status).toBe('done');
            const before = s.wallet.asked.length;
            const order = await s.double.buy(500);
            const leg = order.legs[at];
            if (!leg || leg.kind !== kind) throw new Error(`step ${at} is not a ${kind}`);
            const cash = (await s.w.adapter.getWalletHoldings(s.w.owner))[0]?.raw;
            const api = lying(s, leg.id, lie);
            const result = await how(order, { ...s.deps, api });
            return { s, order, leg, result, signed: s.wallet.asked.length - before, cash };
          };

          const { s, order, leg, result, signed } = await run(execute);
          expect(result.status).toBe('refused');
          if (result.status !== 'refused') return;
          expect(result.legId).toBe(leg.id);
          expect(lie.code, result.refusal.message).toContain(result.refusal.code);
          // The steps before it were signed, and this one was not: the wallet never saw its bytes.
          expect(signed).toBe(at);
          expect(s.wallet.asked.some((tx) => tx.legId === leg.id)).toBe(false);
          // The refusal is written to the API before anything else, and no later step is built.
          const after = s.double.calls.slice(s.double.calls.lastIndexOf(`build ${leg.id}`));
          expect(after[1]).toBe(`cancel ${leg.id}`);
          expect(after.some((c) => c.startsWith('build') && c !== `build ${leg.id}`)).toBe(false);
          for (const later of order.legs.slice(at + 1))
            expect(s.double.calls).not.toContain(`build ${later.id}`);
          expect(result.order.legs.find((l) => l.id === leg.id)?.status).not.toBe('confirmed');

          const unguarded = await run(withoutChecks);
          const reached = unguarded.s.wallet.asked.some((tx) => tx.legId === unguarded.leg.id);
          if (lie.replay) {
            // With the guard's checks taken out, the other rule still holds: bytes that were signed for
            // an earlier step are not signed a second time.
            expect(reached).toBe(false);
            expect(unguarded.signed).toBe(at);
          } else {
            // The guard is what stops it: with its checks taken out, the same lie reaches the wallet.
            expect(reached).toBe(true);
            expect(unguarded.signed).toBeGreaterThan(at);
          }
        });
      }
    });
  }

  it('refuses an attempt that is not of the step the transaction is for', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const api: OrderApi = {
      ...s.double.api,
      async buildLeg(orderId, legId) {
        const built = await s.double.api.buildLeg(orderId, legId);
        return { ...built, attempt: { ...built.attempt, messageHash: 'ab'.repeat(32) } };
      },
    };
    const result = await execute(order, { ...s.deps, api });
    expect(result.status === 'refused' && result.refusal.code).toBe('step');
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });

  it('hands the wallet nothing but a pass the guard made, whatever a guard hands back', async () => {
    for (const signOnly of [true, false]) {
      const s = scene('solana', { signOnly });
      const order = await s.double.buy(100);
      // A copy of a real pass, of the same bytes and the same step, is not one.
      const forged = makeExecute((input) => ({ ...runGuard(input) }));
      const result = await forged(order, s.deps);
      expect(result.status, String(signOnly)).toBe('error');
      expect(s.wallet.sign).not.toHaveBeenCalled();
      expect(s.wallet.send).not.toHaveBeenCalled();
    }
  });

  it('builds and signs nothing when the API answers with another order', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const buildLeg = vi.fn(s.double.api.buildLeg);
    const api: OrderApi = {
      ...s.double.api,
      buildLeg,
      async getOrder(id) {
        return { ...(await s.double.api.getOrder(id)), id: 'another-order' };
      },
    };
    const result = await execute(order, { ...s.deps, api });
    expect(result.status === 'error' && result.error.message).toMatch(/another order/);
    expect(buildLeg).not.toHaveBeenCalled();
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });
});

describe('the executor: what was approved is fixed before the API is asked anything', () => {
  it('refuses an order with a step it signs none of, or steps on two chains, and calls nothing', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const [first, second] = order.legs;
    if (!first || !second) throw new Error('two steps');
    const cases: [OrderDetail, GuardCode][] = [
      [{ ...order, legs: [{ ...first, kind: 'adopt_version' }, second] }, 'unsupported'],
      [{ ...order, legs: [{ ...first, kind: 'publish' }, second] }, 'order'],
      [{ ...order, legs: [first, { ...second, chain: 'robinhood' }] }, 'order'],
      [{ ...order, legs: [first, { ...second, expected: [] }] }, 'order'],
      [{ ...order, legs: [{ ...first, cashRaw: '2000000000' }, second] }, 'order'],
      [{ ...order, owner: { evm: `0x${'11'.repeat(20)}` } }, 'order'],
    ];
    for (const [changed, code] of cases) {
      const result = await execute(changed, s.deps);
      expect(result.status === 'refused' && result.refusal.code, code).toBe(code);
    }
    const none = await execute(order, { ...s.deps, deployments: {} });
    expect(none.status === 'refused' && none.refusal.code).toBe('unsupported');
    // An order for another account than the wallet's, and a wallet with no account at all.
    for (const account of [{ address: s.w.stranger }, null]) {
      s.wallet.active.mockReturnValueOnce(account);
      const other = await execute(order, s.deps);
      expect(other.status === 'refused' && other.refusal.code).toBe('signer');
    }
    expect(s.double.calls).toEqual([]);
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });

  it('holds every step to the order it was handed, whatever the API says of it later', async () => {
    // The API raises the amounts of the order it answers with. The steps signed are still the approved
    // ones, so the build that follows the raised order is refused.
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const api: OrderApi = {
      ...s.double.api,
      async getOrder(id) {
        const seen = await s.double.api.getOrder(id);
        return {
          ...seen,
          depositRaw: '900000000',
          legs: seen.legs.map((l) => ({ ...l, cashRaw: '900000000' })),
        };
      },
      async buildLeg(orderId, legId) {
        const built = await s.double.api.buildLeg(orderId, legId);
        const tx = tampered(built.tx, (m) => {
          m.op.a.amountRaw = '900000000';
        });
        return { tx, attempt: { ...built.attempt, messageHash: tx.messageHash } };
      },
    };
    const result = await execute(order, { ...s.deps, api });
    expect(result.status === 'refused' && result.refusal.code).toBe('amount');
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });
});

describe('the executor: a wallet that says no', () => {
  it('cancels the step, signs nothing more, and the order can be run again', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(300);
    s.wallet.sign.mockRejectedValueOnce(
      Object.assign(new Error('the person said no'), { code: 'rejected' }),
    );
    const result = await execute(order, s.deps);
    expect(result).toMatchObject({
      status: 'cancelled',
      legId: order.legs[0]?.id,
      wallet: { code: 'rejected', message: 'the person said no' },
    });
    expect(s.double.calls.at(-1)).toBe(`cancel ${order.legs[0]?.id}`);
    expect(result.order.legs[0]?.status).toBe('expired');
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);

    // Run again: the step is built anew, on the nonce of the attempt that was cancelled.
    const again = await execute(order, s.deps);
    expect(again.status).toBe('done');
    const nonces = again.order.attempts
      .filter((a) => a.legId === order.legs[0]?.id)
      .map((a) => a.nonce);
    expect(nonces).toEqual([0, 0]);
  });

  it('names any other failure of the wallet, and treats what is not a wallet error as unknown', async () => {
    for (const [thrown, code] of [
      [Object.assign(new Error('no gas'), { code: 'no_gas' }), 'no_gas'],
      [Object.assign(new Error('changed'), { code: 'changed' }), 'changed'],
      [new Error('something else'), 'unknown'],
    ] as const) {
      const s = scene('robinhood');
      const order = await s.double.buy(300);
      s.wallet.sign.mockRejectedValueOnce(thrown);
      const result = await execute(order, s.deps);
      expect(result.status === 'cancelled' && result.wallet.code).toBe(code);
    }
  });

  it('builds the step again when the wallet says the transaction went stale before it signed', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.wallet.sign.mockRejectedValueOnce(
      Object.assign(new Error('blockhash not found'), { code: 'expired' }),
    );
    const result = await execute(order, s.deps);
    expect(result.status).toBe('done');
    // On Solana only time closes the attempt that was never signed: the executor waited it out.
    expect(s.slept.length).toBeGreaterThan(0);
    const attempts = result.order.attempts.filter((a) => a.legId === order.legs[0]?.id);
    expect(attempts.map((a) => a.status)).toEqual(['expired', 'confirmed']);
    expect(new Set(attempts.map((a) => a.messageHash)).size).toBe(2);
  });

  it('refuses a wallet that hands back anything but one signed transaction', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.wallet.sign.mockResolvedValueOnce([]);
    const result = await execute(order, { ...s.deps, patience: { waitTries: 0 } });
    expect(result.status === 'cancelled' && result.wallet.code).toBe('changed');
  });
});

describe('the executor: picking an order up again', () => {
  it('a step that was built and never signed is closed and built again, not signed as it was', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const s = scene(chain);
      const order = await s.double.buy(200);
      const first = order.legs[0]?.id as string;
      // The page built the first step and was closed before the wallet was asked.
      const lost = await s.double.api.buildLeg(order.id, first);
      const result = await execute(order, s.deps);
      expect(result.status, chain).toBe('done');
      expect(s.wallet.asked.some((tx) => tx.attemptId === lost.tx.attemptId)).toBe(false);
      const attempts = result.order.attempts.filter((a) => a.legId === first);
      expect(attempts.map((a) => a.status)).toEqual(['expired', 'confirmed']);
      // Solana: the old attempt is waited out. EVM: it is cancelled, and the new one shares its nonce.
      expect(s.slept.length > 0).toBe(chain === 'solana');
      if (chain === 'robinhood') expect(attempts.map((a) => a.nonce)).toEqual([0, 0]);
    }
  });

  it('a step that was sent is tracked until it lands, and nothing is signed for it again', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(200);
    const first = order.legs[0]?.id as string;
    const built = await s.double.api.buildLeg(order.id, first);
    // The transaction is sent and does not land yet.
    s.w.adapter.mock.dropNext();
    await s.double.api.reportLeg(order.id, first, { signedTx: s.w.adapter.mock.sign(built.tx) });
    const waiting = await execute(order, { ...s.deps, patience: { landingTries: 3 } });
    expect(waiting).toMatchObject({ status: 'waiting', legId: first, why: 'landing' });
    expect(s.wallet.sign).not.toHaveBeenCalled();
    expect(s.slept).toEqual([1500, 1500, 1500]);
  });

  it('a signature that was made and never reported is reported again, not made again', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const signed: SignedStore = new Map();
    let down = true;
    const api: OrderApi = {
      ...s.double.api,
      reportLeg: (...args) =>
        down ? Promise.reject(new Error('network down')) : s.double.api.reportLeg(...args),
    };
    const first = await execute(order, { ...s.deps, api, signed });
    expect(first).toMatchObject({
      status: 'error',
      error: { status: null, message: 'network down' },
    });
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);
    // The call was made again before giving up.
    expect(s.slept.filter((ms) => ms === 1000)).toHaveLength(2);

    down = false;
    const second = await execute(order, { ...s.deps, api, signed });
    expect(second.status).toBe('done');
    // Four steps, four signatures: the first step's was reported from what was kept.
    expect(s.wallet.sign).toHaveBeenCalledTimes(4);
    expect(new Set(s.wallet.asked.map((tx) => tx.messageHash)).size).toBe(4);
  });

  it('never signs the same bytes twice, whatever the API hands out', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const first = order.legs[0]?.id as string;
    let kept: BuildLegResponse | undefined;
    const api: OrderApi = {
      ...s.double.api,
      // Every build of the first step answers with the first transaction built for it.
      async buildLeg(orderId, legId) {
        const built = await s.double.api.buildLeg(orderId, legId);
        if (legId !== first) return built;
        kept ??= built;
        return kept;
      },
    };
    // The first transaction is sent and never lands; the step expires and is built again.
    s.w.adapter.mock.dropNext();
    const result = await execute(order, { ...s.deps, api });
    expect(result.status).toBe('error');
    expect(s.double.calls.filter((c) => c === `build ${first}`).length).toBeGreaterThan(1);
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);
  });

  it('builds a step again when its transaction expired without landing, once the chain itself says it is gone', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.w.adapter.mock.dropNext();
    const chainRead = mockChainRead(s.w, () => s.wallet.asked);
    const result = await execute(order, { ...s.deps, chainRead });
    expect(result.status).toBe('done');
    const attempts = result.order.attempts.filter((a) => a.legId === order.legs[0]?.id);
    expect(attempts.map((a) => a.status)).toEqual(['expired', 'confirmed']);
    // Two signatures for that step, on two different messages.
    const asked = s.wallet.asked.filter((tx) => tx.legId === order.legs[0]?.id);
    expect(new Set(asked.map((tx) => tx.messageHash)).size).toBe(2);
  });

  it('gives up on a step that keeps expiring, after the builds it was allowed', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const sign = s.wallet.sign.getMockImplementation();
    s.wallet.sign.mockImplementation(async (chain, txs) => {
      s.w.adapter.mock.dropNext();
      return (sign as NonNullable<typeof sign>)(chain, txs);
    });
    const chainRead = mockChainRead(s.w, () => s.wallet.asked);
    const result = await execute(order, { ...s.deps, chainRead, patience: { rebuilds: 1 } });
    expect(result).toMatchObject({ status: 'error', legId: order.legs[0]?.id });
    expect(s.wallet.sign).toHaveBeenCalledTimes(2);
  });
});

describe('the executor: what the API can answer', () => {
  it('reports again while the chain has not seen the transaction yet', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(100);
    let unseen = 2;
    const api: OrderApi = {
      ...s.double.api,
      async reportLeg(...args) {
        if (unseen > 0) {
          unseen -= 1;
          throw new ApiRefusal(409, {
            error: 'the chain has not seen that transaction yet',
            details: { retryable: true },
          });
        }
        return s.double.api.reportLeg(...args);
      },
    };
    const result = await execute(order, { ...s.deps, api });
    expect(result.status).toBe('done');
    expect(s.slept).toEqual([1500, 1500]);
    expect(s.wallet.send).toHaveBeenCalledTimes(2);

    // And hands the order back as waiting when its patience runs out, with nothing signed twice.
    const t = scene('robinhood', { signOnly: false });
    const later = await t.double.buy(100);
    const never: OrderApi = {
      ...t.double.api,
      reportLeg: () =>
        Promise.reject(new ApiRefusal(409, { error: 'not seen', details: { retryable: true } })),
    };
    const waiting = await execute(later, { ...t.deps, api: never, patience: { reportTries: 3 } });
    expect(waiting).toMatchObject({ status: 'waiting', why: 'unseen', legId: later.legs[0]?.id });
    expect(t.wallet.send).toHaveBeenCalledTimes(1);
  });

  it('stops on a transaction that reverted, and does not send it or build it again', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.w.adapter.mock.revertNext({ code: 'ReceivedTooLittle', message: 'the price moved' });
    const result = await execute(order, s.deps);
    expect(result).toMatchObject({
      status: 'failed',
      legId: order.legs[0]?.id,
      error: { code: 'ReceivedTooLittle' },
    });
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);
    expect((await execute(order, s.deps)).status).toBe('failed');
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);
  });

  it('answers expired for an order that ran out of time, and blocked for a wallet with a step in flight', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.w.adapter.mock.advance(16 * 60);
    expect((await execute(order, s.deps)).status).toBe('expired');
    expect(s.wallet.sign).not.toHaveBeenCalled();

    const t = scene('robinhood');
    const second = await t.double.buy(100);
    const blocking = { orderId: 'another-order', legId: 'its-step' };
    const api: OrderApi = {
      ...t.double.api,
      buildLeg: () =>
        Promise.reject(
          new ApiRefusal(409, {
            error: 'another order is in flight',
            details: { retryable: true, blocking },
          }),
        ),
    };
    expect(await execute(second, { ...t.deps, api })).toMatchObject({
      status: 'blocked',
      legId: second.legs[0]?.id,
      blocking,
    });
  });

  it('hands back what the API refused for good, with its body', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const api: OrderApi = {
      ...s.double.api,
      buildLeg: () =>
        Promise.reject(
          new ApiRefusal(409, {
            error: 'the wallet holds less cash than this',
            code: 'NOT_FUNDED',
            details: { chainCode: 'NotFunded', retryable: false },
          }),
        ),
    };
    expect(await execute(order, { ...s.deps, api })).toMatchObject({
      status: 'error',
      legId: order.legs[0]?.id,
      error: { status: 409, body: { code: 'NOT_FUNDED' } },
    });
  });

  it('stops between steps when asked to, and leaves no signature unreported', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const signal = { aborted: false };
    const result = await execute(order, {
      ...s.deps,
      signal,
      onEvent: (e) => {
        // The person leaves while the first step is being reported.
        if (e.phase === 'reporting') signal.aborted = true;
      },
    });
    expect(result).toMatchObject({ status: 'waiting', why: 'stopped', legId: order.legs[1]?.id });
    expect(result.order.legs[0]?.status).toBe('confirmed');
    expect(s.wallet.sign).toHaveBeenCalledTimes(1);
  });

  it.each(['building', 'checking'] as const)(
    'asked to stop while a step is %s: the wallet is not asked, and the step is signed once by the next run',
    async (phase) => {
      const s = scene('solana');
      const order = await s.double.buy(100);
      const second = order.legs[1]?.id;
      const signal = { aborted: false };
      const result = await execute(order, {
        ...s.deps,
        signal,
        onEvent: (e) => {
          // The card goes while the second step is on its way to the wallet.
          if (e.legId === second && e.phase === phase) signal.aborted = true;
        },
      });
      expect(result).toMatchObject({ status: 'waiting', why: 'stopped', legId: second });
      expect(s.wallet.sign).toHaveBeenCalledTimes(1);
      expect(s.wallet.asked.map((tx) => tx.legId)).toEqual([order.legs[0]?.id]);
      // The attempt that was built is closed, not left to be signed by nobody.
      expect(result.order.legs[1]?.status).not.toBe('built');
      // Run again by the person: every step is signed once, and the order is done.
      const again = await execute(result.order, s.deps);
      expect(again.status).toBe('done');
      expect(s.wallet.asked.map((tx) => tx.legId)).toEqual(order.legs.map((l) => l.id));
    },
  );

  it('asked to stop while a wallet that sends is being written down as asked: it is not asked, and the next run sends once', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(100);
    const signal = { aborted: false };
    // A store that takes time, as an agent's may: the stop arrives while the "asked" record is written.
    const kept = new Map<string, SignedRecord>();
    const signed = {
      get: async (key: string) => kept.get(key),
      set: async (key: string, record: SignedRecord) => {
        await Promise.resolve();
        if (record.proof === null && record.times > 0) signal.aborted = true;
        kept.set(key, record);
      },
    };
    const result = await execute(order, { ...s.deps, signed, signal });
    expect(result).toMatchObject({ status: 'waiting', why: 'stopped', legId: order.legs[0]?.id });
    expect(s.wallet.send).not.toHaveBeenCalled();
    // nothing says the wallet was asked: the next run is not held for a look at a send that never was
    expect([...kept.values()].every((record) => record.times === 0)).toBe(true);
    signal.aborted = false;
    const quiet = {
      get: signed.get,
      set: async (key: string, record: SignedRecord) => void kept.set(key, record),
    };
    const again = await execute(result.order, { ...s.deps, signed: quiet });
    expect(again.status).toBe('done');
    expect(s.wallet.asked.map((tx) => tx.legId)).toEqual(order.legs.map((l) => l.id));
  });

  it('asked to stop before the first step: nothing is signed at all', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(100);
    const signal = { aborted: false };
    const result = await execute(order, {
      ...s.deps,
      signal,
      onEvent: (e) => {
        if (e.phase === 'checking') signal.aborted = true;
      },
    });
    expect(result).toMatchObject({ status: 'waiting', why: 'stopped', legId: order.legs[0]?.id });
    expect(s.wallet.send).not.toHaveBeenCalled();
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });
});

describe('the executor: an API that never lets go', () => {
  it('stops waiting on an attempt the API says it closed and still shows as built', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const first = order.legs[0]?.id as string;
    await s.double.api.buildLeg(order.id, first);
    const stuck = await s.double.api.getOrder(order.id);
    const api: OrderApi = {
      ...s.double.api,
      getOrder: async () => stuck,
      cancelLeg: async () => stuck,
    };
    const result = await execute(order, { ...s.deps, api, patience: { waitTries: 4 } });
    expect(result).toMatchObject({ status: 'waiting', why: 'in_flight', legId: first });
    expect(s.slept).toHaveLength(4);
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });
});

// ---- one approved step, one signature (the review of AGT-1, item 1)

/**
 * The API of the review's proof: it takes each signed transaction of one step, keeps it, and answers
 * that the step expired, so the step is built again. Every build is fresh, as on a real chain.
 */
function hoarding(s: Scene, order: OrderDetail, kind: string) {
  const leg = order.legs.find((l) => l.kind === kind);
  if (!leg) throw new Error(`the order has no ${kind} step`);
  const held: string[] = [];
  const lied: BuildLegResponse['attempt'][] = [];
  const overlay = (o: OrderDetail): OrderDetail => {
    if (!lied.length) return o;
    const out = structuredClone(o);
    const mine = out.legs.find((l) => l.id === leg.id);
    if (mine) Object.assign(mine, { status: 'expired', attempt: lied.length });
    out.attempts.push(...lied.map((a) => ({ ...a, status: 'expired' as const })));
    return out;
  };
  const honest = s.double.api;
  const api: OrderApi = {
    ...honest,
    getOrder: async (id) => overlay(await honest.getOrder(id)),
    cancelLeg: async (id, legId) =>
      legId === leg.id ? overlay(await honest.getOrder(id)) : honest.cancelLeg(id, legId),
    async buildLeg(id, legId) {
      if (legId !== leg.id) return honest.buildLeg(id, legId);
      const vault = await s.double.vault();
      if (!vault) throw new Error('the vault is not open yet');
      const built = await s.w.adapter.buildOwnerSwap({
        vault,
        trades: leg.trades,
        slippageBps: 100,
      });
      const attempt = {
        id: `kept-${lied.length + 1}`,
        legId,
        n: lied.length + 1,
        messageHash: built.messageHash,
        nonce: null,
        status: 'built' as const,
        txId: null,
        explorerUrl: null,
        validUntil: String(built.lastValidBlockHeight),
        builtAt: new Date(0).toISOString(),
      };
      lied.push(attempt);
      return { tx: { ...built, legId, attemptId: attempt.id } as BasketTx, attempt };
    },
    async reportLeg(id, legId, body) {
      if (legId !== leg.id) return honest.reportLeg(id, legId, body);
      if ('signedTx' in body) held.push(body.signedTx);
      return overlay(await honest.getOrder(id));
    },
  };
  /** The API sends everything it was handed. What lands, and what the vault has left in cash. */
  const release = async () => {
    const landed: string[] = [];
    for (const signedTx of held) {
      try {
        const { txId } = await s.w.adapter.relay(signedTx);
        landed.push((await s.w.adapter.track(txId)).status);
      } catch {
        landed.push('refused');
      }
    }
    return landed;
  };
  const signedFor = () => s.wallet.asked.filter((tx) => tx.legId === leg.id);
  return { api, leg, held, release, signedFor };
}
const cashOf = async (s: Scene) => BigInt((await vaultOf(s))?.cash.raw ?? '0');

describe('the executor: one approved step gets one signature', () => {
  it('an API that says each signed step did not land gets one signature, and then the person is asked', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const h = hoarding(s, order, 'swap');
    const result = await execute(order, { ...s.deps, api: h.api });
    expect(result).toMatchObject({
      status: 'needs_review',
      legId: h.leg.id,
      signedTimes: 1,
      why: 'unproven',
    });
    expect(h.signedFor()).toHaveLength(1);
    // The attempt that would have been the second signature was closed before the answer.
    expect(s.events.filter((e) => e.legId === h.leg.id).map((e) => e.phase)).toEqual([
      'building',
      'checking',
      'signing',
      'reporting',
      'building',
      'checking',
    ]);

    // Run again, and again: the store remembers the step, whatever the API says.
    for (let i = 0; i < 3; i += 1)
      expect((await execute(order, { ...s.deps, api: h.api })).status).toBe('needs_review');
    expect(h.signedFor()).toHaveLength(1);

    // What the API was handed lands once, and the vault sold what the step said and no more.
    const before = await cashOf(s);
    expect(await h.release()).toEqual(['confirmed']);
    expect(before - (await cashOf(s))).toBe(BigInt(h.leg.trades[0]?.amountInRaw ?? 0));
  });

  it("with the chain's own word: no second signature while the first can still land, and one once it cannot", async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const h = hoarding(s, order, 'swap');
    const chainRead = mockChainRead(s.w, () => s.wallet.asked);
    const deps = { ...s.deps, api: h.api, chainRead };

    // No time passes while the executor waits: the first signature stays alive.
    const still = await execute(order, {
      ...deps,
      sleep: async () => {},
      patience: { waitTries: 5 },
    });
    expect(still).toMatchObject({ status: 'waiting', legId: h.leg.id, why: 'in_flight' });
    expect(h.signedFor()).toHaveLength(1);

    // Time passes. Each signature is made only after the one before it is past its last valid height
    // and not on the chain, so of everything the API holds, at most the last can land.
    const result = await execute(order, { ...deps, patience: { rebuilds: 1 } });
    expect(result.status).toBe('error');
    const asked = h.signedFor();
    expect(asked.length).toBeGreaterThan(1);
    expect(new Set(asked.map((tx) => tx.messageHash)).size).toBe(asked.length);
    const before = await cashOf(s);
    const landed = await h.release();
    expect(landed.filter((status) => status === 'confirmed').length).toBeLessThanOrEqual(1);
    expect(before - (await cashOf(s))).toBeLessThanOrEqual(
      BigInt(h.leg.trades[0]?.amountInRaw ?? 0),
    );
  });

  /** A chain read that answers what it is told to, and counts how often it was asked. */
  const saying = (...fates: (Fate | Error)[]) => {
    const read = {
      asked: 0,
      heightBefore: async () => 0,
      fateOf: async () => {
        const fate = fates[Math.min(read.asked, fates.length - 1)] as Fate | Error;
        read.asked += 1;
        if (fate instanceof Error) throw fate;
        return fate;
      },
    };
    return read satisfies ChainRead;
  };

  it('three runs over one store, with a read that cannot be believed and an approval for another step: one signature', async () => {
    const reads: [string, ChainRead | undefined, number][] = [
      ['no read', undefined, 1],
      ['a read that throws', saying(new Error('rpc down')), 1],
      ['a read that says junk', saying('gone ' as Fate), 1],
      [
        'a read that says something like gone',
        saying({ toString: () => 'gone' } as unknown as Fate),
        1,
      ],
      // A read that cannot say where a real chain is signs nothing there (real-bytes.test.ts); the
      // mock chain is not asked for a height at all.
    ];
    for (const [name, chainRead, signatures] of reads) {
      const s = scene('solana');
      const order = await s.double.buy(100);
      const h = hoarding(s, order, 'swap');
      for (let run = 0; run < 3; run += 1)
        await execute(order, {
          ...s.deps,
          api: h.api,
          chainRead,
          approvedAgain: { legId: 'another step', signedTimes: 1 },
          patience: { waitTries: 2, knownTries: 2 },
        });
      expect(h.signedFor(), name).toHaveLength(signatures);
    }
  });

  it('EVM: a held signature whose nonce another transaction took is dropped, and the step signed once more', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const approve = order.legs.find((l) => l.kind === 'approve');
    if (!approve) throw new Error('no approval');
    let first: string | undefined;
    // The report of the first signature never gets through: the API says the chain has not seen it.
    const api: OrderApi = {
      ...s.double.api,
      async reportLeg(id, legId, body) {
        if (legId === approve.id && 'signedTx' in body && first === undefined)
          first = body.signedTx;
        if (legId === approve.id && 'signedTx' in body && first === body.signedTx)
          throw new ApiRefusal(409, { error: 'not seen yet', details: { retryable: true } });
        return s.double.api.reportLeg(id, legId, body);
      },
    };
    const chainRead = mockChainRead(s.w, () => s.wallet.asked);
    const deps = { ...s.deps, api, chainRead, patience: { reportTries: 2 } };
    expect(await execute(order, deps)).toMatchObject({ status: 'waiting', why: 'unseen' });
    // Another transaction of the wallet takes nonce 0, the one the held signature was made on.
    const other = await s.w.adapter.buildApprove({
      owner: s.w.owner,
      basketId: s.double.plan.basketId,
      amountRaw: '1',
      nonce: 0,
    });
    await s.w.adapter.mock.send(other);
    const results: string[] = [];
    for (let run = 0; run < 3; run += 1) results.push((await execute(order, deps)).status);
    expect(results).toEqual(['done', 'done', 'done']);
    const forApprove = s.wallet.asked.filter((tx) => tx.legId === approve.id);
    expect(forApprove).toHaveLength(2);
    expect(forApprove.map((tx) => tx.evm?.nonce)).toEqual([0, 1]);
  });

  it('on a mock chain, a read of a real node is handed over and no blockhash is asked of it', async () => {
    const asked: string[] = [];
    // A node that knows no blockhash: on a real chain nothing would be signed.
    const rpc: RpcCall = async (method) => {
      asked.push(method);
      if (method === 'isBlockhashValid') return { context: { slot: 1 }, value: false };
      if (method === 'getBlockHeight') return 1;
      return { context: { slot: 1 }, value: [null] };
    };
    const s = scene('solana');
    const order = await s.double.buy(100);
    const result = await execute(order, { ...s.deps, chainRead: chainReadOf({ solana: rpc }) });
    expect(result.status).toBe('done');
    expect(s.wallet.sign).toHaveBeenCalledTimes(order.legs.length);
    expect(asked).toEqual([]);
  });

  it('signs again when the chain says the first is gone, and only then', async () => {
    const outcomes: [string, ChainRead | undefined, string, number][] = [
      ['gone', saying('gone'), 'error', 3],
      // One of the builds it is allowed went on the attempt it gave up while the first was alive.
      ['open, then gone', saying('open', 'open', 'gone'), 'error', 2],
      ['open', saying('open'), 'waiting', 1],
      ['unknown', saying('unknown'), 'needs_review', 1],
      ['a read that throws', saying(new Error('rpc down')), 'needs_review', 1],
      // Taken as `unknown` where it is read, and so the person is asked; it never reaches a branch.
      ['an answer that is no fate', saying('expired' as Fate), 'needs_review', 1],
      ['an answer that is not even text', saying({} as Fate), 'needs_review', 1],
      ['no read at all', undefined, 'needs_review', 1],
    ];
    for (const [name, chainRead, status, signatures] of outcomes) {
      const s = scene('solana');
      const order = await s.double.buy(100);
      const h = hoarding(s, order, 'swap');
      const result = await execute(order, {
        ...s.deps,
        api: h.api,
        chainRead,
        patience: { waitTries: 3 },
      });
      expect(result.status, name).toBe(status);
      expect(h.signedFor().length, name).toBe(signatures);
    }
  });

  it('signs nothing more for a step whose transaction is on the chain, whoever approves', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const h = hoarding(s, order, 'swap');
    const first = await execute(order, { ...s.deps, api: h.api });
    expect(first.status).toBe('needs_review');
    // The API sent what it held after all, and still says the step expired.
    expect(await h.release()).toEqual(['confirmed']);
    const result = await execute(order, {
      ...s.deps,
      api: h.api,
      chainRead: mockChainRead(s.w, () => s.wallet.asked),
      approvedAgain: { legId: h.leg.id, signedTimes: 1 },
    });
    expect(result).toMatchObject({ status: 'error', legId: h.leg.id });
    expect(result.status === 'error' && result.error.message).toMatch(/on the chain/);
    expect(h.signedFor()).toHaveLength(1);
  });

  it('follows a step the chain has and the API then admits to', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const swap = order.legs.find((l) => l.kind === 'swap');
    if (!swap) throw new Error('no swap');
    // The first report of the swap is taken and its answer lost, and the API builds the step again.
    let lost = 0;
    const api: OrderApi = {
      ...s.double.api,
      async reportLeg(id, legId, body) {
        const answer = await s.double.api.reportLeg(id, legId, body);
        if (legId !== swap.id || lost) return answer;
        lost += 1;
        const before = structuredClone(answer);
        const mine = before.legs.find((l) => l.id === legId);
        if (mine) mine.status = 'expired';
        return before;
      },
      async buildLeg(id, legId) {
        if (legId !== swap.id || lost !== 1) return s.double.api.buildLeg(id, legId);
        lost += 1;
        const vault = await s.double.vault();
        const built = await s.w.adapter.buildOwnerSwap({
          vault: vault as string,
          trades: swap.trades,
          slippageBps: 100,
        });
        const attempt = {
          id: 'again',
          legId,
          n: 2,
          messageHash: built.messageHash,
          nonce: null,
          status: 'built' as const,
          txId: null,
          explorerUrl: null,
          validUntil: String(built.lastValidBlockHeight),
          builtAt: new Date(0).toISOString(),
        };
        return { tx: { ...built, legId, attemptId: attempt.id } as BasketTx, attempt };
      },
      cancelLeg: async (id) => s.double.api.getOrder(id),
    };
    const chainRead = mockChainRead(s.w, () => s.wallet.asked);
    const result = await execute(order, { ...s.deps, api, chainRead });
    expect(result.status).toBe('done');
    expect(s.wallet.asked.filter((tx) => tx.legId === swap.id)).toHaveLength(1);
  });

  it('the person approving the step again is good for one more signature, and for one only', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const h = hoarding(s, order, 'swap');
    const deps = { ...s.deps, api: h.api };
    const asked = await execute(order, deps);
    expect(asked).toMatchObject({ status: 'needs_review', signedTimes: 1 });

    // An approval of another step, or of another count, approves nothing.
    for (const approvedAgain of [
      { legId: order.legs[0]?.id as string, signedTimes: 1 },
      { legId: h.leg.id, signedTimes: 0 },
      { legId: h.leg.id, signedTimes: 2 },
    ]) {
      expect((await execute(order, { ...deps, approvedAgain })).status).toBe('needs_review');
      expect(h.signedFor()).toHaveLength(1);
    }

    const approvedAgain = { legId: h.leg.id, signedTimes: 1 };
    const again = await execute(order, { ...deps, approvedAgain });
    // One more signature, and the same approval does not buy a third.
    expect(again).toMatchObject({ status: 'needs_review', signedTimes: 2 });
    expect(h.signedFor()).toHaveLength(2);
    expect((await execute(order, { ...deps, approvedAgain })).status).toBe('needs_review');
    expect(h.signedFor()).toHaveLength(2);
  });

  it('keeps what was signed under the order and the step, and reads nothing it cannot trust', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const h = hoarding(s, order, 'swap');
    const signed = s.deps.signed as Map<string, SignedRecord>;
    await execute(order, { ...s.deps, api: h.api });
    const key = signedKey(order.id, h.leg.id);
    expect(signed.get(key)).toEqual({
      times: 1,
      chain: 'solana',
      messageHash: h.signedFor()[0]?.messageHash,
      // No read of the chain was given, so no height was kept.
      height: null,
      proof: { signedTx: h.held[0] },
    });
    expect([...signed.keys()].sort()).toEqual(
      order.legs
        .slice(0, order.legs.indexOf(h.leg) + 1)
        .map((l) => signedKey(order.id, l.id))
        .sort(),
    );

    // A record that cannot be read is a step that may have been signed: the person is asked.
    for (const broken of [
      'signed',
      { times: -1, chain: 'solana', messageHash: 'x', proof: null },
      { times: 1, chain: 'solana', messageHash: 'x', proof: {} },
      { times: 1, chain: 'solana', messageHash: 'x', proof: { signedTx: 'a', txId: 'b' } },
      { times: 1, chain: 'solana', proof: null },
      { times: 1, chain: '', messageHash: 'x', proof: null },
    ]) {
      signed.set(key, broken as never);
      const result = await execute(order, { ...s.deps, api: h.api });
      expect(result, JSON.stringify(broken)).toMatchObject({
        status: 'needs_review',
        why: 'unreadable',
        signedTimes: 0,
      });
    }
    expect(h.signedFor()).toHaveLength(1);
    // Approved again, it is signed once and the record is whole again.
    const approvedAgain = { legId: h.leg.id, signedTimes: 0 };
    await execute(order, { ...s.deps, api: h.api, approvedAgain });
    expect(h.signedFor()).toHaveLength(2);
    expect(signed.get(key)).toMatchObject({ times: 1 });
  });

  it('signs nothing without a store, or with one that cannot be written to', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(100);
    for (const signed of [undefined, {}, { get: () => undefined }]) {
      const result = await execute(order, { ...s.deps, signed: signed as never });
      expect(result).toMatchObject({ status: 'error', legId: null });
    }
    // A wallet that sends by itself is not asked when it cannot first be written down that it was.
    const full: SignedStore = {
      get: () => undefined,
      set: () => {
        throw new Error('storage is full');
      },
    };
    const result = await execute(order, { ...s.deps, signed: full });
    expect(result).toMatchObject({ status: 'error', error: { message: 'storage is full' } });
    expect(s.wallet.send).not.toHaveBeenCalled();
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });

  it('a wallet that sends by itself and fails without saying whether it sent is not asked again', async () => {
    const s = scene('robinhood', { signOnly: false });
    const order = await s.double.buy(100);
    const first = order.legs[0]?.id as string;
    const signed = s.deps.signed as Map<string, SignedRecord>;
    s.wallet.send.mockRejectedValueOnce(new Error('the connection dropped'));
    const result = await execute(order, s.deps);
    expect(result).toMatchObject({
      status: 'needs_review',
      legId: first,
      why: 'asked',
      signedTimes: 1,
    });
    expect(signed.get(signedKey(order.id, first))).toMatchObject({ times: 1, proof: null });
    // The attempt was not closed: the transaction may be on its way.
    expect(s.double.calls).not.toContain(`cancel ${first}`);

    // Run again, with or without a read of the chain: the wallet is not asked.
    for (const chainRead of [undefined, saying('gone')])
      expect(await execute(order, { ...s.deps, chainRead })).toMatchObject({
        status: 'needs_review',
        why: 'asked',
        signedTimes: 1,
      });
    expect(s.wallet.send).toHaveBeenCalledTimes(1);
    // And the attempt stays open while the person has not looked: it is not closed on a reload either.
    expect(s.double.calls).not.toContain(`cancel ${first}`);

    // The person looked, and approves the step again.
    const again = await execute(order, {
      ...s.deps,
      approvedAgain: { legId: first, signedTimes: 1 },
    });
    expect(again.status).toBe('done');
    expect(signed.get(signedKey(order.id, first))).toMatchObject({ times: 2 });
  });

  it('a wallet that sends by itself and says it sent nothing leaves no trace', async () => {
    for (const code of ['rejected', 'no_gas', 'wrong_chain', 'expired'] as const) {
      const s = scene('robinhood', { signOnly: false });
      const order = await s.double.buy(100);
      const first = order.legs[0]?.id as string;
      s.wallet.send.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const result = await execute(order, { ...s.deps, patience: { rebuilds: 0 } });
      expect(result.status, code).toBe('cancelled');
      const signed = s.deps.signed as Map<string, SignedRecord>;
      expect(signed.get(signedKey(order.id, first)), code).toMatchObject({ times: 0 });
      expect((await execute(order, s.deps)).status, code).toBe('done');
    }
  });

  it('does not sign for one step the bytes it signed for another', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const [create, swap] = order.legs;
    const last = order.legs.at(-1);
    if (!create || !swap || !last || last === swap) throw new Error('the order has too few steps');
    const signed = s.deps.signed as Map<string, SignedRecord>;
    let built: BuildLegResponse | undefined;
    const api: OrderApi = {
      ...s.double.api,
      async buildLeg(id, legId) {
        built = await s.double.api.buildLeg(id, legId);
        // The store says these very bytes were signed for another step of the order.
        if (legId === swap.id)
          signed.set(signedKey(order.id, last.id), {
            times: 1,
            chain: 'solana',
            messageHash: built.tx.messageHash,
            proof: { signedTx: 'kept' },
          });
        return built;
      },
    };
    const result = await execute(order, { ...s.deps, api });
    expect(result.status === 'refused' && result.refusal.code).toBe('step');
    expect(s.wallet.asked.map((tx) => tx.legId)).toEqual([create.id]);
    expect(s.double.calls.at(-1)).toBe(`cancel ${swap.id}`);
  });
});

describe('the executor: an API that keeps it turning', () => {
  it('stops on an API that answers each close with a new attempt', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const first = order.legs[0]?.id as string;
    let n = 0;
    // Every answer shows the step built, on an attempt nobody signed, one later than the last.
    const fresh = async (id: string): Promise<OrderDetail> => {
      const o = structuredClone(await s.double.api.getOrder(id));
      n += 1;
      const leg = o.legs.find((l) => l.id === first);
      if (leg) Object.assign(leg, { status: 'built', attempt: n });
      o.attempts.push({
        id: `fresh-${n}`,
        legId: first,
        n,
        messageHash: `${n}`.padStart(64, '0'),
        nonce: 0,
        status: 'built',
        txId: null,
        explorerUrl: null,
        validUntil: null,
        builtAt: new Date(0).toISOString(),
      });
      return o;
    };
    const api: OrderApi = { ...s.double.api, getOrder: fresh, cancelLeg: fresh };
    const result = await execute(order, { ...s.deps, api });
    expect(result).toMatchObject({ status: 'error', legId: first });
    expect(result.status === 'error' && result.error.message).toMatch(/each time one is closed/);
    // It turned a few times, not for ever, and never slept between: there was nothing to wait for.
    expect(n).toBeLessThan(8);
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });

  it('stops on an API whose answers change with every build it refuses', async () => {
    const s = scene('robinhood');
    const order = await s.double.buy(100);
    const first = order.legs[0]?.id as string;
    let n = 0;
    const api: OrderApi = {
      ...s.double.api,
      // The step is never built, and each read shows it one attempt further on.
      async getOrder(id) {
        const o = structuredClone(await s.double.api.getOrder(id));
        n += 1;
        const leg = o.legs.find((l) => l.id === first);
        if (leg) Object.assign(leg, { status: 'expired', attempt: n });
        return o;
      },
      buildLeg: () => Promise.reject(new ApiRefusal(409, { error: 'not now' })),
    };
    const builds = vi.fn(api.buildLeg);
    const result = await execute(order, { ...s.deps, api: { ...api, buildLeg: builds } });
    expect(result).toMatchObject({ status: 'error', legId: first });
    expect(result.status === 'error' && result.error.message).toMatch(/refuses each build/);
    // As far as the close loop goes, and no further: the builds it is allowed, and one more.
    expect(builds).toHaveBeenCalledTimes(DEFAULT_PATIENCE.rebuilds + 2);
    expect(s.wallet.sign).not.toHaveBeenCalled();
  });
});

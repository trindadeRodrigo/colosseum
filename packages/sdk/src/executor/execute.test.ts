import type { BasketTx, BuildLegResponse, ChainId, OrderDetail } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { type ApiDouble, apiDouble } from '../../test/api-double';
import { type MockWorld, mockWorld, tampered } from '../../test/mock';
import { GUARD_CHECKS, type GuardCode } from '../guard/refusal';
import { runGuard } from '../guard/run';
import { ApiRefusal, type OrderApi } from './api';
import { type ExecutionEvent, type ExecutorDeps, makeExecute, type SignedStore } from './execute';
import { execute } from './index';

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

const withoutChecks = makeExecute((input) => runGuard(input, { without: [...GUARD_CHECKS] }));

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
});

describe('the executor: what was approved is fixed before the API is asked anything', () => {
  it('refuses an order with a step it signs none of, or steps on two chains, and calls nothing', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    const [first, second] = order.legs;
    if (!first || !second) throw new Error('two steps');
    const cases: [OrderDetail, GuardCode][] = [
      [{ ...order, legs: [{ ...first, kind: 'publish' }, second] }, 'unsupported'],
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

  it('builds a step again when its transaction expired without landing', async () => {
    const s = scene('solana');
    const order = await s.double.buy(100);
    s.w.adapter.mock.dropNext();
    const result = await execute(order, s.deps);
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
    const result = await execute(order, { ...s.deps, patience: { rebuilds: 1 } });
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

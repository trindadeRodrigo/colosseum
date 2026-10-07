import { randomUUID } from 'node:crypto';
import {
  type Attempt,
  type BuiltTx,
  ChainError,
  chainFamily,
  type Leg,
  type OrderDetail,
  type OrderError,
  type ReportLegRequest,
  stampTx,
  type Target,
  type Trade,
} from '@colosseum/schemas';
import { ApiRefusal, type OrderApi } from '../src/executor/api';
import type { PlanTerms } from '../src/guard/types';
import type { MockWorld } from './mock';

// The order routes in memory, over packages/chain-mock: what apps/api does for a buy, without a
// database or HTTP. It plans the steps as `planBuy` does, builds each with the mock's builders, relays
// what is reported and tracks it. tests/sdk-executor.test.ts runs the same executor against the real
// route handlers; this one is for the cases that need a hand on the API's answers.

const lessBps = (amount: bigint, bps: number) => (amount * BigInt(10_000 - bps)) / 10_000n;
const refuse = (status: number, error: string, extra: Omit<OrderError, 'error'> = {}): never => {
  throw new ApiRefusal(status, { error, ...extra });
};
const SETTLED = (l: Leg) => l.status === 'confirmed' || l.status === 'skipped';
const FINAL = (a: Attempt) => a.status === 'confirmed' || a.status === 'failed';
const LIVE = (a: Attempt) => a.status === 'built' || a.status === 'sent';

export type ApiDouble = {
  api: OrderApi;
  plan: PlanTerms;
  /** A buy of the plan for this many dollars: the order as POST /v1/orders answers it. */
  buy(amountUsd: number): Promise<OrderDetail>;
  /** The address of the plan's vault once it is open. */
  vault(): Promise<string | undefined>;
  /**
   * Any other order: its steps, and how each is built. What POST /v1/orders answers for a publish, a
   * buy of a shared portfolio or a follow, for a stub that plans those itself.
   */
  place(o: Placed): Promise<OrderDetail>;
  /** Every call the API took, in order. */
  calls: string[];
};

export type Placed = {
  type: OrderDetail['type'];
  summary: string;
  depositRaw?: string;
  needsConsent: OrderDetail['needsConsent'];
  steps: Pick<Leg, 'kind' | 'description' | 'trades' | 'cashRaw' | 'withdrawals'>[];
  /** Builds a step of this order: one transaction, as the adapter builds it. */
  build(leg: Leg, nonce: number | undefined): Promise<BuiltTx>;
};

export function apiDouble(
  w: MockWorld,
  o: { basketId?: string; targets?: Target[]; slippageBps?: number; openSeconds?: number } = {},
): ApiDouble {
  const { adapter, owner, chain } = w;
  const basketId = o.basketId ?? '9001';
  const slippageBps = o.slippageBps ?? 100;
  const targets = o.targets ?? [
    { asset: `${chain}:spy`, weightBps: 5000 },
    { asset: `${chain}:nvda`, weightBps: 3000 },
    { asset: `${chain}:gold`, weightBps: 1500 },
  ];
  const orders = new Map<string, OrderDetail>();
  const builders = new Map<string, Placed['build']>();
  const calls: string[] = [];
  const now = () => adapter.mock.now();
  const family = chainFamily(chain);

  const orderOf = (id: string): OrderDetail =>
    orders.get(id) ?? refuse(404, 'no order with that id');
  const legOf = (order: OrderDetail, legId: string): Leg =>
    order.legs.find((l) => l.id === legId) ?? refuse(404, 'this order has no such step');
  const latest = (order: OrderDetail, leg: Leg) =>
    order.attempts.find((a) => a.legId === leg.id && a.n === leg.attempt);
  const vaultOf = async () =>
    (await adapter.getVaults(owner)).find((v) => v.basketId === basketId)?.address;

  /** A chain's refusal as the API answers it. */
  const chainWork = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      return refuse(409, e.message, { details: { chainCode: e.code, retryable: e.retryable } });
    }
  };

  /** What the chain says of an attempt's transaction, written onto the attempt and its leg. */
  async function settle(order: OrderDetail, leg: Leg, attempt: Attempt, txId: string) {
    const tracked = await adapter.track(txId, attempt.validUntil ?? undefined);
    const status = (
      { pending: 'sent', confirmed: 'confirmed', reverted: 'failed', expired: 'expired' } as const
    )[tracked.status];
    Object.assign(attempt, { status, txId, explorerUrl: tracked.explorerUrl });
    Object.assign(leg, {
      status,
      txId,
      explorerUrl: tracked.explorerUrl,
      error:
        status === 'failed'
          ? {
              code: tracked.error?.code ?? 'Unknown',
              message: tracked.error?.message ?? 'the transaction reverted',
              retryable: false,
            }
          : null,
    });
    // The first transaction the chain has seen keeps the order open for a day.
    if (status === 'confirmed' || status === 'failed')
      order.expiresAt = Math.max(order.expiresAt, now() + 86_400);
    restate(order);
  }
  function restate(order: OrderDetail) {
    order.status = order.legs.every(SETTLED)
      ? 'done'
      : order.legs.some((l) => l.status === 'failed')
        ? 'failed'
        : now() > order.expiresAt
          ? 'expired'
          : 'open';
  }
  async function refresh(order: OrderDetail) {
    for (const leg of order.legs) {
      const attempt = latest(order, leg);
      if (leg.status === 'sent' && attempt?.txId) await settle(order, leg, attempt, attempt.txId);
    }
    restate(order);
  }
  const fateOf = (attempt: Attempt) =>
    attempt.txId
      ? adapter
          .track(attempt.txId, attempt.validUntil ?? undefined)
          .then((t) =>
            t.status === 'confirmed' || t.status === 'reverted'
              ? { state: 'landed' as const, txId: attempt.txId as string }
              : { state: t.status === 'expired' ? ('gone' as const) : ('open' as const) },
          )
      : adapter.fate({
          messageHash: attempt.messageHash,
          signer: owner,
          validUntil: attempt.validUntil,
          nonce: attempt.nonce,
        });

  async function buildFor(
    order: OrderDetail,
    leg: Leg,
    nonce: number | undefined,
  ): Promise<BuiltTx> {
    const own = builders.get(order.id);
    if (own) return own(leg, nonce);
    const cashRaw = order.depositRaw ?? '0';
    const trades = leg.trades.length ? leg.trades : undefined;
    // As the API builds a step (apps/api/src/orders/legs.ts): with the minimums the order stated when
    // it was made, never ones worked out from the price at the moment of the build.
    const minimums =
      trades && leg.expected.length === trades.length
        ? leg.expected.map((figure) => figure.minOutRaw)
        : undefined;
    const shared = { ...(nonce === undefined ? {} : { nonce }), ...(minimums ? { minimums } : {}) };
    const vault = async () =>
      (await vaultOf()) ?? refuse(409, 'the vault for this plan is not open yet');
    switch (leg.kind) {
      case 'approve':
        return adapter.buildApprove({
          owner,
          basketId,
          amountRaw: cashRaw,
          ...(nonce === undefined ? {} : { nonce }),
        });
      case 'create_vault':
        return adapter.buildCreateVault({
          owner,
          basketId,
          targets,
          autoFollow: false,
          depositRaw: cashRaw,
          trades,
          slippageBps,
          ...shared,
        });
      case 'deposit':
        return adapter.buildDeposit({
          vault: await vault(),
          amountRaw: cashRaw,
          trades,
          slippageBps,
          ...shared,
        });
      case 'swap':
        return adapter.buildOwnerSwap({
          vault: await vault(),
          trades: leg.trades,
          slippageBps,
          ...shared,
        });
      default:
        return refuse(501, `a ${leg.kind} step cannot be built yet`);
    }
  }

  const api: OrderApi = {
    async createOrder() {
      return refuse(501, 'the double plans a buy with buy()');
    },
    async getOrder(orderId) {
      calls.push('get');
      const order = orderOf(orderId);
      await refresh(order);
      return structuredClone(order);
    },
    async buildLeg(orderId, legId) {
      calls.push(`build ${legId}`);
      const order = orderOf(orderId);
      await refresh(order);
      const leg = legOf(order, legId);
      if (order.status !== 'done' && now() > order.expiresAt)
        refuse(410, 'this order has expired', {
          code: 'ORDER_EXPIRED',
          fix: 'Make the order again.',
        });
      if (SETTLED(leg)) refuse(409, 'this step is already done');
      if (order.legs.some((l) => l.seq < leg.seq && !SETTLED(l)))
        refuse(409, 'an earlier step on this chain has not settled yet');

      // Nothing is built while the transaction built before can still land.
      let nonce: number | undefined;
      const before = latest(order, leg);
      if (before && !FINAL(before)) {
        const fate = await chainWork(() => fateOf(before));
        if (fate.state === 'landed') {
          await settle(order, leg, before, fate.txId);
          refuse(
            409,
            'the transaction built earlier for this step has landed: read the order again',
          );
        }
        if (fate.state === 'open' && LIVE(before))
          refuse(409, 'the transaction built earlier for this step can still land', {
            details: { retryable: true },
          });
        if (fate.state === 'open' && before.nonce !== null) nonce = before.nonce;
      }

      const built = await chainWork(() => buildFor(order, leg, nonce));
      const attempt: Attempt = {
        id: randomUUID(),
        legId,
        n: leg.attempt + 1,
        messageHash: built.messageHash,
        nonce: built.evm?.nonce ?? null,
        status: 'built',
        txId: null,
        explorerUrl: null,
        validUntil:
          built.lastValidBlockHeight === undefined ? null : String(built.lastValidBlockHeight),
        builtAt: new Date(now() * 1000).toISOString(),
      };
      order.attempts.push(attempt);
      Object.assign(leg, {
        status: 'built',
        attempt: attempt.n,
        txId: null,
        explorerUrl: null,
        validUntil: attempt.validUntil,
        error: null,
        // The minimum a person is shown is the one in the bytes.
        expected: leg.expected.map((figure, i) => ({
          ...figure,
          minOutRaw: built.preview.minimums[i]?.minOutRaw ?? figure.minOutRaw,
        })),
      });
      return structuredClone({ tx: stampTx(built, { legId, attemptId: attempt.id }), attempt });
    },
    async reportLeg(orderId, legId, body: ReportLegRequest) {
      calls.push(`report ${legId}`);
      const order = orderOf(orderId);
      const leg = legOf(order, legId);
      const attempts = order.attempts.filter((a) => a.legId === legId);
      if (!attempts.length) refuse(409, 'this step has not been built yet');
      const notBuiltHere = { details: { chainCode: 'NotBuiltHere', retryable: false } } as const;
      if ('signedTx' in body) {
        const hash = await adapter
          .messageHashOf(body.signedTx)
          .catch(() => refuse(422, 'the signed transaction cannot be read'));
        const attempt =
          [...attempts].reverse().find((a) => a.messageHash === hash && LIVE(a)) ??
          attempts.find((a) => a.messageHash === hash) ??
          refuse(
            409,
            'these are not the bytes built for this step: nothing was sent',
            notBuiltHere,
          );
        if (FINAL(attempt)) return structuredClone(order);
        if (attempt.txId) await settle(order, leg, attempt, attempt.txId);
        else if (attempt.status === 'built') {
          if (now() > order.expiresAt)
            refuse(410, 'this order has expired', { code: 'ORDER_EXPIRED' });
          const relayed = await chainWork(() => adapter.relay(body.signedTx));
          await settle(order, leg, attempt, relayed.txId);
        } else {
          const fate = await fateOf(attempt);
          if (fate.state !== 'landed')
            refuse(
              409,
              'these bytes are of an attempt that was closed: nothing was sent',
              notBuiltHere,
            );
          else await settle(order, leg, attempt, fate.txId);
        }
        return structuredClone(order);
      }
      let found = attempts.find((a) => a.txId === body.txId);
      let unseen = false;
      for (const a of [...attempts].reverse()) {
        if (found) break;
        const carried = await adapter.carries(body.txId, a.messageHash);
        if (carried === 'this') found = a;
        else if (carried === 'unseen') unseen = true;
      }
      if (!found && unseen)
        refuse(409, 'the chain has not seen that transaction yet', {
          fix: 'Report it again in a moment.',
          details: { retryable: true },
        });
      const attempt = found ?? refuse(409, 'that transaction is not the one built for this step');
      if (!FINAL(attempt)) await settle(order, leg, attempt, body.txId);
      return structuredClone(order);
    },
    async cancelLeg(orderId, legId) {
      calls.push(`cancel ${legId}`);
      const order = orderOf(orderId);
      await refresh(order);
      const leg = legOf(order, legId);
      const attempt = latest(order, leg);
      if (!attempt || !LIVE(attempt)) return refuse(409, 'this step has no attempt to cancel');
      const fate = await fateOf(attempt);
      if (fate.state === 'landed') {
        await settle(order, leg, attempt, fate.txId);
        refuse(409, 'the transaction of this step has landed: read the order again');
      }
      // On Solana only time closes an attempt. On an EVM chain the person's word does.
      if (fate.state === 'open' && attempt.validUntil !== null)
        refuse(409, 'the transaction of this step can still land until it expires', {
          details: { retryable: true },
        });
      attempt.status = 'expired';
      Object.assign(leg, {
        status: 'expired',
        error:
          fate.state === 'gone'
            ? null
            : { code: 'rejected', message: 'cancelled before it landed', retryable: true },
      });
      restate(order);
      return structuredClone(order);
    },
  };

  /** The legs of steps, each trade with its quote and its minimum, as apps/api plans them. */
  async function legsOf(id: string, steps: Placed['steps']): Promise<Leg[]> {
    const legs: Leg[] = [];
    for (const [seq, step] of steps.entries()) {
      const expected: Leg['expected'] = [];
      for (const trade of step.trades) {
        const quote = await adapter.quote(trade, owner);
        expected.push({
          inRaw: trade.amountInRaw,
          outRaw: quote.outRaw,
          minOutRaw: lessBps(BigInt(quote.outRaw), slippageBps).toString(),
          costBps: quote.costBps,
        });
      }
      legs.push({
        id: randomUUID(),
        orderId: id,
        chain,
        seq,
        ...step,
        signer: 'owner',
        expected,
        status: 'planned',
        attempt: 0,
        txId: null,
        explorerUrl: null,
        validUntil: null,
        error: null,
        trigger: 'manual',
        provenance: 'mock',
      });
    }
    return legs;
  }

  async function place(p: Placed): Promise<OrderDetail> {
    const id = randomUUID();
    const order: OrderDetail = {
      id,
      type: p.type,
      owner: { [family]: owner },
      summary: p.summary,
      ...(p.depositRaw ? { depositRaw: p.depositRaw } : {}),
      legs: await legsOf(id, p.steps),
      warnings: [],
      needsConsent: p.needsConsent,
      fees: [],
      preparedBy: 'app',
      status: 'open',
      approvalUrl: `/orders/${id}`,
      expiresAt: now() + (o.openSeconds ?? 15 * 60),
      createdAt: new Date(now() * 1000).toISOString(),
      disclaimer: 'a test order',
      attempts: [],
    };
    orders.set(id, order);
    builders.set(id, p.build);
    return structuredClone(order);
  }

  /** The steps of a buy on this chain, as `planBuy` of apps/api lays them out. */
  async function buy(amountUsd: number): Promise<OrderDetail> {
    const id = randomUUID();
    const cashRaw = BigInt(Math.round(amountUsd * 100)) * 10_000n;
    const invested = (cashRaw * BigInt(targets.reduce((n, t) => n + t.weightBps, 0))) / 10_000n;
    const weights = targets.reduce((n, t) => n + t.weightBps, 0);
    const trades: Trade[] = targets.map((t) => ({
      sell: adapter.mock.cash,
      buy: t.asset,
      amountInRaw: ((invested * BigInt(t.weightBps)) / BigInt(weights)).toString(),
    }));
    const caps = adapter.capabilities;
    const groups: Trade[][] = [];
    for (let i = 0; i < trades.length; i += caps.maxTradesPerTx)
      groups.push(trades.slice(i, i + caps.maxTradesPerTx));
    const riding = caps.tradesInCreate ? (groups.shift() ?? []) : [];
    const deposit = cashRaw.toString();
    const steps: Pick<Leg, 'kind' | 'description' | 'trades' | 'cashRaw'>[] = [];
    if (caps.needsApprove)
      steps.push({
        kind: 'approve',
        description: 'Allow your vault to take the cash',
        cashRaw: deposit,
        trades: [],
      });
    steps.push({
      kind: (await vaultOf()) ? 'deposit' : 'create_vault',
      description: 'Move the cash into the vault',
      cashRaw: deposit,
      trades: riding,
    });
    for (const group of groups) steps.push({ kind: 'swap', description: 'Buy', trades: group });

    const legs: Leg[] = [];
    for (const [seq, step] of steps.entries()) {
      const expected: Leg['expected'] = [];
      for (const trade of step.trades) {
        const quote = await adapter.quote(trade, owner);
        expected.push({
          inRaw: trade.amountInRaw,
          outRaw: quote.outRaw,
          minOutRaw: lessBps(BigInt(quote.outRaw), slippageBps).toString(),
          costBps: quote.costBps,
        });
      }
      legs.push({
        id: randomUUID(),
        orderId: id,
        chain,
        seq,
        ...step,
        signer: 'owner',
        expected,
        status: 'planned',
        attempt: 0,
        txId: null,
        explorerUrl: null,
        validUntil: null,
        error: null,
        trigger: 'manual',
        provenance: 'mock',
      });
    }
    const order: OrderDetail = {
      id,
      type: 'buy',
      owner: { [family]: owner },
      summary: `Buy $${amountUsd} of your plan`,
      depositRaw: deposit,
      legs,
      warnings: [],
      needsConsent: [],
      fees: [],
      preparedBy: 'app',
      status: 'open',
      approvalUrl: `/orders/${id}`,
      expiresAt: now() + (o.openSeconds ?? 15 * 60),
      createdAt: new Date(now() * 1000).toISOString(),
      disclaimer: 'a test order',
      attempts: [],
    };
    orders.set(id, order);
    return structuredClone(order);
  }

  return { api, plan: { basketId, targets, autoFollow: false }, buy, vault: vaultOf, place, calls };
}

import type { Db } from '@colosseum/db';
import {
  type Address,
  type Attempt,
  type BuildLegResponse,
  BuiltTx,
  ChainError,
  chainFamily,
  type Leg,
  type Order,
  type ReportLegRequest,
  stampTx,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { legErrorFromRevert, Refusal, refusing } from './errors';
import { basketIdOf, expectedOf, ORDER_POLICY, targetsOf } from './prepare';
import {
  loadOrder,
  loadProposal,
  recordBuild,
  recordOrderState,
  recordOutcome,
  recordRefusal,
  type StoredOrder,
  txIdTaken,
} from './store';

// Building a leg and settling it (DESIGN-VAULT 3.3). The API builds unsigned transactions and relays
// signed ones. It holds no key and signs nothing.

export type OrderDeps = {
  db: Db;
  chains: ChainRegistry;
  now: () => Date;
};

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const settled = (leg: Leg) => leg.status === 'confirmed' || leg.status === 'skipped';

/**
 * An order's status, from its legs and the clock. `partial` is one chain done and a failed leg on
 * another; an order past its time that is not done is `expired`.
 */
export function orderStatus(legs: Leg[], expiresAt: number, nowSeconds: number): Order['status'] {
  if (legs.every(settled)) return 'done';
  if (legs.some((l) => l.status === 'failed')) {
    const chains = [...new Set(legs.map((l) => l.chain))];
    const oneDone = chains.some((c) => legs.filter((l) => l.chain === c).every(settled));
    return oneDone ? 'partial' : 'failed';
  }
  return nowSeconds > expiresAt ? 'expired' : 'open';
}

/** Reads the order again, and stores its status if the legs or the clock moved it. */
async function reload(deps: OrderDeps, id: string, expiresAt?: number): Promise<StoredOrder> {
  const stored = await loadOrder(deps.db, id);
  if (!stored) throw new Error('the order vanished');
  const until = expiresAt ?? stored.order.expiresAt;
  const status = orderStatus(stored.order.legs, until, seconds(deps.now()));
  if (status !== stored.order.status || until !== stored.order.expiresAt)
    await recordOrderState(deps.db, id, { status, expiresAt: until });
  return { ...stored, order: { ...stored.order, status, expiresAt: until } };
}

const ownerOn = (order: Order, leg: Leg): Address => {
  const owner = order.owner[chainFamily(leg.chain)];
  if (!owner) throw new Error('an order has a leg on a chain its owner has no address for');
  return owner;
};

const latestAttempt = (stored: StoredOrder, leg: Leg): Attempt | undefined =>
  stored.attempts.find((a) => a.legId === leg.id && a.n === leg.attempt);

function legOf(stored: StoredOrder, legId: string): Leg {
  const leg = stored.order.legs.find((l) => l.id === legId);
  if (!leg) throw new Refusal(404, 'this order has no such step');
  return leg;
}

/** The owner's vault for the plan this order buys, or null before it is opened. */
async function planVault(entry: ChainEntry, owner: Address, basketId: string) {
  return (await entry.adapter.getVaults(owner)).find((v) => v.basketId === basketId) ?? null;
}

/** One unsigned transaction for a leg, from the adapter. The owner is the order's, never the request's. */
async function buildFor(
  deps: OrderDeps,
  stored: StoredOrder,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
): Promise<BuiltTx> {
  const { request, order } = stored;
  if (request.type !== 'buy' || !request.proposalId)
    throw new Refusal(501, `a ${request.type} order cannot be built yet`);
  const { adapter } = entry;
  const basketId = basketIdOf(request.proposalId);
  const slippageBps = ORDER_POLICY.slippageBps;
  // The trades of a buy add up to the cash it deposits on that chain (prepare.ts).
  const cashRaw = order.legs
    .filter((l) => l.chain === leg.chain)
    .flatMap((l) => l.trades)
    .reduce((sum, t) => sum + BigInt(t.amountInRaw), 0n)
    .toString();
  const trades = leg.trades.length ? leg.trades : undefined;
  const vault = async () => {
    const found = await planVault(entry, owner, basketId);
    if (!found) throw new ChainError('VaultNotFound', 'the vault for this plan is not open yet');
    return found.address;
  };
  switch (leg.kind) {
    case 'approve': {
      const existing = await planVault(entry, owner, basketId);
      const spender = entry.approveSpender(existing?.address ?? null);
      return adapter.buildApprove({ owner, spender, amountRaw: cashRaw });
    }
    case 'create_vault': {
      const proposal = await loadProposal(deps.db, request.proposalId);
      const recipe = proposal?.recipes.find((r) => r.chain === leg.chain);
      if (!recipe) throw new Refusal(409, 'the plan this order buys is no longer stored');
      return adapter.buildCreateVault({
        owner,
        basketId,
        targets: targetsOf(recipe.components),
        autoFollow: false,
        depositRaw: cashRaw,
        trades,
        slippageBps,
      });
    }
    case 'deposit':
      return adapter.buildDeposit({
        vault: await vault(),
        amountRaw: cashRaw,
        trades,
        slippageBps,
      });
    case 'swap':
      return adapter.buildOwnerSwap({ vault: await vault(), trades: leg.trades, slippageBps });
    default:
      throw new Refusal(501, `a ${leg.kind} step cannot be built yet`);
  }
}

/** A fresh transaction for a leg and the attempt that records it. Any attempt before it can no longer settle the leg. */
export async function buildLeg(
  deps: OrderDeps,
  stored: StoredOrder,
  legId: string,
): Promise<BuildLegResponse> {
  const { order } = stored;
  const leg = legOf(stored, legId);
  const now = deps.now();
  if (order.status !== 'done' && seconds(now) > order.expiresAt) {
    await reload(deps, order.id);
    throw new Refusal(410, 'this order has expired', {
      code: 'ORDER_EXPIRED',
      fix: 'Make the order again.',
    });
  }
  if (leg.status === 'confirmed' || leg.status === 'skipped')
    throw new Refusal(409, 'this step is already done');
  if (leg.status === 'sent')
    throw new Refusal(409, 'this step was sent and has not settled yet: read the order again');
  const waiting = order.legs.find((l) => l.chain === leg.chain && l.seq < leg.seq && !settled(l));
  if (waiting) throw new Refusal(409, 'an earlier step on this chain has not settled yet');

  const entry = deps.chains.get(leg.chain);
  assertBuilds(entry);
  const owner = ownerOn(order, leg);
  let built: BuiltTx;
  let expected: Leg['expected'];
  try {
    [built, expected] = await refusing(async () => [
      BuiltTx.parse(await buildFor(deps, stored, leg, entry, owner)),
      await expectedOf(entry, leg.trades, owner),
    ]);
  } catch (e) {
    const chain = e instanceof Refusal ? e.extra.details : undefined;
    if (e instanceof Refusal && chain?.chainCode)
      await recordRefusal(deps.db, leg.id, {
        code: chain.chainCode,
        message: e.message,
        retryable: chain.retryable ?? false,
      });
    throw e;
  }
  // Whatever an adapter returns, the API hands out a transaction only for the order's own wallet.
  if (built.signer !== owner || built.chainId !== leg.chain || built.legKind !== leg.kind)
    throw new Error('the adapter built a transaction for another signer, chain or step');

  const attempt = await recordBuild(deps.db, leg, {
    messageHash: built.messageHash,
    validUntil:
      built.lastValidBlockHeight === undefined ? null : String(built.lastValidBlockHeight),
    expected,
    stamp: {
      source: built.preview.source,
      method: built.preview.method,
      fetchedAt: built.preview.fetchedAt,
      provenance: built.preview.provenance,
    },
    builtAt: now,
  });
  await reload(deps, order.id);
  return { tx: stampTx(built, { legId: leg.id, attemptId: attempt.id }), attempt };
}

/** Asks the chain what became of an attempt's transaction and writes it down. */
async function settle(
  deps: OrderDeps,
  leg: Leg,
  attempt: Attempt,
  sent: { txId: string; validUntil: string | null },
): Promise<void> {
  const entry = deps.chains.get(leg.chain);
  const tracked = await refusing(() =>
    entry.adapter.track(sent.txId, sent.validUntil ?? undefined),
  );
  const status = (
    { pending: 'sent', confirmed: 'confirmed', reverted: 'failed', expired: 'expired' } as const
  )[tracked.status];
  await recordOutcome(deps.db, attempt, {
    status,
    txId: sent.txId,
    explorerUrl: tracked.explorerUrl || null,
    validUntil: sent.validUntil,
    error: status === 'failed' ? legErrorFromRevert(tracked.error) : null,
  });
}

/**
 * The caller says a leg was sent: by its transaction id, or by handing over the signed bytes to relay.
 * Either way the leg can only settle on the transaction of its latest attempt: bytes this server did
 * not build are not relayed, and an id that carries other bytes is refused and changes nothing.
 */
export async function reportLeg(
  deps: OrderDeps,
  stored: StoredOrder,
  legId: string,
  body: ReportLegRequest,
): Promise<StoredOrder> {
  const leg = legOf(stored, legId);
  const attempt = latestAttempt(stored, leg);
  if (!attempt) throw new Refusal(409, 'this step has not been built yet');
  const entry = deps.chains.get(leg.chain);
  const open = attempt.status === 'built' || attempt.status === 'sent';

  let sent: { txId: string; validUntil: string | null };
  if ('signedTx' in body) {
    const hash = refuseUnread(() => entry.probe.messageHashOf(body.signedTx));
    if (hash !== attempt.messageHash)
      throw new Refusal(409, 'these are not the bytes built for this step: nothing was sent', {
        details: { chainCode: 'NotBuiltHere', retryable: false },
      });
    if (!open) return stored;
    // Relayed once. The same bytes are never sent a second time.
    if (attempt.status === 'sent' && attempt.txId)
      sent = { txId: attempt.txId, validUntil: attempt.validUntil };
    else {
      assertBuilds(entry);
      const relayed = await refusing(() => entry.probe.relay(body.signedTx, hash));
      sent = { txId: relayed.txId, validUntil: relayed.validUntil ?? attempt.validUntil };
    }
  } else {
    const matches =
      (attempt.txId === null || attempt.txId === body.txId) &&
      (await refusing(() => entry.probe.carries(body.txId, attempt.messageHash)));
    if (!matches || (await txIdTaken(deps.db, leg.chain, body.txId, attempt.id)))
      throw new Refusal(409, 'that transaction is not the one built for this step');
    if (!open) return stored;
    sent = { txId: body.txId, validUntil: attempt.validUntil };
  }

  await settle(deps, leg, attempt, sent);
  // The first signed leg keeps the order open for a day.
  const first = stored.attempts.every((a) => a.txId === null);
  return reload(
    deps,
    stored.order.id,
    first ? seconds(deps.now()) + ORDER_POLICY.signedSeconds : undefined,
  );
}

function refuseUnread<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new Refusal(422, 'the signed transaction cannot be read');
  }
}

/** The order as it stands now: legs that were sent and not settled are tracked again first. */
export async function refreshOrder(deps: OrderDeps, stored: StoredOrder): Promise<StoredOrder> {
  for (const leg of stored.order.legs) {
    const attempt = latestAttempt(stored, leg);
    if (leg.status !== 'sent' || !attempt?.txId) continue;
    try {
      await settle(deps, leg, attempt, {
        txId: attempt.txId,
        validUntil: attempt.validUntil,
      });
    } catch (e) {
      // A chain that is off or not answering leaves the leg as it was; the read still answers.
      if (!(e instanceof Refusal)) throw e;
    }
  }
  return reload(deps, stored.order.id);
}

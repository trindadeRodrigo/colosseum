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
import { basketIdOf, expectedOf, ORDER_POLICY, slippageOf, targetsOf } from './prepare';
import {
  loadOrder,
  loadProposal,
  type Outcome,
  recordBuild,
  recordOrderState,
  recordOutcome,
  recordRefusal,
  type StoredOrder,
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

/** The attempt the leg mirrors: its newest, or the one that settled it. */
const latestAttempt = (stored: StoredOrder, leg: Leg): Attempt | undefined =>
  stored.attempts.find((a) => a.legId === leg.id && a.n === leg.attempt);

/** The chain has given this attempt's outcome: it landed, and went through or reverted. */
const final = (a: Attempt) => a.status === 'confirmed' || a.status === 'failed';
/** Built or sent: nothing has closed it, so its transaction may yet land. */
const live = (a: Attempt) => a.status === 'built' || a.status === 'sent';

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
  /** EVM: the nonce of the step's earlier attempt that can still land, for the rebuild to share. */
  nonce: number | undefined,
): Promise<BuiltTx> {
  const { request, order } = stored;
  if (request.type !== 'buy' || !request.proposalId)
    throw new Refusal(501, `a ${request.type} order cannot be built yet`);
  const { adapter } = entry;
  const basketId = basketIdOf(request.proposalId);
  const slippageBps = slippageOf(request);
  // The trades of a buy add up to the cash it deposits on that chain (prepare.ts).
  const cashRaw = order.legs
    .filter((l) => l.chain === leg.chain)
    .flatMap((l) => l.trades)
    .reduce((sum, t) => sum + BigInt(t.amountInRaw), 0n)
    .toString();
  const trades = leg.trades.length ? leg.trades : undefined;
  const shared = nonce === undefined ? {} : { nonce };
  const vault = async () => {
    const found = await planVault(entry, owner, basketId);
    if (!found) throw new ChainError('VaultNotFound', 'the vault for this plan is not open yet');
    return found.address;
  };
  switch (leg.kind) {
    // The adapter works out who may take the cash from the plan: nobody here names a spender.
    case 'approve':
      return adapter.buildApprove({ owner, basketId, amountRaw: cashRaw, ...shared });
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
        ...shared,
      });
    }
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
      throw new Refusal(501, `a ${leg.kind} step cannot be built yet`);
  }
}

/**
 * What the chain knows of an attempt: by its transaction id when one was reported, by its bytes when
 * none was.
 */
async function fateOf(entry: ChainEntry, attempt: Attempt, signer: Address) {
  const { txId, validUntil, messageHash, nonce } = attempt;
  if (!txId) return refusing(() => entry.adapter.fate({ messageHash, signer, validUntil, nonce }));
  const { status } = await refusing(() => entry.adapter.track(txId, validUntil ?? undefined));
  if (status === 'confirmed' || status === 'reverted') return { state: 'landed' as const, txId };
  return { state: status === 'expired' ? ('gone' as const) : ('open' as const) };
}

/** Asks the chain what became of an attempt's transaction and writes it down. */
async function settle(
  deps: OrderDeps,
  leg: Leg,
  attempt: Attempt,
  sent: { txId: string; validUntil: string | null },
): Promise<Outcome['status']> {
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
  return status;
}

/**
 * Reads the order again after an outcome. The first transaction the chain has seen keeps an order open
 * for a day; a transaction that is only claimed, or one that lands after the order expired, does not.
 */
function afterOutcome(deps: OrderDeps, stored: StoredOrder, status: Outcome['status']) {
  const now = seconds(deps.now());
  const seen = status === 'confirmed' || status === 'failed';
  const first = !stored.attempts.some(final);
  const open = now <= stored.order.expiresAt;
  return reload(
    deps,
    stored.order.id,
    seen && first && open ? now + ORDER_POLICY.signedSeconds : undefined,
  );
}

/**
 * Refuses while the transaction of the leg's latest attempt can still land, so a person is never asked
 * to sign a second transaction for a step whose first may go through. If that transaction has landed
 * and nobody reported it, the leg settles on it here.
 * - Solana: an attempt can land until the chain is past its `validUntil`. Only time closes it.
 * - EVM: there is no expiry. The attempt stays open until it is reported or the person cancels it.
 *
 * Answers the nonce the next build must share. On an EVM chain a cancelled attempt can still be sent
 * by the wallet that signed it, so the rebuild is given its nonce: at most one of the two can land.
 * Undefined where there is nothing to share: Solana, a first build, or a nonce another call has used.
 */
async function assertNothingInFlight(
  deps: OrderDeps,
  stored: StoredOrder,
  leg: Leg,
): Promise<number | undefined> {
  const latest = latestAttempt(stored, leg);
  if (!latest || final(latest)) return undefined;
  const fate = await fateOf(deps.chains.get(leg.chain), latest, ownerOn(stored.order, leg));
  if (fate.state === 'landed') {
    const status = await settle(deps, leg, latest, { ...latest, txId: fate.txId });
    await afterOutcome(deps, stored, status);
    throw new Refusal(
      409,
      'the transaction built earlier for this step has landed: read the order again',
    );
  }
  if (fate.state === 'open' && live(latest))
    throw new Refusal(409, 'the transaction built earlier for this step can still land', {
      fix:
        latest.validUntil === null
          ? 'Report it, or cancel it, before building this step again.'
          : 'Report it, or wait until it has expired, before building this step again.',
      details: { retryable: true },
    });
  return fate.state === 'open' && latest.nonce !== null ? latest.nonce : undefined;
}

/**
 * A fresh transaction for a leg and the attempt that records it. Built only when no earlier attempt can
 * still land.
 */
export async function buildLeg(
  deps: OrderDeps,
  read: StoredOrder,
  legId: string,
): Promise<BuildLegResponse> {
  // A leg that was sent is tracked first, so what follows sees what the chain says now.
  const stored = await refreshOrder(deps, read);
  const { order } = stored;
  const leg = legOf(stored, legId);
  const now = deps.now();
  if (order.status !== 'done' && seconds(now) > order.expiresAt)
    throw new Refusal(410, 'this order has expired', {
      code: 'ORDER_EXPIRED',
      fix: 'Make the order again.',
    });
  if (leg.status === 'confirmed' || leg.status === 'skipped')
    throw new Refusal(409, 'this step is already done');
  const waiting = order.legs.find((l) => l.chain === leg.chain && l.seq < leg.seq && !settled(l));
  if (waiting) throw new Refusal(409, 'an earlier step on this chain has not settled yet');

  const entry = deps.chains.get(leg.chain);
  assertBuilds(entry);
  // On an EVM chain a cancelled attempt can still be sent by the wallet that signed it. The next
  // attempt is built on its nonce, so only one of them can ever land.
  const nonce = await assertNothingInFlight(deps, stored, leg);
  const owner = ownerOn(order, leg);
  let built: BuiltTx;
  let expected: Leg['expected'];
  try {
    [built, expected] = await refusing(async () => [
      BuiltTx.parse(await buildFor(deps, stored, leg, entry, owner, nonce)),
      await expectedOf(entry, leg.trades, owner, slippageOf(stored.request)),
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
  // And only for the leg's own trades. The minimum a person is shown is the one the adapter put in the
  // bytes, which it states per trade: the leg takes it from there, not from the quote beside it.
  const { minimums } = built.preview;
  const same =
    minimums.length === leg.trades.length &&
    minimums.every((m, i) => {
      const t = leg.trades[i];
      return t && m.sell === t.sell && m.buy === t.buy && m.inRaw === t.amountInRaw;
    });
  if (!same) throw new Error('the adapter built other trades than the step has');
  expected = expected.map((figure, i) => ({
    ...figure,
    minOutRaw: minimums[i]?.minOutRaw ?? figure.minOutRaw,
  }));

  const attempt = await recordBuild(deps.db, leg, {
    messageHash: built.messageHash,
    nonce: built.evm?.nonce ?? null,
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

async function refuseUnread<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new Refusal(422, 'the signed transaction cannot be read');
  }
}

const NOT_BUILT_HERE = { details: { chainCode: 'NotBuiltHere', retryable: false } } as const;

/**
 * The caller says a leg was sent: by its transaction id, or by handing over the signed bytes to relay.
 * The id or the bytes are matched against every attempt of the leg, and the leg settles on the attempt
 * that landed, whichever it is and whatever it was labelled. What matches no attempt is refused and
 * changes nothing. Bytes are relayed only for an attempt that is built and was never sent.
 */
export async function reportLeg(
  deps: OrderDeps,
  stored: StoredOrder,
  legId: string,
  body: ReportLegRequest,
): Promise<StoredOrder> {
  const leg = legOf(stored, legId);
  const attempts = stored.attempts.filter((a) => a.legId === leg.id);
  if (!attempts.length) throw new Refusal(409, 'this step has not been built yet');
  const entry = deps.chains.get(leg.chain);

  let attempt: Attempt | undefined;
  let sent: { txId: string; validUntil: string | null };
  if ('signedTx' in body) {
    const hash = await refuseUnread(() => entry.adapter.messageHashOf(body.signedTx));
    attempt = attempts.find((a) => a.messageHash === hash);
    if (!attempt)
      throw new Refusal(
        409,
        'these are not the bytes built for this step: nothing was sent',
        NOT_BUILT_HERE,
      );
    // Its outcome is recorded. The same bytes are never sent a second time.
    if (final(attempt)) return stored;
    if (attempt.txId) sent = { txId: attempt.txId, validUntil: attempt.validUntil };
    else if (attempt.status === 'built') {
      assertBuilds(entry);
      const relayed = await refusing(() => entry.adapter.relay(body.signedTx));
      sent = { txId: relayed.txId, validUntil: relayed.validUntil ?? attempt.validUntil };
    } else {
      // Closed before it was sent. The server does not send it now, but looks whether it landed anyway.
      const fate = await fateOf(entry, attempt, ownerOn(stored.order, leg));
      if (fate.state !== 'landed')
        throw new Refusal(
          409,
          'these bytes are of an attempt that was closed: nothing was sent',
          NOT_BUILT_HERE,
        );
      sent = { txId: fate.txId, validUntil: attempt.validUntil };
    }
  } else {
    attempt = attempts.find((a) => a.txId === body.txId);
    let unseen = false;
    for (const a of attempts) {
      if (attempt) break;
      if (a.txId !== null) continue;
      const carried = await refusing(() => entry.adapter.carries(body.txId, a.messageHash));
      if (carried === 'this') attempt = a;
      else if (carried === 'unseen') unseen = true;
    }
    // A wallet that sent a moment ago can be ahead of the node. That is not the wrong transaction:
    // the caller is told to report again, and nothing is written.
    if (!attempt && unseen)
      throw new Refusal(409, 'the chain has not seen that transaction yet', {
        fix: 'Report it again in a moment.',
        details: { retryable: true },
      });
    if (!attempt) throw new Refusal(409, 'that transaction is not the one built for this step');
    if (final(attempt)) return stored;
    sent = { txId: body.txId, validUntil: attempt.validUntil };
  }

  return afterOutcome(deps, stored, await settle(deps, leg, attempt, sent));
}

/**
 * The person says the transaction of the leg's latest attempt will not be sent, so the leg can be built
 * again. Refused on Solana while the transaction can still land: only its expiry closes it. If the
 * transaction has landed, the leg settles on it instead.
 */
export async function cancelLeg(
  deps: OrderDeps,
  read: StoredOrder,
  legId: string,
): Promise<StoredOrder> {
  const stored = await refreshOrder(deps, read);
  const leg = legOf(stored, legId);
  const attempt = latestAttempt(stored, leg);
  if (!attempt || !live(attempt)) throw new Refusal(409, 'this step has no attempt to cancel');
  const fate = await fateOf(deps.chains.get(leg.chain), attempt, ownerOn(stored.order, leg));
  if (fate.state === 'landed') {
    const status = await settle(deps, leg, attempt, { ...attempt, txId: fate.txId });
    await afterOutcome(deps, stored, status);
    throw new Refusal(409, 'the transaction of this step has landed: read the order again');
  }
  if (fate.state === 'open' && attempt.validUntil !== null)
    throw new Refusal(409, 'the transaction of this step can still land until it expires', {
      fix: 'Report it, or wait until it has expired.',
      details: { retryable: true },
    });
  // See buildLeg: on an EVM chain the next attempt is built on this one's nonce.
  await recordOutcome(deps.db, attempt, {
    status: 'expired',
    txId: attempt.txId,
    explorerUrl: attempt.explorerUrl,
    validUntil: attempt.validUntil,
    error:
      fate.state === 'gone'
        ? null
        : { code: 'rejected', message: 'cancelled before it landed', retryable: true },
  });
  return reload(deps, stored.order.id);
}

/** The order as it stands now: legs that were sent and not settled are tracked again first. */
export async function refreshOrder(deps: OrderDeps, stored: StoredOrder): Promise<StoredOrder> {
  let seen: Outcome['status'] = 'sent';
  for (const leg of stored.order.legs) {
    const attempt = latestAttempt(stored, leg);
    if (leg.status !== 'sent' || !attempt?.txId) continue;
    try {
      const status = await settle(deps, leg, attempt, { ...attempt, txId: attempt.txId });
      if (status === 'confirmed' || status === 'failed') seen = status;
    } catch (e) {
      // A chain that is off or not answering leaves the leg as it was; the read still answers.
      if (!(e instanceof Refusal)) throw e;
    }
  }
  return afterOutcome(deps, stored, seen);
}

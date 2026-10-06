import { familyIdOf, metaHash } from '@colosseum/basket';
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
  type Recipe,
  type ReportLegRequest,
  stampTx,
  type Trade,
} from '@colosseum/schemas';
import { assertBuilds, type ChainEntry, type ChainRegistry } from './chains';
import { legErrorFromRevert, Refusal, refusing } from './errors';
import { familyBySlug } from './families';
import {
  basketIdOf,
  basketIdOfBuy,
  expectedOf,
  ORDER_POLICY,
  slippageOf,
  targetsOf,
  tradesFor,
} from './prepare';
import { autoFollowOffer, familyText, followedOn, recipeTargets, refuseAutoFollow } from './shared';
import {
  blockedBy,
  continuationsOf,
  isLinkedProposal,
  liveElsewhere,
  loadFamilies,
  loadOrder,
  loadProposal,
  type Outcome,
  pairElsewhere,
  proposalExists,
  recordBuild,
  recordOrderState,
  recordOutcome,
  recordRefusal,
  type StoredOrder,
  TakenElsewhere,
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
 * An order's status, from its legs and the clock. An order on one chain with a failed leg is `failed`:
 * the chain with the failed leg is not done, and it is the only one. `partial` is one chain done and a
 * failed leg on another, which takes legs on two chains, and only a publish order has those (the
 * `Order` schema, gate ONE-CHAIN). An order past its time that is not done is `expired`.
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

/** The cash a step takes from the wallet: the whole deposit, whatever its trades spend. */
function cashOf(leg: Leg): string {
  if (leg.cashRaw === undefined)
    throw new Refusal(
      409,
      'this order was planned before a step carried its deposit: make it again',
    );
  return leg.cashRaw;
}

const sameTrades = (a: Trade[], b: Trade[]) =>
  a.length === b.length &&
  a.every((t, i) => {
    const o = b[i];
    return o && t.sell === o.sell && t.buy === o.buy && t.amountInRaw === o.amountInRaw;
  });

/** One unsigned transaction for a leg, from the adapter. The owner is the order's, never the request's. */
async function buildFor(
  deps: OrderDeps,
  stored: StoredOrder,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  /** EVM: the nonce of the step's earlier attempt that can still land, for the rebuild to share. */
  nonce: number | undefined,
  /** The signed-in person building it: the buyer of a plan made from a link. */
  buyer: string | undefined,
): Promise<BuiltTx> {
  const { request, order } = stored;
  if (request.type === 'publish' || request.type === 'follow')
    return buildShared(deps, stored, leg, entry, owner, nonce);
  if (request.type !== 'buy' || !(request.proposalId || request.family))
    throw new Refusal(501, `a ${request.type} order cannot be built yet`);
  const { adapter } = entry;
  // A buy of a shared portfolio reaches the vault numbered from the family's id.
  const family = request.family ? await familyBySlug(deps.db, request.family) : null;
  if (request.family && !family)
    throw new Refusal(409, 'the shared portfolio this order buys is gone');
  // A plan's order is built only while its plan is there: a plan made from a link that nobody bought is
  // deleted after a few days, and an order that raced that is refused here, not signed half way.
  if (!family && request.proposalId && !(await proposalExists(deps.db, request.proposalId)))
    throw new Refusal(409, 'the plan this order buys is gone', {
      code: 'PLAN_GONE',
      fix: 'Make the plan again, then the order.',
    });
  // The vault the order was made for, as it was stored with it. An order made before the number was
  // stored works it out as it was worked out then.
  const basketId =
    stored.order.basketId ??
    (family
      ? basketIdOf(family.familyId)
      : basketIdOfBuy(
          request.proposalId ?? '',
          await isLinkedProposal(deps.db, request.proposalId ?? ''),
          buyer,
        ));
  const slippageBps = slippageOf(request);
  const trades = leg.trades.length ? leg.trades : undefined;
  // The terms the order stated when it was made, and the person approved: every build of the step
  // carries these minimums, however the price has moved since. A builder that can no longer meet one
  // refuses (`PriceMoved`); it never writes another. A step stored before each trade had its figure
  // states none, and is built from the quote as it was.
  const minimums =
    trades && leg.expected.length === trades.length
      ? leg.expected.map((figure) => figure.minOutRaw)
      : undefined;
  const shared = { ...(nonce === undefined ? {} : { nonce }), ...(minimums ? { minimums } : {}) };
  const vault = async () => {
    const found = await planVault(entry, owner, basketId);
    if (!found) throw new ChainError('VaultNotFound', 'the vault for this plan is not open yet');
    return found.address;
  };
  switch (leg.kind) {
    // The adapter works out who may take the cash from the plan: nobody here names a spender.
    case 'approve':
      return adapter.buildApprove({
        owner,
        basketId,
        amountRaw: cashOf(leg),
        ...(nonce === undefined ? {} : { nonce }),
      });
    case 'create_vault': {
      if (request.family) {
        // A vault that follows the version the order holds to: it copies that version's weights, and
        // the trades are the ones planned for them. Once it is open the order's swaps buy what it
        // follows, whatever the portfolio publishes meanwhile.
        const followed = await refusing(() =>
          followedOn(request.family ?? '', leg.chain, sharedOf(deps), request.version),
        );
        const assets = await adapter.listAssets();
        const cash = assets.find((x) => x.cls === 'cash');
        if (!cash) throw new Error(`${entry.chain} lists no cash token`);
        const targets = recipeTargets(followed.onchain.active);
        const planned = order.legs.flatMap((l) => l.trades);
        if (!sameTrades(planned, tradesFor(targets, BigInt(cashOf(leg)), cash.id)))
          throw new Refusal(409, 'the shared portfolio has changed since the order was made', {
            code: 'VERSION_CHANGED',
            fix: 'Make the order again.',
          });
        return adapter.buildCreateVault({
          owner,
          basketId,
          targets: [],
          recipeOnchainId: followed.recipe.onchainId,
          expectedVersion: followed.onchain.active.version,
          autoFollow: false,
          depositRaw: cashOf(leg),
          trades,
          slippageBps,
          ...shared,
        });
      }
      const proposal = await loadProposal(deps.db, request.proposalId ?? '');
      const recipe = proposal?.recipes.find((r) => r.chain === leg.chain);
      if (!recipe) throw new Refusal(409, 'the plan this order buys is no longer stored');
      const assets = await adapter.listAssets();
      const cash = assets.find((x) => x.cls === 'cash');
      if (!cash) throw new Error(`${entry.chain} lists no cash token`);
      const targets = await targetsOf(leg.chain, recipe.components, assets, (chain) =>
        loadFamilies(deps.db, chain),
      );
      // The vault's targets are fixed here. They have to be the ones the order's trades were planned
      // for: a shared portfolio in the plan that changed since the order was made gives others.
      const planned = order.legs.flatMap((l) => l.trades);
      if (!sameTrades(planned, tradesFor(targets, BigInt(cashOf(leg)), cash.id)))
        throw new Refusal(
          409,
          'a shared portfolio in this plan has changed since the order was made',
          { code: 'VERSION_CHANGED', fix: 'Make the order again.' },
        );
      return adapter.buildCreateVault({
        owner,
        basketId,
        targets,
        autoFollow: false,
        // The whole deposit. The trades spend the invested share of it; the rest stays as cash.
        depositRaw: cashOf(leg),
        trades,
        slippageBps,
        ...shared,
      });
    }
    case 'deposit':
      // A deposit into a vault that follows a shared portfolio buys the version the order holds to,
      // as the create does.
      if (request.family)
        await refusing(() =>
          followedOn(request.family ?? '', leg.chain, sharedOf(deps), request.version),
        );
      return adapter.buildDeposit({
        vault: await vault(),
        amountRaw: cashOf(leg),
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

/** The store of shared portfolios, as the planning functions take it. */
const sharedOf = (deps: OrderDeps) => ({
  chains: deps.chains,
  bySlug: (slug: string) => familyBySlug(deps.db, slug),
});

/**
 * One step of a publish or a follow. Each is built from the order's stored request and the chain as it
 * is now: a follow is refused with `VERSION_CHANGED` once another version is in effect than the one it
 * holds to, and auto-follow on is checked again (gate GOLD-ONE-TAP).
 */
async function buildShared(
  deps: OrderDeps,
  stored: StoredOrder,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
  nonce: number | undefined,
): Promise<BuiltTx> {
  const { request } = stored;
  const { adapter } = entry;
  const shared = nonce === undefined ? {} : { nonce };
  if (request.type === 'publish') {
    if (leg.kind !== 'publish') throw new Refusal(501, `a ${leg.kind} step cannot be built yet`);
    const draft = request.recipes.find((r) => r.chain === leg.chain);
    if (!draft) throw new Error('a publish step on a chain the request has no recipe for');
    const familyId = request.familyId ?? familyIdOf(request.family);
    // The hash of the text the order was made with. The guard works it out again from the text the
    // creator's form showed, and refuses bytes that carry another.
    const recipe: Recipe = {
      schemaVersion: 1,
      familyId,
      chain: leg.chain,
      onchainId: null,
      creator: owner,
      kind: 'community',
      version: 1,
      effectiveAt: 0,
      components: draft.components,
      metaHash: metaHash(familyText(request, familyId)),
      maxFeeBps: 0,
      flags: 0,
    };
    return adapter.buildPublishRecipe({ creator: owner, recipe, ...shared });
  }
  if (request.type !== 'follow') throw new Error('not a shared-portfolio order');
  const { onchain } = await refusing(() =>
    followedOn(request.family, leg.chain, sharedOf(deps), request.version),
  );
  /** The offer, held again when the step is built: the portfolio may have changed since (GOLD-ONE-TAP). */
  const offered = async () => {
    const offer = autoFollowOffer(
      entry,
      [onchain.active, ...(onchain.pending ? [onchain.pending] : [])].map(recipeTargets),
      await adapter.listAssets(),
    );
    if (!offer.offered) refuseAutoFollow(entry, offer);
  };
  switch (leg.kind) {
    case 'accept_version': {
      // A vault that has auto-follow on when it takes a version is rebalanced into it by the keeper:
      // asked for in the order, or on in the vault as the chain has it now.
      const now = await refusing(() => adapter.getVault(request.vault));
      if (request.autoFollow || now?.autoFollow) await offered();
      return adapter.buildAcceptVersion({
        vault: request.vault,
        recipeOnchainId: onchain.active.onchainId ?? '',
        expectedVersion: onchain.active.version,
        ...shared,
      });
    }
    case 'set_auto_follow': {
      if (request.autoFollow) await offered();
      return adapter.buildSetAutoFollow({
        vault: request.vault,
        on: request.autoFollow,
        ...shared,
      });
    }
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

/**
 * Asks the chain what became of an attempt's transaction and writes it down. `nonce` is the nonce of
 * record where the caller read one from the transaction: the attempt then carries it.
 */
async function settle(
  deps: OrderDeps,
  leg: Leg,
  attempt: Attempt,
  sent: { txId: string; validUntil: string | null },
  nonce: number | null = null,
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
    nonce,
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
 * The transaction of an attempt nobody reported has landed. The leg settles on it, unless that
 * transaction is recorded against another step: one transaction settles one step. That happens on an
 * EVM chain when two orders of one wallet hold the same call on the same nonce, a cancelled attempt and
 * a later one. This attempt can then no longer land, and it is closed.
 *
 * Answers the outcome, or null when the transaction was another step's.
 */
async function settleLanding(
  deps: OrderDeps,
  leg: Leg,
  attempt: Attempt,
  txId: string,
): Promise<Outcome['status'] | null> {
  try {
    return await settle(deps, leg, attempt, { txId, validUntil: attempt.validUntil });
  } catch (e) {
    if (!(e instanceof TakenElsewhere)) throw e;
    await recordOutcome(deps.db, attempt, {
      status: 'expired',
      txId: attempt.txId,
      explorerUrl: attempt.explorerUrl,
      validUntil: attempt.validUntil,
      error: null,
    });
    return null;
  }
}

/**
 * Refuses while the transaction of the leg's latest attempt can still land, so a person is never asked
 * to sign a second transaction for a step whose first may go through. If that transaction has landed
 * and nobody reported it, the leg settles on it here.
 * - Solana: an attempt can land until the chain is past its `validUntil`. Only time closes it.
 * - EVM: a call that trades carries a deadline (`validUntil`); past it with the nonce still free, `fate`
 *   says `gone`. A call that does not trade has none, and stays open until it is reported or the person
 *   cancels it.
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
    const status = await settleLanding(deps, leg, latest, fate.txId);
    // Another step's transaction took the nonce: this attempt is gone, and the next takes a fresh one.
    if (status === null) return undefined;
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
 * The same for several steps of one order: none of them has a transaction that can still land. For a
 * continuation (continue.ts), which makes the steps again in another order: a transaction built for
 * one of them and signed later would spend the vault's cash a second time.
 */
export async function assertNoneInFlight(
  deps: OrderDeps,
  stored: StoredOrder,
  steps: readonly Leg[],
): Promise<void> {
  for (const leg of steps) await assertNothingInFlight(deps, stored, leg);
}

/**
 * EVM only. A wallet has one next nonce on a chain, and every build states it. Two orders of one
 * wallet built side by side would both be built on that nonce, and only one of the two transactions
 * could ever land. So a step is not built while another order of the same wallet holds a transaction
 * on that chain that can still land: that one is reported or cancelled first. The refusal names it.
 *
 * Answers the attempts found that can no longer land, which do not stand in the way.
 */
async function assertNoOtherOrderInFlight(
  deps: OrderDeps,
  order: Order,
  leg: Leg,
  entry: ChainEntry,
  owner: Address,
): Promise<string[]> {
  const others = await liveElsewhere(deps.db, {
    chain: leg.chain,
    owner,
    orderId: order.id,
    now: deps.now(),
  });
  const clear: string[] = [];
  for (const other of others) {
    const fate = await fateOf(entry, other.attempt, owner);
    if (fate.state === 'open') throw blockedBy(entry.config.name, other);
    clear.push(other.attempt.id);
  }
  return clear;
}

/**
 * A fresh transaction for a leg and the attempt that records it. Built only when no earlier attempt can
 * still land.
 */
export async function buildLeg(
  deps: OrderDeps,
  read: StoredOrder,
  legId: string,
  /** The signed-in person's user id: a plan made from a link numbers its vault with it. */
  buyer?: string,
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
  // An order that another finishes (continue.ts) builds nothing more: what it left is that order's,
  // at the terms that one states, and the vault's cash is spent once.
  const [finishedBy] = await continuationsOf(deps.db, order.id);
  if (finishedBy)
    throw new Refusal(409, 'another order finishes this one: its steps left are that order’s', {
      fix: `Open order ${finishedBy.id}.`,
    });
  const waiting = order.legs.find((l) => l.chain === leg.chain && l.seq < leg.seq && !settled(l));
  if (waiting) throw new Refusal(409, 'an earlier step on this chain has not settled yet');

  const entry = deps.chains.get(leg.chain);
  assertBuilds(entry);
  // On an EVM chain a cancelled attempt can still be sent by the wallet that signed it. The next
  // attempt is built on its nonce, so only one of them can ever land.
  const nonce = await assertNothingInFlight(deps, stored, leg);
  const owner = ownerOn(order, leg);
  const evm = chainFamily(leg.chain) === 'evm';
  const clear = evm ? await assertNoOtherOrderInFlight(deps, order, leg, entry, owner) : [];
  let built: BuiltTx;
  let expected: Leg['expected'];
  try {
    [built, expected] = await refusing(async () => [
      BuiltTx.parse(await buildFor(deps, stored, leg, entry, owner, nonce, buyer)),
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
    // Two builds of one wallet at the same moment: the second to be recorded is refused.
    ...(evm
      ? { exclusive: { owner, orderId: order.id, chainName: entry.config.name, clear } }
      : {}),
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
const NOT_THIS_STEP = 'that transaction is not the one built for this step';

/**
 * Which attempt at a step a transaction is. `same` are the attempts whose message the transaction
 * carries, oldest first, and `nonce` is the nonce it was signed with, where it has one.
 *
 * On Solana a message names one attempt: every build is a new message. On an EVM chain the message is
 * the call alone, so two builds of one step share it, and an attempt is the pair (message, nonce).
 * - The nonce is one an attempt states: that pair. If one of them has landed, it is that one: a nonce
 *   is used once. Otherwise the newest that can still land, and failing that the newest that was
 *   closed. After a cancel and a rebuild both attempts state the pair, and the rebuilt one is the
 *   one the person was last asked to sign. After a revert and a rebuild the new attempt has a nonce
 *   of its own, so the reverted one is never taken for it.
 * - The nonce is one no attempt states: an outside wallet chose its own. It is the newest attempt that
 *   can still land, or was closed without landing. A step that is already settled takes no such
 *   transaction: the same call on another nonce is another transaction. Neither does a nonce below
 *   every nonce the step's attempts state: a wallet's nonce only grows, so that transaction landed
 *   before the step was first built. It is an older call of the same wallet that happens to be the
 *   same call, an approval or a deposit made by another route, and not this step's.
 * - No nonce (Solana, or bytes that state none): the newest that can still land, then one that landed,
 *   then one that was closed.
 */
export function attemptFor(
  same: Attempt[],
  nonce: number | null,
  legSettled: boolean,
): Attempt | undefined {
  const newest = (list: Attempt[]) =>
    list.reduce<Attempt | undefined>((a, b) => (a && a.n > b.n ? a : b), undefined);
  if (nonce === null)
    return newest(same.filter(live)) ?? newest(same.filter(final)) ?? newest(same);
  const pair = same.filter((a) => a.nonce === nonce);
  if (pair.length) return newest(pair.filter(final)) ?? newest(pair.filter(live)) ?? newest(pair);
  if (legSettled) return undefined;
  const stated = same.flatMap((a) => (a.nonce === null ? [] : [a.nonce]));
  if (stated.length && nonce < Math.min(...stated)) return undefined;
  return newest(same.filter(live)) ?? newest(same.filter((a) => !final(a)));
}

/**
 * The caller says a leg was sent: by its transaction id, or by handing over the signed bytes to relay.
 * The id or the bytes are matched against every attempt of the leg, and the leg settles on the attempt
 * that landed, whichever it is and whatever it was labelled. What matches no attempt is refused and
 * changes nothing. Bytes are relayed only for an attempt that is built and was never sent, and only
 * while the order has not expired.
 *
 * On an EVM chain the match is by the pair (message, nonce), with the nonce read from the transaction
 * itself (`nonceOf`), and the attempt is left carrying the nonce the wallet really used.
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
  const { adapter } = entry;

  /** A nonce no attempt of this step states: it must not be the pair of another step. */
  const assertNotAnothers = async (attempt: Attempt, nonce: number | null) => {
    if (nonce === null || attempt.nonce === nonce) return;
    const other = await pairElsewhere(deps.db, {
      chain: leg.chain,
      messageHash: attempt.messageHash,
      nonce,
      legId: leg.id,
    });
    if (other)
      throw new Refusal(409, 'that transaction was built for another step', NOT_BUILT_HERE);
  };

  let attempt: Attempt | undefined;
  let sent: { txId: string; validUntil: string | null };
  let nonce: number | null;
  if ('signedTx' in body) {
    const hash = await refuseUnread(() => adapter.messageHashOf(body.signedTx));
    const same = attempts.filter((a) => a.messageHash === hash);
    if (!same.length)
      throw new Refusal(
        409,
        'these are not the bytes built for this step: nothing was sent',
        NOT_BUILT_HERE,
      );
    nonce = await refuseUnread(() => adapter.nonceOf({ signedTx: body.signedTx }));
    attempt = attemptFor(same, nonce, settled(leg));
    if (!attempt)
      throw new Refusal(
        409,
        'these bytes are not a transaction this step can settle on: nothing was sent',
        NOT_BUILT_HERE,
      );
    await assertNotAnothers(attempt, nonce);
    // Its outcome is recorded. The same bytes are never sent a second time.
    if (final(attempt)) return stored;
    if (attempt.txId) sent = { txId: attempt.txId, validUntil: attempt.validUntil };
    else if (attempt.status === 'built') {
      assertBuilds(entry);
      // An order past its time is not acted on: its steps are no longer built, and its bytes are no
      // longer sent. A transaction the wallet sent itself is still recorded, by id or by its bytes.
      if (seconds(deps.now()) > stored.order.expiresAt)
        throw new Refusal(410, 'this order has expired: nothing was sent', {
          code: 'ORDER_EXPIRED',
          fix: 'Make the order again.',
        });
      const relayed = await refusing(() => adapter.relay(body.signedTx));
      sent = { txId: relayed.txId, validUntil: relayed.validUntil ?? attempt.validUntil };
      // Bytes that state no nonce landed on one all the same: the transaction says which.
      nonce ??= await refusing(() => adapter.nonceOf({ txId: relayed.txId }));
    } else {
      // Closed before it was sent. The server does not send it now, but looks whether it landed anyway.
      const fate = await fateOf(
        entry,
        { ...attempt, nonce: nonce ?? attempt.nonce },
        ownerOn(stored.order, leg),
      );
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
    if (attempt) {
      if (final(attempt)) return stored;
      nonce = await refusing(() => adapter.nonceOf({ txId: body.txId }));
    } else {
      // Ask the chain once per message, the newest first.
      const hashes = [...new Set([...attempts].reverse().map((a) => a.messageHash))];
      let hash: string | undefined;
      let unseen = false;
      for (const candidate of hashes) {
        const carried = await refusing(() => adapter.carries(body.txId, candidate));
        if (carried === 'this') {
          hash = candidate;
          break;
        }
        if (carried === 'unseen') unseen = true;
      }
      // A wallet that sent a moment ago can be ahead of the node. That is not the wrong transaction:
      // the caller is told to report again, and nothing is written.
      if (!hash && unseen)
        throw new Refusal(409, 'the chain has not seen that transaction yet', {
          fix: 'Report it again in a moment.',
          details: { retryable: true },
        });
      if (!hash) throw new Refusal(409, NOT_THIS_STEP);
      nonce = await refusing(() => adapter.nonceOf({ txId: body.txId }));
      attempt = attemptFor(
        attempts.filter((a) => a.messageHash === hash),
        nonce,
        settled(leg),
      );
      if (!attempt) throw new Refusal(409, NOT_THIS_STEP);
      await assertNotAnothers(attempt, nonce);
      // The pair has landed and is recorded, under the id it landed with.
      if (final(attempt)) {
        if (attempt.txId !== body.txId) throw new Refusal(409, NOT_THIS_STEP);
        return stored;
      }
    }
    sent = { txId: body.txId, validUntil: attempt.validUntil };
  }

  return afterOutcome(deps, stored, await settle(deps, leg, attempt, sent, nonce));
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
    const status = await settleLanding(deps, leg, attempt, fate.txId);
    // Another step's transaction took the nonce: the attempt is closed, which is what was asked.
    if (status === null) return reload(deps, stored.order.id);
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

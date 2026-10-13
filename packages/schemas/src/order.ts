import { z } from 'zod';
import { ApiError } from './api';
import {
  Address,
  AssetId,
  Bps,
  ChainId,
  chainFamily,
  EvmAddress,
  Hex32,
  RawAmount,
  SolanaAddress,
  Sourced,
} from './chain';
import { ChainErrorCode } from './chain-error';
import { Provenance } from './enums';
import { RecipeDraft, Target } from './recipe';
import { Trade } from './vault';
import { WalletAccount } from './wallet';

// DESIGN-VAULT 3.3. One object, the order, with legs, backs every buy, rebalance, publish and agent approval.

export const LegStatus = z.enum([
  'planned',
  'built',
  'sent',
  'confirmed',
  'failed',
  'expired',
  'skipped',
]);
export type LegStatus = z.infer<typeof LegStatus>;

export const LegKind = z.enum([
  'approve',
  'create_vault',
  'deposit',
  'swap',
  'set_targets',
  'accept_version',
  'set_auto_follow',
  'withdraw',
  'publish',
  'adopt_version',
  'keeper_leg',
]);
export type LegKind = z.infer<typeof LegKind>;

export const LegTrigger = z.enum(['manual', 'index_update', 'drift', 'liquidity_breach']);
export type LegTrigger = z.infer<typeof LegTrigger>;

const KEEPER_KINDS: ReadonlySet<string> = new Set(['adopt_version', 'keeper_leg']);

/**
 * What one trade of a leg is expected to do, from a quote: what goes in, what the quote pays out, the
 * least the transaction accepts (`minOutRaw`, which is the number in the bytes once the leg is built),
 * and the cost against the reference.
 */
export const TradeExpected = z.object({
  inRaw: RawAmount,
  outRaw: RawAmount,
  minOutRaw: RawAmount,
  costBps: z.number(),
});
export type TradeExpected = z.infer<typeof TradeExpected>;

/**
 * One token a `withdraw` step takes out of a vault, in kind, to the vault's owner and nobody else.
 * `amountRaw` null is all the vault holds of it when the step is built; `heldRaw` is what the vault
 * held when the order was planned, which is what a review shows beside it.
 */
export const LegWithdrawal = z.object({
  asset: AssetId,
  amountRaw: RawAmount.nullable(),
  heldRaw: RawAmount,
  /**
   * What it was worth in dollars when the order was made, with where the price came from: the amount
   * (all that was held, where no amount is named) at the chain's reference price then, cash at one
   * dollar. Absent for a token with no price. A portfolio counts what was taken out from it.
   */
  valued: Sourced.extend({ usd: z.string().regex(/^\d+(\.\d+)?$/) }).optional(),
});
export type LegWithdrawal = z.infer<typeof LegWithdrawal>;

export const LegBase = z.object({
  id: z.string().min(1),
  /** Null for keeper legs. */
  orderId: z.string().min(1).nullable(),
  chain: ChainId,
  /** Order within its chain. */
  seq: z.number().int().nonnegative(),
  kind: LegKind,
  signer: z.enum(['owner', 'keeper']),
  description: z.string(),
  /**
   * The cash this step is about, in the cash token's raw units: what a `create_vault` or a `deposit`
   * takes from the wallet into the vault, and what an `approve` allows the vault to take. An approval
   * moves nothing. It is the whole deposit, which is more than the step's trades spend when the plan
   * keeps a share in cash: the rest stays in the vault as cash. Absent on any other step.
   *
   * Do not add it up over an order's legs. On a chain that needs an approval, the approval and the
   * step that deposits both carry the same amount, so the sum is twice the deposit. What the order
   * moves is `Order.depositRaw`.
   */
  cashRaw: RawAmount.optional(),
  /** What a `withdraw` step takes out, each token once. Absent on any other step. */
  withdrawals: z.array(LegWithdrawal).min(1).optional(),
  trades: z.array(Trade),
  /**
   * One entry per trade, in the order of `trades`: entry `i` is trade `i`. Empty for a leg with no
   * trade, and for one whose trades were not quoted.
   */
  expected: z.array(TradeExpected),
  status: LegStatus,
  attempt: z.number().int().nonnegative(),
  txId: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  /** Opaque to everything but the adapter that produced it: a block height on Solana. */
  validUntil: z.string().nullable(),
  /** A ChainError's three fields where the chain or an adapter refused; a WalletError's code where the wallet did. */
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  trigger: LegTrigger,
  // The design says 'live' | 'mock'. Since test networks came first (GATES, 2026-10-02) a leg on one is
  // neither, so this is the full Provenance: 'sandbox' is a test network or a local copy.
  provenance: Provenance,
});

/**
 * A planned step. Never duplicated: each build is an Attempt, and the leg mirrors its latest one.
 * A keeper leg belongs to no order and is one of the two keeper kinds; an owner leg is neither.
 */
export const Leg = LegBase.refine((l) => (l.signer === 'keeper') === (l.orderId === null), {
  message: 'a keeper leg has no order, and an owner leg has one',
  path: ['orderId'],
})
  .refine((l) => (l.signer === 'keeper') === KEEPER_KINDS.has(l.kind), {
    message: 'adopt_version and keeper_leg are the keeper kinds, and the only ones',
    path: ['kind'],
  })
  .refine((l) => l.expected.length === 0 || l.expected.length === l.trades.length, {
    message: 'one expected figure per trade, or none',
    path: ['expected'],
  });
export type Leg = z.infer<typeof Leg>;

export const AttemptStatus = z.enum(['built', 'sent', 'confirmed', 'failed', 'expired']);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const Attempt = z.object({
  id: z.string().min(1),
  legId: z.string().min(1),
  n: z.number().int().min(1),
  messageHash: z.string().min(1),
  nonce: z.number().int().nonnegative().nullable(),
  status: AttemptStatus,
  txId: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  validUntil: z.string().nullable(),
  builtAt: z.string().datetime(),
});
export type Attempt = z.infer<typeof Attempt>;

export const OwnerBase = z.object({ solana: SolanaAddress.optional(), evm: EvmAddress.optional() });

/** One address per wallet family, each in its family's form. The EVM address serves both EVM chains. */
export const Owner = OwnerBase.refine(
  (o) => Boolean(o.solana ?? o.evm),
  'an owner has at least one address',
);
export type Owner = z.infer<typeof Owner>;

export const OrderType = z.enum(['buy', 'rebalance', 'follow', 'publish', 'withdraw', 'settings']);
export type OrderType = z.infer<typeof OrderType>;

/**
 * What a person agrees to on the review screen, beside the order: following a shared portfolio by
 * itself, taking an asset new to the vault, and publishing (or taking back) a shared portfolio of their
 * own (gate `SHARED-FULL`).
 */
export const ConsentKind = z.enum(['auto_follow_on', 'new_asset', 'publish']);
export type ConsentKind = z.infer<typeof ConsentKind>;

export const OrderBase = z.object({
  id: z.string().min(1),
  type: OrderType,
  owner: Owner,
  /** Written by the server, never caller text. */
  summary: z.string(),
  /**
   * The cash this order moves from the wallet into the vault, once, in the raw units of the chain's
   * cash token: the amount of a buy. This is the figure to show and to add up. The legs repeat it
   * (`Leg.cashRaw` is on the approval and on the step that deposits), so their sum is not it. Absent
   * for an order that deposits nothing.
   */
  depositRaw: RawAmount.optional(),
  /**
   * For a buy: the vault's number on chain, which the vault's address is derived from. A plan's, a
   * shared portfolio's, or, for a plan made from a link, the buyer's own (gate `AGENT-LINK`). Stored
   * with the order when it is made, so a step is built for it whatever happens to the plan after. A
   * client holds it to a number it works out itself. Absent on orders made before it was stored.
   */
  basketId: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  /**
   * For an order that finishes another (`POST /v1/orders/{id}/continue`): the id of the buy whose
   * swaps it makes, with the cash that buy already put in the vault. It deposits nothing
   * (`depositRaw` is absent) and its steps spend only the vault's cash.
   */
  continues: z.string().min(1).optional(),
  legs: z.array(Leg),
  warnings: z.array(z.object({ code: z.string(), text: z.string() })),
  /** Granted only on the approval page. */
  needsConsent: z.array(ConsentKind),
  /** Empty in the MVP. */
  fees: z.array(z.object({ kind: z.string(), bps: z.number() })),
  preparedBy: z.enum(['app', 'api', 'mcp']),
  /** Shown as "unverified: …". */
  agentLabel: z.string().optional(),
  status: z.enum(['open', 'partial', 'done', 'failed', 'expired']),
  approvalUrl: z.string().min(1),
  /** Unix seconds. */
  expiresAt: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  disclaimer: z.string(),
});

/**
 * Every leg is the order's own, on a chain the owner has an address for. A plan lives on one chain
 * (gate ONE-CHAIN), so the legs of a buy, a rebalance, a follow, a withdrawal and a settings change are
 * all on one chain: only a publish order, one recipe per chain, may have legs on more than one.
 */
export const Order = OrderBase.refine((o) => o.legs.every((l) => l.orderId === o.id), {
  message: "every leg carries the order's id",
  path: ['legs'],
})
  .refine((o) => o.legs.every((l) => o.owner[chainFamily(l.chain)] !== undefined), {
    message: 'the owner has an address for the chain of every leg',
    path: ['legs'],
  })
  .refine((o) => o.type === 'publish' || new Set(o.legs.map((l) => l.chain)).size <= 1, {
    message: 'only a publish order has legs on more than one chain',
    path: ['legs'],
  });
export type Order = z.infer<typeof Order>;

/** The most a request may ask for. One place, so the schema, the server and a client agree. */
export const ORDER_LIMITS = {
  /** The most one order may buy, in dollars: the ceiling of a plan's own amount (`BasketSheet`). */
  maxAmountUsd: 1_000_000,
  /**
   * The most slippage an owner's trade may be built with, in bps. It is the hard bound the vaults put
   * on the keeper's tolerance (DESIGN-VAULT 3.7), so no request can ask for a looser trade than that.
   */
  maxSlippageBps: 300,
} as const;

/** `family` is always the slug. */
export const IntentRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('buy'),
    owner: Owner,
    amountUsd: z
      .number()
      .positive()
      .max(ORDER_LIMITS.maxAmountUsd, 'one deposit is at most $1,000,000'),
    /**
     * The slippage each trade of this order is built with: the least a trade accepts is its quote
     * less this. Left out, the server's own figure applies. Never more than
     * `ORDER_LIMITS.maxSlippageBps`.
     */
    maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
    proposalId: z.string().optional(),
    /**
     * A shared portfolio's slug, in place of `proposalId`: the buy opens a vault that follows it (or
     * adds to the one that does), with auto-follow off, on the chain `chain` names, else on the
     * person's current chain.
     */
    family: z.string().optional(),
    /**
     * With `family` only: the chain of the recipe to follow, for a portfolio published on more than
     * one (gate CHAIN-AT-THE-PLAN). It has to be a chain the portfolio has a recipe on and one a wallet
     * of the person signs on (409 `NO_WALLET_FOR_CHAIN` otherwise). Left out, the person's current
     * chain. The order is still on one chain (ONE-CHAIN): a plan and a vault name none, they have their own.
     */
    chain: ChainId.optional(),
    /**
     * With `family`: the version of the shared portfolio the person reviewed. The order is refused with
     * `VERSION_CHANGED` when another is in effect, then or when a step is built. Left out, the version in
     * effect when the order is made, which the order then holds to.
     */
    version: z.number().int().min(1).optional(),
    /**
     * A vault of the person's, in place of `proposalId` and `family`: the buy adds the amount to that
     * vault and buys to the targets the vault has on chain now, the cash share they leave kept as cash.
     * A vault that is not the caller's is answered as one that does not exist.
     */
    vault: z.object({ chain: ChainId, address: Address }).optional(),
    /**
     * Never sent. A buy is on one chain (gate ONE-CHAIN): a plan's own, a vault's own, or the one
     * `chain` names for a shared portfolio. The list a buy once took is refused with a sentence, not
     * ignored, so a caller that still asks for a split across chains is told instead of getting
     * another order.
     */
    chains: z
      .never({
        error:
          'a buy names no chain: an order is on the chain of the wallet, where the plan lives. Leave `chains` out',
      })
      .optional(),
  }),
  z.object({
    type: z.literal('rebalance'),
    vaults: z.array(Address).min(1),
    reason: z.enum(['manual', 'index_update', 'drift']),
    /**
     * Written by the server, never taken from this route: the vault's new own targets, for an order
     * made by `POST /v1/vaults/{chain}/{address}/targets`. `POST /v1/orders` plans no rebalance yet.
     */
    targets: z.array(Target).max(16).optional(),
    /** With `targets`: the slippage the order's trades are built with. */
    maxSlippageBps: Bps.max(ORDER_LIMITS.maxSlippageBps).optional(),
  }),
  z.object({
    type: z.literal('follow'),
    vault: Address,
    family: z.string().min(1),
    autoFollow: z.boolean(),
    /** The version the person reviewed, as for a buy of a shared portfolio. */
    version: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('publish'),
    creator: Owner,
    family: z.string().min(1),
    /**
     * The family's id as the publish form shows it: for a new shared portfolio `familyIdOf(slug)`, for
     * an update the id of the one being updated. The order is refused when the server works out another.
     * Left out, the one the server works out.
     */
    familyId: Hex32.optional(),
    name: z.string().min(1),
    copy: z.string(),
    /** One per chain. Only the chain and the weights: the server and the registry assign the rest. */
    recipes: z.array(RecipeDraft).min(1),
  }),
  z.object({
    type: z.literal('withdraw'),
    /** One vault per order for now: the first, and a second is refused. */
    vaults: z.array(Address).min(1),
    /** Not offered yet: `true` is refused. The tokens leave as they are, to the vault's owner. */
    sellToCash: z.boolean(),
    /**
     * Which tokens, each once. `amountRaw` left out or null: all the vault holds of that token. The
     * whole list left out: everything the vault holds.
     */
    withdrawals: z
      .array(z.object({ asset: AssetId, amountRaw: RawAmount.nullable().optional() }))
      .min(1)
      .optional(),
  }),
  z.object({ type: z.literal('settings'), vault: Address, autoFollow: z.boolean() }),
]);
export type IntentRequest = z.infer<typeof IntentRequest>;

/** Who is calling. Wallets come from a verified identity token, never from what the client says. */
export const Principal = z.object({
  kind: z.enum(['anon', 'user', 'service']),
  userId: z.string().optional(),
  wallets: z.array(WalletAccount),
  ip: z.string(),
});
export type Principal = z.infer<typeof Principal>;

/**
 * What the API answers with. A ChainError from an adapter is mapped onto one of these (NotFunded to
 * NOT_FUNDED, VersionMismatch to VERSION_CHANGED, and so on); the vault's own name stays on the leg.
 * MARKET_CLOSED is a warning on an order, not an error: only keeper trades are bound to the session.
 */
export const OrderErrorCode = z.enum([
  'NOT_FUNDED',
  'ASSET_NOT_ELIGIBLE',
  'GOAL_NOT_ACHIEVABLE',
  'NEW_ASSET_NEEDS_APPROVAL',
  'VERSION_CHANGED',
  'CREATOR_LIMIT',
  'ORDER_EXPIRED',
  'US_PERSON',
  'RATE_LIMITED',
  'CHAIN_UNAVAILABLE',
  /** The plan an order buys is no longer stored: one made from a link nobody bought goes after days. */
  'PLAN_GONE',
  /** A plan's goal or a withdrawal in another currency than US dollars (gate USD-ONLY). */
  'CURRENCY_UNSUPPORTED',
  /** A switch to a chain none of the person's wallets signs on: an EVM wallet alone cannot sign on Solana. */
  'NO_WALLET_FOR_CHAIN',
  /**
   * A step's trade would now give less than the least the order stated. The order's terms are never
   * changed after it is made: it is made again, at the price now.
   */
  'PRICE_MOVED',
  // What `POST /v1/orders/{id}/continue` refuses with, and a build of a step for the same reasons.
  /** Another order already finishes this one: `details.continuedBy` is its id, and it is the one to open. */
  'ORDER_CONTINUED',
  /** A transaction built for a step can still land, so the step is not made again yet. Retryable. */
  'STEP_IN_FLIGHT',
  /**
   * A step's transaction landed and nobody had reported it: the step has settled on it now, and the
   * order reads differently. Read the order again; nothing else is to be done.
   */
  'STEP_LANDED',
  /** Every step of the order is done: there is nothing to finish. */
  'NOTHING_LEFT',
  /** The vault holds less cash than the steps left would spend. */
  'VAULT_CASH_SHORT',
  /** The order's deposit has not landed: its own steps are signed first. */
  'DEPOSIT_NOT_LANDED',
  /** Another request is working on the order, and the wait for it ran out. Retryable. */
  'ORDER_BUSY',
  /** The order is not one this route finishes: a buy on a chain that trades inside its deposit, or not a buy with a vault. */
  'CONTINUE_NOT_SUPPORTED',
  /**
   * A mix that cannot be bought or applied as sent (gate ANY-COMPOSITION): `details.issues` says
   * why, one `MixIssueCode` each, with the asset where there is one.
   */
  'MIX_NOT_VALID',
  /** A buy of a confirmed mix above the amount it was reviewed at: its warnings were confirmed at that size. */
  'AMOUNT_OVER_REVIEW',
]);
export type OrderErrorCode = z.infer<typeof OrderErrorCode>;

/**
 * What an order route answers when it says no: the existing ApiError shape plus `code`, `fix` and
 * typed `details`. A refusal that came from a chain keeps the chain's own code and its `retryable`, so
 * a client can tell "try again" from "change something first".
 */
export const OrderError = ApiError.extend({
  /** One of the order codes, where one fits. Absent for a refusal that is none of them. */
  code: OrderErrorCode.optional(),
  /** What the person can do about it, in a sentence. */
  fix: z.string().optional(),
  details: z
    .object({
      /** The chain adapter's own code. */
      chainCode: ChainErrorCode.optional(),
      /** True when the same request can succeed later with nothing changed by the person. */
      retryable: z.boolean().optional(),
      /**
       * EVM: the step of another order of the same wallet whose transaction can still land. A step is
       * not built while one is open, since both would be built on the wallet's next nonce and only
       * one could land. Report that step or cancel it, then build again.
       */
      blocking: z.object({ orderId: z.string().min(1), legId: z.string().min(1) }).optional(),
      /** With `ORDER_CONTINUED`: the id of the order that finishes this one. */
      continuedBy: z.string().min(1).optional(),
      /** With `MIX_NOT_VALID`: what is wrong with the mix, `CODE` or `CODE:assetId` each. */
      issues: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});
export type OrderError = z.infer<typeof OrderError>;

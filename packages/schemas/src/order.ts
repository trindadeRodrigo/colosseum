import { z } from 'zod';
import { ApiError } from './api';
import { Address, ChainId, RawAmount } from './chain';
import { Provenance } from './enums';
import { Recipe } from './recipe';
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

/** A planned step. Never duplicated: each build is an Attempt, and the leg mirrors its latest one. */
export const Leg = z.object({
  id: z.string().min(1),
  /** Null for keeper legs. */
  orderId: z.string().min(1).nullable(),
  chain: ChainId,
  /** Order within its chain. */
  seq: z.number().int().nonnegative(),
  kind: LegKind,
  signer: z.enum(['owner', 'keeper']),
  description: z.string(),
  trades: z.array(Trade),
  expected: z
    .object({ inRaw: RawAmount, outRaw: RawAmount, minOutRaw: RawAmount, costBps: z.number() })
    .nullable(),
  status: LegStatus,
  attempt: z.number().int().nonnegative(),
  txId: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  /** Opaque to everything but the adapter that produced it: a block height on Solana. */
  validUntil: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  trigger: LegTrigger,
  // The design says 'live' | 'mock'. Since test networks came first (GATES, 2026-10-02) a leg on one is
  // neither, so this is the full Provenance: 'sandbox' is a test network or a local copy.
  provenance: Provenance,
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

/** One address per wallet family. The EVM address serves both EVM chains. */
export const Owner = z
  .object({ solana: Address.optional(), evm: Address.optional() })
  .refine((o) => Boolean(o.solana ?? o.evm), 'an owner has at least one address');
export type Owner = z.infer<typeof Owner>;

export const OrderType = z.enum(['buy', 'rebalance', 'follow', 'publish', 'withdraw', 'settings']);
export type OrderType = z.infer<typeof OrderType>;

export const ConsentKind = z.enum(['auto_follow_on', 'new_asset']);
export type ConsentKind = z.infer<typeof ConsentKind>;

export const Order = z.object({
  id: z.string().min(1),
  type: OrderType,
  owner: Owner,
  /** Written by the server, never caller text. */
  summary: z.string(),
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
export type Order = z.infer<typeof Order>;

/** `family` is always the slug. */
export const IntentRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('buy'),
    owner: Owner,
    amountUsd: z.number().positive(),
    proposalId: z.string().optional(),
    family: z.string().optional(),
    chains: z.array(ChainId).optional(),
  }),
  z.object({
    type: z.literal('rebalance'),
    vaults: z.array(Address).min(1),
    reason: z.enum(['manual', 'index_update', 'drift']),
  }),
  z.object({
    type: z.literal('follow'),
    vault: Address,
    family: z.string().min(1),
    autoFollow: z.boolean(),
  }),
  z.object({
    type: z.literal('publish'),
    creator: Owner,
    family: z.string().min(1),
    name: z.string().min(1),
    copy: z.string(),
    recipes: z.array(Recipe).min(1),
  }),
  z.object({
    type: z.literal('withdraw'),
    vaults: z.array(Address).min(1),
    sellToCash: z.boolean(),
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

/** MARKET_CLOSED is a warning on an order, not an error: only keeper trades are bound to the session. */
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
]);
export type OrderErrorCode = z.infer<typeof OrderErrorCode>;

/** The existing ApiError shape plus `code` and `fix`. The design names the fields, not the type. */
export const OrderError = ApiError.extend({ code: OrderErrorCode, fix: z.string().optional() });
export type OrderError = z.infer<typeof OrderError>;

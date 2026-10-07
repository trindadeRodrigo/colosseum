import type {
  AttemptStatus,
  BasketAsset,
  BasketProposal,
  ChainId,
  Component,
  ConsentKind,
  Holding,
  IntentRequest,
  Leg,
  LegKind,
  LegStatus,
  LegTrigger,
  Network,
  Order,
  OrderType,
  Price,
  Target,
  Trade,
  VaultPosition,
  VaultState,
  VaultView,
  WalletAccount,
} from '@colosseum/schemas';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { chainEnum, provenanceEnum } from './schema';

// Vault tables (DESIGN-VAULT section 4, migration 0006). Kept apart from schema.ts and risk-schema.ts so
// the structurer's and the risk layer's tables are untouched. These tables cache chain state and hold
// off-chain text; the chains are the source of truth.
// Units: weights are integer basis points; token amounts are raw units in numeric(78,0) or, inside
// jsonb, decimal strings; dollars are display values only.
// A chain is a row in `chains`, so every chain_id is text with a foreign key and a new chain is not a
// migration. Statuses and kinds are text for the same reason until the interfaces freeze (FRAME-3);
// packages/schemas validates them.
const ts = (name: string) => timestamp(name, { withTimezone: true });
const raw = (name: string) => numeric(name, { precision: 78, scale: 0 });
const provenanceCols = {
  source: text('source').notNull(),
  method: text('method').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
};
const chainId = () =>
  text('chain_id')
    .$type<ChainId>()
    .notNull()
    .references(() => chains.id);

/**
 * The only list of chains. seedChains() writes it from the chain configs at start. `network` says
 * mainnet, testnet or local, and one database serves one network: seedChains refuses a config that
 * names another.
 */
export const chains = pgTable('chains', {
  id: text('id').$type<ChainId>().primaryKey(),
  family: chainEnum('family').notNull(),
  name: text('name').notNull(),
  network: text('network').$type<Network>().notNull(),
  networkName: text('network_name').notNull(),
  evmChainId: integer('evm_chain_id'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * A person, by their Privy id. Written only from a verified identity token.
 * `chain_id` is the chain a person who made a wallet in the app picked (gate CHAIN-PICK): set once,
 * never changed, and null for someone whose chain is that of the outside wallet they connected.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  privyId: text('privy_id').notNull().unique(),
  chainId: text('chain_id')
    .$type<ChainId>()
    .references(() => chains.id),
  chainPickedAt: ts('chain_picked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** A person's wallets. One address belongs to one person. */
export const userWallets = pgTable(
  'user_wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    family: chainEnum('family').notNull(),
    address: text('address').notNull(),
    kind: text('kind').$type<WalletAccount['kind']>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('user_wallets_family_address_key').on(t.family, t.address),
    index('user_wallets_user_idx').on(t.userId),
  ],
);

/** The listed assets: static description, no prices. id is `chain:slug`. */
export const basketAssets = pgTable(
  'basket_assets',
  {
    id: text('id').primaryKey(),
    chainId: chainId(),
    address: text('address').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    cls: text('cls').$type<BasketAsset['cls']>().notNull(),
    underlying: text('underlying').notNull(),
    issuer: text('issuer').notNull(),
    tier: text('tier').$type<BasketAsset['tier']>().notNull(),
    priceKind: text('price_kind').$type<BasketAsset['priceKind']>().notNull(),
    priceRef: text('price_ref').notNull(),
    session: text('session').$type<BasketAsset['session']>().notNull(),
    autoFollowEligible: boolean('auto_follow_eligible').notNull(),
    maxWeightBps: integer('max_weight_bps').notNull(),
    blockedCountries: jsonb('blocked_countries').$type<string[]>().notNull(),
    sheet: text('sheet').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('basket_assets_chain_address_key').on(t.chainId, t.address)],
);

/** A shared portfolio's off-chain text. `name_key` is the folded name: one family per look-alike name. */
export const indexFamilies = pgTable('index_families', {
  familyId: text('family_id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nameKey: text('name_key').notNull().unique(),
  name: text('name').notNull(),
  copy: text('copy').notNull(),
  creatorUserId: uuid('creator_user_id').references(() => users.id),
  creatorKind: text('creator_kind').$type<'platform' | 'community'>().notNull(),
  kind: text('kind').$type<'index' | 'single'>().notNull(),
  /** The platform badge, set from the platform creator address. */
  platform: boolean('platform').notNull().default(false),
  params: jsonb('params').notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** A family's recipe on one chain. */
export const recipes = pgTable(
  'recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: text('family_id')
      .notNull()
      .references(() => indexFamilies.familyId),
    chainId: chainId(),
    onchainId: text('onchain_id'),
    creator: text('creator').notNull(),
    kind: text('kind').$type<'community' | 'personal'>().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('recipes_family_chain_key').on(t.familyId, t.chainId),
    unique('recipes_chain_onchain_key').on(t.chainId, t.onchainId),
  ],
);

export const recipeVersions = pgTable(
  'recipe_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id),
    version: integer('version').notNull(),
    components: jsonb('components').$type<Component[]>().notNull(),
    metaHash: text('meta_hash').notNull(),
    effectiveAt: ts('effective_at').notNull(),
    status: text('status').$type<'pending' | 'active' | 'superseded' | 'cancelled'>().notNull(),
    /** Null in the MVP: no creator fees. */
    feeBps: integer('fee_bps'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique('recipe_versions_recipe_version_key').on(t.recipeId, t.version)],
);

/** A stored plan as the engine built it, keyed by the hash of its inputs. */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inputsHash: text('inputs_hash').notNull().unique(),
    userId: uuid('user_id').references(() => users.id),
    proposal: jsonb('proposal').$type<BasketProposal>().notNull(),
    engineVersion: text('engine_version').notNull(),
    shelfVersion: text('shelf_version').notNull(),
    paramsHash: text('params_hash').notNull(),
    /**
     * Made from a link (`POST /v1/baskets/propose`, gate `AGENT-LINK`): stored with no person, read back
     * by anybody holding its id, and a buyer's vault numbered from the plan and the buyer.
     */
    fromLink: boolean('from_link').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // The daily cap and the cleanup read the plans made from a link by their time, and only those.
    index('proposals_from_link_created_idx').on(t.createdAt).where(sql`${t.fromLink}`),
  ],
);

/** A person's plan: made to measure (`personal`) or following a shared portfolio (`follow`). */
export const baskets = pgTable(
  'baskets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').$type<'personal' | 'follow'>().notNull(),
    familyId: text('family_id').references(() => indexFamilies.familyId),
    proposalId: uuid('proposal_id').references(() => proposals.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('baskets_user_idx').on(t.userId)],
);

/** The last state read from a vault. A cache: the chain is the truth, and `observed_at` says how old. */
export const vaults = pgTable(
  'vaults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: chainId(),
    address: text('address').notNull(),
    owner: text('owner').notNull(),
    /** The name its owner gave it (`VaultName`, plain text); null when they gave none. */
    name: text('name'),
    basketId: uuid('basket_id').references(() => baskets.id),
    /** The plan's number onchain: the Solana seed and the EVM salt. */
    onchainBasketId: numeric('onchain_basket_id', { precision: 20, scale: 0 }).notNull(),
    recipeId: uuid('recipe_id').references(() => recipes.id),
    acceptedVersion: integer('accepted_version').notNull().default(0),
    autoFollow: boolean('auto_follow').notNull().default(false),
    targets: jsonb('targets').$type<Target[]>().notNull(),
    balances: jsonb('balances').$type<{ cash: Holding; positions: VaultPosition[] }>().notNull(),
    valueUsd: numeric('value_usd', { precision: 18, scale: 2 }),
    vaultType: text('vault_type').notNull().default('standard'),
    observedAt: ts('observed_at').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [
    unique('vaults_chain_address_key').on(t.chainId, t.address),
    index('vaults_owner_idx').on(t.owner),
    index('vaults_recipe_idx').on(t.recipeId),
  ],
);

/**
 * One read of one vault at one time, kept whole: the view, and every price it stood on. A cache with
 * its time, as `vaults` is, but never overwritten: the rows of a vault are its history. Only the
 * snapshot worker (apps/snapshot) writes it, and it names a vault by its chain and address, as the
 * keeper's tables do, since it finds vaults on the chain. `basket_id` is the plan the vault was joined
 * to when it was read, null for a vault no order of ours opened.
 */
export const vaultSnapshots = pgTable(
  'vault_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: chainId(),
    address: text('address').notNull(),
    observedAt: ts('observed_at').notNull(),
    /**
     * The chain's height at the start of the pass that read the vault: a slot on Solana, a block on
     * EVM. Every read of the pass is at or after it. Null where the chain could not say.
     */
    blockOrSlot: numeric('block_or_slot', { precision: 20, scale: 0 }),
    owner: text('owner').notNull(),
    basketId: uuid('basket_id').references(() => baskets.id),
    /** The plan's number onchain: the Solana seed and the EVM salt. */
    onchainBasketId: numeric('onchain_basket_id', { precision: 20, scale: 0 }).notNull(),
    /** The shared portfolio the vault followed, by its id on the chain; null when it followed none. */
    recipeOnchainId: text('recipe_onchain_id'),
    acceptedVersion: integer('accepted_version').notNull(),
    autoFollow: boolean('auto_follow').notNull(),
    /** Display only, cut to cents. The positions carry their own figures to six places. */
    valueUsd: numeric('value_usd', { precision: 18, scale: 2 }).notNull(),
    cash: jsonb('cash').$type<Holding>().notNull(),
    /** As `view()` of packages/basket gave them: amount, value, weight, target and drift. */
    positions: jsonb('positions').$type<VaultView['positions']>().notNull(),
    /** A published version of the followed portfolio that was not yet applied. */
    pending: jsonb('pending').$type<VaultState['pending']>(),
    lossUsedBps: integer('loss_used_bps').notNull(),
    /** The chain's settings at the read. Null where the chain has none (the mock has only a band). */
    bandBps: integer('band_bps'),
    lossCapBps: integer('loss_cap_bps'),
    paused: boolean('paused'),
    /** Every price the view stood on, each with its own source, time, method and provenance. */
    prices: jsonb('prices').$type<Price[]>().notNull(),
    provenance: provenanceEnum('provenance').notNull(),
    source: text('source').notNull(),
    method: text('method').notNull(),
  },
  (t) => [
    // One row per vault per time; its index also serves the newest-first read of one vault.
    unique('vault_snapshots_chain_address_time_key').on(t.chainId, t.address, t.observedAt),
    // A person's history is read by the addresses of their wallets.
    index('vault_snapshots_owner_time_idx').on(t.owner, t.observedAt),
  ],
);

/**
 * One pass of the snapshot worker over one chain. The partial unique index allows one open run per
 * chain, as `keeper_runs` has it. `error` is why the pass as a whole failed, in words that carry no
 * node address; null when it went through.
 */
export const snapshotRuns = pgTable(
  'snapshot_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: chainId(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    vaultsRead: integer('vaults_read').notNull().default(0),
    vaultsFailed: integer('vaults_failed').notNull().default(0),
    error: text('error'),
    provenance: provenanceEnum('provenance').notNull(),
  },
  (t) => [
    uniqueIndex('snapshot_runs_one_open_per_chain')
      .on(t.chainId)
      .where(sql`${t.finishedAt} is null`),
    // When a chain last answered is read by its newest runs.
    index('snapshot_runs_chain_started_idx').on(t.chainId, t.startedAt),
  ],
);

/** The watchlist. `prompt_version` is a new version waiting for the person's answer. */
export const follows = pgTable(
  'follows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: text('family_id')
      .notNull()
      .references(() => indexFamilies.familyId),
    promptVersion: integer('prompt_version'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('follows_user_family_key').on(t.userId, t.familyId),
    index('follows_family_idx').on(t.familyId),
  ],
);

/** One object behind every buy, rebalance, publish and agent approval. Reachable only by its id. */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').$type<OrderType>().notNull(),
    ownerSolana: text('owner_solana'),
    ownerEvm: text('owner_evm'),
    userId: uuid('user_id').references(() => users.id),
    orgId: text('org_id'),
    /** Written by the server, never caller text. */
    summary: text('summary').notNull(),
    request: jsonb('request').$type<IntentRequest>().notNull(),
    /** For a buy: the vault's number on chain, as the order was made (`Order.basketId`). */
    basketId: text('basket_id'),
    warnings: jsonb('warnings').$type<Order['warnings']>().notNull().default([]),
    needsConsent: jsonb('needs_consent').$type<ConsentKind[]>().notNull().default([]),
    fees: jsonb('fees').$type<Order['fees']>().notNull().default([]),
    preparedBy: text('prepared_by').$type<Order['preparedBy']>().notNull(),
    agentLabel: text('agent_label'),
    status: text('status').$type<Order['status']>().notNull(),
    expiresAt: ts('expires_at').notNull(),
    disclaimer: text('disclaimer').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('orders_owner_solana_idx').on(t.ownerSolana),
    index('orders_owner_evm_idx').on(t.ownerEvm),
  ],
);

/** A consent given on the approval page, bound to the legs it covered. */
export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    address: text('address').notNull(),
    kind: text('kind').$type<ConsentKind>().notNull(),
    textVersion: text('text_version').notNull(),
    legsHash: text('legs_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('consents_order_idx').on(t.orderId)],
);

/** An owner-signed step of an order. Its status, tx id and attempt number mirror its latest attempt. */
export const legs = pgTable(
  'legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    chainId: chainId(),
    /** Order within its chain. */
    seq: integer('seq').notNull(),
    kind: text('kind').$type<LegKind>().notNull(),
    signer: text('signer').$type<Leg['signer']>().notNull(),
    description: text('description').notNull(),
    /**
     * The cash the step is about, in raw units: a deposit, or what an approval allows. The approval
     * and the deposit of one order both hold it, so it is not summed over an order's rows.
     */
    cashRaw: raw('cash_raw'),
    /** What a `withdraw` step takes out (`Leg.withdrawals`). Null on any other step. */
    withdrawals: jsonb('withdrawals').$type<Leg['withdrawals']>(),
    trades: jsonb('trades').$type<Trade[]>().notNull(),
    expected: jsonb('expected').$type<Leg['expected']>(),
    status: text('status').$type<LegStatus>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    txId: text('tx_id'),
    explorerUrl: text('explorer_url'),
    validUntil: text('valid_until'),
    error: jsonb('error').$type<Leg['error']>(),
    trigger: text('trigger').$type<LegTrigger>().notNull(),
    provenance: provenanceEnum('provenance').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [unique('legs_order_chain_seq_key').on(t.orderId, t.chainId, t.seq)],
);

/** One keeper pass over one chain. The partial unique index allows one open run per chain. */
export const keeperRuns = pgTable(
  'keeper_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: chainId(),
    startedAt: ts('started_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
    outcome: jsonb('outcome'),
  },
  (t) => [
    uniqueIndex('keeper_runs_one_open_per_chain').on(t.chainId).where(sql`${t.finishedAt} is null`),
  ],
);

/**
 * The keeper's own leg log and idempotency key. Only the keeper writes it; it never signs from a row.
 * A vault is named by its chain and address, not by a row of `vaults`: the keeper finds vaults on the
 * chain, and `vaults` is the API's cache, which the keeper may not write.
 */
export const keeperLegs = pgTable(
  'keeper_legs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keeperRunId: uuid('keeper_run_id')
      .notNull()
      .references(() => keeperRuns.id),
    chainId: chainId(),
    vaultAddress: text('vault_address').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').$type<Extract<LegKind, 'adopt_version' | 'keeper_leg'>>().notNull(),
    description: text('description').notNull(),
    trades: jsonb('trades').$type<Trade[]>().notNull(),
    expected: jsonb('expected').$type<Leg['expected']>(),
    status: text('status').$type<LegStatus>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    txId: text('tx_id'),
    explorerUrl: text('explorer_url'),
    validUntil: text('valid_until'),
    error: jsonb('error').$type<Leg['error']>(),
    trigger: text('trigger').$type<LegTrigger>().notNull(),
    provenance: provenanceEnum('provenance').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('keeper_legs_vault_run_seq_key').on(t.chainId, t.vaultAddress, t.keeperRunId, t.seq),
    index('keeper_legs_run_idx').on(t.keeperRunId),
  ],
);

/** Per vault, by chain and address: the last version the keeper brought fully inside the band, and expired tries since. */
export const keeperVaults = pgTable(
  'keeper_vaults',
  {
    chainId: chainId(),
    vaultAddress: text('vault_address').notNull(),
    syncedVersion: integer('synced_version').notNull().default(0),
    expiredAttempts: integer('expired_attempts').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.vaultAddress] })],
);

/**
 * Every build of a leg, an owner's or the keeper's: exactly one of the two leg columns is set. This is
 * the rule that every transaction is logged with its explorer link and provenance.
 */
export const legAttempts = pgTable(
  'leg_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    legId: uuid('leg_id').references(() => legs.id),
    keeperLegId: uuid('keeper_leg_id').references(() => keeperLegs.id),
    chainId: chainId(),
    n: integer('n').notNull(),
    messageHash: text('message_hash').notNull(),
    nonce: bigint('nonce', { mode: 'number' }),
    status: text('status').$type<AttemptStatus>().notNull(),
    txId: text('tx_id'),
    explorerUrl: text('explorer_url'),
    validUntil: text('valid_until'),
    /** Raw units of the fee taken, when there is one. Null in the MVP. */
    feeAmount: raw('fee_amount'),
    builtAt: ts('built_at').notNull().defaultNow(),
    ...provenanceCols,
  },
  (t) => [
    unique('leg_attempts_chain_tx_key').on(t.chainId, t.txId),
    unique('leg_attempts_leg_n_key').on(t.legId, t.n),
    unique('leg_attempts_keeper_leg_n_key').on(t.keeperLegId, t.n),
    // A reported transaction is matched to the attempt that built it by this hash.
    index('leg_attempts_message_hash_idx').on(t.messageHash),
    check('leg_attempts_one_leg', sql`num_nonnulls(${t.legId}, ${t.keeperLegId}) = 1`),
  ],
);

/** Every reference price shown or used: USD per whole token, with where it came from. */
export const priceObservations = pgTable(
  'price_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: text('asset_id')
      .notNull()
      .references(() => basketAssets.id),
    usdPerToken: numeric('usd_per_token', { precision: 38, scale: 18 }).notNull(),
    ...provenanceCols,
  },
  (t) => [index('price_observations_asset_time_idx').on(t.assetId, t.fetchedAt)],
);

/** A request that must not run twice: the key, what was asked, and what was answered. */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  route: text('route').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code'),
  response: jsonb('response'),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
});

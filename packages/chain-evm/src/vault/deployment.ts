import { BasketAsset, ChainError, type EvmAddress, normalizeAddress } from '@colosseum/schemas';
import { z } from 'zod';
import { type V4Pools, v4Pools } from './routes';
import { ask, type EvmRpc } from './rpc';
import { type TradeLimits, unlimitedOnMainnet } from './trade-limits';

// The record an EVM deploy writes (`deployments/<chain>-<network>.json`: `robinhood-testnet`,
// `robinhood-local`), the EVM twin of Solana's `deployments/solana-devnet.json`. It is committed and
// reviewed like code, so what a server runs on is what the deploy made: the factory, the registry and
// the beacon, the routers, and the network's tokens with their feeds. Token contracts are under
// `address`, never `token`: a secret scanner reads `"token": "0x…"` as a credential.

/** Any case in the file; lower-case once read, as every EVM address is here. */
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address')
  .transform((v) => normalizeAddress('evm', v) as EvmAddress);
const Raw = z.string().regex(/^\d+$/);
const Kind = z.enum(['stock', 'etf', 'gold', 'commodity', 'dollar_yield', 'crypto']);

/** The mainnets' chain ids: a node that answers one is mainnet, whatever it is called. */
export const MAINNET_CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  robinhood: 4663,
  base: 8453,
};

/** The one chain a mainnet record is admitted for: the others have no mainnet in this app. */
const MAINNET_CHAINS: readonly string[] = ['robinhood'];
/** The least a mainnet's timelock waits, in seconds: 48 hours, as the deploy script holds it. */
const MIN_MAINNET_DELAY = 172_800;

// Strict throughout: a field the record does not have is a record of another shape, refused.
const Token = z.strictObject({
  id: z.string().regex(/^(?:robinhood|base):[a-z0-9][a-z0-9-]*$/),
  symbol: z.string().min(1),
  name: z.string().min(1),
  address: Address,
  decimals: z.number().int().min(0).max(18),
});

export const EvmDeploymentRecord = z
  .strictObject({
    /**
     * The record's own name for its network, which is its file's: `robinhood-testnet`,
     * `robinhood-local`, and `robinhood-mainnet` for a mainnet, which is admitted only when the record
     * is complete (`incompleteMainnet` below).
     */
    network: z.string().regex(/^(?:robinhood|base)-(?:testnet|local|mainnet)$/),
    chain: z.enum(['robinhood', 'base']),
    /** `live` on a mainnet and nowhere else; `sandbox` on a test network or a local copy. */
    provenance: z.enum(['sandbox', 'live']),
    /**
     * The number the node answers `eth_chainId` with. A mainnet's only in a mainnet's record: a test
     * network has its own, and a local copy runs under its own number (31337), since a signature made
     * for a mainnet's number is good on that mainnet.
     */
    evmChainId: z.number().int().positive(),
    /** The block the factory was deployed in, where known: nothing of ours is older. */
    deployBlock: z.number().int().nonnegative().nullable(),
    contracts: z.strictObject({
      factory: Address,
      registry: Address,
      beacon: Address,
      vaultLogic: Address,
      factoryLogic: Address,
      registryLogic: Address,
    }),
    roles: z.strictObject({
      admin: Address,
      guardian: Address,
      keeper: Address,
      /** Who writes the test price feeds (TNET-1's `TestPriceFeed.setWriter`); null where the feeds are real. */
      priceWriter: Address.nullable(),
      /** Who mints, schedules multipliers on and pauses the test tokens; null where the tokens are real. */
      tokenIssuer: Address.nullable(),
    }),
    /** The chain's sequencer uptime feed as the factory names it (`sequencerFeed()`); null for none. */
    sequencerFeed: Address.nullable(),
    /**
     * How far a pool's quote for an owner's trade may be from the asset's Chainlink price, in basis
     * points, pool fee included, before the builder refuses the trade (trade-limits.ts). Null: not
     * checked on this network. The test network's is null: its pools are kept at its feeds by our own
     * market maker and its feeds are written by our own copier, so the check would add nothing but a
     * way for a stopped copier to stop deposits on a demo. A mainnet's is a number.
     */
    priceBoundBps: z.number().int().min(1).max(1_000).nullable(),
    /**
     * While an asset's feed is stale: how far a pool's quote may be from the feed's last answer,
     * however old, in basis points; and with it the asset's one-hour pool average (`average` below)
     * takes the feed's place as the witness. Null: a stale feed refuses the trade.
     */
    staleRailBps: z.number().int().min(1).max(5_000).nullable(),
    /**
     * How young a feed's answer is while the feed itself is the witness of an owner's trade, in
     * seconds: the chain's `sessionPriceAge` (3,600 on Robinhood Chain). Past it an asset whose
     * `average` is usable is held to the average instead. Null: a feed is the witness to its `maxAge`.
     */
    sessionPriceAge: z.number().int().min(60).max(86_400).nullable(),
    /**
     * The largest single trade of any asset, in dollars, while its witness is not the live feed: the
     * smaller of this and the asset's own `maxTradeUsd`. Null: none.
     */
    maxTradeUsdNotLive: z.number().int().positive().nullable(),
    /**
     * How old a feed's last answer may be and still anchor the rail, in seconds. Past it an asset is
     * not traded against its average. Null: no limit.
     */
    staleRailMaxAge: z
      .number()
      .int()
      .min(3_600)
      .max(30 * 86_400)
      .nullable(),
    /** `pull` 1 takes the input with `transferFrom`, 2 through Permit2. */
    routers: z.array(
      z.strictObject({ address: Address, pull: z.union([z.literal(1), z.literal(2)]) }),
    ),
    cash: Token,
    assets: z.array(
      Token.extend({
        /** The underlying a person reads: 'NVDA' for the NVDA token. */
        modelOf: z.string().min(1),
        kind: Kind,
        /** The asset's Chainlink-interface feed, 8 decimals or what `feedDecimals` says. */
        feed: Address,
        feedDecimals: z.number().int().min(0).max(18),
        /** The same source's one-hour average; the zero address where there is none. */
        averageFeed: Address,
        maxAge: z.number().int().positive(),
        session: z.union([z.literal(0), z.literal(1)]),
        maxWeightBps: z.number().int().min(0).max(5_000),
        keeperOn: z.boolean(),
        /** In the feed's units; null where the asset has no range (and so no keeper). */
        range: z.strictObject({ minPrice: Raw, maxPrice: Raw }).nullable(),
        /**
         * The asset's own Uniswap v4 pool against the cash token, hookless: its fee in hundredths of a
         * basis point and its tick spacing, within Uniswap's bounds. Every trade of the asset goes
         * through this pool and no other, and the guard's deployment file says the same pool.
         */
        pool: z.strictObject({
          fee: z.number().int().min(0).max(1_000_000),
          tickSpacing: z.number().int().min(1).max(32_767),
        }),
        /**
         * The largest single trade of the asset the builder makes, in dollars: the size its pool was
         * measured to fill near its price. Null: no limit (the test network, whose pools hold a
         * million dollars a side).
         */
        maxTradeUsd: z.number().int().positive().nullable(),
        /**
         * The pool the asset's one-hour average is read from while its feed is stale: a Uniswap v3
         * pool of the asset and the cash, the least liquidity in range it may hold (its own units),
         * and whether its history is long enough to use. `usable` is stated by whoever writes the
         * record, from the pool's observation cardinality: nothing guesses it when a trade is built.
         * Null: the asset has none, and is not traded on a stale feed.
         */
        average: z
          .strictObject({ pool: Address, minLiquidity: Raw, usable: z.boolean() })
          .nullable(),
      }),
    ),
    /** Listed once and taken off the list: vaults may still hold them. */
    retired: z.array(
      z.strictObject({
        id: z.string().nullable(),
        symbol: z.string().nullable(),
        address: Address,
      }),
    ),
    /**
     * The timelock that is the admin of a mainnet's factory and the owner of its beacon, and what the
     * deploy is expected to hold. Both are read and held to the chain by `pnpm ops:authority-check`
     * (scripts/ops/authority.ts), which owns their shape; here only the timelock's address is read,
     * to hold `roles.admin` to it. A mainnet's record has both; a test network's need not.
     */
    timelock: z.looseObject({ address: Address, minDelay: z.number().int().optional() }).optional(),
    expected: z
      .looseObject({
        launched: z.boolean().optional(),
        publishDelay: z.number().int().optional(),
        keeperEnabled: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((r, ctx) => {
    const wrong = incompleteMainnet(r);
    if (wrong) ctx.addIssue({ code: 'custom', message: wrong, path: ['network'] });
  })
  .refine((r) => r.network.startsWith(`${r.chain}-`), {
    message: "the network is the record's own chain",
    path: ['network'],
  })
  .refine((r) => [r.cash, ...r.assets].every((t) => t.id.startsWith(`${r.chain}:`)), {
    message: "every token's id is on the record's chain",
    path: ['assets'],
  })
  // Null is "not checked", and that is a test network's to say. A record of a mainnet, by its chain's
  // number or by its name, states the bound and every asset's largest trade.
  .superRefine((r, ctx) => {
    const missing = unlimitedOnMainnet(r);
    if (missing) ctx.addIssue({ code: 'custom', message: missing, path: ['priceBoundBps'] });
  })
  .refine((r) => r.assets.every((a) => !a.keeperOn || a.range !== null), {
    message: 'the keeper is on only for an asset with a range',
    path: ['assets'],
  });
export type EvmDeploymentRecord = z.infer<typeof EvmDeploymentRecord>;

/** Whether a record is a mainnet's, by what it says of itself: its name. */
export const isMainnetRecord = (record: { network: string }) => /-mainnet$/.test(record.network);

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * A mainnet's record says what it is in three places that go together, and is complete: `-mainnet` in
 * its name, `live`, and the chain's own mainnet number, all three or none; every contract the deploy
 * made, the block it was made in, an admin that is the timelock, a guardian, a router and the cash
 * token; the timelock and what the deploy is expected to hold, for the authority check; and nothing of
 * a test network (a price writer, a token issuer of ours). Returns what is wrong, or null. The trade
 * limits are held beside it (`unlimitedOnMainnet`).
 */
function incompleteMainnet(r: {
  network: string;
  chain: string;
  provenance: string;
  evmChainId: number;
  deployBlock: number | null;
  contracts: Record<string, string>;
  roles: {
    admin: string;
    guardian: string;
    priceWriter: string | null;
    tokenIssuer: string | null;
  };
  routers: readonly { address: string }[];
  cash: { address: string };
  assets: readonly { symbol: string; address: string; feed: string }[];
  timelock?: { address: string; minDelay?: number | undefined } | undefined;
  expected?:
    | {
        launched?: boolean | undefined;
        publishDelay?: number | undefined;
        keeperEnabled?: boolean | undefined;
      }
    | undefined;
}): string | null {
  const named = isMainnetRecord(r);
  const numbered = Object.values(MAINNET_CHAIN_IDS).includes(r.evmChainId);
  const live = r.provenance === 'live';
  if (!named && !numbered && !live) return null;
  if (!named)
    return numbered
      ? "a mainnet's chain id in a record that is not a mainnet's"
      : 'live is a mainnet record’s to say';
  if (!live) return 'a mainnet record is live, not sandbox';
  if (!MAINNET_CHAINS.includes(r.chain)) return `${r.chain} has no mainnet in this app`;
  if (r.evmChainId !== MAINNET_CHAIN_IDS[r.chain])
    return `a mainnet record of ${r.chain} carries its mainnet's chain id, ${MAINNET_CHAIN_IDS[r.chain]}`;
  if (r.deployBlock === null) return 'a mainnet record states the block it was deployed in';
  const empty = Object.entries(r.contracts).find(([, address]) => address === ZERO_ADDRESS);
  if (empty) return `a mainnet record states ${empty[0]}`;
  if (r.roles.guardian === ZERO_ADDRESS) return 'a mainnet record states its guardian';
  if (r.roles.priceWriter !== null || r.roles.tokenIssuer !== null)
    return 'a mainnet record has no price writer and no token issuer of ours: its feeds and tokens are real';
  if (!r.timelock || !r.expected)
    return 'a mainnet record carries its timelock and what the deploy is expected to hold';
  if (r.timelock.address === ZERO_ADDRESS || r.roles.admin !== r.timelock.address)
    return 'the admin of a mainnet record is its timelock';
  if (r.timelock.minDelay === undefined || r.timelock.minDelay < MIN_MAINNET_DELAY)
    return `a mainnet record's timelock waits at least ${MIN_MAINNET_DELAY} s`;
  if (
    r.expected.launched === undefined ||
    r.expected.publishDelay === undefined ||
    r.expected.keeperEnabled === undefined
  )
    return 'a mainnet record says what the deploy is expected to hold: launched, publishDelay, keeperEnabled';
  if (r.routers.length === 0 || r.routers.some((x) => x.address === ZERO_ADDRESS))
    return 'a mainnet record states its router';
  if (r.cash.address === ZERO_ADDRESS) return 'a mainnet record states its cash token';
  if (r.assets.length === 0) return 'a mainnet record lists the tokens it was deployed with';
  const blank = r.assets.find((a) => a.address === ZERO_ADDRESS || a.feed === ZERO_ADDRESS);
  if (blank) return `a mainnet record states the token and the feed of ${blank.symbol}`;
  return null;
}

/** What a chain config takes from the record: the factory and the registry, and the one router. */
export function deploymentAddresses(record: EvmDeploymentRecord) {
  return {
    factory: record.contracts.factory,
    registry: record.contracts.registry,
    beacon: record.contracts.beacon,
    router: record.routers[0]?.address ?? null,
  };
}

/** The pools the adapter trades in, from the record: each asset's own, against the record's cash. */
export function deploymentPools(record: EvmDeploymentRecord): V4Pools {
  return v4Pools(record.cash.address, record.assets);
}

/** What the adapter holds an owner's trade to, from the record: the bound to the feed and each asset's largest trade. */
export function deploymentLimits(record: EvmDeploymentRecord): TradeLimits {
  // Held here too, where the limits are handed to the adapter: a record that came by another way than
  // the schema above still cannot run a mainnet unchecked.
  const missing = unlimitedOnMainnet(record);
  if (missing) throw new ChainError('NotSupported', missing);
  return {
    priceBoundBps: record.priceBoundBps,
    maxTradeUsd: Object.fromEntries(record.assets.map((a) => [a.address, a.maxTradeUsd])),
    staleRailBps: record.staleRailBps,
    liveFeedSeconds: record.sessionPriceAge,
    maxTradeUsdNotLive: record.maxTradeUsdNotLive,
    staleRailMaxAgeSeconds: record.staleRailMaxAge,
    average: Object.fromEntries(
      record.assets.map((a) => [
        a.address,
        a.average
          ? {
              pool: a.average.pool,
              minLiquidity: BigInt(a.average.minLiquidity),
              usable: a.average.usable,
            }
          : null,
      ]),
    ),
  };
}

/**
 * The network's assets as the adapter lists them, from the record. What the record does not say is
 * set to the careful side: tier C and no risk sheet of its own. On a test network they say they are a
 * test network's (the issuer "test network", `sandbox`). On a mainnet they are `live` and say nothing
 * of a test network: the issuer is not in the record, so it is named as unknown rather than guessed.
 * The keeper's eligibility is the asset's switch. Cash is priced at a dollar by the vault and never by
 * a feed.
 */
export function deploymentAssets(record: EvmDeploymentRecord): BasketAsset[] {
  const live = isMainnetRecord(record);
  const common = {
    chain: record.chain,
    issuer: live ? 'issuer not recorded' : 'test network',
    tier: 'C' as const,
    blockedCountries: [],
    sheet: live ? 'unrated' : 'test-network',
    provenance: live ? ('live' as const) : ('sandbox' as const),
  };
  const cash = record.cash;
  return [
    BasketAsset.parse({
      ...common,
      id: cash.id,
      address: cash.address,
      symbol: cash.symbol,
      decimals: cash.decimals,
      cls: 'cash',
      underlying: 'USD',
      priceKind: 'none',
      priceRef: '',
      session: 'always',
      autoFollowEligible: true,
      maxWeightBps: 0,
    }),
    ...record.assets.map((a) =>
      BasketAsset.parse({
        ...common,
        id: a.id,
        address: a.address,
        symbol: a.symbol,
        decimals: a.decimals,
        cls: a.kind,
        underlying: a.modelOf,
        priceKind: 'chainlink',
        priceRef: a.feed,
        session: a.session === 1 ? 'us_equity' : 'always',
        autoFollowEligible: a.keeperOn,
        maxWeightBps: a.maxWeightBps,
      }),
    ),
  ];
}

/** How long a server waits at start for the node to say which network it is. */
export const NODE_CHECK_TIMEOUT_MS = 10_000;

/**
 * The node is the network the record is for: a mainnet only for a mainnet's own record, the record's
 * own chain id, and the record's factory deployed there. Asked once, at start, of the node the server will read through. A
 * node that does not answer in `timeoutMs` fails the start rather than hang it. A local copy of mainnet
 * keeps mainnet's chain id unless it is started with another (`anvil --chain-id 31337`), and is
 * refused as mainnet until it is: a signature for mainnet's id is good on mainnet.
 */
export async function assertNode(
  rpc: EvmRpc,
  record: EvmDeploymentRecord,
  timeoutMs = NODE_CHECK_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ChainError('Unavailable', `the EVM RPC did not say its chain id in ${timeoutMs} ms`),
        ),
      timeoutMs,
    );
  });
  const [chainId, code] = await Promise.race([
    Promise.all([
      ask('eth_chainId', () => rpc.getChainId()),
      ask('eth_getCode', () => rpc.getCode({ address: record.contracts.factory as `0x${string}` })),
    ]),
    late,
  ]).finally(() => clearTimeout(timer));
  // Not left to the schema: a record that came another way is held here too.
  const mainnetRecord =
    isMainnetRecord(record) &&
    record.provenance === 'live' &&
    record.evmChainId === MAINNET_CHAIN_IDS[record.chain];
  if (Object.values(MAINNET_CHAIN_IDS).includes(chainId) && !mainnetRecord)
    throw new ChainError(
      'NotSupported',
      `the EVM RPC answers chain id ${chainId}, a mainnet's, and the record ${record.network} is not a mainnet's`,
    );
  if (chainId !== record.evmChainId)
    throw new ChainError(
      'NotSupported',
      `the EVM RPC answers chain id ${chainId}, and the record ${record.network} is for ${record.evmChainId}`,
    );
  if (!code || code === '0x')
    throw new ChainError(
      'NotSupported',
      `the record ${record.network} names a factory the node has no code at`,
    );
}

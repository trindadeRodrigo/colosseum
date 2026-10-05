import { BasketAsset, ChainError, type EvmAddress, normalizeAddress } from '@colosseum/schemas';
import { z } from 'zod';
import { ask, type EvmRpc } from './rpc';

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
export const MAINNET_CHAIN_IDS: Readonly<Record<string, number>> = { robinhood: 4663, base: 8453 };

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
    /** The record's own name for its network, which is its file's: `robinhood-testnet`, `robinhood-local`. */
    network: z.string().regex(/^(?:robinhood|base)-(?:testnet|local)$/),
    chain: z.enum(['robinhood', 'base']),
    provenance: z.literal('sandbox'),
    /**
     * The number the node answers `eth_chainId` with. Never a mainnet's: this record is for a test
     * network or a local copy, and a local copy runs under its own number (31337), since a signature
     * made for a mainnet's number is good on that mainnet.
     */
    evmChainId: z
      .number()
      .int()
      .positive()
      .refine((id) => !Object.values(MAINNET_CHAIN_IDS).includes(id), "a mainnet's chain id"),
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
  })
  .refine((r) => r.network.startsWith(`${r.chain}-`), {
    message: "the network is the record's own chain",
    path: ['network'],
  })
  .refine((r) => [r.cash, ...r.assets].every((t) => t.id.startsWith(`${r.chain}:`)), {
    message: "every token's id is on the record's chain",
    path: ['assets'],
  })
  .refine((r) => r.assets.every((a) => !a.keeperOn || a.range !== null), {
    message: 'the keeper is on only for an asset with a range',
    path: ['assets'],
  });
export type EvmDeploymentRecord = z.infer<typeof EvmDeploymentRecord>;

/** What a chain config takes from the record: the factory and the registry, and the one router. */
export function deploymentAddresses(record: EvmDeploymentRecord) {
  return {
    factory: record.contracts.factory,
    registry: record.contracts.registry,
    beacon: record.contracts.beacon,
    router: record.routers[0]?.address ?? null,
  };
}

/**
 * The network's assets as the adapter lists them, from the record. What the record does not say is
 * set to the careful side and says it is a test network's: tier C, the issuer "test network", no risk
 * sheet of its own. The keeper's eligibility is the asset's switch. Cash is priced at a dollar by the
 * vault and never by a feed.
 */
export function deploymentAssets(record: EvmDeploymentRecord): BasketAsset[] {
  const common = {
    chain: record.chain,
    issuer: 'test network',
    tier: 'C' as const,
    blockedCountries: [],
    sheet: 'test-network',
    provenance: 'sandbox' as const,
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
 * The node is the network the record is for: never a mainnet, the record's own chain id, and the
 * record's factory deployed there. Asked once, at start, of the node the server will read through. A
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
  if (Object.values(MAINNET_CHAIN_IDS).includes(chainId))
    throw new ChainError(
      'NotSupported',
      `the EVM RPC answers chain id ${chainId}, a mainnet's, and this server runs a test network only`,
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

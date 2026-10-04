import { BasketAsset, SolanaAddress } from '@colosseum/schemas';
import { z } from 'zod';

// The record a Solana deploy writes (`deployments/solana-<network>.json`, made by the TNET-4 set-up:
// `Deployment` in programs/tests/src/testnet/setup.ts). It is committed and reviewed like code, so what
// a server runs on is what the deploy made: the vault program, the router and the price account, and
// the network's tokens. Only the fields read here are checked; the rest of the record is the deploy's.

// Strict throughout: a field the record does not have is a record of another shape, refused.
const Token = z.strictObject({
  id: z.string().regex(/^solana:[a-z0-9][a-z0-9-]*$/),
  symbol: z.string().min(1),
  name: z.string().min(1),
  modelOf: z.string().min(1),
  kind: z.enum(['stock', 'gold', 'dollar_yield', 'cash']),
  mint: SolanaAddress,
  tokenProgram: z.enum(['token', 'token-2022']),
  decimals: z.number().int().min(0).max(18),
  reserve: SolanaAddress,
});
const Raw = z.string().regex(/^\d+$/);

export const SolanaDeploymentRecord = z.strictObject({
  /** The record's own name for its network, which is its file's: `solana-devnet`, `solana-local`. */
  network: z.string().min(1),
  chain: z.literal('solana'),
  provenance: z.literal('sandbox'),
  genesisHash: z.string().nullable(),
  programs: z.strictObject({ basket: SolanaAddress, mockRouter: SolanaAddress }),
  accounts: z.strictObject({
    config: SolanaAddress,
    assets: SolanaAddress,
    priceAccount: SolanaAddress,
    router: SolanaAddress,
    lookupTable: SolanaAddress.nullable(),
  }),
  roles: z.strictObject({
    admin: SolanaAddress,
    guardian: SolanaAddress,
    defaultKeeper: SolanaAddress,
    priceOwner: SolanaAddress,
    exchangeAdmin: SolanaAddress,
    priceWriter: SolanaAddress.nullable(),
    tokenAuthority: SolanaAddress,
  }),
  params: z.strictObject({
    toleranceBps: z.number().int(),
    lossCapBps: z.number().int(),
    bandBps: z.number().int(),
    twapDevBps: z.number().int(),
    maxPriceAgeS: z.number().int(),
    assetCooldownS: z.number().int(),
    publishDelayS: z.number().int(),
    sessionOpenUtcS: z.number().int(),
    sessionCloseUtcS: z.number().int(),
  }),
  closedDays: z.array(z.string()),
  cash: Token,
  assets: z.array(
    Token.extend({
      session: z.union([z.literal(0), z.literal(1)]),
      priceIndex: z.number().int().min(0).max(511),
      twapIndex: z.number().int().min(0).max(511),
      indexSource: z.enum(['scope-indexes', 'test-network']),
      maxWeightBps: z.number().int().min(0).max(10_000),
      keeperOn: z.boolean(),
      range: z.strictObject({ minPrice: Raw, maxPrice: Raw }).nullable(),
      spreadBps: z.number().int().min(0).max(10_000),
      pairs: z.strictObject({ buy: SolanaAddress, sell: SolanaAddress }),
    }),
  ),
  /** Listed on chain and dropped from the config: vaults may still hold them. */
  retired: z.array(
    z.strictObject({
      id: z.string().nullable(),
      symbol: z.string().nullable(),
      mint: SolanaAddress,
      tokenProgram: z.enum(['token', 'token-2022']),
      keeperOn: z.literal(false),
    }),
  ),
});
export type SolanaDeploymentRecord = z.infer<typeof SolanaDeploymentRecord>;

/** Every mint the record names, cash, the listed assets and the retired ones, by address. */
export function deploymentMints(record: SolanaDeploymentRecord) {
  const mints = new Map<string, { id: string | null; decimals: number | null }>();
  mints.set(record.cash.mint, { id: record.cash.id, decimals: record.cash.decimals });
  for (const a of record.assets) mints.set(a.mint, { id: a.id, decimals: a.decimals });
  for (const r of record.retired) mints.set(r.mint, { id: r.id, decimals: null });
  return mints;
}

/** What a chain config takes from the record: the program, the one router, the price account. */
export function deploymentAddresses(record: SolanaDeploymentRecord) {
  return {
    program: record.programs.basket,
    router: record.programs.mockRouter,
    priceAccount: record.accounts.priceAccount,
  };
}

/**
 * The network's assets as the adapter lists them, from the record. What the record does not say is
 * set to the careful side and says it is a test network's: tier C, the issuer "test network", no
 * risk sheet of its own. The keeper's eligibility is the asset's switch.
 */
export function deploymentAssets(record: SolanaDeploymentRecord): BasketAsset[] {
  const common = {
    chain: 'solana' as const,
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
      address: cash.mint,
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
        address: a.mint,
        symbol: a.symbol,
        decimals: a.decimals,
        cls: a.kind === 'cash' ? 'cash' : a.kind,
        underlying: a.modelOf.replace(/x$/, ''),
        priceKind: 'scope',
        priceRef: String(a.priceIndex),
        session: a.session === 1 ? 'us_equity' : 'always',
        autoFollowEligible: a.keeperOn,
        maxWeightBps: a.maxWeightBps,
      }),
    ),
  ];
}

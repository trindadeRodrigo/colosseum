import { BasketAsset, SolanaAddress } from '@colosseum/schemas';
import { z } from 'zod';

// The record a Solana deploy writes (`deployments/solana-<network>.json`, made by the TNET-4 set-up:
// `Deployment` in programs/tests/src/testnet/setup.ts). It is committed and reviewed like code, so what
// a server runs on is what the deploy made: the vault program, the router and the price account, and
// the network's tokens. Only the fields read here are checked; the rest of the record is the deploy's.

const Token = z.object({
  id: z.string().regex(/^solana:[a-z0-9][a-z0-9-]*$/),
  symbol: z.string().min(1),
  modelOf: z.string().min(1),
  kind: z.enum(['stock', 'gold', 'dollar_yield', 'cash']),
  mint: SolanaAddress,
  tokenProgram: z.enum(['token', 'token-2022']),
  decimals: z.number().int().min(0).max(18),
});

export const SolanaDeploymentRecord = z.object({
  network: z.string().min(1),
  chain: z.literal('solana'),
  provenance: z.literal('sandbox'),
  programs: z.object({ basket: SolanaAddress, mockRouter: SolanaAddress }),
  accounts: z.object({ priceAccount: SolanaAddress }),
  cash: Token,
  assets: z.array(
    Token.extend({
      session: z.union([z.literal(0), z.literal(1)]),
      priceIndex: z.number().int().min(0).max(511),
      maxWeightBps: z.number().int().min(0).max(10_000),
      keeperOn: z.boolean(),
    }),
  ),
});
export type SolanaDeploymentRecord = z.infer<typeof SolanaDeploymentRecord>;

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

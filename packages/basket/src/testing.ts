import type {
  BasketAsset,
  ChainId,
  FamilyMeta,
  Price,
  Recipe,
  Shelf,
  VaultState,
} from '@colosseum/schemas';

// Builders for the tests of this package. Not exported from the package.

const SOLANA_ADDRESS = '11111111111111111111111111111111';
const EVM_ADDRESS = `0x${'0'.repeat(40)}`;

export function asset(id: string, over: Partial<BasketAsset> = {}): BasketAsset {
  const [chain = 'solana', slug = 'x'] = id.split(':');
  return {
    id,
    chain: chain as ChainId,
    address: chain === 'solana' ? SOLANA_ADDRESS : EVM_ADDRESS,
    symbol: slug.toUpperCase(),
    decimals: 8,
    cls: 'stock',
    underlying: slug.toUpperCase(),
    issuer: 'issuer-a',
    tier: 'A',
    priceKind: 'scope',
    priceRef: '',
    session: 'us_equity',
    autoFollowEligible: true,
    maxWeightBps: 5000,
    blockedCountries: [],
    sheet: 'test',
    provenance: 'fixture',
    ...over,
  };
}

/** A recipe from 'solana:spy' or 'index:slug' to weight. */
export function recipe(
  chain: ChainId,
  weights: Record<string, number>,
  over: Partial<Recipe> = {},
): Recipe {
  return {
    schemaVersion: 1,
    familyId: 'ab'.repeat(32),
    chain,
    onchainId: null,
    creator: chain === 'solana' ? SOLANA_ADDRESS : EVM_ADDRESS,
    kind: 'personal',
    version: 1,
    effectiveAt: 0,
    components: Object.entries(weights).map(([key, weightBps]) =>
      key.startsWith('index:')
        ? { kind: 'index' as const, family: key.slice(6), weightBps }
        : { kind: 'asset' as const, asset: key, weightBps },
    ),
    metaHash: '00'.repeat(32),
    maxFeeBps: 0,
    flags: 0,
    ...over,
  };
}

export function family(slug: string, recipes: Recipe[], over: Partial<FamilyMeta> = {}) {
  const meta: FamilyMeta = {
    familyId: 'cd'.repeat(32),
    slug,
    name: slug,
    copy: '',
    kind: 'index',
    chains: [...new Set(recipes.map((r) => r.chain))],
    ...over,
  };
  return { meta, recipes: recipes.map((r) => ({ ...r, kind: 'community' as const })) };
}

export function shelf(assets: BasketAsset[], families: Shelf['families'] = []): Shelf {
  return { version: 'test', assets, families };
}

const AT = '2026-10-05T15:00:00.000Z';

export function price(id: string, usdPerToken: string): Price {
  return {
    source: 'test',
    method: 'fixed',
    fetchedAt: AT,
    provenance: 'fixture',
    asset: id,
    usdPerToken,
    ageSeconds: 0,
    market: 'open',
  };
}

/** A vault on Solana from raw balances. `positions` is asset to [raw, targetBps]. */
export function vault(cashRaw: string, positions: Record<string, [string, number]>): VaultState {
  const holding = (id: string, raw: string) => ({ asset: id, raw, multiplier: '1', display: '0' });
  return {
    chain: 'solana',
    address: SOLANA_ADDRESS,
    owner: SOLANA_ADDRESS,
    basketId: '1',
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    keeper: SOLANA_ADDRESS,
    cash: holding('solana:usdc', cashRaw),
    positions: Object.entries(positions).map(([id, [raw, targetBps]]) => ({
      ...holding(id, raw),
      targetBps,
      lastKeeperAt: null,
    })),
    lossUsedBps: 0,
    observedAt: AT,
    pending: null,
  };
}

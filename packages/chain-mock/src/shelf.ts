import { type BasketAsset, type ChainId, chainFamily } from '@colosseum/schemas';
import { mockAddress } from './ids';

// The mock's own asset list: one cash token and five assets per chain, with the decimals each chain's
// real tokens use (stock tokens: 8 on Solana and Base, 18 on Robinhood Chain). Addresses belong to
// nobody and every row is stamped `provenance: 'mock'`.

type Row = {
  slug: string;
  symbol: Record<ChainId, string>;
  cls: BasketAsset['cls'];
  /** One for every chain, or each chain's own: gold is PAXG on Solana and GLD on Robinhood Chain. */
  underlying: string | Record<ChainId, string>;
  session: BasketAsset['session'];
  /** Round numbers, so nobody reads one as a market price. */
  usdPerToken: string;
};

const ROWS: Row[] = [
  {
    slug: 'spy',
    symbol: { solana: 'SPYx', robinhood: 'SPY', base: 'SPYc' },
    cls: 'etf',
    underlying: 'SPY',
    session: 'us_equity',
    usdPerToken: '100',
  },
  {
    slug: 'nvda',
    symbol: { solana: 'NVDAx', robinhood: 'NVDA', base: 'NVDAc' },
    cls: 'stock',
    underlying: 'NVDA',
    session: 'us_equity',
    usdPerToken: '50',
  },
  {
    slug: 'tsla',
    symbol: { solana: 'TSLAx', robinhood: 'TSLA', base: 'TSLAc' },
    cls: 'stock',
    underlying: 'TSLA',
    session: 'us_equity',
    usdPerToken: '20',
  },
  {
    slug: 'gold',
    symbol: { solana: 'mGOLD', robinhood: 'mGOLD', base: 'mGOLD' },
    cls: 'gold',
    underlying: { solana: 'PAXG', robinhood: 'GLD', base: 'XAU' },
    session: 'always',
    usdPerToken: '200',
  },
  {
    slug: 'yield',
    symbol: { solana: 'mYIELD', robinhood: 'mYIELD', base: 'mYIELD' },
    cls: 'dollar_yield',
    underlying: 'USD',
    session: 'always',
    usdPerToken: '1',
  },
];

const STOCK_DECIMALS: Record<ChainId, number> = { solana: 8, robinhood: 18, base: 8 };

export function mockCashId(chain: ChainId): string {
  return `${chain}:usdc`;
}

export function mockAssets(chain: ChainId): BasketAsset[] {
  const priceKind = chainFamily(chain) === 'solana' ? 'scope' : 'chainlink';
  const common: Pick<
    BasketAsset,
    'chain' | 'issuer' | 'tier' | 'autoFollowEligible' | 'blockedCountries' | 'sheet' | 'provenance'
  > = {
    chain,
    issuer: 'mock',
    tier: 'A',
    autoFollowEligible: true,
    blockedCountries: [],
    sheet: 'mock',
    provenance: 'mock',
  };
  const cash: BasketAsset = {
    ...common,
    id: mockCashId(chain),
    address: mockAddress(chain, 'asset:usdc'),
    symbol: 'USDC',
    decimals: 6,
    cls: 'cash',
    underlying: 'USD',
    priceKind: 'none',
    priceRef: '',
    session: 'always',
    maxWeightBps: 0,
  };
  return [
    cash,
    ...ROWS.map(
      (r): BasketAsset => ({
        ...common,
        id: `${chain}:${r.slug}`,
        address: mockAddress(chain, `asset:${r.slug}`),
        symbol: r.symbol[chain],
        decimals: r.cls === 'dollar_yield' ? 6 : STOCK_DECIMALS[chain],
        cls: r.cls,
        underlying: typeof r.underlying === 'string' ? r.underlying : r.underlying[chain],
        priceKind,
        priceRef: `mock:${r.slug}`,
        session: r.session,
        maxWeightBps: 5000,
      }),
    ),
  ];
}

/** USD per whole token for every asset of `mockAssets(chain)`. Cash counts as one dollar. */
export function mockPrices(chain: ChainId): Record<string, string> {
  return Object.fromEntries([
    [mockCashId(chain), '1'],
    ...ROWS.map((r) => [`${chain}:${r.slug}`, r.usdPerToken]),
  ]);
}

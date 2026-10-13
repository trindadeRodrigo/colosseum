import type { Fact } from './fact';

// The shapes of the risk API's answers, as far as the Bearing pages read them (apps/api/src/routes/
// risk*.ts are the source). Fields the pages do not read are left out.

export type CapCell = {
  status: 'ok' | 'insufficient_samples' | string;
  capacityUsd: number | null;
  lowerBound: boolean;
  samples: number;
  from: string | null;
  to: string | null;
};
export type AssetRow = {
  /** Robinhood Chain's rows: `robinhood:<sym>`. */
  id?: string;
  assetMint: string;
  symbol: string;
  /** The chain the row is read for; an API from before chains leaves it out (Solana). */
  chain?: 'solana' | 'robinhood';
  /** Null on Robinhood Chain, whose pools are not in the registry; `poolsNullReason` says so. */
  poolTvlUsd: number | null;
  pools: number | null;
  poolsNullReason?: string;
  capacityAtTau: Partial<Record<string, CapCell>>;
  provenance?: string;
};
export type AssetsBody = {
  methodVersion: string;
  tau: number;
  chain?: 'solana' | 'robinhood';
  honesty: string[];
  assets: AssetRow[];
};

/** A figure of `GET /risk/chains`: sourced, or null with the reason it is not collected. */
export type ChainFigure = {
  value: number | null;
  nullReason?: string;
  source?: string;
  method?: string;
  methodVersion?: string;
  fetchedAt?: string | null;
  provenance?: string;
  regime?: string;
  measuredAssets?: number;
  assets?: number;
  pools?: number;
};
export type ChainsBody = {
  tau: number;
  regime: string;
  at: string;
  chains: Array<{
    chain: 'solana' | 'robinhood';
    assetsTracked: ChainFigure;
    poolTvlUsd: ChainFigure;
    exitCapacityUsd: ChainFigure;
    volume24hUsd: ChainFigure;
  }>;
};

export type Pool = {
  address: string;
  venue: string;
  assetSymbol: string;
  quoteSymbol: string | null;
  /**
   * How a seller reaches dollars through the pool: `direct_usd`, `via_sol`, `via_xstock`, or `other`,
   * a quote token with no measured way to dollars: no recording of such a pool has a dollar value.
   */
  exitPath: string;
  tvlUsd: number | null;
  /** DexScreener's 24 h volume of the pair, as reported when the pool was registered. */
  discoveryVolume24hUsd?: number | null;
  fetchedAt: string;
};
export type PoolsBody = { pools: Pool[]; nullReason?: string };
export type RecordedBody = { pools: Array<{ address: string }> };

export type Exit = {
  total: Fact;
  lossUsd: Fact;
  poolFee?: Fact;
  transferFee?: Fact;
  impact?: Fact;
  basis?: Fact;
  platformFee?: Fact;
  networkFeeUsd?: Fact;
};
export type SheetBody = {
  costs: Array<{ regime: string; exit: Exit }>;
  flow: { byWindow?: Array<{ window: string; volumeUsd: Fact; to?: string }> };
  liquidityStability: {
    lpTop3Share?: Fact;
    depthRecovery?: Array<{ regime: string; hoursTo90?: Fact }>;
  };
};

export type HistPoint = {
  t: string;
  sellCapacityUsd: number | null;
  sellLowerBound?: boolean;
  buyCapacityUsd: number | null;
};
export type Series<P> = {
  points: P[];
  from?: string;
  to?: string;
  source: string;
  method: string;
  methodVersion: string;
  provenance?: string;
};
export type HistBody = Series<HistPoint>;

export type LendMeta = { account: string; venue: string; market: string; symbol: string };
export type LendListBody = { pools: LendMeta[] };
export type LendBody = {
  collateral: Array<{ asset: string; collateralUsd?: Fact }>;
  withdrawal: { availableUsd: Fact; shareLentOut: Fact };
  lenders: { top1Share: Fact };
};
export type LendPoint = {
  t: string;
  suppliedUsd: number | null;
  borrowedUsd: number | null;
  availableUsd: number | null;
  availableNullReason?: string | null;
  usdNullReason?: string | null;
};
export type LendHistBody = Series<LendPoint>;

export type LiqHistBody = Series<{
  t: string;
  valueUsd: number | null;
  assetUsd: number | null;
  /** Why a recording has no dollar value (`no_quote_price`: its quote token has no measured price). */
  usdNullReason?: string | null;
}> & {
  /** What the API says its recordings are: `live`, or `mock` or `sandbox`, never shown as live. */
  provenance?: string;
};

export type LiquidityBody = {
  pool: string;
  bands: Array<{
    priceLow: number;
    priceHigh: number;
    amountUsd: number | null;
    side: 'asset' | 'quote';
  }>;
  midPrice: number;
  asset?: string;
  quote?: string;
  /**
   * Both null when the quote token has no price in dollars: the band amounts are then not in dollars.
   * `usdNullReason` says so where the API names its reason.
   */
  totalAssetUsd?: number | null;
  totalQuoteUsd?: number | null;
  usdNullReason?: string | null;
  basis?: string;
  fetchedAt: string;
  source: string;
  method: string;
  methodVersion: string;
  provenance?: string;
  reason?: string;
};

export type SplitBody = {
  legs: Array<{
    pool: string;
    venue: string;
    quote: string | null;
    feeRate: number | null;
    share: number;
    exitPath?: string;
    costPct: number | null;
  }>;
  notionalUsd: number;
  refMidUsd: number | null;
  fetchedAt: string;
  regime: string;
  reason?: string;
  source: string;
  method: string;
  methodVersion: string;
};

export type RecovBody = {
  at: string;
  methodVersion: string;
  primary: {
    issuer?: string;
    status?: string;
    settlementHours?: number | null;
    openHoursInHorizon?: number;
    capacityUsd: number | null;
    source: string;
  } | null;
};

export type HeatmapBody = {
  asset: string;
  notionalUsd?: number;
  cells: Array<{ hourOfWeekEt: number; medianCost: number; samples: number }>;
  timezone?: string;
  hourOfWeek?: string;
};

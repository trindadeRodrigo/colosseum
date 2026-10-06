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
  assetMint: string;
  symbol: string;
  poolTvlUsd: number;
  pools: number;
  capacityAtTau: Partial<Record<string, CapCell>>;
};
export type AssetsBody = {
  methodVersion: string;
  tau: number;
  honesty: string[];
  assets: AssetRow[];
};

export type Pool = {
  address: string;
  venue: string;
  assetSymbol: string;
  quoteSymbol: string | null;
  tvlUsd: number | null;
  fetchedAt: string;
};
export type PoolsBody = { pools: Pool[] };
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

export type LiqHistBody = Series<{ t: string; valueUsd: number | null; assetUsd: number | null }>;

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
  totalAssetUsd?: number;
  totalQuoteUsd?: number;
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

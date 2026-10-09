import {
  type BasketCard,
  type BasketSheet,
  DISCLAIMER,
  type PlanNewest,
  type PortfolioExposureResponse,
  type PortfolioHistoryResponse,
  type PortfolioPlansResponse,
  type PortfolioRebalancesResponse,
  type Price,
  TRACK_RULE,
  type TrackLine,
  type TrackStatus,
} from '@colosseum/schemas';

// What the four routes of the portfolio section answer (PORT-2), made up for the tests of its pages
// and for the e2e stub (tests/e2e/stub-api.ts): one person with five vaults on Solana, on a test
// network, and two on Robinhood Chain, on the mock, with Base switched off. Every figure is sample:
// nothing here was read from a chain, and nothing the product ships may import this file
// (components/shell/product-routes.test.ts, rule 1). The figures live here, in a folder named
// `fixtures`, because no rate or price is typed anywhere else (tests/no-yield-literals.test.ts).
//
// The vaults, and what each is here for:
//   SOL_GROW      a plan made to measure (grow), read four minutes ago: On track (`inside`)
//   SOL_INCOME    an income plan with a name of its own and two deposits: Watch (`outside_band`)
//   SOL_UNPRICED  a plan to protect, one held part with no price: Watch (`unpriced`)
//   SOL_STALE     opened to follow a shared portfolio and following it (`openedFor`, `follows`), last
//                 read three hours ago: stale, Watch (`stale`)
//   SOL_NEVER     a vault the worker never read, with a name and no plan: no status (`never_read`)
//   RH_SILENT     opened to follow a shared portfolio, on the mock, where a snapshot names none
//                 (`follows: null`), its chain not read for 26 hours: Off track (`chain_silent`)
//   RH_EMPTY      a vault that holds nothing: no status (`empty`)
//
// The figures agree with each other: a vault's value is its cash and its positions, the exposure's
// sums are the vaults' holdings, and every list of shares adds up to 10,000 (fixtures.test.ts).

/** The moment the answers were made: every age in them counts back from it. */
export const NOW = '2026-10-07T12:00:00.000Z';

/** The tests' person (features/wallet/test/fake-port.ts): one wallet a family. */
export const OWNER_SOLANA = 'So11111111111111111111111111111111111111112';
export const OWNER_EVM = '0x204faca1764b154221e35c0d20abb3c525710498';

export const SOL_GROW = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
export const SOL_INCOME = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const SOL_UNPRICED = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOL_STALE = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const SOL_NEVER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const RH_SILENT = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
export const RH_EMPTY = '0x8a791620dd6260079bf849dc5567adc3f2fdc318';

/** The shared portfolios two of the vaults were opened to follow, as the server's own rows name them. */
export const FAMILY_DOLLARS = {
  familyId: '3f6c1e0a9b2d4c7e8f1a0b3c5d7e9f2a4b6c8d0e1f3a5b7c9d2e4f6a8b0c1d3e',
  slug: 'steady-dollars',
  name: 'Steady dollars',
};
export const FAMILY_STOCKS = {
  familyId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  slug: 'us-stocks',
  name: 'US stocks',
};

export const ORDER_GROW = '6b1f0c52-3a4d-4e7b-9c1a-2d5e8f7a0b13';
export const ORDER_INCOME_1 = '0d9e8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
export const ORDER_INCOME_2 = '7c2a4e68-91b3-4d5f-a7c9-e1b3d5f7a9c1';
export const ORDER_UNPRICED = '2e4a6c8e-0b1d-4f3a-9c5e-7a9b1c3d5e7f';
export const ORDER_STALE = '9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f';
export const ORDER_SILENT = '4a3b2c1d-0e9f-4a8b-b7c6-d5e4f3a2b1c0';

// ---------------------------------------------------------------------------------------------------
// The stamps, as the API and the snapshot worker write them
// ---------------------------------------------------------------------------------------------------

const SOLANA_READER = 'Solana devnet, read over RPC by the vault reader';
const SOLANA_ADAPTER = 'Solana devnet, read over RPC by the vault adapter';
const MOCK_CHAIN = 'chain-mock';
const SNAPSHOT_METHOD =
  "the vault's state as the chain's reader gave it; value, weights and drift by view() of packages/basket on the prices kept in this row, cash counted as one dollar; the dollar value cut to cents";
const PUT_IN_METHOD =
  'the cash of each order whose deposit confirmed, counted once an order and added up, at one dollar a cash token; gross: a withdrawal is not taken off, and money that reached the vault any other way is not in it';
const KEEPER_METHOD =
  "worked out from two snapshots of the vault between which the vault's last keeper time on the asset changed: the amounts are what the vault held of the asset in each snapshot, the time is the chain's time of the keeper's last trade on the asset, and every trade of the asset between the two snapshots is in this one entry. It is not read from a record of the trade: the keeper's own log is not in the database, so there is no transaction id, no quote and no reason";
const QUOTE_METHOD =
  'the route the step was last built with, quoted against the reference price of the asset';
const EXPOSURE_METHOD =
  'sums over the newest snapshot of each vault: each position at the value its snapshot gave it, and the cash at one dollar each; a holding with no price, or one the asset list does not name, is in no sum; a share is its dollars in basis points of the total, by largest remainders';
const NO_SNAPSHOT_SOURCE =
  'vault_snapshots: no snapshot of a vault of yours was found for this answer';
const BEARING = 'Bearing, from the pools its collectors read each hour';
const BEARING_METHOD = 'risk-0.3';

const putInSource = (chain: string) =>
  `the person's confirmed deposits in this app's order record on ${chain}`;

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A price on Solana's test network, as a snapshot keeps it. */
const solanaPrice = (
  asset: string,
  usdPerToken: string,
  fetchedAt: string,
  open = true,
): Price => ({
  asset,
  usdPerToken,
  source: 'Scope',
  method: 'the feed’s price, read on chain by the vault reader',
  fetchedAt,
  provenance: 'sandbox',
  ageSeconds: 30,
  maxAgeSeconds: 120,
  market: open ? 'open' : 'closed',
});

/** What a snapshot on Solana's test network says of itself. */
const onSolana = { source: SOLANA_READER, method: SNAPSHOT_METHOD, provenance: 'sandbox' } as const;
const onMock = { source: MOCK_CHAIN, method: SNAPSHOT_METHOD, provenance: 'mock' } as const;

const UNAVAILABLE: PortfolioPlansResponse['unavailable'] = [
  {
    chain: 'base',
    name: 'Base',
    code: 'CHAIN_UNAVAILABLE',
    error: 'Base is switched off on this server',
    retryable: false,
  },
];

// ---------------------------------------------------------------------------------------------------
// The plans the vaults were opened for
// ---------------------------------------------------------------------------------------------------

const sheet = (
  over: Partial<BasketSheet> & Pick<BasketSheet, 'goal' | 'amountUsd'>,
): BasketSheet => ({
  basketType: 'standard',
  horizonMonths: 36,
  risk: 'medium',
  themes: [],
  country: 'BR',
  chains: ['solana'],
  rules: { useHoldings: false, glide: true },
  language: 'en',
  ...over,
});

const card = (over: Partial<BasketCard> & Pick<BasketCard, 'moneyTodayUsd'>): BasketCard => ({
  termMonths: 36,
  cashFlow: 'none',
  expectedReturn: {
    lowPct: 2.1,
    highPct: 6.8,
    basis: 'sample: the test network’s rates, after the haircut',
    lossInFallUsd: 240,
  },
  exit: { text: 'access to cash within a day', costBps: null },
  ...over,
});

const observations = (fetchedAt: string) => [
  {
    id: 'obs-usdy-yield',
    kind: 'yield' as const,
    source: 'Ondo',
    method: 'the issuer’s rate, after the haircut',
    fetchedAt,
    provenance: 'sandbox' as const,
  },
];

export const SHEET_GROW = sheet({ goal: 'grow', amountUsd: 2000 });
export const SHEET_INCOME = sheet({
  goal: 'income',
  amountUsd: 50_000,
  horizonMonths: 60,
  risk: 'low',
  incomeTargetUsdMonthly: 300,
});
export const SHEET_PROTECT = sheet({
  goal: 'protect',
  amountUsd: 500,
  horizonMonths: 18,
  risk: 'low',
});

// ---------------------------------------------------------------------------------------------------
// The newest snapshot of each vault
// ---------------------------------------------------------------------------------------------------

const NEWEST_GROW: PlanNewest = {
  observedAt: '2026-10-07T11:56:00.000Z',
  ageSeconds: 240,
  stale: false,
  blockOrSlot: '412345678',
  valueUsd: '2051.37',
  cash: { asset: 'solana:usdc', raw: '99870000', multiplier: '1', display: '99.87' },
  positions: [
    {
      asset: 'solana:spyx',
      raw: '160000000',
      multiplier: '1',
      display: '1.6',
      targetBps: 5000,
      lastKeeperAt: null,
      valueUsd: '1025',
      weightBps: 4997,
      driftBps: -3,
    },
    {
      asset: 'solana:usdy',
      raw: '850000000',
      multiplier: '1',
      display: '850',
      targetBps: 4500,
      lastKeeperAt: null,
      valueUsd: '926.5',
      weightBps: 4517,
      driftBps: 17,
    },
  ],
  lossUsedBps: 12,
  bandBps: 200,
  lossCapBps: 100,
  paused: false,
  prices: [
    solanaPrice('solana:spyx', '640.625', '2026-10-07T11:55:30.000Z', false),
    solanaPrice('solana:usdy', '1.09', '2026-10-07T11:55:30.000Z'),
  ],
  ...onSolana,
};

const NEWEST_INCOME: PlanNewest = {
  observedAt: '2026-10-07T11:56:02.000Z',
  ageSeconds: 238,
  stale: false,
  blockOrSlot: '412345678',
  valueUsd: '81243.55',
  cash: { asset: 'solana:usdc', raw: '6850350000', multiplier: '1', display: '6850.35' },
  positions: [
    {
      asset: 'solana:usdy',
      raw: '47300000000',
      multiplier: '1',
      display: '47300',
      targetBps: 6000,
      lastKeeperAt: unix('2026-10-07T06:12:40.000Z'),
      valueUsd: '51557',
      weightBps: 6346,
      driftBps: 346,
    },
    {
      asset: 'solana:sgov',
      raw: '227000000',
      multiplier: '1',
      display: '227',
      targetBps: 3000,
      lastKeeperAt: null,
      valueUsd: '22836.2',
      weightBps: 2811,
      driftBps: -189,
    },
  ],
  lossUsedBps: 8,
  bandBps: 200,
  lossCapBps: 100,
  paused: false,
  prices: [
    solanaPrice('solana:usdy', '1.09', '2026-10-07T11:55:32.000Z'),
    solanaPrice('solana:sgov', '100.6', '2026-10-07T11:55:32.000Z', false),
  ],
  ...onSolana,
};

const NEWEST_UNPRICED: PlanNewest = {
  observedAt: '2026-10-07T11:56:04.000Z',
  ageSeconds: 236,
  stale: false,
  blockOrSlot: '412345678',
  // what has a price: the gold is in no sum
  valueUsd: '500.28',
  cash: { asset: 'solana:usdc', raw: '249580000', multiplier: '1', display: '249.58' },
  positions: [
    {
      asset: 'solana:paxg',
      raw: '6000000',
      multiplier: '1',
      display: '0.06',
      targetBps: 3000,
      lastKeeperAt: null,
      valueUsd: null,
      weightBps: 0,
      driftBps: -3000,
    },
    {
      asset: 'solana:usdy',
      raw: '230000000',
      multiplier: '1',
      display: '230',
      targetBps: 5000,
      lastKeeperAt: null,
      valueUsd: '250.7',
      weightBps: 5011,
      driftBps: 11,
    },
  ],
  lossUsedBps: 0,
  bandBps: 200,
  lossCapBps: 100,
  paused: false,
  prices: [solanaPrice('solana:usdy', '1.09', '2026-10-07T11:55:34.000Z')],
  ...onSolana,
};

const NEWEST_STALE: PlanNewest = {
  observedAt: '2026-10-07T08:55:00.000Z',
  ageSeconds: 11_100,
  stale: true,
  blockOrSlot: '412318002',
  valueUsd: '251.9',
  cash: { asset: 'solana:usdc', raw: '12500000', multiplier: '1', display: '12.5' },
  positions: [
    {
      asset: 'solana:usdy',
      raw: '120000000',
      multiplier: '1',
      display: '120',
      targetBps: 5000,
      lastKeeperAt: unix('2026-10-06T22:14:05.000Z'),
      valueUsd: '130.8',
      weightBps: 5192,
      driftBps: 192,
    },
    {
      asset: 'solana:syrupusdc',
      raw: '100000000',
      multiplier: '1',
      display: '100',
      targetBps: 4500,
      lastKeeperAt: null,
      valueUsd: '108.6',
      weightBps: 4311,
      driftBps: -189,
    },
  ],
  lossUsedBps: 0,
  bandBps: 200,
  lossCapBps: 100,
  paused: false,
  prices: [
    solanaPrice('solana:usdy', '1.09', '2026-10-07T08:54:30.000Z'),
    solanaPrice('solana:syrupusdc', '1.086', '2026-10-07T08:54:30.000Z'),
  ],
  ...onSolana,
};

const NEWEST_SILENT: PlanNewest = {
  observedAt: '2026-10-06T10:00:00.000Z',
  ageSeconds: 93_600,
  stale: true,
  blockOrSlot: null,
  valueUsd: '41.5',
  cash: { asset: 'robinhood:usdc', raw: '16500000', multiplier: '1', display: '16.5' },
  positions: [
    {
      asset: 'robinhood:tspy',
      raw: '40000000000000000',
      multiplier: '1',
      display: '0.04',
      targetBps: 6000,
      lastKeeperAt: null,
      valueUsd: '25',
      weightBps: 6024,
      driftBps: 24,
    },
  ],
  lossUsedBps: 0,
  bandBps: 200,
  lossCapBps: null,
  paused: null,
  prices: [
    {
      asset: 'robinhood:tspy',
      usdPerToken: '625',
      source: MOCK_CHAIN,
      method: 'the mock chain’s own price',
      fetchedAt: '2026-10-06T10:00:00.000Z',
      provenance: 'mock',
      ageSeconds: 0,
      maxAgeSeconds: 120,
      market: 'open',
    },
  ],
  ...onMock,
};

const NEWEST_EMPTY: PlanNewest = {
  observedAt: '2026-10-06T10:00:01.000Z',
  ageSeconds: 93_599,
  stale: true,
  blockOrSlot: null,
  valueUsd: '0',
  cash: { asset: 'robinhood:usdc', raw: '0', multiplier: '1', display: '0' },
  positions: [],
  lossUsedBps: 0,
  bandBps: 200,
  lossCapBps: null,
  paused: null,
  prices: [],
  ...onMock,
};

// ---------------------------------------------------------------------------------------------------
// The status of a plan, one answer for each line of the rule
// ---------------------------------------------------------------------------------------------------

const said = (
  status: TrackStatus['status'],
  line: TrackLine,
  params: TrackStatus['params'],
  text: string,
  observedAt: string | null,
  rule: string = TRACK_RULE,
): TrackStatus => ({ status, rule, line, params, text, observedAt });

const AT = NEWEST_GROW.observedAt;

/**
 * Each line of the rule as `statusOf` of packages/basket answers it, with the figures the line names.
 * Some lines have two answers: the two ways a position is outside its band, one part and several with
 * no price, the four findings of a verdict.
 */
export const STATUS_BY_LINE: Record<TrackLine, TrackStatus[]> = {
  verdict: [
    said(
      'on_track',
      'verdict',
      { coveredNow: 1, coveredUnderStress: 1, observedOn: '2026-10-07' },
      'ENG-3 income verdict v1 says the goal is covered now and under stress, as observed on 2026-10-07.',
      AT,
      'ENG-3 income verdict v1',
    ),
    said(
      'on_track',
      'verdict',
      { coveredNow: 1 },
      'ENG-3 income verdict v1 says the goal is covered now, with no stress run.',
      AT,
      'ENG-3 income verdict v1',
    ),
    said(
      'watch',
      'verdict',
      { coveredNow: 1, coveredUnderStress: 0 },
      'ENG-3 income verdict v1 says the goal is covered now but not under stress.',
      AT,
      'ENG-3 income verdict v1',
    ),
    said(
      'off_track',
      'verdict',
      { coveredNow: 0, coveredUnderStress: 0 },
      'ENG-3 income verdict v1 says the goal is not covered now.',
      AT,
      'ENG-3 income verdict v1',
    ),
  ],
  never_read: [
    said(null, 'never_read', {}, 'No status yet: this vault has not been read yet.', null),
  ],
  empty: [
    said(null, 'empty', {}, 'No status yet: the vault holds nothing.', NEWEST_EMPTY.observedAt),
  ],
  chain_silent: [
    said(
      'off_track',
      'chain_silent',
      { hours: 26 },
      "The plan's chain has not been read for 26 hours, a day or more.",
      NEWEST_SILENT.observedAt,
    ),
  ],
  loss_half: [
    said(
      'off_track',
      'loss_half',
      { lossUsedBps: 62, lossCapBps: 100, usedPct: 62 },
      'Loss used 62% of the budget, half or more.',
      AT,
    ),
  ],
  unpriced: [
    said(
      'watch',
      'unpriced',
      { asset: 'solana:paxg', count: 1 },
      '1 held position has no price (solana:paxg), so the plan cannot be weighed.',
      NEWEST_UNPRICED.observedAt,
    ),
    said(
      'watch',
      'unpriced',
      { asset: 'solana:paxg', count: 2 },
      '2 held positions have no price (solana:paxg first), so the plan cannot be weighed.',
      AT,
    ),
  ],
  no_band: [
    said(
      null,
      'no_band',
      {},
      'No status yet: this network states no band to hold the positions to.',
      AT,
    ),
  ],
  outside_band: [
    said(
      'watch',
      'outside_band',
      { asset: 'solana:usdy', driftBps: 346, bandBps: 200 },
      'solana:usdy is 3.46% over its target, outside the band of 2%.',
      NEWEST_INCOME.observedAt,
    ),
    said(
      'watch',
      'outside_band',
      { asset: 'solana:spyx', driftBps: -415, bandBps: 200 },
      'solana:spyx is 4.15% under its target, outside the band of 2%.',
      AT,
    ),
  ],
  cash_over: [
    said(
      'watch',
      'cash_over',
      { overBps: 350, bandBps: 200 },
      'The cash is 3.5% over its share, more than the band of 2%.',
      AT,
    ),
  ],
  loss_quarter: [
    said(
      'watch',
      'loss_quarter',
      { lossUsedBps: 31, lossCapBps: 100, usedPct: 31 },
      'Loss used 31% of the budget, a quarter or more.',
      AT,
    ),
  ],
  stale: [
    said(
      'watch',
      'stale',
      { minutes: 185 },
      'The vault was last read 185 minutes ago, more than an hour.',
      NEWEST_STALE.observedAt,
    ),
  ],
  inside: [
    said(
      'on_track',
      'inside',
      { bandBps: 200, lossUsedBps: 12, lossCapBps: 100, usedPct: 12 },
      'Every position inside the band; loss used 12% of the budget.',
      AT,
    ),
  ],
  inside_no_budget: [
    said(
      'on_track',
      'inside_no_budget',
      { bandBps: 200 },
      'Every position inside the band; this network keeps no loss budget.',
      AT,
    ),
  ],
};

/** The first answer of a line: the one the vaults below carry. */
const statusOf = (line: TrackLine): TrackStatus => {
  const [first] = STATUS_BY_LINE[line];
  if (!first) throw new Error(`no status for ${line}`);
  return first;
};

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/plans
// ---------------------------------------------------------------------------------------------------

export const PLANS: PortfolioPlansResponse = {
  chains: [
    {
      chain: 'solana',
      name: 'Solana devnet',
      provenance: 'sandbox',
      answeredAt: '2026-10-07T11:56:10.000Z',
      plans: [
        {
          chain: 'solana',
          address: SOL_GROW,
          owner: OWNER_SOLANA,
          name: null,
          basketId: '7',
          plan: {
            kind: 'personal',
            placedAt: '2026-10-03T14:00:00.000Z',
            proposalId: '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60',
            sheet: SHEET_GROW,
            card: card({ moneyTodayUsd: 2000 }),
            verdict: null,
            observations: observations('2026-10-03T13:58:00.000Z'),
          },
          openedFor: null,
          putIn: {
            usd: '2000',
            orders: 1,
            deposits: [{ orderId: ORDER_GROW, at: '2026-10-03T14:04:02.000Z', usd: '2000' }],
            source: putInSource('Solana devnet'),
            method: PUT_IN_METHOD,
            fetchedAt: NOW,
            provenance: 'sandbox',
          },
          newest: NEWEST_GROW,
          status: statusOf('inside'),
          follows: null,
          provenance: 'sandbox',
        },
        {
          chain: 'solana',
          address: SOL_INCOME,
          owner: OWNER_SOLANA,
          name: 'Rent fund',
          basketId: '8',
          plan: {
            kind: 'personal',
            placedAt: '2026-10-01T15:00:00.000Z',
            proposalId: '8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d',
            sheet: SHEET_INCOME,
            card: card({
              moneyTodayUsd: 50_000,
              termMonths: 60,
              cashFlow: 'monthly',
              expectedReturn: {
                lowPct: 3.4,
                highPct: 5.2,
                basis: 'sample: the test network’s rates, after the haircut',
                lossInFallUsd: 900,
              },
              exit: { text: 'access to cash within 7 days', costBps: null },
            }),
            verdict: {
              met: false,
              gapUsdMonthly: 40,
              ways: [{ change: 'Start with $57,000', closesGap: true }],
            },
            observations: observations('2026-10-01T14:58:00.000Z'),
          },
          openedFor: null,
          putIn: {
            usd: '80000',
            orders: 2,
            deposits: [
              { orderId: ORDER_INCOME_1, at: '2026-10-01T15:04:11.000Z', usd: '50000' },
              { orderId: ORDER_INCOME_2, at: '2026-10-05T09:30:02.000Z', usd: '30000' },
            ],
            source: putInSource('Solana devnet'),
            method: PUT_IN_METHOD,
            fetchedAt: NOW,
            provenance: 'sandbox',
          },
          newest: NEWEST_INCOME,
          status: statusOf('outside_band'),
          follows: null,
          provenance: 'sandbox',
        },
        {
          chain: 'solana',
          address: SOL_UNPRICED,
          owner: OWNER_SOLANA,
          name: null,
          basketId: '9',
          plan: {
            kind: 'personal',
            placedAt: '2026-10-06T09:00:00.000Z',
            proposalId: '1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a',
            sheet: SHEET_PROTECT,
            card: card({ moneyTodayUsd: 500, termMonths: 18 }),
            verdict: null,
            observations: observations('2026-10-06T08:58:00.000Z'),
          },
          openedFor: null,
          putIn: {
            usd: '500',
            orders: 1,
            deposits: [{ orderId: ORDER_UNPRICED, at: '2026-10-06T09:03:40.000Z', usd: '500' }],
            source: putInSource('Solana devnet'),
            method: PUT_IN_METHOD,
            fetchedAt: NOW,
            provenance: 'sandbox',
          },
          newest: NEWEST_UNPRICED,
          status: statusOf('unpriced'),
          follows: null,
          provenance: 'sandbox',
        },
        {
          chain: 'solana',
          address: SOL_STALE,
          owner: OWNER_SOLANA,
          name: null,
          basketId: '10',
          plan: {
            kind: 'follow',
            placedAt: '2026-09-28T16:20:00.000Z',
            familyId: FAMILY_DOLLARS.familyId,
          },
          openedFor: FAMILY_DOLLARS,
          putIn: {
            usd: '250',
            orders: 1,
            deposits: [{ orderId: ORDER_STALE, at: '2026-09-28T16:24:30.000Z', usd: '250' }],
            source: putInSource('Solana devnet'),
            method: PUT_IN_METHOD,
            fetchedAt: NOW,
            provenance: 'sandbox',
          },
          newest: NEWEST_STALE,
          status: statusOf('stale'),
          follows: {
            recipeOnchainId: '41',
            acceptedVersion: 3,
            autoFollow: true,
            ...FAMILY_DOLLARS,
          },
          provenance: 'sandbox',
        },
        {
          chain: 'solana',
          address: SOL_NEVER,
          owner: OWNER_SOLANA,
          name: 'Rainy day',
          basketId: '11',
          plan: null,
          openedFor: null,
          putIn: null,
          newest: null,
          status: statusOf('never_read'),
          follows: null,
          provenance: 'sandbox',
        },
      ],
    },
    {
      chain: 'robinhood',
      name: 'Robinhood Chain',
      provenance: 'mock',
      answeredAt: '2026-10-06T10:00:05.000Z',
      plans: [
        {
          chain: 'robinhood',
          address: RH_SILENT,
          owner: OWNER_EVM,
          name: null,
          basketId: '3',
          plan: {
            kind: 'follow',
            placedAt: '2026-10-02T13:05:00.000Z',
            familyId: FAMILY_STOCKS.familyId,
          },
          openedFor: FAMILY_STOCKS,
          putIn: {
            usd: '40',
            orders: 1,
            deposits: [{ orderId: ORDER_SILENT, at: '2026-10-02T13:05:40.000Z', usd: '40' }],
            source: putInSource('Robinhood Chain'),
            method: PUT_IN_METHOD,
            fetchedAt: NOW,
            provenance: 'mock',
          },
          newest: NEWEST_SILENT,
          status: statusOf('chain_silent'),
          // on the worker's mock a snapshot never carries a followed portfolio
          follows: null,
          provenance: 'mock',
        },
        {
          chain: 'robinhood',
          address: RH_EMPTY,
          owner: OWNER_EVM,
          name: null,
          basketId: '4',
          plan: null,
          openedFor: null,
          putIn: null,
          newest: NEWEST_EMPTY,
          status: statusOf('empty'),
          follows: null,
          provenance: 'mock',
        },
      ],
    },
  ],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/history
// ---------------------------------------------------------------------------------------------------

type Point = PortfolioHistoryResponse['chains'][number]['vaults'][number]['points'][number];

/** Dollars as the API writes them: a decimal with no zeros it does not need. */
const usd = (n: number) => String(Math.round(n * 100) / 100);

/**
 * One point of a vault's history: its value, and each position as [asset, weight, target] in basis
 * points, valued at its weight of the whole. The cash is what the positions leave. A weight of null
 * is a position with no price: it has no value and weighs nothing.
 */
function point(
  observedAt: string,
  value: number,
  positions: readonly (readonly [string, number | null, number])[],
  lossUsedBps = 0,
  over: Pick<Point, 'source' | 'method'> = {},
): Point {
  const held = positions.map(([asset, weightBps, targetBps]) => ({
    asset,
    valueUsd: weightBps === null ? null : usd((value * weightBps) / 10_000),
    weightBps: weightBps ?? 0,
    targetBps,
    driftBps: (weightBps ?? 0) - targetBps,
  }));
  const invested = held.reduce((sum, p) => sum + Number(p.valueUsd ?? 0), 0);
  return {
    observedAt,
    valueUsd: usd(value),
    cashUsd: usd(value - invested),
    positions: held,
    lossUsedBps,
    ...over,
  };
}

/** The last snapshot of a day, as a step of a day keeps it: ten to midnight, UTC. */
const day = (d: number) => `2026-10-0${d}T23:50:00.000Z`;

/** A week by the day, wide enough for both deposits of the income plan to fall inside it. */
export const HISTORY: PortfolioHistoryResponse = {
  from: '2026-09-30T12:00:00.000Z',
  to: NOW,
  step: '1d',
  chains: [
    {
      chain: 'solana',
      name: 'Solana devnet',
      provenance: 'sandbox',
      vaults: [
        {
          address: SOL_GROW,
          name: null,
          source: SOLANA_READER,
          method: SNAPSHOT_METHOD,
          points: [
            point(day(3), 2000.4, [
              ['solana:spyx', 5000, 5000],
              ['solana:usdy', 4500, 4500],
            ]),
            // a day read through another node: the point says so, since it differs from the series
            point(
              day(4),
              2012.9,
              [
                ['solana:spyx', 5031, 5000],
                ['solana:usdy', 4472, 4500],
              ],
              4,
              { source: `${SOLANA_READER}, on its second node` },
            ),
            point(
              day(5),
              2031.75,
              [
                ['solana:spyx', 5074, 5000],
                ['solana:usdy', 4431, 4500],
              ],
              9,
            ),
            point(
              day(6),
              2044.1,
              [
                ['solana:spyx', 5012, 5000],
                ['solana:usdy', 4498, 4500],
              ],
              12,
            ),
            point(
              NEWEST_GROW.observedAt,
              2051.37,
              [
                ['solana:spyx', 4997, 5000],
                ['solana:usdy', 4517, 4500],
              ],
              12,
            ),
          ],
        },
        {
          address: SOL_INCOME,
          name: 'Rent fund',
          source: SOLANA_READER,
          method: SNAPSHOT_METHOD,
          points: [
            point(day(1), 50_012.4, [
              ['solana:usdy', 6001, 6000],
              ['solana:sgov', 2999, 3000],
            ]),
            point(day(2), 50_031.9, [
              ['solana:usdy', 6004, 6000],
              ['solana:sgov', 2997, 3000],
            ]),
            point(day(3), 50_048.1, [
              ['solana:usdy', 6008, 6000],
              ['solana:sgov', 2995, 3000],
            ]),
            point(day(4), 50_066.75, [
              ['solana:usdy', 6001, 6000],
              ['solana:sgov', 2998, 3000],
            ]),
            // the second deposit is in: thirty thousand more
            point(
              day(5),
              81_105.2,
              [
                ['solana:usdy', 6012, 6000],
                ['solana:sgov', 3005, 3000],
              ],
              3,
            ),
            point(
              day(6),
              81_190.4,
              [
                ['solana:usdy', 6471, 6000],
                ['solana:sgov', 2790, 3000],
              ],
              3,
            ),
            point(
              NEWEST_INCOME.observedAt,
              81_243.55,
              [
                ['solana:usdy', 6346, 6000],
                ['solana:sgov', 2811, 3000],
              ],
              8,
            ),
          ],
        },
        {
          address: SOL_UNPRICED,
          name: null,
          source: SOLANA_READER,
          method: SNAPSHOT_METHOD,
          points: [
            point(day(6), 500.1, [
              ['solana:paxg', null, 3000],
              ['solana:usdy', 5008, 5000],
            ]),
            point(NEWEST_UNPRICED.observedAt, 500.28, [
              ['solana:paxg', null, 3000],
              ['solana:usdy', 5011, 5000],
            ]),
          ],
        },
        {
          address: SOL_STALE,
          name: null,
          source: SOLANA_READER,
          method: SNAPSHOT_METHOD,
          points: [
            point(day(5), 250.9, [
              ['solana:usdy', 5003, 5000],
              ['solana:syrupusdc', 4498, 4500],
            ]),
            point(day(6), 251.4, [
              ['solana:usdy', 5190, 5000],
              ['solana:syrupusdc', 4312, 4500],
            ]),
            point(NEWEST_STALE.observedAt, 251.9, [
              ['solana:usdy', 5192, 5000],
              ['solana:syrupusdc', 4311, 4500],
            ]),
          ],
        },
      ],
    },
    {
      chain: 'robinhood',
      name: 'Robinhood Chain',
      provenance: 'mock',
      vaults: [
        {
          address: RH_SILENT,
          name: null,
          source: MOCK_CHAIN,
          method: SNAPSHOT_METHOD,
          points: [
            point(day(2), 40, [['robinhood:tspy', 6000, 6000]]),
            point(day(3), 40.6, [['robinhood:tspy', 6059, 6000]]),
            point(day(4), 41.1, [['robinhood:tspy', 6010, 6000]]),
            point(day(5), 41.3, [['robinhood:tspy', 6019, 6000]]),
            point(NEWEST_SILENT.observedAt, 41.5, [['robinhood:tspy', 6024, 6000]]),
          ],
        },
        {
          address: RH_EMPTY,
          name: null,
          source: MOCK_CHAIN,
          method: SNAPSHOT_METHOD,
          points: [point(NEWEST_EMPTY.observedAt, 0, [])],
        },
      ],
    },
  ],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/rebalances
// ---------------------------------------------------------------------------------------------------

const SIG_INCOME =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const SIG_GROW_FAILED =
  '3AsdoALgZFuq2oUVWrDYhg2pNeaLJKPLf8hU2mQ6U8qJxeJ6hsrPVpMn9ma39DtfYCrDQSvngWRP8NnTpEhezJpE';
const SIG_GROW =
  '2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UxtbCXy2rqYcuyuv';
const SIG_VERSION =
  '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM5nGQHhYBS7jq3bDfpH9hbKQmjXnQ5sBqHZ3z8sBdsLmZp';
const TX_SILENT = '0x9c2f4e6a8b0d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a';

const solscan = (signature: string) => `https://solscan.io/tx/${signature}?cluster=devnet`;

const ownerOnSolana = (fetchedAt: string) =>
  ({ source: SOLANA_ADAPTER, method: QUOTE_METHOD, fetchedAt, provenance: 'sandbox' }) as const;
const keeperOnSolana = (fetchedAt: string) =>
  ({ source: SOLANA_READER, method: KEEPER_METHOD, fetchedAt, provenance: 'sandbox' }) as const;

export const REBALANCES: PortfolioRebalancesResponse = {
  chains: [
    {
      chain: 'solana',
      name: 'Solana devnet',
      provenance: 'sandbox',
      entries: [
        // the keeper sold what was over its share: worked out from two snapshots
        {
          chain: 'solana',
          vault: SOL_INCOME,
          at: '2026-10-07T06:12:40.000Z',
          by: 'keeper',
          derived: true,
          kind: 'keeper_leg',
          why: null,
          outcome: 'confirmed',
          trades: [
            {
              sell: 'solana:usdy',
              buy: 'solana:usdc',
              asset: 'solana:usdy',
              rawBefore: '48400000000',
              rawAfter: '47300000000',
              reference: solanaPrice('solana:usdy', '1.09', '2026-10-07T06:09:30.000Z'),
              before: {
                observedAt: '2026-10-07T06:10:00.000Z',
                weightBps: 6471,
                targetBps: 6000,
                driftBps: 471,
              },
              after: {
                observedAt: '2026-10-07T06:20:00.000Z',
                weightBps: 6346,
                targetBps: 6000,
                driftBps: 346,
              },
            },
          ],
          orderId: null,
          txId: null,
          explorerUrl: null,
          ...keeperOnSolana('2026-10-07T06:20:00.000Z'),
        },
        {
          chain: 'solana',
          vault: SOL_STALE,
          at: '2026-10-06T22:14:05.000Z',
          by: 'keeper',
          derived: true,
          kind: 'keeper_leg',
          why: null,
          outcome: 'confirmed',
          trades: [
            {
              sell: 'solana:usdc',
              buy: 'solana:usdy',
              asset: 'solana:usdy',
              rawBefore: '112000000',
              rawAfter: '120000000',
              reference: solanaPrice('solana:usdy', '1.0899', '2026-10-06T22:09:30.000Z'),
              before: {
                observedAt: '2026-10-06T22:10:00.000Z',
                weightBps: 4871,
                targetBps: 5000,
                driftBps: -129,
              },
              after: {
                observedAt: '2026-10-06T22:20:00.000Z',
                weightBps: 5190,
                targetBps: 5000,
                driftBps: 190,
              },
            },
          ],
          orderId: null,
          txId: null,
          explorerUrl: null,
          ...keeperOnSolana('2026-10-06T22:20:00.000Z'),
        },
        // a step of the owner's: the second buy of the income plan, with its quote, the reference
        // price before it and the drift on each side
        {
          chain: 'solana',
          vault: SOL_INCOME,
          at: '2026-10-05T09:29:41.000Z',
          by: 'owner',
          derived: false,
          kind: 'swap',
          why: 'manual',
          outcome: 'confirmed',
          trades: [
            {
              sell: 'solana:usdc',
              buy: 'solana:usdy',
              asset: 'solana:usdy',
              amountInRaw: '18000000000',
              expected: {
                inRaw: '18000000000',
                outRaw: '16510000000',
                minOutRaw: '16427450000',
                costBps: 4,
              },
              reference: solanaPrice('solana:usdy', '1.0898', '2026-10-05T09:19:30.000Z'),
              before: {
                observedAt: '2026-10-05T09:20:00.000Z',
                weightBps: 6001,
                targetBps: 6000,
                driftBps: 1,
              },
              after: {
                observedAt: '2026-10-05T09:40:00.000Z',
                weightBps: 6012,
                targetBps: 6000,
                driftBps: 12,
              },
            },
            {
              sell: 'solana:usdc',
              buy: 'solana:sgov',
              asset: 'solana:sgov',
              amountInRaw: '9000000000',
              expected: {
                inRaw: '9000000000',
                outRaw: '89460000',
                minOutRaw: '89012700',
                costBps: 6,
              },
              reference: solanaPrice('solana:sgov', '100.55', '2026-10-05T09:19:30.000Z', false),
              before: {
                observedAt: '2026-10-05T09:20:00.000Z',
                weightBps: 2998,
                targetBps: 3000,
                driftBps: -2,
              },
              after: {
                observedAt: '2026-10-05T09:40:00.000Z',
                weightBps: 3005,
                targetBps: 3000,
                driftBps: 5,
              },
            },
          ],
          orderId: ORDER_INCOME_2,
          txId: SIG_INCOME,
          explorerUrl: solscan(SIG_INCOME),
          ...ownerOnSolana('2026-10-05T09:29:40.000Z'),
        },
        // the buy of the plan to grow: the attempt that confirmed, with the quote of the step's last
        // build
        {
          chain: 'solana',
          vault: SOL_GROW,
          at: '2026-10-03T14:03:30.000Z',
          by: 'owner',
          derived: false,
          kind: 'swap',
          why: 'manual',
          outcome: 'confirmed',
          trades: [
            {
              sell: 'solana:usdc',
              buy: 'solana:spyx',
              asset: 'solana:spyx',
              amountInRaw: '1000000000',
              expected: {
                inRaw: '1000000000',
                outRaw: '156200000',
                minOutRaw: '155419000',
                costBps: 9,
              },
              after: {
                observedAt: '2026-10-03T14:10:00.000Z',
                weightBps: 5000,
                targetBps: 5000,
                driftBps: 0,
              },
            },
          ],
          orderId: ORDER_GROW,
          txId: SIG_GROW,
          explorerUrl: solscan(SIG_GROW),
          ...ownerOnSolana('2026-10-03T14:03:29.000Z'),
        },
        // and the attempt before it, which reverted: its quote was not kept
        {
          chain: 'solana',
          vault: SOL_GROW,
          at: '2026-10-03T14:02:11.000Z',
          by: 'owner',
          derived: false,
          kind: 'swap',
          why: 'manual',
          outcome: 'failed',
          trades: [
            {
              sell: 'solana:usdc',
              buy: 'solana:spyx',
              asset: 'solana:spyx',
              amountInRaw: '1000000000',
            },
          ],
          orderId: ORDER_GROW,
          txId: SIG_GROW_FAILED,
          explorerUrl: solscan(SIG_GROW_FAILED),
          ...ownerOnSolana('2026-10-03T14:02:10.000Z'),
        },
        // a version of the followed portfolio, accepted by hand: it adopts and trades nothing
        {
          chain: 'solana',
          vault: SOL_STALE,
          at: '2026-10-01T10:00:00.000Z',
          by: 'owner',
          derived: false,
          kind: 'accept_version',
          why: 'manual',
          outcome: 'confirmed',
          trades: [],
          orderId: ORDER_STALE,
          txId: SIG_VERSION,
          explorerUrl: solscan(SIG_VERSION),
          ...ownerOnSolana('2026-10-01T09:59:58.000Z'),
        },
      ],
    },
    {
      chain: 'robinhood',
      name: 'Robinhood Chain',
      provenance: 'mock',
      entries: [
        // on an EVM chain the create buys: there was no snapshot before it, so no reference and no
        // drift before, and the quote's cost reads zero
        {
          chain: 'robinhood',
          vault: RH_SILENT,
          at: '2026-10-02T13:05:20.000Z',
          by: 'owner',
          derived: false,
          kind: 'create_vault',
          why: 'manual',
          outcome: 'confirmed',
          trades: [
            {
              sell: 'robinhood:usdc',
              buy: 'robinhood:tspy',
              asset: 'robinhood:tspy',
              amountInRaw: '24000000',
              expected: {
                inRaw: '24000000',
                outRaw: '40000000000000000',
                minOutRaw: '39800000000000000',
                costBps: 0,
              },
              after: {
                observedAt: '2026-10-02T13:10:00.000Z',
                weightBps: 6000,
                targetBps: 6000,
                driftBps: 0,
              },
            },
          ],
          orderId: ORDER_SILENT,
          txId: TX_SILENT,
          explorerUrl: `mock://robinhood/tx/${TX_SILENT}`,
          source: MOCK_CHAIN,
          method: 'mock price less a fixed cost',
          fetchedAt: '2026-10-02T13:05:19.000Z',
          provenance: 'mock',
        },
      ],
    },
  ],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

// ---------------------------------------------------------------------------------------------------
// GET /v1/portfolio/exposure
// ---------------------------------------------------------------------------------------------------

type ExposureChain = PortfolioExposureResponse['chains'][number];

/** A chain the person holds nothing with a value on: no snapshot stands behind it. */
const holdsNothing = (
  chain: Pick<ExposureChain, 'chain' | 'name' | 'provenance'>,
): ExposureChain => ({
  ...chain,
  vaults: 0,
  valueUsd: '0',
  observedAt: null,
  byUnderlying: [],
  byIssuer: [],
  rollUp: null,
  exit: [],
  unvalued: [],
  source: NO_SNAPSHOT_SOURCE,
  method: EXPOSURE_METHOD,
});

const SOLANA_FRAME = { chain: 'solana', name: 'Solana devnet', provenance: 'sandbox' } as const;
const ROBINHOOD_FRAME = {
  chain: 'robinhood',
  name: 'Robinhood Chain',
  provenance: 'mock',
} as const;

/** Bearing's stamp on a cost it measured: its own label, which is live, on a test network's holding. */
const measured = {
  source: BEARING,
  method: BEARING_METHOD,
  fetchedAt: '2026-10-07T11:00:00.000Z',
  provenance: 'live',
} as const;

export const EXPOSURE: PortfolioExposureResponse = {
  // a sum with a mock chain in it is mock
  total: {
    valueUsd: '84088.6',
    provenance: 'mock',
    source: [MOCK_CHAIN, SOLANA_READER].sort().join('; '),
    method: `${EXPOSURE_METHOD}; the chains' sums added together`,
    observedAt: [NEWEST_STALE.observedAt, NEWEST_SILENT.observedAt].sort()[0] ?? null,
    byUnderlying: [
      { key: 'USDY', usd: '52865', bps: 6287 },
      { key: 'SGOV', usd: '22836.2', bps: 2716 },
      { key: 'USD', usd: '7228.8', bps: 859 },
      { key: 'SPY', usd: '1050', bps: 125 },
      { key: 'syrupUSDC', usd: '108.6', bps: 13 },
    ],
    byIssuer: [
      { key: 'ondo', usd: '52865', bps: 6287 },
      { key: 'ishares', usd: '22836.2', bps: 2716 },
      { key: 'test network', usd: '7212.3', bps: 857 },
      { key: 'backed', usd: '1025', bps: 122 },
      { key: 'maple', usd: '108.6', bps: 13 },
      { key: 'mock', usd: '41.5', bps: 5 },
    ],
  },
  chains: [
    {
      ...SOLANA_FRAME,
      // the four vaults with a snapshot: the one never read adds nothing
      vaults: 4,
      valueUsd: '84047.1',
      // the oldest of them: the sums are no fresher than it
      observedAt: NEWEST_STALE.observedAt,
      byUnderlying: [
        { key: 'USDY', usd: '52865', bps: 6290 },
        { key: 'SGOV', usd: '22836.2', bps: 2717 },
        { key: 'USD', usd: '7212.3', bps: 858 },
        { key: 'SPY', usd: '1025', bps: 122 },
        { key: 'syrupUSDC', usd: '108.6', bps: 13 },
      ],
      byIssuer: [
        { key: 'ondo', usd: '52865', bps: 6290 },
        { key: 'ishares', usd: '22836.2', bps: 2717 },
        { key: 'test network', usd: '7212.3', bps: 858 },
        { key: 'backed', usd: '1025', bps: 122 },
        { key: 'maple', usd: '108.6', bps: 13 },
      ],
      rollUp: {
        byIssuer: [
          { key: 'ondo', bps: 6290 },
          { key: 'ishares', bps: 2717 },
          { key: 'test network', bps: 858 },
          { key: 'backed', bps: 122 },
          { key: 'maple', bps: 13 },
        ],
        byChain: [{ key: 'solana', bps: 10_000 }],
        byClass: [
          { key: 'dollar_yield', bps: 9020 },
          { key: 'cash', bps: 858 },
          { key: 'etf', bps: 122 },
        ],
        flags: ['exit_quote_missing'],
        exit: {
          quotedBps: null,
          quotedAt: null,
          measuredWorstBps: 7.25,
          measuredShareBps: 9129,
        },
      },
      exit: [
        // measured, with its whole stamp
        { asset: 'solana:usdy', usd: '52865', measured: true, costBps: 7.25, ...measured },
        // measured, and this size is beyond what was measured: no cost is stated
        { asset: 'solana:sgov', usd: '22836.2', measured: true, costBps: null, ...measured },
        // measured on a curve that has no time: the time is left out, never made up
        {
          asset: 'solana:spyx',
          usd: '1025',
          measured: true,
          costBps: 3.1,
          source: BEARING,
          method: BEARING_METHOD,
          provenance: 'live',
        },
        // not measured: the tier is named as the fallback, and a tier states no cost
        {
          asset: 'solana:syrupusdc',
          usd: '108.6',
          measured: false,
          costBps: null,
          fallbackTier: 'B',
        },
      ],
      unvalued: [{ asset: 'solana:paxg', vault: SOL_UNPRICED, display: '0.06' }],
      source: SOLANA_READER,
      method: EXPOSURE_METHOD,
    },
    {
      ...ROBINHOOD_FRAME,
      vaults: 2,
      valueUsd: '41.5',
      observedAt: NEWEST_SILENT.observedAt,
      byUnderlying: [
        { key: 'SPY', usd: '25', bps: 6024 },
        { key: 'USD', usd: '16.5', bps: 3976 },
      ],
      // on the mock every issuer is the mock
      byIssuer: [{ key: 'mock', usd: '41.5', bps: 10_000 }],
      rollUp: {
        byIssuer: [{ key: 'mock', bps: 10_000 }],
        byChain: [{ key: 'robinhood', bps: 10_000 }],
        byClass: [
          { key: 'stock', bps: 6024 },
          { key: 'cash', bps: 3976 },
        ],
        flags: ['exit_not_measured', 'exit_quote_missing'],
        exit: { quotedBps: null, quotedAt: null, measuredWorstBps: null, measuredShareBps: 0 },
      },
      exit: [
        {
          asset: 'robinhood:tspy',
          usd: '25',
          measured: false,
          costBps: null,
          fallbackTier: 'A',
        },
      ],
      unvalued: [],
      source: MOCK_CHAIN,
      method: EXPOSURE_METHOD,
    },
  ],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

/**
 * The exposure of one vault alone, as the route answers with `address`: the sums, the roll-up and the
 * size each exit is costed at are that vault's. Made for the income plan's vault; a chain the address
 * is not on holds nothing.
 */
export const EXPOSURE_OF_INCOME: PortfolioExposureResponse = {
  total: {
    valueUsd: '81243.55',
    provenance: 'sandbox',
    source: SOLANA_READER,
    method: `${EXPOSURE_METHOD}; the chains' sums added together`,
    observedAt: NEWEST_INCOME.observedAt,
    byUnderlying: [
      { key: 'USDY', usd: '51557', bps: 6346 },
      { key: 'SGOV', usd: '22836.2', bps: 2811 },
      { key: 'USD', usd: '6850.35', bps: 843 },
    ],
    byIssuer: [
      { key: 'ondo', usd: '51557', bps: 6346 },
      { key: 'ishares', usd: '22836.2', bps: 2811 },
      { key: 'test network', usd: '6850.35', bps: 843 },
    ],
  },
  chains: [
    {
      ...SOLANA_FRAME,
      vaults: 1,
      valueUsd: '81243.55',
      observedAt: NEWEST_INCOME.observedAt,
      byUnderlying: [
        { key: 'USDY', usd: '51557', bps: 6346 },
        { key: 'SGOV', usd: '22836.2', bps: 2811 },
        { key: 'USD', usd: '6850.35', bps: 843 },
      ],
      byIssuer: [
        { key: 'ondo', usd: '51557', bps: 6346 },
        { key: 'ishares', usd: '22836.2', bps: 2811 },
        { key: 'test network', usd: '6850.35', bps: 843 },
      ],
      rollUp: {
        byIssuer: [
          { key: 'ondo', bps: 6346 },
          { key: 'ishares', bps: 2811 },
          { key: 'test network', bps: 843 },
        ],
        byChain: [{ key: 'solana', bps: 10_000 }],
        byClass: [
          { key: 'dollar_yield', bps: 9157 },
          { key: 'cash', bps: 843 },
        ],
        flags: ['exit_quote_missing'],
        exit: {
          quotedBps: null,
          quotedAt: null,
          measuredWorstBps: 7.1,
          measuredShareBps: 9157,
        },
      },
      exit: [
        { asset: 'solana:usdy', usd: '51557', measured: true, costBps: 7.1, ...measured },
        { asset: 'solana:sgov', usd: '22836.2', measured: true, costBps: null, ...measured },
      ],
      unvalued: [],
      source: SOLANA_READER,
      method: EXPOSURE_METHOD,
    },
    holdsNothing(ROBINHOOD_FRAME),
  ],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

/** What the route answers for an address that is no vault of the person's: every chain holds nothing. */
export const EXPOSURE_OF_NOTHING: PortfolioExposureResponse = {
  total: null,
  chains: [holdsNothing(SOLANA_FRAME), holdsNothing(ROBINHOOD_FRAME)],
  unavailable: UNAVAILABLE,
  disclaimer: DISCLAIMER.en,
};

/** The exposure answers that were made for one vault, by its address. */
export const EXPOSURE_BY_VAULT: Readonly<Record<string, PortfolioExposureResponse>> = {
  [SOL_INCOME]: EXPOSURE_OF_INCOME,
};

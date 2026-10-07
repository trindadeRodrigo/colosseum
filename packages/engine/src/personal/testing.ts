import { EXIT_WINDOW_DAYS, flattenReport, metaHash, sha256Hex } from '@colosseum/basket';
import {
  type BasketAsset,
  BasketProposal,
  type ChainId,
  chainFamily,
  DISCLAIMER,
  type FactRegime,
  type FxObservation,
  normalizeAddress,
  PlanScorecard,
  PlanStatus,
  type Reason,
  type Recipe,
  type RegimeLiquidityProvider,
  type Shelf,
  type Target,
  Targets,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import seedFile from '../../../../docs/vault/research/open-questions/launch-shelf.seed.json';
import { compose } from './compose';
import yieldRows from './fixtures/yields.json';
import { LEG_TYPES } from './leg-types';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import { INPUT_NAMES, REASON_TEMPLATES } from './templates';
import {
  type ComposeContext,
  type PersonalParameters,
  type PersonalProposal,
  type PersonalSheet,
  type PooledLiquidityProvider,
  type RiskLevel,
  SLEEVES,
  type Sleeve,
} from './types';
import { monthAfter, tableFor } from './world';

// Builders for the tests of this folder. Not exported from the engine: every row is a fixture.
// The shelf is the launch shelf of docs/vault/research/open-questions/launch-shelf.seed.json, turned
// into the `Shelf` the engine takes. It is a draft shelf, measured on Oct 1, and nothing here is a
// live figure.

type SeedAsset = {
  symbol: string;
  cls: string;
  address: string;
  tier: string;
  decimals?: number;
  program?: string;
  pyth?: string | null;
  chainlink?: string;
};
type Seed = {
  cash: Record<string, string>;
  assets: Record<string, SeedAsset[]>;
  indexes: {
    slug: string;
    name: string;
    copy: string;
    mvp?: boolean;
    recipes: Record<string, Record<string, number>>;
  }[];
};
const SEED = seedFile as unknown as Seed;

const CLASS: Record<string, BasketAsset['cls']> = {
  stock: 'stock',
  'stock-index': 'etf',
  gold: 'gold',
  commodity: 'commodity',
  'dollar-yield': 'dollar_yield',
  'crypto-major': 'crypto',
  'solana-native': 'crypto',
  'base-native': 'crypto',
};
const TOKENIZED = new Set(['stock', 'etf', 'gold', 'commodity']);
const STOCK_ISSUER: Record<ChainId, string> = {
  solana: 'Backed (xStocks)',
  base: 'Coinbase',
  robinhood: 'Robinhood',
};
const YIELD_ISSUER: Record<string, string> = {
  jlUSDC: 'Jupiter Lend',
  syrupUSDC: 'Maple',
  SGOV: 'Robinhood',
};
// The ten stock tokens Kamino Scope prices on Solana (DESIGN-VAULT section 17, item 19).
const SCOPE = new Set('AAPLx CRCLx GOOGLx HOODx METAx MSTRx NVDAx QQQx SPYx TSLAx'.split(' '));
const SUFFIX: Record<ChainId, RegExp> = { solana: /x$/, base: /c$/, robinhood: /$^/ };
const FIXTURE_ADDRESS: Record<'solana' | 'evm', string> = {
  solana: '11111111111111111111111111111111',
  evm: `0x${'0'.repeat(40)}`,
};

export const assetId = (chain: string, symbol: string) => `${chain}:${symbol.toLowerCase()}`;

function listed(chain: ChainId, a: SeedAsset): BasketAsset | null {
  const cls = CLASS[a.cls];
  // No meme tokens at launch, and tier X is not listed.
  if (!cls || !['A', 'B', 'C'].includes(a.tier)) return null;
  const family = chainFamily(chain);
  const tokenized = TOKENIZED.has(cls);
  const scope = chain === 'solana' && SCOPE.has(a.symbol);
  const priceKind = family === 'evm' ? 'chainlink' : scope ? 'scope' : 'none';
  return {
    id: assetId(chain, a.symbol),
    chain,
    address: normalizeAddress(family, a.address),
    symbol: a.symbol,
    // compose never reads decimals. Where the seed has none, this is the usual figure, not a fact.
    decimals: a.decimals ?? (family === 'evm' ? 18 : a.program === 'T22' ? 8 : 6),
    cls,
    underlying: tokenized ? a.symbol.replace(SUFFIX[chain], '') : a.symbol,
    issuer: YIELD_ISSUER[a.symbol] ?? (tokenized ? STOCK_ISSUER[chain] : a.symbol),
    tier: a.tier as BasketAsset['tier'],
    priceKind,
    priceRef: family === 'evm' ? normalizeAddress('evm', a.chainlink ?? '') : '',
    session: tokenized || a.symbol === 'SGOV' ? 'us_equity' : 'always',
    autoFollowEligible: priceKind !== 'none',
    maxWeightBps: 5000,
    blockedCountries: [],
    sheet: tokenized ? `${chain}-stock-tokens` : a.symbol.toLowerCase(),
    provenance: 'fixture',
  };
}

function cashToken(chain: ChainId): BasketAsset {
  const [symbol = 'USDC', address = ''] = (SEED.cash[chain] ?? '').split(' ');
  return {
    id: assetId(chain, symbol),
    chain,
    address: normalizeAddress(chainFamily(chain), address),
    symbol,
    decimals: 6,
    cls: 'cash',
    underlying: 'USD',
    issuer: symbol,
    tier: 'A',
    priceKind: 'none',
    priceRef: '',
    session: 'always',
    autoFollowEligible: false,
    maxWeightBps: 0,
    blockedCountries: [],
    sheet: symbol.toLowerCase(),
    provenance: 'fixture',
  };
}

const CHAINS: ChainId[] = ['solana', 'robinhood', 'base'];
const hex = (text: string) => sha256Hex(new TextEncoder().encode(text));

/** The launch shelf: every listed token on the three chains, their cash tokens, and seven portfolios. */
export function launchShelf(): Shelf {
  const assets = CHAINS.flatMap((chain) => [
    cashToken(chain),
    ...(SEED.assets[chain] ?? []).flatMap((a) => listed(chain, a) ?? []),
  ]);
  const families = SEED.indexes
    .filter((index) => index.mvp !== false)
    .map((index) => {
      const chains = CHAINS.filter((chain) => index.recipes[chain]);
      const single = chains.every((chain) => Object.keys(index.recipes[chain] ?? {}).length === 1);
      const base = {
        familyId: hex(`family:${index.slug}`),
        slug: index.slug,
        name: index.name,
        copy: index.copy,
        kind: single ? ('single' as const) : ('index' as const),
      };
      const hash = metaHash(base);
      const recipes = chains.map(
        (chain): Recipe => ({
          schemaVersion: 1,
          familyId: base.familyId,
          chain,
          onchainId: null,
          creator: FIXTURE_ADDRESS[chainFamily(chain)],
          kind: 'community',
          version: 1,
          effectiveAt: 0,
          components: Object.entries(index.recipes[chain] ?? {}).map(([symbol, weightBps]) => ({
            kind: 'asset' as const,
            asset: assetId(chain, symbol),
            weightBps,
          })),
          metaHash: hash,
          maxFeeBps: 0,
          flags: 0,
        }),
      );
      return { meta: { ...base, chains }, recipes };
    });
  return { version: 'launch-shelf-2026-10-01-fixture', assets, families };
}

/** The same shelf with some tokens changed: `edit` gets a copy of each and returns what to use. */
export function editShelf(shelf: Shelf, edit: (asset: BasketAsset) => BasketAsset): Shelf {
  return { ...shelf, assets: shelf.assets.map((a) => edit({ ...a })) };
}

export const NOW = '2026-10-03T15:00:00.000Z';
const MEASURED_TO = '2026-10-02T00:00:00.000Z';
/** Where the fixture capacities come from, as a caller that wires a provider would say it. */
export const LIQUIDITY_SOURCE =
  'packages/engine/src/personal/testing.ts: capacities made up for the tests';

/**
 * The yield observations of fixtures/yields.json. Each row carries its own source, method and time,
 * and says what it is: a value written by hand into the prototype, not a reading of any feed.
 */
export function fixtureYields(): YieldObservation[] {
  return z.array(YieldObservation).parse(yieldRows);
}

const REGIMES: FactRegime[] = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'];

/**
 * A liquidity provider over a table of exit capacities in dollars. Thin gold on Solana by default,
 * as measured on Oct 1 (gold works up to about $10k per plan there). Like the risk layer's own, it
 * says which times of the week each figure was measured in: all of them, unless `notMeasured` names
 * some for a token.
 */
export function fixtureLiquidity(
  capacityUsd: Record<string, number> = {
    'solana:gldx': 40_000,
    'solana:spyx': 2_000_000,
    'solana:nvdax': 1_500_000,
  },
  samples = 40,
  /** The end of the data a capacity was measured on, as the provider gives it. Null: it gives none. */
  measuredTo: string | null = MEASURED_TO,
  /** The times of the week a token's figure leaves out, by asset id. */
  notMeasured: Record<string, FactRegime[]> = {},
): RegimeLiquidityProvider {
  const capacity = (id: string) => {
    const usd = capacityUsd[id];
    return usd === undefined
      ? null
      : {
          capacityUsd: usd,
          lowerBound: false,
          regime: 'weekend',
          samples,
          dataFrom: null,
          dataTo: measuredTo,
        };
  };
  return {
    methodVersion: 'fixture-0.1',
    provenance: 'fixture',
    covers: (id) => capacityUsd[id] !== undefined,
    exitCapacity: (id) => capacity(id),
    exitCost: (id, usd) => {
      const cap = capacityUsd[id];
      return cap === undefined ? null : cap === 0 ? null : Math.min(0.05, (0.01 * usd) / cap);
    },
    weekendRatio: () => null,
    entry: () => null,
    assess: () => {
      throw new Error('the fixture provider does not assess');
    },
    regimes: (id) => {
      if (capacityUsd[id] === undefined) return null;
      const gaps = notMeasured[id] ?? [];
      return {
        measured: REGIMES.filter((regime) => !gaps.includes(regime)),
        missing: REGIMES.filter((regime) => gaps.includes(regime)).map((regime) => ({
          regime,
          reason: 'insufficient_samples' as const,
        })),
      };
    },
    exitCostIn: () => null,
    entryCostIn: () => null,
    exitCapacityIn: () => null,
  };
}

/** A context with the fixture yields and the fixture liquidity, at a fixed time. */
export function fixtureContext(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    now: NOW,
    yields: fixtureYields(),
    liquidity: fixtureLiquidity(),
    liquiditySource: LIQUIDITY_SOURCE,
    ...over,
  };
}

/** A sheet for a person on Solana: a plan lives on one chain, the one the person signed in with. */
export function sheet(over: Partial<PersonalSheet> = {}): PersonalSheet {
  return {
    basketType: 'standard',
    goal: 'grow',
    amountUsd: 10_000,
    horizonMonths: 120,
    risk: 'medium',
    themes: [],
    country: 'BR',
    chains: ['solana'],
    rules: { useHoldings: true, glide: true },
    language: 'en',
    ...over,
  };
}

/** MOCK: a cash token in reais on Solana, for tests only; the launch shelf lists none. */
export const reaisToken = (): BasketAsset => {
  const usdc = launchShelf().assets.find((a) => a.id === 'solana:usdc');
  if (!usdc) throw new Error('no USDC on the launch shelf');
  return {
    ...usdc,
    id: 'solana:brlx',
    symbol: 'BRLX',
    underlying: 'BRL',
    issuer: 'brlx',
    currency: 'BRL',
    provenance: 'fixture',
  };
};
export const withReais = (shelf: Shelf = launchShelf()): Shelf => ({
  ...shelf,
  assets: [...shelf.assets, reaisToken()],
});

/** MOCK: a rate of dollars into reais, labelled as a fixture. */
export const usdBrl = (value = 5.5): FxObservation => ({
  pair: 'USDBRL',
  value,
  source: 'test fixture (MOCK)',
  method: 'fixed in the test',
  fetchedAt: NOW,
  provenance: 'fixture',
});

/** MOCK: a second rate-only token on Robinhood Chain, for the shared-pool test; the shelf lists one. */
export const secondRateToken = (): BasketAsset => {
  const sgov = launchShelf().assets.find((a) => a.id === 'robinhood:sgov');
  if (!sgov) throw new Error('no SGOV on the launch shelf');
  return {
    ...sgov,
    id: 'robinhood:usdy',
    symbol: 'USDY',
    underlying: 'USDY',
    issuer: 'usdy-fixture',
    provenance: 'fixture',
  };
};

/** MOCK: the SGOV reading again, for `secondRateToken`, labelled as a fixture. */
export const secondRateYield = (): YieldObservation => {
  const sgov = fixtureYields().find((y) => y.assetId === 'robinhood:sgov');
  if (!sgov) throw new Error('no SGOV reading in the fixtures');
  return {
    ...sgov,
    assetId: 'robinhood:usdy',
    source: 'test fixture (MOCK)',
    provenance: 'fixture',
  };
};

/**
 * The fixture provider, where some tokens sell into one pool: each pool takes at most its figure in
 * one window for all its tokens together, whatever each token's own figure says.
 */
export function pooledLiquidity(
  capacityUsd: Record<string, number>,
  poolOf: Record<string, string>,
  poolCapacityUsd: Record<string, number>,
): RegimeLiquidityProvider & PooledLiquidityProvider {
  return {
    ...fixtureLiquidity(capacityUsd),
    poolOf: (id) => {
      const pool = poolOf[id];
      const capacity = pool === undefined ? undefined : poolCapacityUsd[pool];
      return pool === undefined || capacity === undefined ? null : { pool, capacityUsd: capacity };
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// What the tests measure a plan with, written apart from the engine: it reads the plan, the shelf and
// the parameter table, and never the engine's own working.

const cents = (usd: number) => Math.round(usd * 100);
const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);

/** Each asset's share of the plan in basis points. */
export function weights(plan: PersonalProposal): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of plan.lines) out.set(l.assetId, (out.get(l.assetId) ?? 0) + l.weightBps);
  return out;
}

/** How far apart two plans are: the basis points that would have to move, by asset. */
export function distanceBps(a: PersonalProposal, b: PersonalProposal): number {
  const [x, y] = [weights(a), weights(b)];
  const keys = new Set([...x.keys(), ...y.keys()]);
  return sum([...keys].map((k) => Math.abs((x.get(k) ?? 0) - (y.get(k) ?? 0)))) / 2;
}

/**
 * How far apart two plans are in shape: the basis points that would have to move between the four
 * sleeves. Unlike `distanceBps` it does not see which token or which chain carries a sleeve.
 */
export function sleeveDistanceBps(a: PersonalProposal, b: PersonalProposal): number {
  const of = (plan: PersonalProposal, sleeve: Sleeve) =>
    plan.sleeves.find((x) => x.sleeve === sleeve)?.weightBps ?? 0;
  return sum(SLEEVES.map((sleeve) => Math.abs(of(a, sleeve) - of(b, sleeve)))) / 2;
}

export function allReasons(plan: PersonalProposal): Reason[] {
  return [...plan.lines.flatMap((l) => l.reasons), ...plan.removed.flatMap((r) => r.reasons)];
}

/** The reasons `next` has and `base` has not that name `input`. */
export function newReasonsNaming(
  base: PersonalProposal,
  next: PersonalProposal,
  input: string,
): Reason[] {
  const key = (r: Reason) => `${r.rule} ${JSON.stringify(r.params)}`;
  const before = new Set(allReasons(base).map(key));
  return allReasons(next).filter((r) => !before.has(key(r)) && r.inputs.includes(input));
}

/** The share of a plan in one sleeve, in basis points, read from its lines and the shelf. */
export function sleeveBps(plan: PersonalProposal, shelf: Shelf, sleeve: Sleeve): number {
  const cls = new Map(shelf.assets.map((a) => [a.id, a.cls]));
  return sum(
    plan.lines
      .filter((l) => sleeveOfClass(cls.get(l.assetId) ?? 'cash') === sleeve)
      .map((l) => l.weightBps),
  );
}

/** A token's measured exit capacity in dollars, or null when the provider has no measurement of it. */
export function measuredCapacityUsd(asset: BasketAsset, ctx: ComposeContext): number | null {
  if (!ctx.liquidity?.covers(asset.id)) return null;
  const P = ctx.params ?? PERSONAL_PARAMS;
  const measured = ctx.liquidity.exitCapacity(asset.id, P.tau, EXIT_WINDOW_DAYS);
  return measured && measured.samples > 0 ? measured.capacityUsd : null;
}

/**
 * The most dollars one token may hold (gate EXIT-SOURCE): where its exit capacity is measured, the
 * share of it a plan may count on; where it is not, the ceiling of its tier.
 */
export function ceilingUsd(asset: BasketAsset, ctx: ComposeContext): number {
  const P = ctx.params ?? PERSONAL_PARAMS;
  const capacity = measuredCapacityUsd(asset, ctx);
  return capacity === null ? P.tierCeilingUsd[asset.tier] : P.shareOfDepth * capacity;
}

/**
 * The most of the plan one dollar-yield token may hold, in basis points (gate SOLVER-PARAMS): its
 * symbol's row, otherwise the smallest of its leg types' rows. Null for a token with no leg type.
 */
export function yieldCapBps(asset: BasketAsset, table: PersonalParameters): number | null {
  const row = LEG_TYPES[asset.symbol];
  if (!row) return null;
  return (
    table.capPerAssetBps.bySymbol[asset.symbol] ??
    Math.min(...row.types.map((t) => table.capPerAssetBps.byLegType[t] ?? 10_000))
  );
}

/** A table whose dollar-yield limits never bind: for the tests of the sleeves, not of the fill. */
export function roomyYield(table: PersonalParameters = PERSONAL_PARAMS): PersonalParameters {
  return {
    ...table,
    capPerAssetBps: {
      bySymbol: {},
      byLegType: { rate: 10_000, credit: 10_000, basis: 10_000, market_deposit: 10_000 },
    },
    issuerCapBps: 10_000,
    creditShareBps: { none: 0, limited: 10_000, accept: 10_000 },
  };
}

/**
 * What the sleeves of a plan should be, worked out here from the table's numbers alone. It shares no
 * code with the engine, so a test that compares the two holds the engine to the table, not to itself.
 *
 * The row for the goal and the risk gives stocks and crypto, dollar yield and gold; cash is the rest.
 * Then three floors, each filled from stocks first and then gold: dollar yield for the date, cash for
 * how soon the money may be needed (which may also take from dollar yield), and dollar yield plus
 * cash for what must not be lost. A floor is the largest step whose months have not passed.
 */
export function expectedSleeves(
  sheetOf: PersonalSheet,
  table: PersonalParameters,
): Record<Sleeve, number> {
  // A stated mix (gate EXPLICIT-MIX) is the row, of the whole plan; the floors still apply.
  const mix = sheetOf.mix;
  const row = mix
    ? { growthBps: mix.growthBps, dollarYieldBps: mix.dollarYieldBps, goldBps: mix.goldBps }
    : table.sleeves[`${sheetOf.goal}:${sheetOf.risk}`];
  if (!row) throw new Error('no row');
  // With a split (gate SLEEVES), the goal sleeve's share scales the row and the date's floors; the
  // safe-yield share counts toward what must not be lost. The result is the goal sleeve only.
  const share = (kind: string) =>
    (sheetOf.sleeves ?? [{ kind: 'goal', shareBps: 10_000 }])
      .filter((x) => x.kind === kind)
      .reduce((n, x) => n + x.shareBps, 0);
  const goalBps = share('goal');
  const safeBps = share('safe_yield');
  const scaled = (bps: number) => Math.floor((bps * goalBps) / 10_000);
  const scaledUp = (bps: number) => Math.ceil((bps * goalBps) / 10_000);
  let growth = scaled(row.growthBps);
  let dollarYield = scaled(row.dollarYieldBps);
  let gold = scaled(row.goldBps);
  let cash = goalBps - growth - dollarYield - gold;
  const fromStocksThenGold = (need: number) => {
    const stocks = Math.min(growth, need);
    const metal = Math.min(gold, need - stocks);
    growth -= stocks;
    gold -= metal;
    return stocks + metal;
  };
  const floorOf = (
    steps: { monthsLeft: number }[],
    months: number,
    read: (step: never) => number,
  ) =>
    Math.max(
      0,
      ...steps.filter((step) => months <= step.monthsLeft).map((step) => read(step as never)),
    );

  const { glide } = sheetOf.rules;
  if (glide) {
    const least = scaledUp(
      floorOf(
        table.glideFloor,
        sheetOf.horizonMonths,
        (s: { dollarYieldBps: number }) => s.dollarYieldBps,
      ),
    );
    if (dollarYield < least) dollarYield += fromStocksThenGold(least - dollarYield);
  }
  const said = sheetOf.limits?.mayNeedInMonths;
  const soon = glide ? Math.min(said ?? sheetOf.horizonMonths, sheetOf.horizonMonths) : said;
  if (soon !== undefined) {
    const least = scaledUp(floorOf(table.cashFloor, soon, (s: { cashBps: number }) => s.cashBps));
    if (cash < least) {
      const found = fromStocksThenGold(least - cash);
      const fromYield = Math.min(dollarYield, least - cash - found);
      dollarYield -= fromYield;
      cash += found + fromYield;
    }
  }
  const keep = sheetOf.limits?.mustKeepUsd ?? 0;
  if (keep > 0) {
    const least = Math.min(10_000, Math.ceil((cents(keep) * 10_000) / cents(sheetOf.amountUsd)));
    if (dollarYield + cash + safeBps < least)
      dollarYield += fromStocksThenGold(least - dollarYield - cash - safeBps);
  }
  return { growth, dollarYield, gold, cash };
}

/** The sleeve of a line's token: growth, dollar yield, gold or cash. */
function sleeveOfAsset(byId: Map<string, BasketAsset>, l: { assetId: string }): Sleeve | null {
  const a = byId.get(l.assetId);
  return a ? sleeveOfClass(a.cls) : null;
}

/** The risks in order, lowest first: written here, not read from the engine. */
const RISK_ORDER: readonly RiskLevel[] = ['low', 'medium', 'high'];

/**
 * The same table with the caps of one risk at every risk: whatever risk a plan then takes, these are
 * the caps it is held to. It is how a test asks "what would this plan hold at that risk?" of the
 * engine as a whole, with no helper of the engine's in between.
 */
export function withCapsOf(table: PersonalParameters, risk: RiskLevel): PersonalParameters {
  const every = (cap: number | undefined) => ({ low: cap ?? 0, medium: cap ?? 0, high: cap ?? 0 });
  return {
    ...table,
    capPerStockBps: every(table.capPerStockBps[risk]),
    capPerIssuerBps: every(table.capPerIssuerBps[risk]),
  };
}

/**
 * What a person adds to a mix that can raise the risk the plan takes, as the sheet and the context
 * carry it: written here, not read from the engine. `back` puts one of them on the mix alone.
 */
const RAISED_BY: {
  id: string;
  on: (s: PersonalSheet, ctx: ComposeContext) => boolean;
  back: (alone: PersonalSheet, s: PersonalSheet) => PersonalSheet;
}[] = [
  {
    id: 'withdrawals',
    on: (s) => (s.obligations ?? []).length > 0,
    back: (alone, s) => ({ ...alone, obligations: s.obligations ?? [] }),
  },
  {
    id: 'holdings',
    on: (s, ctx) => s.rules.useHoldings && (ctx.holdings ?? []).length > 0,
    back: (alone) => ({ ...alone, rules: { useHoldings: true, glide: false } }),
  },
  {
    id: 'cannotHold',
    on: (s) => s.limits?.cannotHold !== undefined,
    back: (alone, s) => ({ ...alone, limits: { cannotHold: s.limits?.cannotHold ?? {} } }),
  },
  {
    id: 'limits',
    on: (s) =>
      s.limits?.mustKeepUsd !== undefined ||
      s.limits?.mayNeedInMonths !== undefined ||
      s.limits?.creditTolerance !== undefined,
    back: (alone, s) => {
      const { mustKeepUsd, mayNeedInMonths, creditTolerance } = s.limits ?? {};
      return {
        ...alone,
        limits: {
          ...(mustKeepUsd !== undefined ? { mustKeepUsd } : {}),
          ...(mayNeedInMonths !== undefined ? { mayNeedInMonths } : {}),
          ...(creditTolerance !== undefined ? { creditTolerance } : {}),
        },
      };
    },
  },
  {
    id: 'date',
    on: (s) => s.rules.glide,
    back: (alone) => ({ ...alone, rules: { useHoldings: false, glide: true } }),
  },
];

/** The mix on its own: the sheet with no withdrawal, no holding counted, no date and no limit. */
function mixOnItsOwn(s: PersonalSheet): PersonalSheet {
  const alone: PersonalSheet = { ...s, rules: { useHoldings: false, glide: false } };
  delete alone.obligations;
  delete alone.limits;
  return alone;
}

/** The rules that say something was left out. */
const LEFT_OUT = ['MAX_LINES', 'BELOW_MINIMUM', 'EXCLUDED', 'NOT_FOR_GOAL', 'NOT_ON_CHAIN'];

/**
 * Everything a plan must be, whatever the inputs and the numbers: the vault's target rules, the
 * ceilings and caps, nothing the person cannot hold, a reason on every line, sums that add up.
 * Returns what is wrong, in words. An empty list is a plan in order.
 */
export function violations(plan: PersonalProposal, shelf: Shelf, given: ComposeContext): string[] {
  // A candidate is held to its own table: the person's, moved toward its aim (gate THREE-PLANS).
  const base = given.params ?? PERSONAL_PARAMS;
  const P = tableFor(base, plan.candidate ?? null);
  const ctx: ComposeContext = { ...given, params: P };
  const wrong: string[] = [];
  const say = (ok: boolean, what: string) => {
    if (!ok) wrong.push(what);
  };
  const byId = new Map(shelf.assets.map((a) => [a.id, a]));
  const portfolios = shelf.families.map((f) => f.meta.name);
  const s = plan.sheet;
  const amount = cents(s.amountUsd);

  // A figure with no time or no source is listed as it is, and flagged: it is not the shared type.
  const complete = plan.observations.filter((o) => o.source !== null && o.fetchedAt !== null);
  for (const o of plan.observations) {
    say(
      o.source !== null || plan.flags.includes(`${o.kind}_unsourced`),
      `${o.id}: no source, no flag`,
    );
    say(
      o.fetchedAt !== null || plan.flags.includes(`${o.kind}_undated:${o.id}`),
      `${o.id}: no time, no flag`,
    );
    say(
      o.provenance === 'live' || plan.flags.includes(`${o.kind}_provenance:${o.provenance}`),
      `${o.id}: ${o.provenance} and not labelled`,
    );
  }
  const parsed = BasketProposal.safeParse({ ...plan, observations: complete });
  say(
    parsed.success,
    `not a BasketProposal: ${parsed.success ? '' : parsed.error.issues[0]?.message}`,
  );
  say(plan.disclaimer === DISCLAIMER[s.language], 'the disclaimer is not the one constant');

  // Lines: each asset once, whole basis points adding up to 10,000, dollars adding up to the amount.
  say(
    new Set(plan.lines.map((l) => l.assetId)).size === plan.lines.length,
    'an asset is on two lines',
  );
  say(sum(plan.lines.map((l) => l.weightBps)) === 10_000, 'the lines do not add up to 10,000');
  say(
    sum(plan.lines.map((l) => cents(l.amountUsd))) === amount,
    'the lines do not add up to the amount',
  );
  for (const l of plan.lines) {
    const a = byId.get(l.assetId);
    if (!a) {
      wrong.push(`${l.assetId} is not on the shelf`);
      continue;
    }
    say(Number.isInteger(l.weightBps) && l.weightBps >= 0, `${l.assetId}: weight is not whole bps`);
    say(a.chain === l.chain && s.chains.includes(l.chain), `${l.assetId} is on a chain not funded`);
    say(l.reasons.length > 0, `${l.assetId} has no reason`);
    say(
      l.reasons.some((r) => r.inputs.length > 0),
      `${l.assetId} has no reason that names an input`,
    );
    for (const r of l.reasons) {
      say(r.rule in REASON_TEMPLATES, `${l.assetId}: unknown rule ${r.rule}`);
      // No hole and no empty subject: every value is there, and the sentence starts with a word.
      say(
        r.text.length > 0 && !/[{}]|undefined|NaN|^\s|\s\s|\s[:,.]/.test(r.text),
        `${l.assetId}: a hole in "${r.text}"`,
      );
      say(
        Object.values(r.params).every((v) => String(v).trim() !== ''),
        `${l.assetId}: ${r.rule} has an empty value`,
      );
      for (const input of r.inputs)
        say((INPUT_NAMES as readonly string[]).includes(input), `unknown input ${input}`);
      // What a reason says is true of the line it is on. "Left out" is about another token than this
      // one, never about a shared portfolio the line holds a part of.
      if (LEFT_OUT.includes(r.rule) && a.cls !== 'cash')
        say(
          ![a.symbol, a.underlying, ...portfolios].includes(String(r.params.asset)),
          `${l.assetId} holds what its own reason says is left out: "${r.text}"`,
        );
      // "When you choose no shared portfolio" is said only to someone who chose none.
      say(r.rule !== 'SLEEVE_DEFAULT' || s.themes.length === 0, `${l.assetId}: "${r.text}"`);
      say(r.rule !== 'SLEEVE_FILLED' || s.themes.length > 0, `${l.assetId}: "${r.text}"`);
    }
    if (a.cls === 'cash') continue;

    // Nothing the person cannot hold.
    const no = s.limits?.cannotHold;
    say(eligibleForGoal(a, s.goal), `${a.id} is not eligible for a goal of ${s.goal}`);
    say(!no?.assets?.includes(a.id), `${a.id} was excluded`);
    say(
      !(no?.classes as string[] | undefined)?.includes(a.cls),
      `${a.id}: class ${a.cls} was excluded`,
    );
    say(
      !no?.underlyings?.some((u) => u.toLowerCase() === a.underlying.toLowerCase()),
      `${a.id}: ${a.underlying} was excluded`,
    );

    // No line over its ceiling.
    say(
      cents(l.amountUsd) <= Math.floor(ceilingUsd(a, ctx) * 100),
      `${a.id} holds ${l.amountUsd}, over its ceiling of ${ceilingUsd(a, ctx)}`,
    );
    // A dollar-yield token: within its cap in the plan, and only with a leg type and a yield read.
    if (a.cls === 'dollar_yield') {
      const capBps = yieldCapBps(a, P);
      say(capBps !== null, `${a.id} has no leg type and is held`);
      if (capBps !== null)
        say(
          cents(l.amountUsd) <= Math.floor((amount * capBps) / 10_000),
          `${a.id} holds ${l.amountUsd}, over its cap of ${capBps} bps`,
        );
      say(
        (ctx.yields ?? []).some((y) => y.assetId === a.id),
        `${a.id} is held with no yield read`,
      );
    }
    // A ceiling that came from a tier, not a measurement, is said on the line and flagged; one that
    // was measured is not called a tier. A measurement that leaves out a time of the week says so.
    const fromTier = measuredCapacityUsd(a, ctx) === null;
    // A line may also carry the limit of the token before it, to say why it holds the rest: the
    // check is on what the line says of its own token.
    const rules = l.reasons.filter((r) => r.params.asset === a.symbol).map((r) => r.rule);
    say(
      rules.includes('TIER_CEILING') === fromTier,
      `${a.id}: its ceiling is ${fromTier ? 'a tier and the line does not say so' : 'measured and the line calls it a tier'}`,
    );
    say(
      plan.flags.includes(`ceiling_from_tier:${a.id}`) === fromTier,
      `${a.id}: the tier-ceiling flag is ${fromTier ? 'missing' : 'misplaced'}`,
    );
    const provider = ctx.liquidity as Partial<RegimeLiquidityProvider> | undefined;
    const gaps = fromTier ? [] : (provider?.regimes?.(a.id)?.missing ?? []);
    say(
      rules.includes('EXIT_PARTLY_MEASURED') === gaps.length > 0,
      `${a.id}: ${gaps.length} times of the week are not measured, and the line ${gaps.length ? 'does not say so' : 'says some are'}`,
    );
    for (const gap of gaps)
      say(
        plan.flags.includes(`exit_regime_not_measured:${a.id}:${gap.regime}`),
        `${a.id}: no flag for ${gap.regime}`,
      );
    if (!fromTier && typeof provider?.regimes !== 'function')
      say(plan.flags.includes('exit_regimes_not_reported'), `${a.id}: regimes unknown, no flag`);

    // Stocks, crypto and gold: no return assumed, and the loss in the fall shown.
    const priced = sleeveOfClass(a.cls) !== 'dollarYield';
    const shown = l.reasons.find((r) => r.rule === 'NO_RETURN_ASSUMED');
    say(
      priced === (shown !== undefined),
      `${a.id}: the no-return line is ${priced ? 'missing' : 'misplaced'}`,
    );
    if (shown)
      say(
        Math.abs(Number(shown.params.lossUsd) - (l.amountUsd * P.fallBps) / 10_000) <= 0.011,
        `${a.id}: the loss in a fall is ${shown.params.lossUsd}`,
      );
  }

  // Caps by risk: one issuer, and one stock or crypto asset.
  const lines = plan.lines.flatMap((l) => {
    const a = byId.get(l.assetId);
    return a && a.cls !== 'cash' ? [{ a, cents: cents(l.amountUsd) }] : [];
  });
  // A matching leg is a cash token in another currency, with an issuer of its own: it counts against
  // the issuer cap as the plan's cash in dollars does not.
  const issued = [
    ...lines,
    ...plan.lines.flatMap((l) => {
      const a = byId.get(l.assetId);
      return a && a.cls === 'cash' && (a.currency ?? 'USD') !== 'USD'
        ? [{ a, cents: cents(l.amountUsd) }]
        : [];
    }),
  ];
  const total = (key: (a: BasketAsset) => string | null) => {
    const out = new Map<string, number>();
    for (const l of issued) {
      const k = key(l.a);
      if (k !== null) out.set(k, (out.get(k) ?? 0) + l.cents);
    }
    return out;
  };
  // One issuer by risk, whatever the plan holds with it: stocks, crypto, gold, dollar yield or a leg
  // in another currency, read from the lines and from no sentence. And dollar yield and gold by the
  // plan's own issuer cap, which counts those only (Rodrigo, Oct 5).
  const issuerCap = Math.floor((amount * (P.capPerIssuerBps[s.risk] ?? 0)) / 10_000);
  const planIssuerCap = Math.floor((amount * P.issuerCapBps) / 10_000);
  for (const [issuer, held] of total((a) => a.issuer))
    say(
      held <= issuerCap,
      `${issuer} holds ${held / 100} of the plan, over the ${issuerCap / 100} one issuer may hold at ${s.risk} risk`,
    );
  for (const [issuer, held] of total((a) => (sleeveOfClass(a.cls) === 'growth' ? null : a.issuer)))
    say(
      held <= planIssuerCap,
      `${issuer} holds ${held / 100} of dollar yield and gold, over ${planIssuerCap / 100}`,
    );
  // The credit budget: credit and basis legs together. A mix's credit share is the person's budget.
  const tolerance = s.limits?.creditTolerance ?? P.defaultCreditTolerance;
  const theirCreditBps = s.mix?.creditBps ?? P.creditShareBps[tolerance] ?? 0;
  const creditCap = Math.floor((amount * theirCreditBps) / 10_000);
  const credit = sum(
    lines
      .filter((l) =>
        (LEG_TYPES[l.a.symbol]?.types ?? []).some((t) => t === 'credit' || t === 'basis'),
      )
      .map((l) => l.cents),
  );
  say(credit <= creditCap, `credit and basis legs hold ${credit / 100}, over ${creditCap / 100}`);

  // The sentences of the banded fill are true of the plan they are on.
  const nonGrowthOf = (issuer: string) =>
    sum(
      issued
        .filter((l) => l.a.issuer === issuer && sleeveOfClass(l.a.cls) !== 'growth')
        .map((l) => l.cents),
    );
  const bySymbol = new Map(lines.map((l) => [l.a.symbol, l]));
  /** What the coverage check says it moved to cash from the lines of a token, or of an issuer. */
  const movedOn = (keep: (a: BasketAsset) => boolean) =>
    sum(
      plan.lines
        .filter((l) => {
          const a = byId.get(l.assetId);
          return a !== undefined && keep(a);
        })
        .flatMap((l) => l.reasons)
        .filter((x) => x.rule === 'COVERAGE_MOVED' || x.rule === 'COVERAGE_MOVED_UNCOUNTED')
        .map((x) => cents(Number(x.params.usd))),
    );
  const movedFrom = (symbol: string) => movedOn((a) => a.symbol === symbol);
  const movedFromIssuer = (issuer: string) => movedOn((a) => a.issuer === issuer);
  const ys = new Map((ctx.yields ?? []).map((y) => [y.assetId, y.haircutYield]));
  for (const r of allReasons(plan)) {
    if (
      r.rule === 'CREDIT_BUDGET' ||
      r.rule === 'CREDIT_BUDGET_UNSAID' ||
      r.rule === 'CREDIT_BUDGET_MIX'
    ) {
      say(Math.abs(credit - creditCap) <= 1, `"${r.text}" but credit holds ${credit / 100}`);
      say(
        (r.rule === 'CREDIT_BUDGET_MIX') === (s.mix?.creditBps !== undefined),
        `"${r.text}" said of a mix that ${s.mix?.creditBps !== undefined ? 'states' : 'does not state'} a credit share`,
      );
      if (r.rule !== 'CREDIT_BUDGET_MIX')
        say(
          (r.rule === 'CREDIT_BUDGET') === (s.limits?.creditTolerance !== undefined),
          `"${r.text}" said of a tolerance that was ${s.limits?.creditTolerance ? '' : 'not '}stated`,
        );
    }
    if (r.rule === 'CREDIT_NONE_MIX') {
      say(credit === 0, `"${r.text}" but credit holds ${credit / 100}`);
      say(s.mix?.creditBps === 0, `"${r.text}" said of a mix with a credit share`);
    }
    if (r.rule === 'CREDIT_NONE') {
      say(credit === 0, `"${r.text}" but credit holds ${credit / 100}`);
      say(s.limits?.creditTolerance === 'none', `"${r.text}" said to someone who did not say so`);
    }
    // A candidate's own credit limit is said only by Cover, below the person's, and holds.
    if (r.rule === 'CREDIT_NONE_PLAN' || r.rule === 'CREDIT_BUDGET_PLAN') {
      const coverBps = Math.floor((theirCreditBps * P.candidates.cover.creditOfLimitBps) / 10_000);
      const planCap = Math.floor((amount * coverBps) / 10_000);
      say(plan.candidate === 'cover', `"${r.text}" said of a plan that is not Cover`);
      // Compared in basis points, as the engine does: on a small plan both can be zero cents.
      say(coverBps < theirCreditBps, `"${r.text}" but the person's own limit is no higher`);
      say(
        r.rule === 'CREDIT_NONE_PLAN' ? credit === 0 : Math.abs(credit - planCap) <= 1,
        `"${r.text}" but credit holds ${credit / 100}`,
      );
    }
    if (r.rule === 'SHARED_EVENLY') {
      say(plan.candidate === 'spread', `"${r.text}" said of a plan that is not Spread`);
      say(
        String(r.params.assets)
          .split(',')
          .every((n) => bySymbol.has(n)),
        `"${r.text}" names a token the plan does not hold`,
      );
    }
    if (r.rule === 'ASSET_CAP') {
      const held = bySymbol.get(String(r.params.asset));
      const cap = Math.floor((amount * Number(r.params.capBps)) / 10_000);
      // The coverage check may move part of a line to cash after it was placed at its cap; the line
      // says how much. A line it moved whole is gone, and is then held to no more than the cap.
      const after = (held?.cents ?? 0) + movedFrom(String(r.params.asset));
      say(
        Math.abs(after - cap) <= 1 ||
          (plan.flags.includes('coverage_moved') && held === undefined) ||
          (movedFrom(String(r.params.asset)) > 0 && after <= cap),
        `"${r.text}" but the line holds ${held ? held.cents / 100 : 'nothing'}`,
      );
    }
    if (r.rule === 'SHARED_IN_BAND') {
      const named = String(r.params.assets).split(',');
      const held = named.map((n) => bySymbol.get(n));
      say(
        held.every((h) => h !== undefined),
        `"${r.text}" names a token the plan does not hold`,
      );
      const rates = held.map((h) => (h ? (ys.get(h.a.id) ?? Number.NaN) : Number.NaN));
      say(
        Math.max(...rates) - Math.min(...rates) <= P.yieldBand + 1e-12,
        `"${r.text}" but the yields are ${rates.join(', ')}`,
      );
    }
  }
  const stockCap = Math.floor((amount * (P.capPerStockBps[s.risk] ?? 0)) / 10_000);
  for (const [name, held] of total((a) =>
    a.cls === 'stock' || a.cls === 'crypto' ? a.underlying : null,
  ))
    say(
      held <= stockCap,
      `${name} holds ${held / 100}, over the single-stock cap of ${stockCap / 100}`,
    );

  // A stated mix (gate EXPLICIT-MIX). The mix replaces the table, so no line says the table's row. The
  // limits are those of the lowest risk at which the plan holds the most in stocks and crypto, worked
  // out here by composing plans, and the plan says which. Each class of the mix is held, or the lines
  // of that class account for what kept it from it.
  const saidRules = new Set(allReasons(plan).map((r) => r.rule));
  if (!s.mix) {
    for (const rule of [
      'MIX',
      'MIX_ALL',
      'MIX_LIMITS',
      'MIX_LIMITS_RAISED',
      'MIX_ODD_CENTS',
      'MIX_SET_ASIDE',
      'CREDIT_BUDGET_MIX',
      'CREDIT_NONE_MIX',
    ])
      say(!saidRules.has(rule), `${rule} said of a plan with no mix`);
    say(
      !plan.flags.some((f) => f.startsWith('limits_from_mix:') || f.startsWith('limits_raised:')),
      'the limits of a mix are flagged on a plan with no mix',
    );
  } else {
    const mix = s.mix;
    say(s.goal === 'grow' || mix.growthBps === 0, `a mix with stocks in a plan for ${s.goal}`);
    say(!saidRules.has('SLEEVE'), 'the table row is said of a plan with a mix');
    say(
      plan.flags.includes(`limits_from_mix:${s.risk}`),
      `the plan does not say it takes the limits for ${s.risk} risk from the mix`,
    );
    const [lowest = s.risk] = RISK_ORDER;
    if (mix.growthBps > 0)
      say(
        saidRules.has('MIX_LIMITS') || !plan.lines.some((l) => sleeveOfAsset(byId, l) === 'growth'),
        'the plan holds stocks for a mix and does not say which limits it took',
      );
    // The limits it names are the table's for the plan's risk, and the share it takes them for is no
    // more than the mix's: what is set aside and the floors can only leave stocks less.
    for (const r of allReasons(plan).filter((x) => x.rule === 'MIX_LIMITS')) {
      say(
        r.params.risk === s.risk &&
          r.params.stockCapBps === P.capPerStockBps[s.risk] &&
          r.params.issuerCapBps === P.capPerIssuerBps[s.risk],
        `"${r.text}" does not name the caps of ${s.risk} risk`,
      );
      say(
        Number(r.params.sleeveBps) > 0 && Number(r.params.sleeveBps) <= mix.growthBps,
        `"${r.text}" names a share the mix does not leave stocks and crypto`,
      );
    }
    // The risk, worked out again from what plans hold, and from no sentence of theirs and no helper of
    // the engine's: the person's own plan for a sheet is composed under the caps of each risk in turn
    // (`withCapsOf`), and what it holds in stocks and crypto is read off its lines. The rule: the
    // lowest risk at which the plan holds the most, to a cent for each line a plan may hold, which is
    // the rounding of its parts. So no lower risk holds as much, and no higher risk holds more. A
    // candidate takes the risk of the person's own plan, so it is held to the same.
    const at = (r: RiskLevel) => RISK_ORDER.indexOf(r);
    const stocksOf = (made: PersonalProposal) =>
      sum(
        made.lines
          .filter((l) => sleeveOfAsset(byId, l) === 'growth')
          .map((l) => cents(l.amountUsd)),
      );
    const heldAt = (sheetOf: PersonalSheet) =>
      RISK_ORDER.map((r) =>
        stocksOf(compose(sheetOf, shelf, { ...given, params: withCapsOf(base, r) })),
      );
    const riskOf = (sheetOf: PersonalSheet, held = heldAt(sheetOf)): RiskLevel => {
      if ((sheetOf.mix?.growthBps ?? 0) === 0) return lowest;
      const most = Math.max(...held);
      return RISK_ORDER[held.findIndex((c) => c + base.maxLinesPerChain >= most)] ?? lowest;
    };
    const stocksAt = mix.growthBps > 0 ? heldAt(plan.sheet) : RISK_ORDER.map(() => 0);
    const due = riskOf(plan.sheet, stocksAt);
    const usd = (r: RiskLevel) => (stocksAt[at(r)] ?? 0) / 100;
    if (at(s.risk) > at(due))
      say(
        false,
        `the plan took the limits of ${s.risk} risk, and at ${due} risk it holds as much in stocks and crypto (${usd(due)} against ${usd(s.risk)})`,
      );
    if (at(s.risk) < at(due))
      say(
        false,
        `the plan took the limits of ${s.risk} risk and holds ${usd(s.risk)} in stocks and crypto, where at ${due} risk it holds ${usd(due)}`,
      );
    // The person's own plan holds what the plan composed under the caps of its risk holds.
    if (!plan.candidate && mix.growthBps > 0)
      say(
        stocksOf(plan) === stocksAt[at(s.risk)],
        `the plan holds ${stocksOf(plan) / 100} in stocks and crypto, and under the caps of ${s.risk} risk it holds ${usd(s.risk)}`,
      );
    // Where the risk is above the one the mix takes on its own (the same sheet with nothing else of
    // the person's on it), the plan says so on its stocks and crypto, with a flag, and names what
    // raised it: each thing put back by itself that takes a higher risk than the mix alone, or all of
    // them where none does by itself. Otherwise it says no such thing.
    const there = RAISED_BY.filter((x) => x.on(plan.sheet, given));
    const alone = mixOnItsOwn(plan.sheet);
    const own = there.length > 0 ? riskOf(alone) : due;
    const raised = allReasons(plan).filter((r) => r.rule === 'MIX_LIMITS_RAISED');
    const raisedFlags = plan.flags.filter((f) => f.startsWith('limits_raised:'));
    if (at(due) > at(own) && s.risk === due) {
      const each = there.filter((x) => at(riskOf(x.back(alone, plan.sheet))) > at(own));
      const by = (each.length > 0 ? each : there).map((x) => x.id).join(',');
      const wanted = { alone: own, risk: due, by, steps: at(due) - at(own) };
      say(
        raised.length > 0 &&
          raised.every((r) => JSON.stringify(r.params) === JSON.stringify(wanted)),
        `the limits are above the ones the mix takes on its own (${own} risk) because of ${by}, and the plan says ${JSON.stringify(raised.map((r) => r.params))}`,
      );
      say(
        raisedFlags.length === 1 && raisedFlags[0] === `limits_raised:${own}:${by}`,
        `the flag for limits above the mix's own is ${JSON.stringify(raisedFlags)}, not limits_raised:${own}:${by}`,
      );
      for (const l of plan.lines)
        if (sleeveOfAsset(byId, l) === 'growth')
          say(
            l.reasons.some((r) => r.rule === 'MIX_LIMITS_RAISED'),
            `${l.assetId} does not say the limits are above the ones the mix takes on its own`,
          );
    } else if (s.risk === due)
      say(
        raised.length === 0 && raisedFlags.length === 0,
        `the plan says its limits are above the ones the mix takes on its own, and they are not: ${own} risk alone, ${due} with all of the sheet`,
      );
    // Every class of the mix against what the plan holds: stocks and crypto, dollar yield, gold and
    // cash. Where a class holds less than asked, a reason says why on the lines of that class, or on
    // the line that took in what was meant for it: a rule that can keep money out of that class, and
    // not any rule anywhere. Where it holds more, a line of that class says what it took in. Stocks,
    // crypto and gold never hold more than asked, but for what the person already holds elsewhere.
    const stated: Record<Sleeve, number> = {
      growth: mix.growthBps,
      dollarYield: mix.dollarYieldBps,
      gold: mix.goldBps,
      cash: mix.cashBps,
    };
    const linesOf = (sleeve: Sleeve) => plan.lines.filter((l) => sleeveOfAsset(byId, l) === sleeve);
    const heldOf = (sleeve: Sleeve) => sum(linesOf(sleeve).map((l) => l.weightBps));
    // Lines are whole basis points, so each may move its class by one; and money is whole cents, so
    // each class may be a cent off its share, which on a plan of a few dollars is many basis points.
    const slack = plan.lines.length + Math.ceil((SLEEVES.length * 10_000) / amount);
    const everyReason = allReasons(plan);
    /** The reasons that speak for a class: on its own lines, or anywhere when it holds no line. */
    const spokenFor = (sleeve: Sleeve) =>
      linesOf(sleeve).length > 0 ? linesOf(sleeve).flatMap((l) => l.reasons) : everyReason;
    /** The names a sentence can call a class's assets by: the shelf's, and the table's own tickers. */
    const namesIn = (sleeve: Sleeve) =>
      new Set([
        ...shelf.assets
          .filter((a) => sleeveOfClass(a.cls) === sleeve)
          .flatMap((a) => [a.underlying, a.symbol]),
        ...(sleeve === 'growth' ? [P.defaultUnderlying.growth] : []),
        ...(sleeve === 'gold' ? P.defaultUnderlying.gold : []),
      ]);
    /** Money meant for this class that a line says is held in dollar yield or cash instead. */
    const overflowOf = (sleeve: Sleeve) =>
      everyReason.filter(
        (r) =>
          r.rule.startsWith('OVERFLOW_') &&
          String(r.params.assets ?? '')
            .split(',')
            .some((name) => namesIn(sleeve).has(name)),
      );
    const setAsideFrom = (sleeve: Sleeve) =>
      everyReason.filter((r) => r.rule === 'MIX_SET_ASIDE' && r.params.sleeve === sleeve);
    const FLOORS = ['GLIDE', 'CASH_MAY_NEED', 'CASH_NEAR_DATE', 'MUST_KEEP'];
    /** The reasons that can leave a class holding less than the mix asks, as this plan gives them. */
    const whyLess = (sleeve: Sleeve): Reason[] => {
      const on = spokenFor(sleeve);
      const cashLine = linesOf('cash').flatMap((l) => l.reasons);
      const rules = (from: Reason[], ...names: string[]) =>
        from.filter((r) => names.includes(r.rule));
      const heldAlready = plan.removed
        .filter((x) => namesIn(sleeve).has(x.ref))
        .flatMap((x) => x.reasons.filter((r) => r.rule === 'ALREADY_HELD_NONE'));
      // A target rounded down to its token's ceiling: the basis point stays in cash, said there.
      const rounded = cashLine.filter(
        (r) => r.rule === 'ROUNDING' && namesIn(sleeve).has(String(r.params.asset)),
      );
      if (sleeve === 'growth' || sleeve === 'gold')
        return [
          ...setAsideFrom(sleeve),
          // The date, the need for cash and what must not be lost: filled from stocks first, then gold.
          ...rules(on, ...FLOORS),
          // A cap, a ceiling, a line that is not there, a token that cannot be held: said where the
          // money went, with the names it was meant for.
          ...overflowOf(sleeve),
          ...rules(on, 'ALREADY_HELD', 'COVERAGE_MOVED_UNCOUNTED'),
          ...heldAlready,
          ...rounded,
        ];
      if (sleeve === 'dollarYield')
        return [
          ...setAsideFrom(sleeve),
          // The need for cash may take from dollar yield, after stocks and gold.
          ...rules(on, 'CASH_MAY_NEED', 'CASH_NEAR_DATE', 'COVERAGE_MOVED'),
          // What no dollar-yield token took stays in cash, and the cash line says so.
          ...rules(cashLine, 'UNPLACED', 'NO_DOLLAR_YIELD', 'YIELD_TOO_SMALL', 'SET_ASIDE_CASH'),
          ...rounded,
        ];
      // Cash gives only to what is set aside, where that is held in a rate leg.
      return setAsideFrom(sleeve);
    };
    /** The rules that bring money into a class the mix did not give it. */
    const TAKES_IN: Record<Sleeve, string[]> = {
      growth: ['MORE_BECAUSE_HELD'],
      gold: ['MORE_BECAUSE_HELD'],
      dollarYield: ['GLIDE', 'MUST_KEEP', 'SET_ASIDE', 'MORE_BECAUSE_HELD'],
      cash: [
        'CASH_MAY_NEED',
        'CASH_NEAR_DATE',
        'MUST_KEEP',
        'SET_ASIDE',
        'COVERAGE_CASH',
        'UNPLACED',
        'NO_DOLLAR_YIELD',
        'YIELD_TOO_SMALL',
        'ROUNDING',
        'MIX_ODD_CENTS',
        'MORE_BECAUSE_HELD',
      ],
    };
    // The odd cents of the split: said only where the mix has no cash, on the cash line, and never
    // more than a cent for each of the three classes that are rounded down.
    for (const l of plan.lines)
      for (const r of l.reasons.filter((x) => x.rule === 'MIX_ODD_CENTS')) {
        say(
          byId.get(l.assetId)?.cls === 'cash',
          `${l.assetId}: "${r.text}" is not on the cash line`,
        );
        say(
          mix.cashBps === 0 && cents(Number(r.params.usd)) > 0 && cents(Number(r.params.usd)) < 4,
          `"${r.text}" said of a mix with ${mix.cashBps} bps in cash`,
        );
      }
    /** Whether something the person already holds moved the plan: said on a line, or of what was left out. */
    const holdingMoved = [...everyReason, ...plan.removed.flatMap((x) => x.reasons)].some((r) =>
      ['ALREADY_HELD', 'ALREADY_HELD_NONE', 'MORE_BECAUSE_HELD', 'OVERFLOW_HELD'].includes(r.rule),
    );
    for (const sleeve of SLEEVES) {
      const [held, asked] = [heldOf(sleeve), stated[sleeve]];
      if (held < asked - slack) {
        const why = whyLess(sleeve);
        say(
          why.length > 0,
          `${sleeve} holds ${held} bps of the ${asked} asked, and no line of it says why`,
        );
        // The reasons account for the money that is missing, and are not merely there (review 2 of
        // Oct 6, finding 3): what each says it set aside, kept out or moved adds up to what the class
        // is short of. A sentence said on every line of the class is counted once; one about a line's
        // own dollars (the coverage check) is counted line by line.
        const once = new Map<string, Reason>();
        const each: Reason[] = [];
        for (const r of why)
          if (r.rule.startsWith('COVERAGE_MOVED')) each.push(r);
          else once.set(`${r.rule} ${JSON.stringify(r.params)}`, r);
        const counted = [...once.values(), ...each];
        const KEPT_OUT = ['UNPLACED', 'NO_DOLLAR_YIELD', 'YIELD_TOO_SMALL', 'SET_ASIDE_CASH'];
        /** What a reason says it took from the class, in basis points of the plan; null when it names no amount. */
        const takes = (r: Reason): number | null => {
          if (r.rule === 'MIX_SET_ASIDE')
            return Number(r.params.askedBps) - Number(r.params.leftBps);
          if (r.rule === 'ROUNDING') return Number(r.params.bps);
          const names = r.rule.startsWith('OVERFLOW_') || r.rule.startsWith('COVERAGE_MOVED');
          if (typeof r.params.usd === 'number' && (names || KEPT_OUT.includes(r.rule)))
            return (cents(r.params.usd) * 10_000) / amount;
          return null;
        };
        // A floor (the date, the need for cash, what must not be lost) names its level and not what
        // it moved: where nothing is set aside for withdrawals, the table's own arithmetic says what
        // the floors leave the class (`expectedSleeves`, which shares no code with the engine). What
        // a holding moves is stated by no sentence, and it moves every class, since the plan is then
        // sized on what the person has in all; and floors beside withdrawals are not worked out
        // here. In those two cases the reason is required to be there, and no more.
        const allSay = counted.every((r) => takes(r) !== null);
        const floorsBeside = counted.every((r) => takes(r) !== null || FLOORS.includes(r.rule));
        const share = holdingMoved
          ? null
          : allSay
            ? asked
            : floorsBeside && (s.obligations ?? []).length === 0
              ? expectedSleeves(plan.sheet, P)[sleeve]
              : null;
        if (share !== null) {
          const accounted = sum(counted.map((r) => takes(r) ?? 0));
          say(
            // Each sentence states its amount to the cent or to the basis point: one point for each.
            held >= share - accounted - slack - counted.length,
            `${sleeve} holds ${held} bps where its share is ${share}, and its lines account for ${Math.round(accounted)} of the ${share - held} missing`,
          );
        }
      }
      if (held > asked + slack) {
        const on = linesOf(sleeve).flatMap((l) => l.reasons);
        const takesIn = (r: Reason) =>
          TAKES_IN[sleeve].includes(r.rule) ||
          // What stocks, crypto and gold could not take is held in dollar yield, then in cash.
          (r.rule.startsWith('OVERFLOW_') && (sleeve === 'dollarYield' || sleeve === 'cash'));
        say(
          on.some(takesIn),
          `${sleeve} holds ${held} bps, over the ${asked} of the mix, and no line of it says why`,
        );
      }
    }
  }

  // The person's split (gate SLEEVES): each sleeve's share and dollars as asked, and the safe-yield
  // sleeve in rate legs and cash only, never more of a token than its line holds.
  const lineUsd = new Map(plan.lines.map((l) => [l.assetId, cents(l.amountUsd)]));
  const splitSaid = allReasons(plan).filter((r) => r.rule.startsWith('SPLIT_'));
  if (!s.sleeves) {
    say(plan.split === undefined, 'a split on a plan whose sheet has none');
    say(splitSaid.length === 0, `"${splitSaid[0]?.text}" said of a plan with no split`);
  } else {
    say(
      JSON.stringify(plan.split?.map((x) => [x.kind, x.shareBps])) ===
        JSON.stringify(s.sleeves.map((x) => [x.kind, x.shareBps])),
      'the split on the plan is not the one asked for',
    );
    say(
      sum((plan.split ?? []).map((x) => cents(x.amountUsd))) === amount,
      'the sleeves do not add up to the amount',
    );
    for (const x of plan.split ?? []) {
      say(
        Math.abs(cents(x.amountUsd) - (amount * x.shareBps) / 10_000) <= 1,
        `the ${x.kind} sleeve holds ${x.amountUsd}, not its share of ${x.shareBps} bps`,
      );
      if (x.kind !== 'safe_yield') continue;
      say(
        sum(x.holds.map((h) => cents(h.amountUsd))) === cents(x.amountUsd),
        'the safe-yield sleeve holds more or less than its dollars',
      );
      for (const h of x.holds) {
        const a = byId.get(h.assetId);
        const rateOnly =
          a?.cls === 'cash' ||
          (a?.cls === 'dollar_yield' &&
            (LEG_TYPES[a.symbol]?.types ?? []).length > 0 &&
            (LEG_TYPES[a.symbol]?.types ?? []).every((t) => t === 'rate'));
        say(rateOnly, `the safe-yield sleeve holds ${h.assetId}, which is not a rate leg`);
        // Lines are rounded to whole basis points after the sleeves are filled: a cent or two.
        const slack = Math.ceil(amount / 10_000) + 1;
        say(
          cents(h.amountUsd) <= (lineUsd.get(h.assetId) ?? 0) + slack,
          `the safe-yield sleeve holds ${h.amountUsd} of ${h.assetId}, more than its line`,
        );
      }
    }
    const goalShare = s.sleeves.find((x) => x.kind === 'goal')?.shareBps ?? 0;
    for (const r of splitSaid)
      if (r.rule === 'SPLIT_GOAL')
        say(
          goalShare < 10_000 && Number(r.params.shareBps) === goalShare,
          `"${r.text}" but the goal sleeve is ${goalShare} bps`,
        );
  }
  // A goal in dollars has no open-FX line; a goal in another currency has one on every line not
  // counted in it, and the flag.
  const goalCurrency = s.currency ?? 'USD';
  say(
    plan.flags.includes(`fx_open:${goalCurrency}`) === (goalCurrency !== 'USD'),
    `the open-FX flag does not match a goal in ${goalCurrency}`,
  );
  for (const l of plan.lines) {
    const inGoal = (byId.get(l.assetId)?.currency ?? 'USD') === goalCurrency;
    say(
      l.reasons.some((r) => r.rule === 'FX_OPEN') === !inGoal,
      `${l.assetId}: the open-FX line is ${inGoal ? 'misplaced' : 'missing'}`,
    );
  }

  // Withdrawals (slice 2): the next `setAsideMonths` of them are set aside in cash, the matching legs
  // and rate legs, and what the plan says of them is true of it. Converted here at the latest reading.
  const nowMonth = ctx.now.slice(0, 7);
  const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
  const fxOf = (cur: string) =>
    [...(ctx.fx ?? [])]
      .filter((f) => f.pair === `USD${cur}`)
      .sort((a, b) =>
        a.fetchedAt < b.fetchedAt ? 1 : a.fetchedAt > b.fetchedAt ? -1 : a.value - b.value,
      )[0]?.value;
  const toCome = (s.obligations ?? []).filter((o) => o.month >= nowMonth);
  const inWindow = toCome.filter(
    (o) => monthIndex(o.month) - monthIndex(nowMonth) < P.setAsideMonths,
  );
  const owedCents = (o: { amount: number; currency: string }) =>
    Math.ceil(
      Math.round(
        (o.amount / (o.currency === 'USD' ? 1 : (fxOf(o.currency) ?? Number.NaN))) * 100 * 10_000,
      ) / 10_000,
    );
  const owed = sum(inWindow.map(owedCents));
  const goalShareBps = (s.sleeves ?? [{ kind: 'goal', shareBps: 10_000 }])
    .filter((x) => x.kind === 'goal')
    .reduce((n, x) => n + x.shareBps, 0);
  const safeShareBps = (s.sleeves ?? [])
    .filter((x) => x.kind === 'safe_yield')
    .reduce((n, x) => n + x.shareBps, 0);
  const goalCents = (amount * goalShareBps) / 10_000;
  const isRate = (a: BasketAsset | undefined) =>
    a?.cls === 'dollar_yield' &&
    (LEG_TYPES[a.symbol]?.types ?? []).length > 0 &&
    (LEG_TYPES[a.symbol]?.types ?? []).every((t) => t === 'rate');
  const centsWhere = (keep: (a: BasketAsset | undefined) => boolean) =>
    sum(plan.lines.filter((l) => keep(byId.get(l.assetId))).map((l) => cents(l.amountUsd)));
  const reasonsOf = (rule: string) => allReasons(plan).filter((r) => r.rule === rule);
  const twoBps = 2 * Math.ceil(amount / 10_000) + 2;
  if (owed > 0 && goalShareBps > 0) {
    // What is set aside, with the safe-yield sleeve, is held in cash, the matching legs and rate legs.
    const setAside = Math.min(owed, goalCents);
    say(
      centsWhere((a) => a?.cls === 'cash' || isRate(a)) + twoBps >=
        setAside + (amount * safeShareBps) / 10_000,
      `${owed / 100} owed in the next months, and cash and rate legs hold ${centsWhere((a) => a?.cls === 'cash' || isRate(a)) / 100}`,
    );
    const [said] = reasonsOf('SET_ASIDE');
    // A goal sleeve under a cent has nothing to set aside, and says it is short.
    say(
      said !== undefined || goalCents < 1,
      'withdrawals in the next months, and no line says what is set aside',
    );
    if (said)
      say(
        cents(Number(said.params.usd)) + 1 >= Math.floor(setAside) &&
          cents(Number(said.params.usd)) <= owed + twoBps,
        `"${said.text}" but ${owed / 100} is owed`,
      );
    say(
      plan.flags.includes('set_aside_short') === owed > goalCents ||
        Math.abs(owed - goalCents) <= 1,
      `the short flag is ${plan.flags.includes('set_aside_short') ? 'set' : 'missing'} with ${owed / 100} owed and ${goalCents / 100} for the goal`,
    );
  } else if (owed > 0) {
    // No goal sleeve: nothing is set aside, and the plan says it falls short.
    say(
      plan.flags.includes('set_aside_short'),
      'withdrawals with no goal sleeve, and no short flag',
    );
  } else {
    for (const rule of [
      'SET_ASIDE',
      'SET_ASIDE_SHORT',
      'SET_ASIDE_CASH',
      'NO_MATCHING_LEG',
      'MIX_SET_ASIDE',
    ])
      say(reasonsOf(rule).length === 0, `${rule} said with nothing to set aside`);
  }
  // With a mix (gate EXPLICIT-MIX) withdrawals keep their rule: what the next months owe is set aside
  // in full, as held above. It counts first as the dollar yield and the cash the person asked for.
  // Stocks, crypto and gold give only what those two together cannot, stocks and crypto before gold,
  // and each class that gave says how much, and what that leaves it.
  const asideSaid = [
    ...new Map(reasonsOf('MIX_SET_ASIDE').map((r) => [JSON.stringify(r.params), r])).values(),
  ];
  if (s.mix) {
    const asked: Record<string, number> = {
      growth: s.mix.growthBps,
      dollarYield: s.mix.dollarYieldBps,
      gold: s.mix.goldBps,
      cash: s.mix.cashBps,
    };
    const asideBps = Math.min(10_000, Math.ceil((owed * 10_000) / amount));
    const gave: Record<string, number> = { growth: 0, dollarYield: 0, gold: 0, cash: 0 };
    for (const r of asideSaid) {
      const sleeve = String(r.params.sleeve);
      const [was, left] = [Number(r.params.askedBps), Number(r.params.leftBps)];
      say(was === asked[sleeve], `"${r.text}" but the mix asks ${asked[sleeve]} bps of ${sleeve}`);
      say(left >= 0 && left < was, `"${r.text}" leaves ${left} bps of ${was}`);
      say(
        Math.abs(cents(Number(r.params.usd)) - Math.floor((amount * (was - left)) / 10_000)) <= 1,
        `"${r.text}" but ${was - left} bps of the plan is not that many dollars`,
      );
      say(
        r.params.from === nowMonth && r.params.to === monthAfter(ctx.now, P.setAsideMonths - 1),
        `"${r.text}" names other months than the ones set aside for`,
      );
      say(gave[sleeve] === 0, `two sentences say what ${sleeve} gave to what is set aside`);
      gave[sleeve] = (gave[sleeve] ?? 0) + was - left;
    }
    const liquid = s.mix.dollarYieldBps + s.mix.cashBps;
    const fromPriced = Math.max(0, asideBps - liquid);
    say(
      (gave.growth ?? 0) + (gave.gold ?? 0) === fromPriced,
      `stocks, crypto and gold give ${(gave.growth ?? 0) + (gave.gold ?? 0)} bps to what is set aside; the mix's dollar yield and cash leave ${fromPriced} to find`,
    );
    say(
      (gave.gold ?? 0) === 0 || gave.growth === s.mix.growthBps,
      'gold gives to what is set aside before stocks and crypto have given all of theirs',
    );
    say(
      (gave.dollarYield ?? 0) + (gave.cash ?? 0) <= Math.min(asideBps, liquid),
      'dollar yield and cash give more to what is set aside than is set aside',
    );
  }
  // A withdrawal named on the plan is one of the sheet's, in the window.
  for (const r of reasonsOf('WITHDRAWAL'))
    say(
      inWindow.some(
        (o) =>
          o.month === r.params.month &&
          o.currency === r.params.currency &&
          o.amount === r.params.amount,
      ),
      `"${r.text}" is not a withdrawal of the next months`,
    );
  // The coverage check: a plan that does not say it falls short holds, in cash and dollar yield, at
  // least what is owed; one that says so says it on its cash line.
  if (inWindow.length > 0 && !plan.flags.includes('coverage_short') && owed <= goalCents)
    say(
      centsWhere((a) => a?.cls === 'cash' || a?.cls === 'dollar_yield') + twoBps >= owed,
      `${owed / 100} owed in the next months, more than cash and dollar yield hold`,
    );
  say(
    plan.flags.includes('coverage_short') === reasonsOf('COVERAGE_SHORT').length > 0,
    'coverage_short and its sentence do not go together',
  );
  say(
    plan.flags.includes('coverage_moved') === reasonsOf('COVERAGE_CASH').length > 0,
    'coverage_moved and its sentence do not go together',
  );
  // The schedule: there when there are withdrawals to come and the rate of the goal's currency is
  // known, in that currency, never paying more months than have a withdrawal.
  const rateKnown = goalCurrency === 'USD' || fxOf(goalCurrency) !== undefined;
  say(
    (plan.schedule !== undefined) === (toCome.length > 0 && rateKnown),
    `the schedule is ${plan.schedule ? 'there' : 'missing'} with ${toCome.length} withdrawals to come`,
  );
  if (plan.schedule) {
    const sc = plan.schedule;
    say(sc.currency === goalCurrency, `the schedule is in ${sc.currency}, not ${goalCurrency}`);
    say(sc.monthsPaid <= sc.monthsWithWithdrawal, 'the schedule pays more months than it has');
    say(
      sc.rows.every((r) => r.balance >= 0),
      'the schedule has a balance under zero',
    );
    say(sc.rows[0]?.month === nowMonth, 'the schedule does not start this month');
    say(
      sc.monthsWithWithdrawal === new Set(toCome.map((o) => o.month)).size ||
        sc.rows.length < monthIndex(toCome.at(-1)?.month ?? nowMonth) - monthIndex(nowMonth) + 1,
      'the schedule does not count the months with a withdrawal',
    );
  }

  // What must not be lost stays in dollar yield and cash, sleeves and all.
  const mustKeep = s.limits?.mustKeepUsd ?? 0;
  if (mustKeep > 0) {
    const kept = sum(
      plan.lines
        .filter((l) => {
          const c = byId.get(l.assetId)?.cls;
          return c === 'cash' || c === 'dollar_yield';
        })
        .map((l) => cents(l.amountUsd)),
    );
    say(
      kept + Math.ceil(amount / 10_000) >= Math.min(amount, cents(mustKeep)),
      `${kept / 100} in dollar yield and cash, under the ${mustKeep} that must not be lost`,
    );
  }

  // A plan lives on one chain: every line is on it, no reason names another, and there is one
  // recipe, whose amount is the deposit.
  const [chain] = s.chains;
  say(
    plan.lines.every((l) => l.chain === chain),
    'a line is on another chain',
  );
  say(
    allReasons(plan).every((r) => r.params.chain === undefined || r.params.chain === chain),
    'a reason names a chain the plan is not on',
  );
  say(
    plan.recipes.length === 1 &&
      plan.recipes[0]?.chain === chain &&
      cents(plan.recipes[0]?.amountUsd ?? 0) === amount,
    'the plan does not have one recipe for the whole amount on its chain',
  );
  for (const chain of new Set(plan.lines.map((l) => l.chain)))
    say(
      plan.recipes.some((r) => r.chain === chain),
      `no recipe for ${chain}`,
    );
  for (const r of plan.recipes) {
    const here = plan.lines.filter((l) => l.chain === r.chain);
    const cash = shelf.assets.find((a) => a.chain === r.chain && a.cls === 'cash');
    const keys = r.components.map((c) => (c.kind === 'asset' ? c.asset : `index:${c.family}`));
    say(s.chains.includes(r.chain), `a recipe on ${r.chain}, which was not funded`);
    say(new Set(keys).size === keys.length, `${r.chain}: a component twice`);
    say(
      r.components.every((c) => Number.isInteger(c.weightBps) && c.weightBps >= 1),
      `${r.chain}: a component under 1 bp`,
    );
    say(sum(r.components.map((c) => c.weightBps)) <= 10_000, `${r.chain}: components over 10,000`);
    say(
      r.components.every(
        (c) => c.kind !== 'asset' || (c.asset.startsWith(`${r.chain}:`) && c.asset !== cash?.id),
      ),
      `${r.chain}: a component on another chain, or the cash token as a target`,
    );
    say(
      cents(r.amountUsd) === sum(here.map((l) => cents(l.amountUsd))),
      `${r.chain}: amount is not its lines`,
    );

    let targets: Target[] = [];
    if (r.components.length > 0) {
      const asRecipe: Recipe = {
        schemaVersion: 1,
        familyId: '0'.repeat(64),
        chain: r.chain,
        onchainId: null,
        creator: FIXTURE_ADDRESS[chainFamily(r.chain)],
        kind: 'personal',
        version: 1,
        effectiveAt: 0,
        components: r.components,
        metaHash: '0'.repeat(64),
        maxFeeBps: 0,
        flags: 0,
      };
      const report = flattenReport(asRecipe, shelf, {
        minLineBps: P.minLineBps,
        maxLines: P.maxLinesPerChain,
      });
      say(
        report.dropped.length === 0,
        `${r.chain}: flatten would drop ${report.dropped[0]?.asset}`,
      );
      targets = report.targets;
    }
    // The vault's own rules: at most 16 targets, each asset once, at most 10,000 with the rest as cash.
    // The shared `Targets` holds the same, for a plan that has any target at all.
    if (targets.length > 0)
      say(Targets.safeParse(targets).success, `${r.chain}: not the shared Targets`);
    say(
      targets.length <= Math.min(16, P.maxLinesPerChain),
      `${r.chain}: ${targets.length} targets`,
    );
    say(sum(targets.map((t) => t.weightBps)) <= 10_000, `${r.chain}: targets over 10,000`);
    say(new Set(targets.map((t) => t.asset)).size === targets.length, `${r.chain}: a target twice`);
    say(
      targets.every((t) => t.asset !== cash?.id),
      `${r.chain}: cash is a target`,
    );

    // The lines are those targets: the same assets, each at the same whole basis points. A line's
    // dollars are what placement gave it, and its basis points are rounded so that each sleeve adds
    // up: the two agree to within two basis points, and two more for each shared portfolio held
    // whole that feeds the line, since opening one rounds again.
    const held = here.filter((l) => l.assetId !== cash?.id);
    say(
      JSON.stringify(held.map((l) => l.assetId).sort()) ===
        JSON.stringify(targets.map((t) => t.asset).sort()),
      `${r.chain}: the lines are not what the recipe flattens to`,
    );
    const oneBp = cents(r.amountUsd) / 10_000;
    for (const t of targets) {
      const line = held.find((l) => l.assetId === t.asset);
      const token = byId.get(t.asset);
      if (!line || !token) continue;
      const through = r.components.filter(
        (c) =>
          c.kind === 'index' &&
          shelf.families
            .find((f) => f.meta.slug === c.family)
            ?.recipes.find((x) => x.chain === r.chain)
            ?.components.some((x) => x.kind === 'asset' && x.asset === t.asset),
      ).length;
      say(
        line.weightBps === t.weightBps,
        `${t.asset}: its target is ${t.weightBps} and its line ${line.weightBps}`,
      );
      say(
        Math.abs(cents(line.amountUsd) - t.weightBps * oneBp) <= (2 + 2 * through) * oneBp + 1,
        `${t.asset}: its dollars are not its target's`,
      );
      // A target never asks for more of a token than its ceiling.
      say(
        t.weightBps * cents(r.amountUsd) <= Math.floor(ceilingUsd(token, ctx) * 100) * 10_000,
        `${t.asset}: its target comes to more than its ceiling of ${ceilingUsd(token, ctx)}`,
      );
    }
  }

  // What a plan says of its own shape is so. Each floor it names is held; an issuer it calls "at
  // that limit" is at it, to within the least a line can be; and the money it says is held in dollar
  // yield or cash instead of where it was meant to go is no more than those two hold.
  const inSleeve = (sleeve: Sleeve) =>
    sum(
      plan.lines
        .filter((l) => sleeveOfClass(byId.get(l.assetId)?.cls ?? 'cash') === sleeve)
        .map((l) => cents(l.amountUsd)),
    );
  const kept = inSleeve('dollarYield') + inSleeve('cash');
  const share = (bps: unknown) => (amount * Number(bps)) / 10_000;
  const said = new Map(allReasons(plan).map((r) => [`${r.rule} ${JSON.stringify(r.params)}`, r]));
  const leastLine = Math.max(cents(P.minLineUsd), Math.ceil((amount * P.minLineBps) / 10_000));
  let instead = 0;
  for (const r of said.values()) {
    if (r.rule === 'GLIDE' || r.rule === 'MUST_KEEP')
      say(kept >= share(r.params.floorBps) - 2, `"${r.text}", and the plan keeps ${kept / 100}`);
    if (r.rule === 'CASH_NEAR_DATE' || r.rule === 'CASH_MAY_NEED')
      say(
        inSleeve('cash') >= share(r.params.floorBps) - 1,
        `"${r.text}", and the plan holds ${inSleeve('cash') / 100} in cash`,
      );
    if (r.rule === 'ISSUER_CAP' || r.rule === 'OVERFLOW_ISSUER') {
      const with_ =
        (total((a) => a.issuer).get(String(r.params.issuer)) ?? 0) +
        movedFromIssuer(String(r.params.issuer));
      say(
        // The cap is whole cents, rounded down, as the engine holds it.
        with_ >= Math.floor(share(r.params.capBps)) - Math.max(leastLine, share(3)),
        `"${r.text}", and it holds ${with_ / 100}`,
      );
    }
    // The plan's issuer cap counts dollar yield, gold and cash only (gate SOLVER-CAPS).
    if (r.rule === 'ISSUER_CAP_PLAN' || r.rule === 'OVERFLOW_ISSUER_PLAN') {
      const with_ = nonGrowthOf(String(r.params.issuer)) + movedFromIssuer(String(r.params.issuer));
      say(
        // The cap is whole cents, rounded down, as the engine holds it.
        with_ >= Math.floor(share(r.params.capBps)) - Math.max(leastLine, share(3)),
        `"${r.text}", and it holds ${with_ / 100}`,
      );
    }
    if (r.rule.startsWith('OVERFLOW_')) instead += cents(Number(r.params.usd));
  }
  say(
    instead <= kept,
    `${instead / 100} is said to be held in dollar yield or cash, which hold ${kept / 100}`,
  );

  // The four sleeves, as the plan holds them.
  for (const sleeve of SLEEVES) {
    const row = plan.sleeves.find((x) => x.sleeve === sleeve);
    say(row?.weightBps === sleeveBps(plan, shelf, sleeve), `the ${sleeve} sleeve is not its lines`);
  }

  // The verdict: met means met, a way is something that closes the gap, and "no amount closes it"
  // is said apart from the ways.
  if (plan.verdict) {
    const v = plan.verdict;
    say(v.met === (v.gapUsdMonthly === 0), 'the verdict: met with a gap, or not met with none');
    say(
      v.ways.every((way) => way.closesGap),
      'the verdict: a way that does not close the gap',
    );
    say(
      v.met ? v.ways.length === 0 && v.noAmountCloses === undefined : true,
      'the verdict: met, and still says how to close a gap',
    );
  }

  // The card.
  const risky = sum(
    lines.filter((l) => sleeveOfClass(l.a.cls) !== 'dollarYield').map((l) => l.cents),
  );
  say(plan.card.moneyTodayUsd === s.amountUsd, 'the card: money today is not the amount');
  say(plan.card.termMonths === s.horizonMonths, 'the card: the term is not the sheet');
  say(
    Math.abs(cents(plan.card.expectedReturn.lossInFallUsd) - (risky * P.fallBps) / 10_000) <= 1,
    'the card: the loss in a fall is not the fall on stocks, crypto and gold',
  );
  say(
    plan.card.expectedReturn.lowPct <= plan.card.expectedReturn.highPct + 1e-9,
    'the card: low over high',
  );
  // The status: a way is listed only while the plan is not met, and each says it closes the gap.
  if (plan.status) {
    say(!plan.status.met || plan.status.ways.length === 0, 'a plan that is met lists ways');
    say(
      plan.status.met || plan.status.ways.length > 0 || plan.status.noAmountCloses !== undefined,
      'a plan that is not met lists no way and does not say why',
    );
  }
  // A candidate carries its scorecard, read from its own lines and status.
  say(
    (plan.candidate === undefined) === (plan.scorecard === undefined),
    'a scorecard without a candidate, or the other way',
  );
  if (plan.status)
    say(PlanStatus.safeParse(plan.status).success, 'the status is not the shared PlanStatus');
  const card = plan.scorecard;
  if (card) {
    say(PlanScorecard.safeParse(card).success, 'the scorecard is not the shared PlanScorecard');
    const creditBps = sum(
      plan.lines
        .filter((l) => {
          const a = byId.get(l.assetId);
          return (
            a !== undefined &&
            (LEG_TYPES[a.symbol]?.types ?? []).some((t) => t === 'credit' || t === 'basis')
          );
        })
        .map((l) => l.weightBps),
    );
    say(
      card.creditBasisBps === creditBps,
      `the scorecard says ${card.creditBasisBps} bps of credit, the lines ${creditBps}`,
    );
    const foreign =
      goalCurrency !== 'USD' ||
      (s.obligations ?? []).some((o) => o.currency !== 'USD' && o.month >= monthAfter(ctx.now, 0));
    // Open FX wherever something is owed in another currency than dollars (C19).
    say(
      (card.openFxUsd === undefined) === !foreign,
      'open FX on the scorecard with nothing owed in another currency, or none with something',
    );
    say(
      JSON.stringify(card.base) === JSON.stringify(plan.status?.base ?? null),
      'the scorecard and the status count other months',
    );
    say(
      card.concentration.largestIssuerBps === (card.concentration.byIssuer[0]?.bps ?? 0),
      'the largest issuer is not the first',
    );
  }
  return wrong;
}

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
import aiOnSolana from '../../../../content/themes/solana/ai.json';
import seedFile from '../../../../docs/vault/research/open-questions/launch-shelf.seed.json';
import yieldRows from './fixtures/yields.json';
import { LEG_TYPES } from './leg-types';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import { INPUT_NAMES, REASON_TEMPLATES } from './templates';
import { parseThemeList, type ThemeList } from './theme-list';
import {
  type ComposeContext,
  type PersonalParameters,
  type PersonalProposal,
  type PersonalSheet,
  type PooledLiquidityProvider,
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

/** The Solana AI list as `content/themes/solana/ai.json` holds it (gate THEME-AI-SOLANA). */
export function aiList(): ThemeList {
  return parseThemeList(aiOnSolana, 'content/themes/solana/ai.json');
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
  const row = table.sleeves[`${sheetOf.goal}:${sheetOf.risk}`];
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

/** The rules that say something was left out. */
const LEFT_OUT = [
  'MAX_LINES',
  'BELOW_MINIMUM',
  'EXCLUDED',
  'NOT_FOR_GOAL',
  'NOT_IN_COUNTRY',
  'NOT_ON_CHAIN',
];

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
    say(!a.blockedCountries.includes(s.country), `${a.id} is blocked in ${s.country}`);
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
  // Stocks and crypto by risk; dollar yield and gold by the plan's issuer cap (Rodrigo, Oct 5).
  const issuerCap = Math.floor((amount * (P.capPerIssuerBps[s.risk] ?? 0)) / 10_000);
  const planIssuerCap = Math.floor((amount * P.issuerCapBps) / 10_000);
  for (const [issuer, held] of total((a) => (sleeveOfClass(a.cls) === 'growth' ? a.issuer : null)))
    say(
      held <= issuerCap,
      `${issuer} holds ${held / 100}, over the issuer cap of ${issuerCap / 100}`,
    );
  for (const [issuer, held] of total((a) => (sleeveOfClass(a.cls) === 'growth' ? null : a.issuer)))
    say(
      held <= planIssuerCap,
      `${issuer} holds ${held / 100} of dollar yield and gold, over ${planIssuerCap / 100}`,
    );
  // The credit budget: credit and basis legs together.
  const tolerance = s.limits?.creditTolerance ?? P.defaultCreditTolerance;
  const creditCap = Math.floor((amount * (P.creditShareBps[tolerance] ?? 0)) / 10_000);
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
    if (r.rule === 'CREDIT_BUDGET' || r.rule === 'CREDIT_BUDGET_UNSAID') {
      say(Math.abs(credit - creditCap) <= 1, `"${r.text}" but credit holds ${credit / 100}`);
      say(
        (r.rule === 'CREDIT_BUDGET') === (s.limits?.creditTolerance !== undefined),
        `"${r.text}" said of a tolerance that was ${s.limits?.creditTolerance ? '' : 'not '}stated`,
      );
    }
    if (r.rule === 'CREDIT_NONE') {
      say(credit === 0, `"${r.text}" but credit holds ${credit / 100}`);
      say(s.limits?.creditTolerance === 'none', `"${r.text}" said to someone who did not say so`);
    }
    // A candidate's own credit limit is said only by Cover, below the person's, and holds.
    if (r.rule === 'CREDIT_NONE_PLAN' || r.rule === 'CREDIT_BUDGET_PLAN') {
      const coverBps = Math.floor(
        ((P.creditShareBps[tolerance] ?? 0) * P.candidates.cover.creditOfLimitBps) / 10_000,
      );
      const planCap = Math.floor((amount * coverBps) / 10_000);
      say(plan.candidate === 'cover', `"${r.text}" said of a plan that is not Cover`);
      // Compared in basis points, as the engine does: on a small plan both can be zero cents.
      say(
        coverBps < (P.creditShareBps[tolerance] ?? 0),
        `"${r.text}" but the person's own limit is no higher`,
      );
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

  // The person's split (gate SLEEVES): each sleeve's share and dollars as asked, and the safe-yield
  // sleeve in rate legs and cash only, never more of a token than its line holds.
  const lineUsd = new Map(plan.lines.map((l) => [l.assetId, cents(l.amountUsd)]));
  const splitSaid = allReasons(plan).filter((r) => r.rule.startsWith('SPLIT_'));
  // A theme's sentence is said only of a theme the sheet asks for, at its share.
  for (const r of allReasons(plan))
    if (r.rule === 'THEME_SLEEVE')
      say(
        (s.sleeves ?? []).some(
          (x) => x.kind === 'theme' && x.shareBps === Number(r.params.shareBps),
        ),
        `"${r.text}" said of a plan with no such theme sleeve`,
      );
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
    // A theme sleeve (gates SLEEVES, THEMES): it holds names of its list on the chain, dollar yield
    // and cash, never more of a token than its line; its names in equal parts, unless the line says
    // which limit holds one to less; each name's line says the theme and why the name is on it.
    const lists = (ctx.themes ?? []).filter((t) => t.chain === s.chains[0]);
    for (const x of plan.split ?? []) {
      if (x.kind !== 'theme') continue;
      const list = lists.find((t) => t.slug === x.theme && t.status === 'confirmed');
      const members = new Set(list?.members.map((m) => m.symbol) ?? []);
      say(
        sum(x.holds.map((h) => cents(h.amountUsd))) === cents(x.amountUsd),
        `the theme ${x.theme} holds more or less than its dollars`,
      );
      const slack = Math.ceil(amount / 10_000) + 1;
      const named: { a: BasketAsset; cents: number }[] = [];
      for (const h of x.holds) {
        const a = byId.get(h.assetId);
        const member = a !== undefined && members.has(a.symbol) && a.cls !== 'dollar_yield';
        say(
          member || a?.cls === 'cash' || a?.cls === 'dollar_yield',
          `the theme ${x.theme} holds ${h.assetId}, which is not on its list`,
        );
        say(
          cents(h.amountUsd) <= (lineUsd.get(h.assetId) ?? 0) + slack,
          `the theme ${x.theme} holds ${h.amountUsd} of ${h.assetId}, more than its line`,
        );
        if (a && member) named.push({ a, cents: cents(h.amountUsd) });
      }
      const top = Math.max(0, ...named.map((n) => n.cents));
      const name = list?.name[s.language];
      for (const { a, cents: held } of named) {
        const reasons = plan.lines.find((l) => l.assetId === a.id)?.reasons ?? [];
        say(
          reasons.some((r) => r.rule === 'THEME_SLEEVE' && r.params.theme === name) &&
            reasons.some((r) => r.rule === 'THEME_MEMBER' && r.params.asset === a.symbol),
          `${a.id} is held for the theme ${x.theme} and its line does not say so`,
        );
        const limited = reasons.some(
          (r) =>
            ((r.rule === 'EXIT_CEILING' || r.rule === 'TIER_CEILING') &&
              r.params.asset === a.symbol) ||
            (r.rule === 'SINGLE_STOCK_CAP' && r.params.asset === a.underlying) ||
            ((r.rule === 'ISSUER_CAP' || r.rule === 'ISSUER_CAP_PLAN') &&
              r.params.issuer === a.issuer),
        );
        say(
          held >= top - 1 || limited,
          `${a.id} holds ${held / 100} of the theme ${x.theme}, under the ${top / 100} of another name, and no limit is said`,
        );
      }
      // What the theme holds outside its names is said: some limit kept it out.
      const elsewhere =
        sum(x.holds.map((h) => cents(h.amountUsd))) - sum(named.map((n) => n.cents));
      say(
        elsewhere <= 0 || allReasons(plan).some((r) => r.rule.startsWith('OVERFLOW_')),
        `the theme ${x.theme} holds ${elsewhere / 100} outside its names, and no line says why`,
      );
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
    for (const rule of ['SET_ASIDE', 'SET_ASIDE_SHORT', 'SET_ASIDE_CASH', 'NO_MATCHING_LEG'])
      say(reasonsOf(rule).length === 0, `${rule} said with nothing to set aside`);
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

import { EXIT_WINDOW_DAYS, flattenReport, metaHash, sha256Hex } from '@colosseum/basket';
import {
  type BasketAsset,
  BasketProposal,
  type ChainId,
  chainFamily,
  DISCLAIMER,
  type LiquidityProvider,
  normalizeAddress,
  type Reason,
  type Recipe,
  type Shelf,
  type Target,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import seedFile from '../../../../docs/vault/research/open-questions/launch-shelf.seed.json';
import yieldRows from './fixtures/yields.json';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import { INPUT_NAMES, REASON_TEMPLATES } from './templates';
import {
  type ComposeContext,
  type PersonalProposal,
  type PersonalSheet,
  SLEEVES,
  type Sleeve,
} from './types';

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

/**
 * A liquidity provider over a table of exit capacities in dollars. Thin gold on Solana by default,
 * as measured on Oct 1 (gold works up to about $10k per plan there).
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
): LiquidityProvider {
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

/** The most dollars one token may hold: its tier's ceiling, and its measured exit capacity if any. */
export function ceilingUsd(asset: BasketAsset, ctx: ComposeContext): number {
  const P = ctx.params ?? PERSONAL_PARAMS;
  const tier = P.tierCeilingUsd[asset.tier];
  if (!ctx.liquidity?.covers(asset.id)) return tier;
  const measured = ctx.liquidity.exitCapacity(asset.id, P.tau, EXIT_WINDOW_DAYS);
  if (!measured || measured.samples < P.minExitSamples) return tier;
  return Math.min(tier, P.shareOfDepth * measured.capacityUsd);
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
export function violations(plan: PersonalProposal, shelf: Shelf, ctx: ComposeContext): string[] {
  const P = ctx.params ?? PERSONAL_PARAMS;
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
  const total = (key: (a: BasketAsset) => string | null) => {
    const out = new Map<string, number>();
    for (const l of lines) {
      const k = key(l.a);
      if (k !== null) out.set(k, (out.get(k) ?? 0) + l.cents);
    }
    return out;
  };
  const issuerCap = Math.floor((amount * (P.capPerIssuerBps[s.risk] ?? 0)) / 10_000);
  for (const [issuer, held] of total((a) => a.issuer))
    say(
      held <= issuerCap,
      `${issuer} holds ${held / 100}, over the issuer cap of ${issuerCap / 100}`,
    );
  const stockCap = Math.floor((amount * (P.capPerStockBps[s.risk] ?? 0)) / 10_000);
  for (const [name, held] of total((a) =>
    a.cls === 'stock' || a.cls === 'crypto' ? a.underlying : null,
  ))
    say(
      held <= stockCap,
      `${name} holds ${held / 100}, over the single-stock cap of ${stockCap / 100}`,
    );

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

    // The lines are those targets: same assets, and each line's dollars are its target's share.
    const held = here.filter((l) => l.assetId !== cash?.id);
    say(
      JSON.stringify(held.map((l) => l.assetId).sort()) ===
        JSON.stringify(targets.map((t) => t.asset).sort()),
      `${r.chain}: the lines are not what the recipe flattens to`,
    );
    for (const t of targets) {
      const line = held.find((l) => l.assetId === t.asset);
      // A target is whole basis points of its chain, and so is each component that feeds it: it is
      // its line to within one basis point for each of them, and one more where a shared portfolio
      // is opened into whole basis points again.
      const through = r.components.filter(
        (c) =>
          c.kind === 'index' &&
          shelf.families
            .find((f) => f.meta.slug === c.family)
            ?.recipes.find((x) => x.chain === r.chain)
            ?.components.some((x) => x.kind === 'asset' && x.asset === t.asset),
      ).length;
      const direct = r.components.some((c) => c.kind === 'asset' && c.asset === t.asset) ? 1 : 0;
      const exact = (cents(r.amountUsd) * t.weightBps) / 10_000;
      const oneBp = cents(r.amountUsd) / 10_000;
      if (line)
        say(
          Math.abs(cents(line.amountUsd) - exact) <=
            (direct + through + (through > 0 ? 1 : 0)) * oneBp + 1,
          `${t.asset}: its target is not its line`,
        );
    }
  }

  // The four sleeves, as the plan holds them.
  for (const sleeve of SLEEVES) {
    const row = plan.sleeves.find((x) => x.sleeve === sleeve);
    say(row?.weightBps === sleeveBps(plan, shelf, sleeve), `the ${sleeve} sleeve is not its lines`);
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
  return wrong;
}

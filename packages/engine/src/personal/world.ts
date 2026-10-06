import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import {
  type BasketAsset,
  type ChainId,
  FxObservation,
  type Language,
  type LiquidityProvider,
  type Reason,
  type RegimeLiquidityProvider,
  type Shelf,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import { pickPrimaryYield } from '../risk/index';
import { CREDIT_LEG_TYPES, legTypesOf } from './leg-types';
import { BPS, byName, ceilCents, floorCents, shareOf, toCents, toUsd } from './money';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import { reason } from './templates';
import {
  type CandidateId,
  type ComposeContext,
  HeldPosition,
  PersonalInputError,
  type PersonalObservation,
  PersonalParameters,
  PersonalSheet,
  type Sleeve,
} from './types';

// What `compose` knows before it decides anything: the sheet, validated; the shelf, in an order that
// does not depend on how it was listed; what the person holds; and, for any token, whether they can
// hold it and how many dollars it may take.

export type Family = Shelf['families'][number];

export type World = {
  sheet: PersonalSheet;
  lang: Language;
  P: PersonalParameters;
  /** The candidate this plan is made as (gate THREE-PLANS), or null for the plain plan. */
  candidate: CandidateId | null;
  /**
   * The cost a sale is counted at where nothing is measured: the person's table's `tau`, never a
   * candidate's tighter one (a lower assumed cost would be less cautious, not more).
   */
  unmeasuredCost: number;
  shelf: Shelf;
  now: string;
  /** The amount, in cents. */
  amount: number;
  /** The person's chain: the one chain the plan lives on. */
  chain: ChainId;
  /** That chain's cash token in dollars, which a vault is funded in. */
  cash: BasketAsset;
  /** The goal's currency (ISO 4217); dollars unless the sheet says otherwise. */
  currency: string;
  /**
   * The matching leg for a currency other than dollars: the chain's cash token counted in it, or null
   * when the shelf lists none (gate SOLVER; the BRL leg for reais, with no code of its own).
   */
  matchingOf(currency: string): BasketAsset | null;
  /** The FX reading for dollars into this currency, recorded on the plan once used; null if none. */
  fxOf(currency: string): FxObservation | null;
  /** What the chain lists that a plan can hold, by id. The cash token is not one of them. */
  tokens: BasketAsset[];
  /** Every token on the shelf, on any chain: a holding may be of one the person's chain lacks. */
  byId: Map<string, BasketAsset>;
  families: Map<string, Family>;
  /** What the person holds that counts (at or over the threshold), in cents, by ticker; and its sum. */
  held: Map<string, number>;
  heldTotal: number;
  /** The yield the plan counts for each token: the best observation given for it. */
  yields: Map<string, YieldObservation>;
  /** Everything that was given, validated and in one order, for the hash of the inputs. */
  given: {
    yields: YieldObservation[];
    fx: FxObservation[];
    holdings: HeldPosition[];
    liquiditySource: string | null;
  };
  liquidity: LiquidityProvider | undefined;
  /** The month of the goal's date, YYYY-MM; null for a goal with no date (`horizonOpen`). */
  goalMonth: string | null;
  /** The month the plan is made in, YYYY-MM. */
  nowMonth: string;
  /**
   * The sheet's withdrawals from this month on, each in dollars too, in order of month, currency and
   * amount. One in another currency than dollars is converted at its FX reading, which is required.
   */
  withdrawals: Withdrawal[];
  /** The smallest line, the most with one issuer, and the most in one stock or crypto asset: cents. */
  minLine: number;
  stockCap: number;
  /** The most cents with this token's issuer: by risk for stocks and crypto, the plan's cap for the rest. */
  issuerCapOf(asset: BasketAsset): number;
  /** Why an issuer takes no more, for this token's sleeve. */
  issuerWhy(asset: BasketAsset): Reason;
  /**
   * For a dollar-yield token: the most cents it may take, the smaller of its cap in the plan and its exit
   * ceiling, with the reason for whichever binds. Null when its leg type is not on the list.
   */
  yieldCapOf(asset: BasketAsset): { cents: number; why: Reason } | null;
  /** Whether a dollar-yield token counts against the credit budget. */
  isCredit(asset: BasketAsset): boolean;
  /** Whether a dollar-yield token is a rate leg and nothing else: what a safe-yield sleeve holds. */
  isRateOnly(asset: BasketAsset): boolean;
  /**
   * The most cents in credit and basis legs, by the person's credit tolerance, and its share. `byPlan`
   * when a candidate holds less than the person allows: the limit is the plan's, not theirs.
   */
  creditBudget: { cents: number; bps: number; stated: boolean; byPlan: boolean };
  flags: Set<string>;
  /** Every figure the plan was shaped by, whether or not its token ends up in the plan. */
  observations: Map<string, PersonalObservation>;
  sleeveOf(asset: BasketAsset): Sleeve;
  /** Why the person cannot hold this token, or null when they can. */
  blockOf(asset: BasketAsset): Reason | null;
  /**
   * The most cents this token may take. Where its exit capacity is measured, the share of it a plan
   * may count on. Where it is not, the ceiling of its tier on the asset list, as a fallback.
   */
  ceilingOf(asset: BasketAsset): number;
  /** Why this token takes no more than that: the measured cost of selling, or its tier. */
  ceilingWhy(asset: BasketAsset): Reason;
  /**
   * What a line of this token says about where its limit came from: that it is a tier and not a
   * measurement, or that the measurement leaves out a time of the week. Nothing when it is measured
   * through the whole week.
   */
  ceilingNotes(asset: BasketAsset): Reason[];
};

/** A dated withdrawal, as the sheet gives it and in whole cents of dollars, rounded up. */
export type Withdrawal = { month: string; amount: number; currency: string; cents: number };

/** A provider that says which times of the week its figures were measured in. */
export const reportsRegimes = (p: LiquidityProvider): p is RegimeLiquidityProvider =>
  typeof (p as Partial<RegimeLiquidityProvider>).regimes === 'function';

type Ceiling = { cents: number; why: Reason; notes: Reason[] };

const issues = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

const IsoTime = z.string().datetime();
/** An FX reading as `compose` takes it: a pair of two currencies and a finite rate. */
const FxRead = FxObservation.extend({
  pair: z.string().regex(/^[A-Z]{6}$/),
  value: z.number().positive().finite(),
});
/** A yield observation as `compose` takes it: complete, and its yields finite numbers. */
const YieldRead = YieldObservation.extend({
  quotedYield: z.number().finite(),
  haircutYield: z.number().finite(),
});

/**
 * The yields in an order that does not depend on how they were listed, each once. When two
 * observations of one token are as good as each other, the lower yield after haircut comes first, so
 * that is the one the plan counts.
 */
function inOrder(yields: YieldObservation[]): YieldObservation[] {
  const keyed = yields.map((y) => ({ y, key: JSON.stringify(Object.entries(y).sort()) }));
  const sorted = keyed.sort(
    (a, b) =>
      (a.y.assetId < b.y.assetId ? -1 : a.y.assetId > b.y.assetId ? 1 : 0) ||
      a.y.haircutYield - b.y.haircutYield ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return sorted.filter((x, i) => x.key !== sorted[i - 1]?.key).map((x) => x.y);
}
const MONTHS_IN_A_YEAR = 12;

/** The month `months` after the month of an ISO time, as YYYY-MM. Read from the text: no clock. */
export function monthAfter(iso: string, months: number): string {
  const [year = '0', month = '1'] = iso.split('-');
  const index = Number(year) * MONTHS_IN_A_YEAR + (Number(month) - 1) + months;
  const y = Math.floor(index / MONTHS_IN_A_YEAR);
  const m = (index % MONTHS_IN_A_YEAR) + 1;
  return `${String(y).padStart(year.length, '0')}-${String(m).padStart(month.length, '0')}`;
}

/**
 * The table a candidate is made with (gate THREE-PLANS): Cover sets more aside and reads exits more
 * cautiously, Spread fills dollar yield equally under a tighter issuer cap; each number moves only
 * toward its aim, never past the table. Carry, and the plain plan, take the table as it is. The
 * credit share of Cover is not here: it bounds the person's budget in `buildWorld`, so the plan says
 * whose limit it is.
 */
export function tableFor(P: PersonalParameters, candidate: CandidateId | null): PersonalParameters {
  if (candidate === 'cover') {
    const c = P.candidates.cover;
    return {
      ...P,
      setAsideMonths: Math.max(P.setAsideMonths, c.setAsideMonths),
      tau: Math.min(P.tau, c.tau),
      shareOfDepth: Math.min(P.shareOfDepth, c.shareOfDepth),
    };
  }
  if (candidate === 'spread') {
    const c = P.candidates.spread;
    return {
      ...P,
      // One band holds every token, whatever their yields: they share equally.
      yieldBand: c.equalFill ? 1 : P.yieldBand,
      issuerCapBps: Math.min(P.issuerCapBps, c.issuerCapBps),
    };
  }
  return P;
}

/** Validates everything `compose` is handed, and throws `PersonalInputError` on what it cannot use. */
export function buildWorld(
  sheetIn: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
  candidate: CandidateId | null = null,
): World {
  const parsedSheet = PersonalSheet.safeParse(sheetIn);
  if (!parsedSheet.success) throw new PersonalInputError('InvalidSheet', issues(parsedSheet.error));
  const sheet = parsedSheet.data;
  // A theme sleeve needs the curated lists of slice 4; it is refused until then, never ignored.
  if (sheet.sleeves?.some((x) => x.kind === 'theme'))
    throw new PersonalInputError('InvalidSheet', [
      { path: 'sleeves', message: 'a theme sleeve is not built yet' },
    ]);

  const parsedParams = PersonalParameters.safeParse(context.params ?? PERSONAL_PARAMS);
  if (!parsedParams.success)
    throw new PersonalInputError('InvalidParams', issues(parsedParams.error));
  const P = tableFor(parsedParams.data, candidate);
  const row = P.sleeves[`${sheet.goal}:${sheet.risk}`];
  const capStock = P.capPerStockBps[sheet.risk];
  const capIssuer = P.capPerIssuerBps[sheet.risk];
  if (!row || capStock === undefined || capIssuer === undefined)
    throw new PersonalInputError('InvalidParams', [
      { path: 'sleeves', message: `no row or cap for ${sheet.goal} at ${sheet.risk} risk` },
    ]);
  if (row.growthBps + row.dollarYieldBps + row.goldBps > BPS)
    throw new PersonalInputError('InvalidParams', [
      { path: `sleeves.${sheet.goal}:${sheet.risk}`, message: 'the sleeves add up to over 100%' },
    ]);

  const parsedNow = IsoTime.safeParse(context.now);
  if (!parsedNow.success)
    throw new PersonalInputError('InvalidContext', [{ path: 'now', message: 'not an ISO time' }]);
  const parsedHoldings = z.array(HeldPosition).safeParse(context.holdings ?? []);
  if (!parsedHoldings.success)
    throw new PersonalInputError('InvalidContext', issues(parsedHoldings.error));
  // A yield with no source, method or time, or one that is not a number, is refused: never shown.
  const parsedYields = z.array(YieldRead).safeParse(context.yields ?? []);
  if (!parsedYields.success)
    throw new PersonalInputError('InvalidContext', issues(parsedYields.error));
  const parsedFx = z.array(FxRead).safeParse(context.fx ?? []);
  if (!parsedFx.success) throw new PersonalInputError('InvalidContext', issues(parsedFx.error));
  // In one order, each once; of two readings for one pair the latest counts, then the lowest value.
  const fxInOrder = byName(parsedFx.data, (f) => JSON.stringify(Object.entries(f).sort()));
  const fxByPair = new Map<string, FxObservation>();
  for (const f of fxInOrder) {
    const had = fxByPair.get(f.pair);
    if (
      !had ||
      f.fetchedAt > had.fetchedAt ||
      (f.fetchedAt === had.fetchedAt && f.value < had.value)
    )
      fxByPair.set(f.pair, f);
  }

  const listed = byName(shelf.assets, (a) => a.id);
  const byId = new Map(listed.map((a) => [a.id, a]));
  if (byId.size !== listed.length)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'assets', message: 'a token is listed twice' },
    ]);
  const families = new Map(byName(shelf.families, (f) => f.meta.slug).map((f) => [f.meta.slug, f]));
  if (families.size !== shelf.families.length)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'families', message: 'a shared portfolio is listed twice' },
    ]);

  // The sheet names exactly one chain (PersonalSheet holds it to that).
  const [chain] = sheet.chains;
  const isDollars = (a: BasketAsset) => (a.currency ?? 'USD') === 'USD';
  const cash = listed.find((a) => a.chain === chain && a.cls === 'cash' && isDollars(a));
  // A vault is funded in its chain's dollar token, so a chain with none listed cannot hold a plan.
  if (!chain || !cash)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'assets', message: `the shelf lists no cash token on ${chain}` },
    ]);
  const tokens = listed.filter((a) => a.chain === chain && a.cls !== 'cash');
  const currency = sheet.currency ?? 'USD';

  const amount = toCents(sheet.amountUsd);
  // What the person holds, by underlying. A holding under the threshold is ignored everywhere: it
  // moves nothing and counts for nothing.
  const all = new Map<string, number>();
  if (sheet.rules.useHoldings)
    for (const h of parsedHoldings.data) {
      const underlying = h.underlying ?? (h.asset ? byId.get(h.asset)?.underlying : undefined);
      if (underlying) all.set(underlying, (all.get(underlying) ?? 0) + toCents(h.valueUsd));
    }
  const counts = shareOf(amount, P.holdingMinBps);
  const held = new Map([...all].filter(([, cents]) => cents > 0 && cents >= counts));
  const heldTotal = [...held.values()].reduce((n, cents) => n + cents, 0);

  const lang = sheet.language;
  const no = sheet.limits?.cannotHold;
  const noAssets = new Set(no?.assets ?? []);
  const noClasses = new Set<string>(no?.classes ?? []);
  const noUnderlyings = new Set((no?.underlyings ?? []).map((u) => u.toLowerCase()));

  const blockOf = (a: BasketAsset): Reason | null => {
    if (a.chain !== chain) return reason('NOT_ON_CHAIN', { asset: a.underlying, chain }, lang);
    if (noAssets.has(a.id)) return reason('EXCLUDED', { asset: a.symbol }, lang);
    if (noClasses.has(a.cls) || noUnderlyings.has(a.underlying.toLowerCase()))
      return reason('EXCLUDED', { asset: a.underlying }, lang);
    if (!eligibleForGoal(a, sheet.goal))
      return reason('NOT_FOR_GOAL', { asset: a.underlying, goal: sheet.goal }, lang);
    // No country rule (gate COUNTRY-REMOVED, Rodrigo, Oct 6): `blockedCountries` is information
    // only. Who may hold an asset is for sign-up and the terms of service, not the plan.
    return null;
  };

  const flags = new Set<string>();
  const observations = new Map<string, PersonalObservation>();
  const liquidity = context.liquidity;
  const ceilings = new Map<string, Ceiling>();
  const ceiling = (a: BasketAsset): Ceiling => {
    const known = ceilings.get(a.id);
    if (known) return known;
    const covered = liquidity?.covers(a.id) ?? false;
    const measured =
      liquidity && covered ? liquidity.exitCapacity(a.id, P.tau, EXIT_WINDOW_DAYS) : null;
    let made: Ceiling;
    // A capacity read from no sample is not a measurement, whatever figure comes with it.
    if (liquidity && measured && measured.samples > 0) {
      // The measured exit is the one source for what a token may weigh: the tier is not read.
      const cents = floorCents(P.shareOfDepth * measured.capacityUsd);
      // The figure is on the plan whether it left the token room or none. Its time is the end of the
      // provider's data and its source is what the caller said: neither is made up when missing.
      const at = IsoTime.safeParse(measured.dataTo);
      const source = context.liquiditySource?.trim() || null;
      if (!at.success) flags.add(`liquidity_undated:${a.id}`);
      if (source === null) flags.add('liquidity_unsourced');
      observations.set(`liquidity ${a.id}`, {
        id: a.id,
        kind: 'liquidity',
        source,
        method: liquidity.methodVersion,
        fetchedAt: at.success ? at.data : null,
        provenance: liquidity.provenance,
      });
      // The risk layer skips a time of the week it has too few samples for, so a capacity can be a
      // weekday figure. Which times it left out is on the plan; so is a provider that cannot say.
      const notes: Reason[] = [];
      const gaps = reportsRegimes(liquidity) ? liquidity.regimes(a.id) : null;
      if (!gaps) flags.add('exit_regimes_not_reported');
      else if (gaps.missing.length > 0) {
        const when = gaps.missing.map((gap) => gap.regime);
        for (const regime of when) flags.add(`exit_regime_not_measured:${a.id}:${regime}`);
        notes.push(reason('EXIT_PARTLY_MEASURED', { asset: a.symbol, when: when.join(',') }, lang));
      }
      const why = reason('EXIT_CEILING', { asset: a.symbol, maxUsd: toUsd(cents) }, lang);
      made = { cents, why, notes };
    } else {
      // Nothing measured: the tier on the asset list stands in, and the plan says that it does. A
      // token the provider has curves for and no figure is flagged as that, never passed in silence.
      const cents = floorCents(P.tierCeilingUsd[a.tier]);
      flags.add(`ceiling_from_tier:${a.id}`);
      if (covered) flags.add(`exit_capacity_thin:${a.id}`);
      const why = reason('TIER_CEILING', { asset: a.symbol, maxUsd: toUsd(cents) }, lang);
      made = { cents, why, notes: [why] };
    }
    ceilings.set(a.id, made);
    return made;
  };

  const nowMonth = monthAfter(context.now, 0);
  const world: World = {
    sheet,
    lang,
    P,
    candidate,
    unmeasuredCost: Math.max(P.tau, parsedParams.data.tau),
    shelf,
    now: context.now,
    amount,
    chain,
    cash,
    currency,
    matchingOf: (cur) =>
      cur === 'USD'
        ? null
        : (listed.find((a) => a.chain === chain && a.cls === 'cash' && a.currency === cur) ?? null),
    fxOf: (cur) => {
      const read = fxByPair.get(`USD${cur}`) ?? null;
      if (read)
        observations.set(`fx ${read.pair}`, {
          id: read.pair,
          kind: 'fx',
          source: read.source,
          method: read.method,
          fetchedAt: read.fetchedAt,
          provenance: read.provenance,
        });
      return read;
    },
    tokens,
    byId,
    families,
    held,
    heldTotal,
    yields: pickPrimaryYield(inOrder(parsedYields.data)),
    given: {
      yields: inOrder(parsedYields.data),
      fx: fxInOrder,
      holdings: byName(parsedHoldings.data, (h) => JSON.stringify(Object.entries(h).sort())),
      liquiditySource: context.liquiditySource?.trim() || null,
    },
    liquidity,
    goalMonth: sheet.horizonOpen ? null : monthAfter(context.now, sheet.horizonMonths),
    nowMonth,
    withdrawals: [],
    // A vault's target is at least one basis point, so a line is too, whatever the table says.
    minLine: Math.max(toCents(P.minLineUsd), Math.ceil((amount * Math.max(1, P.minLineBps)) / BPS)),
    stockCap: shareOf(amount, capStock),
    issuerCapOf: (a) =>
      sleeveOfClass(a.cls) === 'growth'
        ? shareOf(amount, capIssuer)
        : shareOf(amount, P.issuerCapBps),
    issuerWhy: (a) =>
      sleeveOfClass(a.cls) === 'growth'
        ? reason('ISSUER_CAP', { capBps: capIssuer, risk: sheet.risk, issuer: a.issuer }, lang)
        : reason('ISSUER_CAP_PLAN', { capBps: P.issuerCapBps, issuer: a.issuer }, lang),
    yieldCapOf: (a) => {
      const row = legTypesOf(a.symbol);
      if (!row) return null;
      const named = P.capPerAssetBps.bySymbol[a.symbol];
      const capBps =
        named ?? Math.min(...row.types.map((t) => P.capPerAssetBps.byLegType[t] ?? BPS));
      const capCents = shareOf(amount, capBps);
      const exit = ceiling(a);
      // The smaller limit binds; on a tie the exit figure is named, as the one source (EXIT-SOURCE).
      return exit.cents <= capCents
        ? { cents: exit.cents, why: exit.why }
        : {
            cents: capCents,
            why: reason('ASSET_CAP', { asset: a.symbol, capBps, maxUsd: toUsd(capCents) }, lang),
          };
    },
    isCredit: (a) => (legTypesOf(a.symbol)?.types ?? []).some((t) => CREDIT_LEG_TYPES.includes(t)),
    isRateOnly: (a) => {
      const types = legTypesOf(a.symbol)?.types ?? [];
      return types.length > 0 && types.every((t) => t === 'rate');
    },
    creditBudget: (() => {
      const tolerance = sheet.limits?.creditTolerance ?? P.defaultCreditTolerance;
      const theirs = P.creditShareBps[tolerance] ?? 0;
      const plans =
        candidate === 'cover' ? shareOf(theirs, P.candidates.cover.creditOfLimitBps) : theirs;
      const bps = Math.min(theirs, plans);
      return {
        cents: shareOf(amount, bps),
        bps,
        stated: sheet.limits?.creditTolerance !== undefined,
        byPlan: plans < theirs,
      };
    })(),
    flags,
    observations,
    sleeveOf: (a) => sleeveOfClass(a.cls),
    blockOf,
    ceilingOf: (a) => ceiling(a).cents,
    ceilingWhy: (a) => ceiling(a).why,
    ceilingNotes: (a) => ceiling(a).notes,
  };

  // Withdrawals, in dollars. One before this month is past and counts for nothing, and the plan says
  // so. One in another currency needs its FX reading: never guessed.
  const missing = new Set<string>();
  for (const o of byName(sheet.obligations ?? [], (o) => `${o.month} ${o.currency} ${o.amount}`)) {
    if (o.month < nowMonth) {
      flags.add('obligations_past');
      continue;
    }
    let usd = o.amount;
    if (o.currency !== 'USD') {
      const fx = world.fxOf(o.currency);
      if (!fx) {
        missing.add(o.currency);
        continue;
      }
      usd = o.amount / fx.value;
    }
    world.withdrawals.push({ ...o, cents: ceilCents(usd) });
  }
  if (missing.size > 0)
    throw new PersonalInputError(
      'InvalidContext',
      [...missing].sort().map((cur) => ({
        path: 'fx',
        message: `a withdrawal in ${cur} needs an FX reading for USD${cur}`,
      })),
    );
  return world;
}

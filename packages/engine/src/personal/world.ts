import { EXIT_WINDOW_DAYS } from '@colosseum/basket';
import type {
  BasketAsset,
  ChainId,
  Language,
  LiquidityProvider,
  ObservationRef,
  Reason,
  Shelf,
  YieldObservation,
} from '@colosseum/schemas';
import { z } from 'zod';
import { pickPrimaryYield } from '../risk/index';
import { BPS, byName, floorCents, shareOf, toCents } from './money';
import { PERSONAL_PARAMS } from './params';
import { eligibleForGoal, sleeveOfClass } from './registry';
import { reason } from './templates';
import {
  type ComposeContext,
  HeldPosition,
  PersonalInputError,
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
  shelf: Shelf;
  now: string;
  /** The amount, in cents. */
  amount: number;
  /** The chains the person funded that list a cash token, in the person's order. */
  chains: ChainId[];
  /** Every token on the shelf, by id. */
  tokens: BasketAsset[];
  byId: Map<string, BasketAsset>;
  cashOf: Map<ChainId, BasketAsset>;
  families: Map<string, Family>;
  /** What the person holds, in cents, by the ticker of the underlying; and all of it. */
  held: Map<string, number>;
  heldTotal: number;
  yields: Map<string, YieldObservation>;
  liquidity: LiquidityProvider | undefined;
  /** The month of the goal's date, YYYY-MM. */
  goalMonth: string;
  /** The smallest line, the most with one issuer, and the most in one stock or crypto asset: cents. */
  minLine: number;
  issuerCap: number;
  stockCap: number;
  flags: Set<string>;
  observations: Map<string, ObservationRef>;
  sleeveOf(asset: BasketAsset): Sleeve;
  /** Why the person cannot hold this token, or null when they can. */
  blockOf(asset: BasketAsset): Reason | null;
  /** The most cents this token may take: its tier's ceiling, and its measured exit capacity. */
  ceilingOf(asset: BasketAsset): number;
};

const issues = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

const IsoTime = z.string().datetime();
const MONTHS_IN_A_YEAR = 12;

/** The month `months` after the month of an ISO time, as YYYY-MM. Read from the text: no clock. */
function monthAfter(iso: string, months: number): string {
  const [year = '0', month = '1'] = iso.split('-');
  const index = Number(year) * MONTHS_IN_A_YEAR + (Number(month) - 1) + months;
  const y = Math.floor(index / MONTHS_IN_A_YEAR);
  const m = (index % MONTHS_IN_A_YEAR) + 1;
  return `${String(y).padStart(year.length, '0')}-${String(m).padStart(month.length, '0')}`;
}

/** Validates everything `compose` is handed, and throws `PersonalInputError` on what it cannot use. */
export function buildWorld(sheetIn: PersonalSheet, shelf: Shelf, context: ComposeContext): World {
  const parsedSheet = PersonalSheet.safeParse(sheetIn);
  if (!parsedSheet.success) throw new PersonalInputError('InvalidSheet', issues(parsedSheet.error));
  const sheet = parsedSheet.data;

  const parsedParams = PersonalParameters.safeParse(context.params ?? PERSONAL_PARAMS);
  if (!parsedParams.success)
    throw new PersonalInputError('InvalidParams', issues(parsedParams.error));
  const P = parsedParams.data;
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

  const tokens = byName(shelf.assets, (a) => a.id);
  const byId = new Map(tokens.map((a) => [a.id, a]));
  if (byId.size !== tokens.length)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'assets', message: 'a token is listed twice' },
    ]);
  const families = new Map(byName(shelf.families, (f) => f.meta.slug).map((f) => [f.meta.slug, f]));
  if (families.size !== shelf.families.length)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'families', message: 'a shared portfolio is listed twice' },
    ]);

  const cashOf = new Map<ChainId, BasketAsset>();
  for (const a of tokens) if (a.cls === 'cash' && !cashOf.has(a.chain)) cashOf.set(a.chain, a);
  // A vault is funded in its chain's dollar token, so a chain with none listed cannot hold a plan.
  const chains = [...new Set(sheet.chains)].filter((chain) => cashOf.has(chain));
  if (chains.length === 0)
    throw new PersonalInputError('InvalidShelf', [
      { path: 'assets', message: 'the shelf lists no cash token on a chain that was funded' },
    ]);

  const amount = toCents(sheet.amountUsd);
  const held = new Map<string, number>();
  let heldTotal = 0;
  if (sheet.rules.useHoldings)
    for (const h of parsedHoldings.data) {
      const underlying = h.underlying ?? (h.asset ? byId.get(h.asset)?.underlying : undefined);
      heldTotal += toCents(h.valueUsd);
      if (underlying) held.set(underlying, (held.get(underlying) ?? 0) + toCents(h.valueUsd));
    }

  const lang = sheet.language;
  const no = sheet.limits?.cannotHold;
  const noAssets = new Set(no?.assets ?? []);
  const noClasses = new Set<string>(no?.classes ?? []);
  const noUnderlyings = new Set((no?.underlyings ?? []).map((u) => u.toLowerCase()));
  const funded = new Set<string>(chains);

  const blockOf = (a: BasketAsset): Reason | null => {
    if (!funded.has(a.chain)) return reason('NOT_ON_YOUR_CHAINS', { asset: a.underlying }, lang);
    if (noAssets.has(a.id)) return reason('EXCLUDED', { asset: a.symbol }, lang);
    if (noClasses.has(a.cls) || noUnderlyings.has(a.underlying.toLowerCase()))
      return reason('EXCLUDED', { asset: a.underlying }, lang);
    if (!eligibleForGoal(a, sheet.goal))
      return reason('NOT_FOR_GOAL', { asset: a.underlying, goal: sheet.goal }, lang);
    if (a.blockedCountries.includes(sheet.country))
      return reason('NOT_IN_COUNTRY', { asset: a.symbol, country: sheet.country }, lang);
    return null;
  };

  const flags = new Set<string>();
  const observations = new Map<string, ObservationRef>();
  const liquidity = context.liquidity;
  const ceilings = new Map<string, number>();
  const ceilingOf = (a: BasketAsset): number => {
    const known = ceilings.get(a.id);
    if (known !== undefined) return known;
    let usd = P.tierCeilingUsd[a.tier];
    const measured = liquidity?.covers(a.id)
      ? liquidity.exitCapacity(a.id, P.tau, EXIT_WINDOW_DAYS)
      : null;
    if (liquidity && measured && measured.samples >= P.minExitSamples) {
      usd = Math.min(usd, P.shareOfDepth * measured.capacityUsd);
      const at = IsoTime.safeParse(measured.dataTo);
      observations.set(`liquidity ${a.id}`, {
        id: a.id,
        kind: 'liquidity',
        source: 'liquidity-provider',
        method: liquidity.methodVersion,
        fetchedAt: at.success ? at.data : context.now,
        provenance: liquidity.provenance,
      });
    } else if (measured) flags.add(`exit_capacity_thin:${a.id}`);
    const cents = floorCents(usd);
    ceilings.set(a.id, cents);
    return cents;
  };

  return {
    sheet,
    lang,
    P,
    shelf,
    now: context.now,
    amount,
    chains,
    tokens,
    byId,
    cashOf,
    families,
    held,
    heldTotal,
    yields: pickPrimaryYield(context.yields ?? []),
    liquidity,
    goalMonth: monthAfter(context.now, sheet.horizonMonths),
    // A vault's target is at least one basis point, so a line is too, whatever the table says.
    minLine: Math.max(toCents(P.minLineUsd), Math.ceil((amount * Math.max(1, P.minLineBps)) / BPS)),
    issuerCap: shareOf(amount, capIssuer),
    stockCap: shareOf(amount, capStock),
    flags,
    observations,
    sleeveOf: (a) => sleeveOfClass(a.cls),
    blockOf,
    ceilingOf,
  };
}

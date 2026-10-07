import type { Language } from '@colosseum/schemas';
import type { ShelfPortfolio } from './intake';
import { filterOfSlug, type MarketFilterBy, type ShelfLabel } from './market-filter';
import {
  CLASS_WORDS,
  FILTER_BY_WORDS,
  MATCHED_NAME,
  READBACK_TEMPLATES,
  type ReadBackId,
  render,
  TERM_SAID,
} from './templates';
import type { PersonalSheet } from './types';
import { monthAfter } from './world';

// The read-back (gate GUIDED-INTAKE): what the intake understood, said back to the person before the
// engine runs. It is drawn from the validated sheet by templates, in the sheet's language, and never
// written by a model, so what the person confirms is what the engine will use. Every number and name
// in it is a value of the sheet, or the name handed in for a slug the sheet holds: a shared
// portfolio's, a curated label's, or the value a matched theme was matched by (`readback.test.ts`
// holds that, C18). The time frame is the sheet's months, said the way the person said it: as months,
// as those months in whole years, or as the month they end in.

type Value = string | number;

/**
 * How the theme sleeves of a sheet are said (gates THEMES and THEME-MATCHED). A slug with no name
 * handed in is said as it is written.
 */
export type ThemeNames = {
  /** The curated labels: a theme sleeve that holds one is said by the label's name. */
  labels?: readonly Pick<ShelfLabel, 'slug' | 'name'>[];
  /** By matched slug, the value it was matched by as the stocks' attributes write it. */
  matched?: Readonly<Record<string, string>>;
};

/**
 * How the person said the time frame (Oct 6), so the read-back says it back the same way: in months,
 * in years ("about 5 years"), or as a date ("by 2031"). The figure is the sheet's whatever is handed
 * in: its months, those months in years where they are whole years, or, for a date, the month they
 * end in counted from `from` (YYYY-MM), the month the intake counted them from.
 */
export type TermSaid = { said: 'months' | 'years' } | { said: 'date'; from: string };

const MONTHS_IN_A_YEAR = 12;

/** What a theme filled by a filter is said as: "names matched by industry: Aerospace & Defense". */
export const matchedName = (by: MarketFilterBy, value: string, lang: Language): string =>
  render(MATCHED_NAME[lang], { by: FILTER_BY_WORDS[lang][by], value }, lang);

/**
 * The read-back of a sheet, sentence by sentence. `portfolios` names the shared portfolios the sheet
 * holds by slug, and `themes` its theme sleeves. `term` is how the person said the time frame; left
 * out, it is said in months.
 */
export function readBack(
  sheet: PersonalSheet,
  portfolios: ShelfPortfolio[],
  themes: ThemeNames = {},
  term?: TermSaid,
): string[] {
  const lang = sheet.language;
  const say = (id: ReadBackId, params: Record<string, Value> = {}) =>
    render(READBACK_TEMPLATES[id][lang], params, lang);
  const nameOf = (slug: string) => portfolios.find((p) => p.slug === slug)?.name ?? slug;
  // A label handed in with no name in this language is said as a slug with no label is: never a blank.
  const themeOf = (slug: string) =>
    themes.labels?.find((l) => l.slug === slug)?.name[lang] || nameOf(slug);
  const out: string[] = [];
  // The sheet's months, the way the person said them. Anything that cannot be said that way from the
  // sheet (months that are not whole years, a month to count from that is no month) is said in months.
  const termSaid = (): string => {
    const months = sheet.horizonMonths;
    if (term?.said === 'years' && months % MONTHS_IN_A_YEAR === 0)
      return render(TERM_SAID.years[lang], { years: months / MONTHS_IN_A_YEAR }, lang);
    if (term?.said === 'date' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(term.from))
      return render(TERM_SAID.date[lang], { month: monthAfter(term.from, months) }, lang);
    return render(TERM_SAID.months[lang], { months }, lang);
  };

  // A goal with no date is said as one: the months it is built over are a parameter, not the person's.
  // With a stated mix the risk is the mix's, said once in the assumptions (gate EXPLICIT-MIX). The
  // same holds for a plan split into themes and a part kept safe, with no part at a risk the person
  // picks: its limits follow what it holds.
  const themed =
    sheet.sleeves?.some((s) => s.kind === 'theme') === true &&
    !sheet.sleeves.some((s) => s.kind === 'goal');
  const mixed = sheet.mix !== undefined || themed;
  out.push(
    sheet.horizonOpen
      ? mixed
        ? say('GOAL_OPEN_MIX', { goal: sheet.goal, amount: sheet.amountUsd })
        : say('GOAL_OPEN', { goal: sheet.goal, amount: sheet.amountUsd, risk: sheet.risk })
      : mixed
        ? say('GOAL_MIX', { goal: sheet.goal, amount: sheet.amountUsd, term: termSaid() })
        : say('GOAL', {
            goal: sheet.goal,
            amount: sheet.amountUsd,
            term: termSaid(),
            risk: sheet.risk,
          }),
  );
  if (sheet.goal === 'income' && sheet.incomeTargetUsdMonthly !== undefined)
    out.push(say('INCOME', { income: sheet.incomeTargetUsdMonthly }));
  if (sheet.currency && sheet.currency !== 'USD')
    out.push(say('CURRENCY', { currency: sheet.currency }));
  if (sheet.themes.length > 0)
    out.push(say('THEMES', { themes: sheet.themes.map(nameOf).join(',') }));
  for (const chain of sheet.chains) out.push(say('CHAIN', { chain }));
  out.push(say(sheet.rules.useHoldings ? 'HOLDINGS_ON' : 'HOLDINGS_OFF'));
  // The glide is opt-in (gate GLIDE-OPT-IN, Oct 6): said only when it is on.
  if (sheet.rules.glide) out.push(say('GLIDE_ON'));

  const limits = sheet.limits;
  if (limits?.mustKeepUsd !== undefined) out.push(say('MUST_KEEP', { amount: limits.mustKeepUsd }));
  if (limits?.mayNeedInMonths !== undefined)
    out.push(say('MAY_NEED', { months: limits.mayNeedInMonths }));
  if (limits?.creditTolerance === 'none') out.push(say('NO_CREDIT'));
  if (limits?.creditTolerance === 'limited') out.push(say('CREDIT_LIMITED'));
  if (limits?.creditTolerance === 'accept') out.push(say('CREDIT_ACCEPT'));
  // Said in the order of `CLASS_WORDS`, whatever order the sheet holds them in: "stocks and stock
  // funds".
  const said = Object.keys(CLASS_WORDS[lang]);
  const classes = [...(limits?.cannotHold?.classes ?? [])].sort(
    (a, b) => said.indexOf(a) - said.indexOf(b),
  );
  if (classes.length > 0)
    out.push(
      say('CANNOT_HOLD', { classes: classes.map((c) => CLASS_WORDS[lang][c] ?? c).join(',') }),
    );
  const names = [...(limits?.cannotHold?.underlyings ?? []), ...(limits?.cannotHold?.assets ?? [])];
  if (names.length > 0) out.push(say('CANNOT_HOLD_NAMES', { names: names.join(',') }));

  for (const o of sheet.obligations ?? [])
    out.push(say('OBLIGATION', { amount: o.amount, currency: o.currency, month: o.month }));
  // What the person said to hold (gate EXPLICIT-MIX), part by part.
  const mix = sheet.mix;
  if (mix) {
    if (mix.growthBps > 0) out.push(say('MIX_GROWTH', { share: mix.growthBps }));
    if (mix.dollarYieldBps > 0) out.push(say('MIX_DOLLAR_YIELD', { share: mix.dollarYieldBps }));
    if (mix.creditBps) out.push(say('MIX_CREDIT', { share: mix.creditBps }));
    if (mix.goldBps > 0) out.push(say('MIX_GOLD', { share: mix.goldBps }));
    if (mix.cashBps > 0) out.push(say('MIX_CASH', { share: mix.cashBps }));
  }
  for (const sleeve of sheet.sleeves ?? []) {
    if (sleeve.kind === 'goal') out.push(say('SLEEVE_GOAL', { share: sleeve.shareBps }));
    if (sleeve.kind === 'safe_yield')
      out.push(say('SLEEVE_SAFE_YIELD', { share: sleeve.shareBps }));
    if (sleeve.kind === 'theme') {
      // A theme filled by a filter says what it was matched by, never the name of a curated theme.
      const filter = filterOfSlug(sleeve.theme);
      if (filter)
        out.push(
          say('SLEEVE_MATCHED', {
            share: sleeve.shareBps,
            matched: matchedName(filter.by, themes.matched?.[sleeve.theme] || filter.key, lang),
          }),
        );
      else out.push(say('SLEEVE_THEME', { share: sleeve.shareBps, theme: themeOf(sleeve.theme) }));
    }
  }
  // One risk for the plan: with a part kept safe, it is the risk of the rest, and that is said.
  if (!themed && sheet.sleeves?.some((s) => s.kind === 'safe_yield') && sheet.sleeves.length > 1)
    out.push(say('SLEEVE_RISK', { risk: sheet.risk }));
  if (sheet.sleeves) out.push(say(sheet.restoreSplit ? 'RESTORE_ON' : 'RESTORE_OFF'));
  out.push(say('CONFIRM'));
  return out;
}

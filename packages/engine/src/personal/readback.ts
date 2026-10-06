import type { ShelfPortfolio } from './intake';
import { CLASS_WORDS, READBACK_TEMPLATES, type ReadBackId, render } from './templates';
import type { PersonalSheet } from './types';

// The read-back (gate GUIDED-INTAKE): what the intake understood, said back to the person before the
// engine runs. It is drawn from the validated sheet by templates, in the sheet's language, and never
// written by a model, so what the person confirms is what the engine will use. Every number and name
// in it is a value of the sheet, or a shared portfolio's name for a slug the sheet holds
// (`readback.test.ts` holds that, C18).

type Value = string | number;

/** The read-back of a sheet, sentence by sentence. `portfolios` names the slugs the sheet holds. */
export function readBack(sheet: PersonalSheet, portfolios: ShelfPortfolio[]): string[] {
  const lang = sheet.language;
  const say = (id: ReadBackId, params: Record<string, Value> = {}) =>
    render(READBACK_TEMPLATES[id][lang], params, lang);
  const nameOf = (slug: string) => portfolios.find((p) => p.slug === slug)?.name ?? slug;
  const out: string[] = [];

  // A goal with no date is said as one: the months it is built over are a parameter, not the person's.
  out.push(
    sheet.horizonOpen
      ? say('GOAL_OPEN', { goal: sheet.goal, amount: sheet.amountUsd, risk: sheet.risk })
      : say('GOAL', {
          goal: sheet.goal,
          amount: sheet.amountUsd,
          months: sheet.horizonMonths,
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
  const classes = limits?.cannotHold?.classes ?? [];
  if (classes.length > 0)
    out.push(
      say('CANNOT_HOLD', { classes: classes.map((c) => CLASS_WORDS[lang][c] ?? c).join(',') }),
    );
  const names = [...(limits?.cannotHold?.underlyings ?? []), ...(limits?.cannotHold?.assets ?? [])];
  if (names.length > 0) out.push(say('CANNOT_HOLD_NAMES', { names: names.join(',') }));

  for (const o of sheet.obligations ?? [])
    out.push(say('OBLIGATION', { amount: o.amount, currency: o.currency, month: o.month }));
  for (const sleeve of sheet.sleeves ?? []) {
    if (sleeve.kind === 'goal') out.push(say('SLEEVE_GOAL', { share: sleeve.shareBps }));
    if (sleeve.kind === 'safe_yield')
      out.push(say('SLEEVE_SAFE_YIELD', { share: sleeve.shareBps }));
    if (sleeve.kind === 'theme')
      out.push(say('SLEEVE_THEME', { share: sleeve.shareBps, theme: nameOf(sleeve.theme) }));
  }
  // One risk for the plan: with a part kept safe, it is the risk of the rest, and that is said.
  if (sheet.sleeves?.some((s) => s.kind === 'safe_yield') && sheet.sleeves.length > 1)
    out.push(say('SLEEVE_RISK', { risk: sheet.risk }));
  if (sheet.sleeves) out.push(say(sheet.restoreSplit ? 'RESTORE_ON' : 'RESTORE_OFF'));
  out.push(say('CONFIRM'));
  return out;
}

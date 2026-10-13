import type { Shelf } from '@colosseum/schemas';
import { compose } from './compose';
import { RISKS } from './mix';
import { toCents } from './money';
import { PERSONAL_PARAMS } from './params';
import { sleeveOfClass } from './registry';
import type { ComposeContext, PersonalSheet, RiskLevel } from './types';

// The limits a plan held in theme sleeves takes (gates THEMES, THEME-MATCHED). A sheet whose split
// is themes and a part kept safe has no part at a risk the person picks: its risk follows what it
// holds, as a stated mix's does (./mix.ts). A caller that says that risk back before the plan is
// made must name the one the engine will take, so it is found the way a mix's is: not worked out
// apart from placement, but by making the plan at each risk and reading what it holds.

/**
 * What the theme sleeves of a plan hold in their own names, in cents. A theme sleeve also records
 * where the money none of its names took is held, in dollar yield and then cash (./compose.ts):
 * that part is the sleeve's and no name's, so it is not counted. Neither is a token the shelf does
 * not list: a name of a theme is one the chain lists.
 */
function heldInNames(sheet: PersonalSheet, shelf: Shelf, context: ComposeContext): number {
  const names = new Set(
    shelf.assets
      .filter((asset) => !['dollarYield', 'cash'].includes(sleeveOfClass(asset.cls)))
      .map((asset) => asset.id),
  );
  return (compose(sheet, shelf, context).split ?? [])
    .filter((sleeve) => sleeve.kind === 'theme')
    .flatMap((sleeve) => sleeve.holds)
    .reduce(
      (cents, held) => (names.has(held.assetId) ? cents + toCents(held.amountUsd) : cents),
      0,
    );
}

/**
 * The risk whose limits a sheet held in theme sleeves takes: the lowest risk at which the plan holds
 * the most in its theme sleeves' names that it holds at any risk. The plan is made at each risk, by
 * the engine's own `compose` on this shelf and these figures, and what it holds is read. A cent for
 * each line a plan may hold is the rounding of its parts (a share of the plan and a cap are each
 * rounded to the cent), so plans that close hold as much, and a tie goes to the lower risk. It is
 * "the most at any risk" and not "as much as at the highest" so that it also holds on a table whose
 * caps do not rise. A sheet with no theme sleeve takes its own risk.
 */
export function riskForSleeves(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): RiskLevel {
  if (!(sheet.sleeves ?? []).some((sleeve) => sleeve.kind === 'theme')) return sheet.risk;
  const held = RISKS.map((risk) => heldInNames({ ...sheet, risk }, shelf, context));
  const rounding = (context.params ?? PERSONAL_PARAMS).maxLinesPerChain;
  const most = Math.max(...held);
  return RISKS[held.findIndex((cents) => cents + rounding >= most)] ?? sheet.risk;
}

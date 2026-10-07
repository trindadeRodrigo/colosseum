import type { Shelf } from '@colosseum/schemas';
import { compose } from './compose';
import { RISKS } from './mix';
import type { ComposeContext, PersonalSheet, RiskLevel } from './types';

// The limits a plan held in theme sleeves takes (gates THEMES, THEME-MATCHED). A sheet whose split
// is themes and a part kept safe has no part at a risk the person picks: its risk follows what it
// holds, as a stated mix's does (./mix.ts). A caller that says that risk back before the plan is
// made must name the one the engine will take, so it is found the way a mix's is: not worked out
// apart from placement, but by making the plan.

const CENTS = 100;

/** What the theme sleeves of a plan hold in their own names, in cents. */
const heldInThemes = (sheet: PersonalSheet, shelf: Shelf, context: ComposeContext): number =>
  Math.round(
    (compose(sheet, shelf, context).split ?? []).reduce(
      (usd, sleeve) =>
        sleeve.kind === 'theme' ? usd + sleeve.holds.reduce((n, h) => n + h.amountUsd, 0) : usd,
      0,
    ) * CENTS,
  );

/**
 * The risk whose limits a sheet held in theme sleeves takes: the plan is made at each risk in turn,
 * lowest first, by the engine's own `compose` on this shelf and these figures, and what its theme
 * sleeves hold in their names is read. The risk is the lowest at which they hold the most they hold
 * at any; a tie goes to the lower risk. A sheet with no theme sleeve takes its own.
 */
export function riskForSleeves(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): RiskLevel {
  if (!(sheet.sleeves ?? []).some((s) => s.kind === 'theme')) return sheet.risk;
  let best: { risk: RiskLevel; cents: number } | null = null;
  for (const risk of RISKS) {
    const cents = heldInThemes({ ...sheet, risk }, shelf, context);
    if (best === null || cents > best.cents) best = { risk, cents };
  }
  return best?.risk ?? sheet.risk;
}

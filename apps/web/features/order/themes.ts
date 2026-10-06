import type { BasketLine } from '@colosseum/schemas';

// The theme sleeves of a plan (gates SLEEVES, THEMES, THEME-FIRST), read from its lines: the shared
// plan carries no sleeves of its own, but every line a theme holds says so in its reasons, the share
// of the plan the person set for it (`THEME_SLEEVE`) and why the name is on the theme's list, with the
// list's version and curator (`THEME_MEMBER`). The sentences are the engine's, in the plan's language.

export type ThemeGroup = {
  /** The theme's name, as the plan names it ("AI", "IA"). */
  theme: string;
  /** The share of the plan the person set for it, from the line's reason; null if none says. */
  shareBps: number | null;
  /** Each name the theme holds and why it is on the list. */
  names: { line: BasketLine; why: string }[];
};

const reasonOf = (line: BasketLine, rule: string) => line.reasons.find((r) => r.rule === rule);

/** The themes a plan holds, in the order their first name comes in the plan. */
export function themesOf(lines: readonly BasketLine[]): ThemeGroup[] {
  const groups = new Map<string, ThemeGroup>();
  for (const line of lines) {
    const member = reasonOf(line, 'THEME_MEMBER');
    const theme = member?.params.theme;
    if (!member || typeof theme !== 'string') continue;
    const share = reasonOf(line, 'THEME_SLEEVE')?.params.shareBps;
    const group = groups.get(theme) ?? { theme, shareBps: null, names: [] };
    if (group.shareBps === null && typeof share === 'number') group.shareBps = share;
    group.names.push({ line, why: member.text });
    groups.set(theme, group);
  }
  return [...groups.values()];
}

/** The reason a line shows first: on a theme's name, why it is on the list. */
export const whyOf = (line: BasketLine): string | undefined =>
  (reasonOf(line, 'THEME_MEMBER') ?? line.reasons[0])?.text;

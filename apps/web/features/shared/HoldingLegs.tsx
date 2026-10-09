'use client';
import { type PlanLeg, PlanLegs } from '../../components/ui/PlanLegs';

// A draft's holdings on Rodrigo's plan bar (plan-leg.md, `<PlanLegs>`): pill ends, a 2px ground gap,
// the four leg colours, a direct label under the bar for each leg, a rule over the part whose label is
// pointed at, and nothing dimmed. The bar takes at most four legs ("more than 4 legs: group them",
// color-system.md). A draft may hold up to seventeen, so with five or more the three largest are a leg
// each and the rest are one leg, named for how many they are, with their shares added up. The legs
// lie largest first, as his spec has them, the grouped one where its sum puts it. The rows under the
// bar still list every holding, in the draft's order, with its exact share; a row's swatch is its
// leg's colour.
//
// It supersedes the mix joint (Thom, 2026-10-09: the preview uses Rodrigo's plan bar).

export type HeldShare = { key: string; name: string; bps: number };

/** The most legs the bar draws (plan-leg.md). */
const MOST = 4;

/**
 * Which leg each holding is drawn in, the legs largest first (the earlier of two equal ones first).
 * Four holdings or fewer: one each. More: the three largest one each, and one leg for the rest,
 * placed by the sum of its shares.
 */
export function legsOf(shares: readonly HeldShare[]): {
  /** The holdings of each leg, in leg order. */
  legs: HeldShare[][];
  /** The leg a holding is drawn in, by its key. */
  legOf: ReadonlyMap<string, number>;
} {
  const held = shares.filter((s) => s.bps > 0);
  let legs: HeldShare[][];
  if (held.length <= MOST) legs = held.map((s) => [s]);
  else {
    const largest = new Set(
      held
        .map((s, at) => ({ s, at }))
        .sort((a, b) => b.s.bps - a.s.bps || a.at - b.at)
        .slice(0, MOST - 1)
        .map(({ s }) => s.key),
    );
    legs = [
      ...held.filter((s) => largest.has(s.key)).map((s) => [s]),
      held.filter((s) => !largest.has(s.key)),
    ];
  }
  const sum = (leg: HeldShare[]) => leg.reduce((total, s) => total + s.bps, 0);
  legs = legs
    .map((leg, at) => ({ leg, at }))
    .sort((a, b) => sum(b.leg) - sum(a.leg) || a.at - b.at)
    .map(({ leg }) => leg);
  return {
    legs,
    legOf: new Map(legs.flatMap((leg, index) => leg.map((s) => [s.key, index] as const))),
  };
}

/** The leg colour of a holding's row: the same class the bar's segment and its label carry. */
export const legFill = (leg: number | undefined) =>
  leg === undefined ? undefined : (['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'][leg] as string);

export function HoldingLegs({
  shares,
  share,
  others,
  size = 'default',
}: {
  shares: readonly HeldShare[];
  /** A share as the rows show it: "16.67%". A grouped leg shows the sum of its holdings' shares. */
  share: (bps: number) => string;
  /** The name of the leg that groups the smaller holdings: "9 others". */
  others: (count: number) => string;
  /** 12px, or 24px on a card where the draft is the picture. */
  size?: 'default' | 'hero';
}) {
  const { legs } = legsOf(shares);
  const total = legs.flat().reduce((sum, s) => sum + s.bps, 0);
  if (total === 0) return null;
  const drawn: PlanLeg[] = legs.map((leg) => {
    const bps = leg.reduce((sum, s) => sum + s.bps, 0);
    const [one] = leg;
    return {
      id: leg.map((s) => s.key).join(' '),
      name: leg.length === 1 && one ? one.name : others(leg.length),
      weight: bps / total,
      weightLabel: share(bps),
      // a share is no yield: no rate is shown, and so no pin
      rate: null,
    };
  });
  // A new draft is a new plan: its legs seat once (plan-lock), or crossfade under reduced motion.
  const key = drawn.map((leg) => `${leg.id}=${leg.weightLabel}`).join(' ');
  return (
    <div data-ui="holding-legs" data-legs={drawn.length}>
      <PlanLegs key={key} legs={drawn} size={size} lock />
    </div>
  );
}

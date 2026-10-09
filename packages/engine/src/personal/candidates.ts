import type { Shelf } from '@colosseum/schemas';
import { composeAs, limitsOf } from './compose';
import { sum } from './money';
import { PERSONAL_PARAMS } from './params';
import { text } from './templates';
import {
  CANDIDATES,
  type ComposeContext,
  type PersonalCandidates,
  type PersonalMix,
  type PersonalProposal,
  type PersonalSheet,
  type Scorecard,
  SLEEVES,
  type Sleeve,
} from './types';

// The three candidates of gate THREE-PLANS (slice 3; section 2.4 of the research note, C10 and C11):
// one goal, the same engine run three times, each inside the person's limits. Cover sets a year of
// withdrawals aside, holds no credit leg and reads exits more cautiously; Spread fills dollar yield
// evenly under a tighter issuer cap; Carry is the table as it is.
//
// The rules that keep them a real choice, each from a study the note cites:
// - Two closer than `candidates.distinctBps` are one choice: the later in the fixed order is not shown.
// - None is dominated: a candidate that another is as good as on every line of the scorecard, and
//   better on one, is not shown (a dominated option is what makes a decoy).
// - Each is the best on at least one line of the scorecard, alone: one that is best on none is not
//   shown, so there is no middle option to fall back on.
// - None is marked, none is selected, and they come in one fixed order. Fewer than three is said, with
//   why, never filled with a foil.

/** One number of the scorecard, and which way is better. Null where the plan has none. */
export type ScoreLine = {
  key: string;
  better: 'more' | 'less';
  of: (s: Scorecard) => number | null;
};

/** The lines of the scorecard the candidates are compared on. Stresses are added by id. */
const LINES: ScoreLine[] = [
  { key: 'monthsCovered', better: 'more', of: (s) => s.monthsCovered },
  { key: 'monthsPaid', better: 'more', of: (s) => s.base?.monthsPaid ?? null },
  { key: 'carryObserved', better: 'more', of: (s) => s.carryObservedBps },
  { key: 'exitCost', better: 'less', of: (s) => s.exit.costBps },
  { key: 'exitMeasured', better: 'more', of: (s) => s.exit.measuredShareBps },
  { key: 'largestIssuer', better: 'less', of: (s) => s.concentration.largestIssuerBps },
  { key: 'issuers', better: 'more', of: (s) => s.concentration.issuers },
  { key: 'creditBasis', better: 'less', of: (s) => s.creditBasisBps },
  { key: 'openFx', better: 'less', of: (s) => s.openFxUsd ?? null },
];

/** Every line, the stresses of these scorecards included; only lines all of them have a number for. */
export function linesOf(cards: Scorecard[]): ScoreLine[] {
  const stresses = [...new Set(cards.flatMap((c) => c.stresses.map((s) => s.id)))].sort();
  const all: ScoreLine[] = [
    ...LINES,
    ...stresses.map(
      (id): ScoreLine => ({
        key: `stress:${id}`,
        better: 'more',
        // A stress applies only where a plan holds what it moves: one that does not apply leaves the
        // months as they are at the rates observed.
        of: (s) => s.stresses.find((x) => x.id === id)?.monthsPaid ?? s.base?.monthsPaid ?? null,
      }),
    ),
  ];
  return all.filter((line) => cards.every((c) => line.of(c) !== null));
}

/** Plus when `a` is better than `b` on a line, minus when worse, zero when the same. */
function compare(line: ScoreLine, a: Scorecard, b: Scorecard): number {
  const [x, y] = [line.of(a) ?? 0, line.of(b) ?? 0];
  return line.better === 'more' ? Math.sign(x - y) : Math.sign(y - x);
}

/** Whether `b` is as good as `a` on every line and better on one. */
export function dominates(lines: ScoreLine[], b: Scorecard, a: Scorecard): boolean {
  const signs = lines.map((line) => compare(line, b, a));
  return signs.every((s) => s >= 0) && signs.some((s) => s > 0);
}

/** The lines on which `card` is better than every other, alone. */
export function winsOf(lines: ScoreLine[], card: Scorecard, others: Scorecard[]): string[] {
  return lines
    .filter((line) => others.every((o) => compare(line, card, o) > 0))
    .map((line) => line.key);
}

/** Half the sum of the absolute differences in weight, by token: the share that would have to move. */
export function distanceBps(a: PersonalProposal, b: PersonalProposal): number {
  const of = (p: PersonalProposal) => new Map(p.lines.map((l) => [l.assetId, l.weightBps]));
  const [x, y] = [of(a), of(b)];
  const keys = new Set([...x.keys(), ...y.keys()]);
  return sum([...keys].map((k) => Math.abs((x.get(k) ?? 0) - (y.get(k) ?? 0)))) / 2;
}

/** The share of the plan a mix states for each class. */
const statedOf = (mix: PersonalMix): Record<Sleeve, number> => ({
  growth: mix.growthBps,
  dollarYield: mix.dollarYieldBps,
  gold: mix.goldBps,
  cash: mix.cashBps,
});

/**
 * Where a candidate holds another share of a class the mix states than the plan made for the mix as
 * it is: the first such class, the share the candidate would hold and the share that plan holds, or
 * null. Each class the person gave a share to is compared on its own: stocks and crypto, dollar
 * yield, gold, cash. A class they gave none holds only what the others could not, or what is set
 * aside: where that sits is not theirs to have stated. Lines are rounded to whole basis points, so
 * each line may move its class by one.
 */
export function mixBreak(
  plan: PersonalProposal,
  carry: PersonalProposal,
  mix: PersonalMix,
): { sleeve: Sleeve; heldBps: number; mixBps: number } | null {
  const shareOf = (p: PersonalProposal, sleeve: Sleeve) =>
    p.sleeves.find((x) => x.sleeve === sleeve)?.weightBps ?? 0;
  const slack = Math.max(plan.lines.length, carry.lines.length);
  const stated = statedOf(mix);
  for (const sleeve of SLEEVES) {
    if (stated[sleeve] <= 0) continue;
    const [heldBps, mixBps] = [shareOf(plan, sleeve), shareOf(carry, sleeve)];
    if (Math.abs(heldBps - mixBps) > slack) return { sleeve, heldBps, mixBps };
  }
  return null;
}

/**
 * The candidates for one goal: those shown, in the fixed order (Cover, Spread, Carry), each with its
 * scorecard on the plan, and those not shown with why. Pure, as `compose` is: the same arguments give
 * the same answer. The sheet is validated by the first run; an invalid one throws `PersonalInputError`.
 */
export function candidates(
  sheet: PersonalSheet,
  shelf: Shelf,
  context: ComposeContext,
): PersonalCandidates {
  const P = context.params ?? PERSONAL_PARAMS;
  // The limits a mix takes are the ones of the person's own plan, whichever candidate is made: they
  // are found once, and the three take them.
  const limits = sheet.mix ? limitsOf(sheet, shelf, context) : undefined;
  const made = CANDIDATES.map((id) => ({
    id,
    plan: composeAs(id, sheet, shelf, context, limits),
  }));
  const lang = made[0]?.plan.sheet.language ?? sheet.language;
  const notShown: PersonalCandidates['notShown'] = [];

  // A stated mix (gate EXPLICIT-MIX) is the person's, not a candidate's: Cover and Spread may change
  // only what it leaves open (which tokens, the issuers, credit within dollar yield). One that would
  // hold another share of a class the mix states than Carry is not made. Carry is the plan made for
  // the mix as it is: what the mix comes to once the person's own withdrawals are set aside and their
  // limits applied. It is the one measure for every candidate, so each plan shown holds the share
  // the sentence names.
  const carry = made.find((c) => c.id === 'carry');
  const mix = carry?.plan.sheet.mix;
  const keeps = made.filter((c) => {
    if (!carry || c === carry || !mix) return true;
    const broken = mixBreak(c.plan, carry.plan, mix);
    if (broken)
      notShown.push({
        id: c.id,
        why: text('CANDIDATE_BREAKS_MIX', { plan: c.id, ...broken }, lang),
      });
    return broken === null;
  });

  // One choice, not two: the earlier in the fixed order stays.
  let shown: typeof made = [];
  for (const c of keeps) {
    const near = shown.find((s) => distanceBps(s.plan, c.plan) < P.candidates.distinctBps);
    if (near) {
      const apart = distanceBps(near.plan, c.plan);
      const said = { plan: c.id, other: near.id };
      notShown.push({
        id: c.id,
        why:
          apart === 0
            ? text('CANDIDATE_IDENTICAL', said, lang)
            : text(
                'CANDIDATE_SAME',
                { ...said, distanceBps: apart, distinctBps: P.candidates.distinctBps },
                lang,
              ),
      });
    } else shown.push(c);
  }

  // Then neither dominated nor best at nothing. Taking one out can only leave the others better off,
  // so this is repeated until it holds; the last in the fixed order goes first.
  const cardOf = (c: (typeof made)[number]) => c.plan.scorecard as Scorecard;
  for (;;) {
    const lines = linesOf(shown.map(cardOf));
    const out = [...shown].reverse().flatMap((c) => {
      const others = shown.filter((o) => o !== c);
      const by = others.find((o) => dominates(lines, cardOf(o), cardOf(c)));
      if (by)
        return [
          {
            c,
            why: text('CANDIDATE_DOMINATED', { plan: c.id, other: by.id }, lang),
          },
        ];
      if (others.length > 0 && winsOf(lines, cardOf(c), others.map(cardOf)).length === 0)
        return [{ c, why: text('CANDIDATE_NO_LEAD', { plan: c.id }, lang) }];
      return [];
    })[0];
    if (!out) break;
    notShown.push({ id: out.c.id, why: out.why });
    shown = shown.filter((s) => s !== out.c);
  }

  return {
    shown,
    notShown: CANDIDATES.flatMap((id) => notShown.filter((n) => n.id === id)),
  };
}

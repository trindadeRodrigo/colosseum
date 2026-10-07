import { describe, expect, it } from 'vitest';
import { compose } from './compose';
import { RISKS } from './mix';
import { riskForSleeves } from './sleeve-risk';
import { aiList, fixtureContext, launchShelf, sheet } from './testing';
import type { PersonalProposal, PersonalSheet } from './types';

// The risk whose limits a sheet held in theme sleeves takes (./sleeve-risk.ts): the lowest at which
// the plan holds the most in its theme sleeves' names. The rule is held against the engine's own
// plans, made here at each risk, and against no number: what the engine holds at a risk is its own
// to decide, and may move with its caps.

const shelf = launchShelf();
const context = fixtureContext({ themes: [aiList()] });
const WHOLE = 10_000;
/** A sheet with `shareBps` in the AI theme and the rest kept safe. */
const themed = (shareBps: number, over: Partial<PersonalSheet> = {}): PersonalSheet =>
  sheet({
    chains: ['solana'],
    sleeves: [
      { kind: 'theme', theme: 'ai', shareBps },
      ...(shareBps < WHOLE ? [{ kind: 'safe_yield' as const, shareBps: WHOLE - shareBps }] : []),
    ],
    ...over,
  });
/** What the theme sleeves of a plan hold in their names, in cents. */
const heldInThemes = (plan: PersonalProposal): number =>
  Math.round(
    (plan.split ?? []).reduce(
      (usd, s) => (s.kind === 'theme' ? usd + s.holds.reduce((n, h) => n + h.amountUsd, 0) : usd),
      0,
    ) * 100,
  );

describe('the risk a sheet held in theme sleeves takes', () => {
  it('is the lowest risk at which the plan holds the most in its theme sleeves, at every share and amount tried', () => {
    let somewhere = 0;
    for (const shareBps of [1000, 3000, 5000, 7000, WHOLE])
      for (const amountUsd of [500, 2000, 50_000, 500_000]) {
        const s = themed(shareBps, { amountUsd });
        const held = RISKS.map((risk) => heldInThemes(compose({ ...s, risk }, shelf, context)));
        // The first place the most is held: a tie goes to the lower risk.
        const expected = RISKS[held.indexOf(Math.max(...held))];
        expect(riskForSleeves(s, shelf, context), `${shareBps} of ${amountUsd}`).toBe(expected);
        somewhere = Math.max(somewhere, ...held);
      }
    // The rule is not read off empty plans: somewhere on the grid the theme holds something.
    expect(somewhere).toBeGreaterThan(0);
  });

  it('does not depend on the risk the sheet came with', () => {
    const answers = RISKS.map((risk) => riskForSleeves(themed(7000, { risk }), shelf, context));
    expect(new Set(answers).size).toBe(1);
  });

  it('a sheet with no theme sleeve takes its own risk', () => {
    for (const risk of RISKS) {
      expect(riskForSleeves(sheet({ risk }), shelf, context)).toBe(risk);
      expect(
        riskForSleeves(
          sheet({
            risk,
            sleeves: [
              { kind: 'goal', shareBps: 7000 },
              { kind: 'safe_yield', shareBps: 3000 },
            ],
          }),
          shelf,
          context,
        ),
      ).toBe(risk);
    }
  });

  it('is one of the three risks, and the same each time', () => {
    const s = themed(WHOLE);
    const first = riskForSleeves(s, shelf, context);
    expect(RISKS).toContain(first);
    expect(riskForSleeves(s, shelf, context)).toBe(first);
  });
});

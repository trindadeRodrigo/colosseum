import { describe, expect, it } from 'vitest';
import { compose } from './index';
import {
  allReasons,
  fixtureContext,
  launchShelf,
  sheet,
  usdBrl,
  violations,
  withReais,
} from './testing';
import { PersonalInputError, type PersonalSheet } from './types';

// Slice 2 of docs/vault/PROMPT-BUILD-SOLVER.md, step 2: the goal's currency and the matching leg
// (gate SOLVER; change C6 of the research note). The matching leg is any cash token counted in the
// goal's currency: no code knows reais (G-NORA is open).

const launch = launchShelf();
const ctx = fixtureContext();
const run = (s: PersonalSheet, shelf = launch, c = ctx) => {
  const plan = compose(s, shelf, c);
  expect(violations(plan, shelf, c)).toEqual([]);
  return plan;
};

describe('a goal in dollars and the same goal in reais, with no withdrawals', () => {
  it('hold the same lines; the reais one says on each that its value moves with the rate', () => {
    const dollars = run(sheet({ goal: 'income' }));
    const reais = run(sheet({ goal: 'income', currency: 'BRL' }));
    expect(reais.lines.map((l) => [l.assetId, l.weightBps])).toEqual(
      dollars.lines.map((l) => [l.assetId, l.weightBps]),
    );
    expect(allReasons(dollars).some((r) => r.rule === 'FX_OPEN')).toBe(false);
    expect(dollars.flags.some((f) => f.startsWith('fx_open'))).toBe(false);
    expect(reais.flags).toEqual(expect.arrayContaining(['fx_open:BRL', 'no_matching_leg:BRL']));
    expect(reais.lines[0]?.reasons.at(-1)?.text).toBe(
      'This line is not counted in BRL, the currency of your goal: its value in BRL moves with the exchange rate.',
    );
  });

  it('a shelf with a token in reais: no `no_matching_leg` flag, and a token in reais is never cash in dollars', () => {
    const reais = run(sheet({ goal: 'income', currency: 'BRL' }), withReais());
    expect(reais.flags).not.toContain('no_matching_leg:BRL');
    // The vault is funded in dollars: the dollar cash token stays the plan's cash.
    expect(reais.lines.some((l) => l.assetId === 'solana:usdc')).toBe(true);
  });
});

describe('FX readings', () => {
  it('a reading with no source, an unknown pair shape or a rate that is not positive is refused', () => {
    const s = sheet({ currency: 'BRL' });
    for (const bad of [
      { ...usdBrl(), source: '' },
      { ...usdBrl(), pair: 'USD/BRL' },
      { ...usdBrl(), value: 0 },
    ])
      expect(() => compose(s, launch, { ...ctx, fx: [bad] })).toThrow(PersonalInputError);
  });

  it('given and unused, a reading changes nothing in the plan but its hash', () => {
    const s = sheet({ currency: 'BRL' });
    const without = run(s);
    const withFx = run(s, launch, { ...ctx, fx: [usdBrl()] });
    expect(withFx.lines).toEqual(without.lines);
    expect(withFx.observations).toEqual(without.observations);
    expect(withFx.inputsHash).not.toBe(without.inputsHash);
  });
});

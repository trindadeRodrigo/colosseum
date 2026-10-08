import { describe, expect, it } from 'vitest';
import { fixedMix } from './fixed-mix';
import { fixtureContext, launchShelf, sheet } from './testing';

// A mix chosen outside the engine (gate MIX-ANY-COMPOSITION): the engine keeps every weight, splits
// the amount to the cent, and says the ceilings and the goal's list, without choosing anything.

const picks = [
  { assetId: 'solana:usdc', weightBps: 1000 },
  { assetId: 'solana:gldx', weightBps: 6000 },
  { assetId: 'solana:spyx', weightBps: 3000 },
];

describe('fixedMix', () => {
  it('keeps the weights, splits the amount, and reads the ceilings from the same world as compose', () => {
    const mix = fixedMix(
      sheet({ goal: 'income', amountUsd: 100_000 }),
      launchShelf(),
      fixtureContext(),
      picks,
      'person',
    );
    expect(mix.lines.map((l) => [l.line.assetId, l.line.weightBps, l.line.amountUsd])).toEqual([
      ['solana:usdc', 1000, 10_000],
      ['solana:gldx', 6000, 60_000],
      ['solana:spyx', 3000, 30_000],
    ]);
    // Gold is measured thin in the fixture: $60,000 is past its ceiling, which the caller is told.
    const gold = mix.lines[1]?.ceiling;
    expect(gold?.measured).toBe(true);
    expect(gold?.usd).toBeLessThan(60_000);
    expect(mix.lines[0]?.ceiling).toBeNull();
    // Gold and a stock are not on the income list: said, not removed.
    expect(mix.lines.map((l) => l.forGoal)).toEqual([true, false, false]);
    expect(mix.lines[2]?.line.reasons[0]?.text).toBe('You chose 30% for SPYx.');
    expect(mix.card.moneyTodayUsd).toBe(100_000);
    expect(mix.observations.some((o) => o.kind === 'liquidity' && o.id === 'solana:gldx')).toBe(
      true,
    );
  });

  it('throws on weights that do not add up to 10,000, a repeat, or an asset of another chain', () => {
    const run = (p: typeof picks) => fixedMix(sheet(), launchShelf(), fixtureContext(), p, 'model');
    expect(() => run([{ assetId: 'solana:usdc', weightBps: 9999 }])).toThrow();
    expect(() =>
      run([
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'solana:usdc', weightBps: 5000 },
      ]),
    ).toThrow();
    expect(() =>
      run([
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'robinhood:spy', weightBps: 5000 },
      ]),
    ).toThrow();
  });
});

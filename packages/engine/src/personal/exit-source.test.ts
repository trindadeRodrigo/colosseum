import type { LiquidityProvider } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { PERSONAL_PARAMS } from './params';
import { fixtureContext, fixtureLiquidity, launchShelf, sheet, violations } from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';

// Decided on Oct 3 (gate EXIT-SOURCE): the measured exit numbers are the one source for what an
// asset may weigh. Where a capacity is measured it sets the ceiling of a line, and the tier on the
// asset list no longer holds it lower. Where nothing is measured the tier is the fallback, and the
// plan says so. The fixture measures three tokens on Solana: SPYx at $2,000,000, NVDAx at $1,500,000
// and GLDx at $40,000; a plan may count on a quarter of each.

const shelf = launchShelf();

function plan(over: Partial<PersonalSheet>, context: Partial<ComposeContext> = {}) {
  const ctx = fixtureContext(context);
  const made = compose(sheet(over), shelf, ctx);
  expect(violations(made, shelf, ctx)).toEqual([]);
  return made;
}
const line = (made: PersonalProposal, id: string) => made.lines.find((l) => l.assetId === id);
const textsOn = (made: PersonalProposal, id: string) =>
  line(made, id)?.reasons.map((r) => r.text) ?? [];
const rulesOn = (made: PersonalProposal, id: string) =>
  line(made, id)?.reasons.map((r) => r.rule) ?? [];

describe('what a token may weigh comes from its measured exit', () => {
  it('a measured capacity sets the ceiling: the tier does not hold the token lower', () => {
    // SPYx is tier A, which was $50,000 a line. Measured, it takes a quarter of $2,000,000.
    const made = plan({ risk: 'high', amountUsd: 400_000 });
    expect(line(made, 'solana:spyx')?.amountUsd).toBe(380_000);
    expect(rulesOn(made, 'solana:spyx')).not.toContain('TIER_CEILING');
    expect(made.flags).not.toContain('ceiling_from_tier:solana:spyx');
    const large = plan({ risk: 'high', amountUsd: 1_000_000 });
    expect(line(large, 'solana:spyx')?.amountUsd).toBe(500_000);
    expect(textsOn(large, 'solana:spyx')).toContain(
      'SPYx is limited to $500,000: beyond that, selling it would cost too much.',
    );
  });

  it('a measured capacity under the tier holds the token lower', () => {
    // GLDx is tier B, $10,000 a line. Measured at $20,000 it takes a quarter of that.
    const thin = fixtureLiquidity({ 'solana:gldx': 20_000 });
    const made = plan({ goal: 'protect', amountUsd: 50_000 }, { liquidity: thin });
    expect(line(made, 'solana:gldx')?.amountUsd).toBe(5_000);
    expect(textsOn(made, 'solana:gldx')).toContain(
      'GLDx is limited to $5,000: beyond that, selling it would cost too much.',
    );
  });

  it('where nothing is measured the tier is the fallback, and the line and a flag say so', () => {
    const made = plan({ risk: 'high' });
    expect(textsOn(made, 'solana:syrupusdc')).toContain(
      'syrupUSDC takes at most $50,000: what selling it costs is not measured yet, so the limit is the one for its tier on the asset list.',
    );
    expect(made.flags).toContain('ceiling_from_tier:solana:syrupusdc');
    // The measured token beside it says nothing of a tier.
    expect(rulesOn(made, 'solana:spyx')).not.toContain('TIER_CEILING');
    // In Portuguese.
    expect(textsOn(plan({ risk: 'high', language: 'pt' }), 'solana:syrupusdc')).toContain(
      'syrupUSDC comporta no máximo US$ 50.000: o custo de vender ainda não está medido, então o limite é o da faixa dele na lista de ativos.',
    );
  });

  it('the tier is what stops a token that is not measured, and the reason says tier, not cost', () => {
    // $150,000 of income on Solana: two dollar-yield tokens, neither measured, $50,000 each by tier.
    // The person accepts credit risk, so syrupUSDC's 50% credit budget and 40% cap ($60,000) are above
    // its tier: the tier is what stops it.
    const made = plan({
      goal: 'income',
      amountUsd: 150_000,
      limits: { creditTolerance: 'accept' },
    });
    expect(line(made, 'solana:syrupusdc')?.amountUsd).toBe(50_000);
    expect(rulesOn(made, 'solana:syrupusdc')).toContain('TIER_CEILING');
    expect(rulesOn(made, 'solana:syrupusdc')).not.toContain('EXIT_CEILING');
    expect(line(made, 'solana:usdc')?.reasons.map((r) => r.rule)).toContain('TIER_CEILING');
  });

  it('with no provider at all, every ceiling is a tier and every line says so', () => {
    const ctx = fixtureContext({ liquidity: undefined });
    const made = compose(sheet({ themes: ['the-seven'] }), shelf, ctx);
    expect(violations(made, shelf, ctx)).toEqual([]);
    for (const l of made.lines.filter((x) => x.assetId !== 'solana:usdc')) {
      expect(
        l.reasons.map((r) => r.rule),
        l.assetId,
      ).toContain('TIER_CEILING');
      expect(made.flags, l.assetId).toContain(`ceiling_from_tier:${l.assetId}`);
    }
    expect(made.observations.filter((o) => o.kind === 'liquidity')).toEqual([]);
  });
});

describe('what the measurement covers', () => {
  it('a token with curves and no measured regime gets its tier ceiling with a flag, never silently', () => {
    // The risk layer skips a time of the week with too few samples. With none left it gives no figure.
    const base = fixtureLiquidity();
    const none: LiquidityProvider = { ...base, exitCapacity: () => null };
    const made = plan({ risk: 'high' }, { liquidity: none });
    expect(made.flags).toEqual(
      expect.arrayContaining(['ceiling_from_tier:solana:spyx', 'exit_capacity_thin:solana:spyx']),
    );
    expect(rulesOn(made, 'solana:spyx')).toContain('TIER_CEILING');
    expect(made.observations.filter((o) => o.kind === 'liquidity')).toEqual([]);
  });

  it('says so when a time of the week was not measured: the limit may be a weekday figure', () => {
    const weekdays = fixtureLiquidity(undefined, 40, undefined, {
      'solana:spyx': ['weekend', 'us_holiday'],
    });
    const made = plan({ risk: 'high' }, { liquidity: weekdays });
    expect(textsOn(made, 'solana:spyx')).toContain(
      'The limit for SPYx comes from part of the week only: selling it at the weekend and on US holidays is not measured, and may cost more.',
    );
    expect(made.flags).toEqual(
      expect.arrayContaining([
        'exit_regime_not_measured:solana:spyx:weekend',
        'exit_regime_not_measured:solana:spyx:us_holiday',
      ]),
    );
    // Measured through the whole week, it says nothing.
    const whole = plan({ risk: 'high' });
    expect(rulesOn(whole, 'solana:spyx')).not.toContain('EXIT_PARTLY_MEASURED');
    expect(whole.flags.some((f) => f.startsWith('exit_regime'))).toBe(false);
    // In Portuguese, and for market hours.
    const offHours = fixtureLiquidity(undefined, 40, undefined, {
      'solana:spyx': ['us_market_hours'],
    });
    expect(
      textsOn(plan({ risk: 'high', language: 'pt' }, { liquidity: offHours }), 'solana:spyx'),
    ).toContain(
      'O limite de SPYx vem de só uma parte da semana: a venda no horário do mercado dos EUA não está medida, e pode custar mais.',
    );
  });

  it('says so when the provider cannot tell which times of the week it measured', () => {
    const { regimes: _regimes, ...plain } = fixtureLiquidity();
    const made = plan({ risk: 'high' }, { liquidity: plain });
    expect(made.flags).toContain('exit_regimes_not_reported');
    expect(plan({ risk: 'high' }).flags).not.toContain('exit_regimes_not_reported');
  });

  it('a capacity read from no sample is not a measurement: the tier holds the token, flagged', () => {
    const thin = fixtureLiquidity({ 'solana:spyx': 0 }, 0);
    const made = plan({ risk: 'high' }, { liquidity: thin });
    expect(line(made, 'solana:spyx')?.weightBps).toBe(9500);
    expect(made.flags).toEqual(
      expect.arrayContaining(['exit_capacity_thin:solana:spyx', 'ceiling_from_tier:solana:spyx']),
    );
    // The table has no number for this: what counts as measured is the risk layer's to say.
    expect(Object.keys(PERSONAL_PARAMS)).not.toContain('minExitSamples');
  });
});

describe('the card, when a sale was measured above the reference price', () => {
  it('shows the cost as zero, says how, and flags that the figure was under zero', () => {
    const base = fixtureLiquidity();
    const above: LiquidityProvider = {
      ...base,
      exitCost: (id) => (base.covers(id) ? -0.0003 : null),
    };
    const made = plan({ risk: 'high' }, { liquidity: above });
    expect(made.card.exit.costBps).toBe(0);
    expect(made.card.exit.text).toBe(
      'You can withdraw the tokens to your own wallet at any time. In the worst hours measured, selling everything cost nothing: the sale price was at or above the reference price. That is measured for 95% of the plan.',
    );
    expect(made.flags).toContain('exit_cost_below_zero');
    // A cost above zero is shown as before, and not flagged.
    const usual = plan({ risk: 'high' });
    expect(usual.card.exit.costBps).toBeGreaterThan(0);
    expect(usual.card.exit.text).toContain('would cost about');
    expect(usual.flags).not.toContain('exit_cost_below_zero');
  });
});

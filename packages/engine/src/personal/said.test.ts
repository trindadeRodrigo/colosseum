import { describe, expect, it } from 'vitest';
import { compose } from './index';
import {
  allReasons,
  fixtureContext,
  fixtureLiquidity,
  launchShelf,
  sheet,
  violations,
} from './testing';
import type { PersonalProposal } from './types';

// What a plan says has to be true where it says it. Each case here is one a review found: a reason
// with no subject, a reason that contradicted what the person chose, a reason that said "left out"
// on a line that held the thing, and a figure that shaped the plan with no label on it.

const shelf = launchShelf();
const ctx = fixtureContext();
const line = (plan: PersonalProposal, id: string) => plan.lines.find((l) => l.assetId === id);
const rulesOn = (plan: PersonalProposal, id: string) => line(plan, id)?.reasons.map((r) => r.rule);
/** The rules that say something was left out. */
const LEFT_OUT = [
  'MAX_LINES',
  'BELOW_MINIMUM',
  'EXCLUDED',
  'NOT_FOR_GOAL',
  'NOT_IN_COUNTRY',
  'NOT_ON_CHAIN',
];

describe('a reason names what it is about', () => {
  it('at $20 the dollar-yield share is too small to hold, and the cash line says that, not " is left out"', () => {
    for (const language of ['en', 'pt'] as const) {
      const plan = compose(sheet({ amountUsd: 20, risk: 'high', language }), shelf, ctx);
      for (const r of allReasons(plan)) {
        for (const [key, value] of Object.entries(r.params))
          expect(String(value), `${r.rule}.${key}`).not.toBe('');
        expect(r.text, r.rule).not.toMatch(/^\s|\s\s|\s[:,.]/);
      }
      expect(violations(plan, shelf, ctx)).toEqual([]);
      const cash = line(plan, 'solana:usdc');
      expect(cash?.amountUsd).toBe(1);
      expect(cash?.reasons.map((r) => r.rule)).toContain('YIELD_TOO_SMALL');
      expect(cash?.reasons.map((r) => r.rule)).not.toContain('BELOW_MINIMUM');
    }
    const plan = compose(sheet({ amountUsd: 20, risk: 'high' }), shelf, ctx);
    expect(line(plan, 'solana:usdc')?.reasons.find((r) => r.rule === 'YIELD_TOO_SMALL')?.text).toBe(
      '$1 meant for dollar yield stays in cash: it is too small to be a part of your plan.',
    );
  });

  it('what stocks could not take, and is too small for dollar yield, is named too', () => {
    // The 500 can take $15 here, so $4 of the $19 meant for stocks spills, and $4 is under the least
    // a part of a plan can be.
    const tight = fixtureContext({ liquidity: fixtureLiquidity({ 'solana:spyx': 60 }) });
    const plan = compose(sheet({ amountUsd: 20, risk: 'high' }), shelf, tight);
    expect(violations(plan, shelf, tight)).toEqual([]);
    expect(line(plan, 'solana:usdc')?.amountUsd).toBe(5);
    for (const r of allReasons(plan))
      for (const value of Object.values(r.params)) expect(String(value), r.rule).not.toBe('');
  });
});

describe('a reason does not contradict what the person chose', () => {
  it('gold beside a chosen portfolio that holds none: not "when you choose no shared portfolio"', () => {
    const plan = compose(sheet({ themes: ['the-seven'] }), shelf, ctx);
    expect(rulesOn(plan, 'solana:gldx')).not.toContain('SLEEVE_DEFAULT');
    expect(line(plan, 'solana:gldx')?.reasons.find((r) => r.rule === 'SLEEVE_FILLED')?.text).toBe(
      'GLD holds the gold share of this plan: no shared portfolio you chose fills it.',
    );
    for (const r of allReasons(plan)) expect(r.rule).not.toBe('SLEEVE_DEFAULT');
  });

  it('with no portfolio chosen, the starting one is named as that', () => {
    const plan = compose(sheet(), shelf, ctx);
    expect(rulesOn(plan, 'solana:spyx')).toContain('SLEEVE_DEFAULT');
    expect(line(plan, 'solana:spyx')?.reasons.find((r) => r.rule === 'SLEEVE_DEFAULT')?.text).toBe(
      'The 500: where a goal to grow starts when you choose no shared portfolio.',
    );
    for (const r of allReasons(plan)) expect(r.rule).not.toBe('SLEEVE_FILLED');
  });

  it('a chosen portfolio with no version on this chain: the sleeve starts where the goal starts, and says the choice did not fill it', () => {
    for (const themes of [['sand-to-server'], ['no-such-portfolio']]) {
      const plan = compose(sheet({ themes }), shelf, ctx);
      expect(violations(plan, shelf, ctx)).toEqual([]);
      expect(plan.removed.map((r) => r.ref)).toContain(themes[0]);
      expect(rulesOn(plan, 'solana:spyx')).not.toContain('SLEEVE_DEFAULT');
      expect(line(plan, 'solana:spyx')?.reasons.find((r) => r.rule === 'SLEEVE_FILLED')?.text).toBe(
        'The 500 holds the stocks and crypto share of this plan: no shared portfolio you chose fills it.',
      );
    }
    const plan = compose(sheet({ themes: ['sand-to-server'] }), shelf, ctx);
    expect(
      plan.removed.find((r) => r.ref === 'sand-to-server')?.reasons.map((r) => r.text),
    ).toEqual(['Sand to Server is left out: it has no version on Solana.']);
  });
});

describe('a reason on a line is true of that line', () => {
  const two = sheet({
    themes: ['the-seven', 'chips-and-agents'],
    chains: ['base'],
    risk: 'high',
    amountUsd: 20_000,
  });

  it('a portfolio opened for lack of room is not called "left out" on the lines that hold it', () => {
    const plan = compose(two, shelf, ctx);
    expect(violations(plan, shelf, ctx)).toEqual([]);
    const names = shelf.families.map((f) => f.meta.name);
    const tokens = new Map(shelf.assets.map((a) => [a.id, a]));
    for (const l of plan.lines) {
      const token = tokens.get(l.assetId);
      for (const r of l.reasons) {
        // No reason names a chain other than the one the plan is on.
        if (r.params.chain !== undefined) expect(r.params.chain, r.text).toBe('base');
        if (!LEFT_OUT.includes(r.rule) || token?.cls === 'cash') continue;
        expect(names, `${l.assetId}: ${r.text}`).not.toContain(r.params.asset);
        expect([token?.symbol, token?.underlying], `${l.assetId}: ${r.text}`).not.toContain(
          r.params.asset,
        );
      }
    }
    // The portfolio that did not fit says why, as a fact about the portfolio.
    const why = plan.lines.flatMap((l) => l.reasons).filter((r) => r.rule.startsWith('NOT_WHOLE_'));
    expect(why.length).toBeGreaterThan(0);
    expect(why[0]?.text).toBe(
      'Chips & Agents cannot be held whole: a plan holds at most 8 parts, and it would make 9.',
    );
  });

  it('the base plan: the reason The Seven is opened names the issuer cap as a fact about it', () => {
    const plan = compose(sheet({ themes: ['the-seven'] }), shelf, ctx);
    expect(
      line(plan, 'solana:nvdax')?.reasons.find((r) => r.rule === 'NOT_WHOLE_ISSUER')?.text,
    ).toBe(
      'The Seven cannot be held whole: more than 70% of the plan would be with Backed (xStocks), the most with one issuer at medium risk.',
    );
    // "Backed is at that limit" is said only on the line that was cut short by it.
    expect(
      plan.lines
        .filter((l) => l.reasons.some((r) => r.rule === 'ISSUER_CAP'))
        .map((l) => l.assetId),
    ).toEqual(['solana:msftx']);
  });
});

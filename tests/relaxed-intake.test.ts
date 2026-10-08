import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmedProposal,
  equalSplit,
  formatPlan,
  LIMITS,
  Reply,
  render,
  validateMessages,
} from '../scripts/relaxed/core';
import { loadShelf, parseArgs, recordedReply, systemPrompt } from '../scripts/relaxed/intake';

const shelf = loadShelf(resolve(import.meta.dirname, '..'), 'robinhood');
const line = (id: string, why = 'named holding') => ({ id: `robinhood:${id}`, why });
const base = (over: Record<string, unknown> = {}) => ({
  say: 'Your allocation proposal.',
  shape: 'pick',
  lines: [line('tsla'), line('sgov')],
  stated: { amount: 1000, currency: 'USD' },
  open: [],
  ...over,
});
const user = 'I have USD 1000 to invest in Tesla and SGOV';
const run = (raw: unknown, messages = [user]) => render(raw, shelf, 'mock', messages);

// Twelve synthetic audit reproductions, plus the six committed hand-written replies. These test
// corrected behavior rather than treating the original VM output as the acceptance oracle.
describe('PR182 twelve synthetic audit regressions', () => {
  it('follows stated 40/60 holding weights without reshaping a cap conflict', () => {
    const plan = run(
      base({ stated: { amount: 1000, currency: 'USD', weights: '40% Tesla, 60% SGOV' } }),
      [`${user}; 40% Tesla, 60% SGOV`],
    );
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([4000, 6000]);
    expect(plan.missing).toContain(
      'robinhood:sgov: exceeds catalog cap; requested weight retained',
    );
  });
  it('rejects overfull shares', () => {
    const plan = run(
      base({
        shape: 'split',
        buckets: [
          { name: 'safe', goal: 'protect', share: 0.8, lines: [line('sgov')] },
          { name: 'Tesla', goal: 'pick', share: 0.8, lines: [line('tsla')] },
        ],
      }),
    );
    expect(plan.missing).toContain('shares must be positive whole basis points totaling 10000');
    expect(plan.ready).toBe(false);
  });
  it('removes stocks from an explicit protect pot and refuses the changed allocation', () => {
    const plan = run(
      base({
        shape: 'split',
        buckets: [
          { name: 'protect', goal: 'protect', share: 0.5, lines: [line('aapl')] },
          { name: 'Tesla', goal: 'pick', share: 0.5, lines: [line('tsla')] },
        ],
      }),
    );
    expect(plan.buckets[0]?.lines).toEqual([]);
    expect(plan.missing).toContain('ineligible for protect: robinhood:aapl');
    expect(plan.ready).toBe(false);
  });
  it('unknown-only holdings cannot be acknowledged', () => {
    const plan = run(base({ lines: [line('unknown')] }));
    expect(plan.buckets[0]?.lines).toEqual([]);
    expect(plan.ready).toBe(false);
    expect(() => confirmedProposal(plan)).toThrow('unresolved');
  });
  it('rejects model invented numerical financial facts before display', () => {
    expect(() => run(base({ say: 'Guaranteed 12% yield, price $100.' }))).toThrow('unsupported');
  });
  it('rejects an invented amount', () => {
    expect(run(base(), ['Invest in Tesla and SGOV']).missing).toContain(
      'amount not grounded in person text',
    );
  });
  it('does not treat a BRL budget as dollars', () => {
    const plan = run(base({ stated: { amount: 1000, currency: 'BRL' } }), [
      'Tenho BRL 1000 para investir',
    ]);
    expect(plan.missing).toContain('unsupported currency: no FX conversion');
    expect(plan.ready).toBe(false);
  });
  it('rejects duplicate holdings rather than doubling them', () => {
    const plan = run(base({ lines: [line('tsla'), line('tsla')] }));
    expect(plan.buckets[0]?.lines).toHaveLength(1);
    expect(plan.missing).toContain('duplicate holding: robinhood:tsla');
  });
  it('display and acknowledgment use the same readiness result', () => {
    const plan = run(base({ stated: {} }));
    expect(formatPlan(plan)).toContain('open: amount; currency');
    expect(formatPlan(plan)).not.toContain('ready');
    expect(() => confirmedProposal(plan)).toThrow('unresolved');
  });
  it('direct protect filters by the current registry', () => {
    const plan = run(base({ shape: 'protect', lines: [line('tsla'), line('sgov')] }));
    expect(plan.buckets[0]?.lines.map((l) => l.id)).toEqual(['robinhood:sgov']);
    expect(plan.missing).toContain('ineligible for protect: robinhood:tsla');
  });
  it('excludes the held-out yield row under both legacy and catalog IDs', () => {
    expect(shelf.rows.some((r) => r.id === 'robinhood:spusdg')).toBe(false);
    for (const id of ['spUSDG', 'spusdg'])
      expect(run(base({ lines: [line(id)] })).ready).toBe(false);
  });
  it('income excludes gold as well as stocks', () => {
    const plan = run(base({ shape: 'income', lines: [line('gld'), line('aapl')] }));
    expect(plan.buckets[0]?.lines).toEqual([]);
    expect(plan.missing).toContain('ineligible for income: robinhood:gld');
  });
});
const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../scripts/relaxed/recorded.json'), 'utf8'),
) as Record<string, unknown>;
describe('PR182 six committed mock audit cases', () => {
  for (const [key, raw] of Object.entries(recorded).filter(([k]) => k.startsWith('robinhood|'))) {
    it(key, () => {
      const entry = recordedReply(raw, recorded.provenance);
      const plan = run(entry.raw, [key.split('|')[1] ?? '']);
      expect(plan.ready).toBe(false);
      expect(plan.shelfProvenance).toBe('fixture');
      expect(plan.modelProvenance).toBe('mock');
      expect(formatPlan(plan)).toContain('MOCK reply · FIXTURE shelf');
      expect(formatPlan(plan)).not.toContain('ready');
    });
  }
});

describe('bounded standalone proposal contract', () => {
  it('acknowledges a grounded equal proposal with explicit non-executable provenance', () => {
    const plan = run(base());
    expect(plan.ready).toBe(true);
    expect(confirmedProposal(plan)).toMatchObject({
      executable: false,
      kind: 'relaxed-terminal-proposal',
      shelfProvenance: 'fixture',
    });
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([5000, 5000]);
    expect(formatPlan(plan)).toContain('ready to acknowledge proposal');
    expect(plan.warnings.join(' ')).toContain(
      'No compose, API request, FX conversion or execution',
    );
  });
  it('equal remainder is deterministic and exact; zero lines never divide by zero', () => {
    expect(equalSplit(3)).toEqual([3334, 3333, 3333]);
    expect(equalSplit(0)).toEqual([]);
    expect(equalSplit(7).reduce((a, b) => a + b, 0)).toBe(10000);
  });
  it('does not replace floors, partial preferences, or ungrounded percentages with equal weights', () => {
    for (const weights of ['at least 40% stocks', '40% Tesla', '40% Tesla, 60% SGOV']) {
      const plan = run(base({ stated: { amount: 1000, currency: 'USD', weights } }));
      expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([null, null]);
      expect(plan.ready).toBe(false);
      expect(plan.stated.weights).toBe(weights);
    }
  });
  it('does not equalize when the model omits a person holding preference', () => {
    const plan = run(base(), [`${user}; 40% Tesla, 60% SGOV`]);
    expect(plan.ready).toBe(false);
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([null, null]);
  });
  it('qualitative and floor preferences stay unresolved when the model omits weights', () => {
    for (const preference of [
      'mostly Tesla',
      'at least half in stocks',
      'at least 50% Tesla and 50% SGOV',
    ]) {
      const plan = run(base(), [`${user}; ${preference}`]);
      expect(plan.ready).toBe(false);
      expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([null, null]);
    }
  });
  it('filtering never increases the weight of a surviving line', () => {
    const plan = run(base({ lines: [line('unknown'), line('sgov')] }));
    expect(plan.buckets[0]?.lines[0]?.weightBps).toBe(5000);
    const protectedPlan = run(base({ shape: 'protect', lines: [line('tsla'), line('sgov')] }));
    expect(protectedPlan.buckets[0]?.lines[0]?.weightBps).toBe(5000);
  });
  it('binds money to the budget rather than a date, percentage, or a different currency', () => {
    expect(run(base(), ['Invest in Tesla in 1000 years; USD']).ready).toBe(false);
    expect(run(base(), ['Invest 1000% in Tesla; USD']).ready).toBe(false);
    expect(run(base(), [user, 'Actually I have BRL 1000']).missing).toContain(
      'currency does not match stated budget',
    );
    expect(run(base(), [user, 'Actually I have USD 2000']).missing).toContain(
      'amount not grounded in person text',
    );
  });
  it('budget cannot serve as the income target or protection date', () => {
    const income = run(
      base({
        shape: 'income',
        lines: [line('sgov'), line('steakusdg')],
        stated: { amount: 1000, currency: 'USD', monthly: 1000 },
      }),
      ['I have USD 1000', 'I want 20 USD per month'],
    );
    expect(income.missing).toContain('monthly not grounded in person text');
    const protect = run(
      base({ shape: 'protect', stated: { amount: 1000, currency: 'USD', when: 1000 } }),
      ['I have USD 1000 to protect'],
    );
    expect(protect.missing).toContain('when not grounded in person text');
    expect(protect.ready).toBe(false);
  });
  it('explicit monthly currency cannot silently inherit the USD budget currency', () => {
    const raw = base({
      shape: 'income',
      lines: [line('sgov'), line('steakusdg')],
      stated: { amount: 1000, currency: 'USD', monthly: 20 },
    });
    for (const currency of ['BRL', 'EUR']) {
      const plan = run(raw, ['I have USD 1000', `I want ${currency} 20 per month`]);
      expect(plan.ready).toBe(false);
      expect(plan.missing).toContain('monthly currency differs from budget: no FX conversion');
    }
    expect(run(raw, ['I have USD 1000', 'I want USD 20 per month']).ready).toBe(true);
  });
  it('preserves unsupported within-pot preferences instead of silently equalizing', () => {
    const plan = run(
      base({
        shape: 'split',
        buckets: [
          { name: 'one', goal: 'pick', share: 0.5, lines: [line('tsla'), line('sgov')] },
          { name: 'two', goal: 'pick', share: 0.5, lines: [line('aapl'), line('gld')] },
        ],
      }),
      ['I have USD 1000; half in Tesla and SGOV with 40% Tesla, 60% SGOV; half in Apple and gold'],
    );
    expect(plan.ready).toBe(false);
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([null, null]);
  });
  it('latest person holding preferences win over stale model memory', () => {
    const plan = run(
      base({ stated: { amount: 1000, currency: 'USD', weights: '40% Tesla, 60% SGOV' } }),
      [user, '40% TSLA, 60% SGOV', 'Actually 30% Tesla, 70% SGOV'],
    );
    expect(plan.ready).toBe(false);
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([null, null]);
  });
  it('ages and stale share instructions do not serve as pot percentages', () => {
    const raw = base({
      shape: 'split',
      buckets: [
        { name: 'one', goal: 'pick', share: 0.5, lines: [line('tsla'), line('sgov')] },
        { name: 'two', goal: 'pick', share: 0.5, lines: [line('aapl'), line('gld')] },
      ],
    });
    expect(run(raw, ['I am 50; I have USD 1000 to invest']).missing).toContain(
      'pot shares not grounded in person text',
    );
    expect(
      run(raw, [user, 'half in one, half in two', 'Actually 40% one, 60% two']).missing,
    ).toContain('pot shares not grounded in person text');
  });
  it('rejects a model allocation inferred from admiration alone', () => {
    expect(() => run(base(), ['I like Elon'])).toThrow('admiration');
  });
  it('grounded numeric maps are interpreted in basis points only', () => {
    const stated = {
      amount: 1000,
      currency: 'USD',
      weights: { 'robinhood:tsla': 4000, 'robinhood:sgov': 6000 },
    };
    const plan = run(base({ stated }), [`${user}; 40% Tesla, 60% SGOV`]);
    expect(plan.buckets[0]?.lines.map((l) => l.weightBps)).toEqual([4000, 6000]);
  });
  it('does not guess split goals from pot names', () => {
    const plan = run(
      base({
        shape: 'split',
        buckets: [
          { name: 'safe', share: 0.5, lines: [line('aapl')] },
          { name: 'risky', goal: 'pick', share: 0.5, lines: [line('tsla')] },
        ],
      }),
    );
    expect(plan.missing).toContain('safe: explicit pot goal required');
    expect(plan.buckets[0]?.lines).toEqual([]);
  });
  it('partial, zero and sub-basis-point pot shares stay unresolved', () => {
    for (const share of [null, 0, 0.333333]) {
      const plan = run(
        base({
          shape: 'split',
          buckets: [
            { name: 'one', goal: 'pick', share, lines: [line('tsla')] },
            { name: 'two', goal: 'pick', share: 0.5, lines: [line('sgov')] },
          ],
        }),
      );
      expect(plan.ready).toBe(false);
      expect(plan.missing).toContain('shares must be positive whole basis points totaling 10000');
    }
  });
  it('blocks too many lines using existing engine limit', () => {
    const lines = shelf.rows.slice(0, 9).map((r) => ({ id: r.id, why: 'named holding' }));
    expect(run(base({ lines })).missing).toContain('pick: too many holdings');
  });
  it('protect rejects crypto and commodities through registry eligibility', () => {
    const solana = loadShelf(resolve(import.meta.dirname, '..'), 'solana');
    const lines = solana.rows
      .filter((r) => r.cls === 'crypto' || r.cls === 'commodity')
      .map((r) => ({ id: r.id, why: 'named holding' }));
    expect(lines.length).toBeGreaterThan(0);
    const plan = render(base({ shape: 'protect', lines }), solana, 'mock', [user]);
    expect(plan.buckets[0]?.lines).toEqual([]);
  });
  it('source policy checks every prose field, even when a user mentions the figure', () => {
    for (const raw of [
      base({ say: '12% yield.' }),
      base({ lines: [line('tsla', 'price $100')] }),
      base({ not_available: [{ name: 'X', why: 'returns 12%' }] }),
    ]) {
      expect(() => run(raw, [`${user}; a 12% yield and price $100`])).toThrow('unsupported');
    }
  });
  it('person budgets and counts never become unsourced FX or exit observations', () => {
    for (const say of [
      'Exit cost is 5%',
      'FX is 5',
      'Liquidity capacity is USD 1000',
      'Volatility is 5',
      '5% transaction fee',
    ]) {
      expect(() => run(base({ say }), [`${user}; 5 stocks`])).toThrow('unsupported');
    }
  });
  it('person money cannot become model profit, performance, growth or ROI', () => {
    for (const say of [
      'Expected profit is USD 1000.',
      'Performance is 1000.',
      'Growth is 1000.',
      'ROI is 1000.',
      'Lucro de USD 1000.',
      'Ganho de USD 1000.',
      'Desempenho de 1000.',
    ]) {
      expect(() => run(base({ say }))).toThrow('unsupported');
    }
  });
  it('unavailable explanations do not assert unverified country or route restrictions', () => {
    const plan = run(
      base({ not_available: [{ name: 'SpaceX', why: 'not available in your country' }] }),
    );
    expect(plan.notAvailable).toEqual([
      {
        name: 'SpaceX',
        why: 'Not selected from the fixture catalog; live availability unverified.',
      },
    ]);
    expect(formatPlan(plan)).not.toContain('not available in your country');
  });
  it('allows discussion without guessing an allocation or money terms', () => {
    const plan = run(
      base({
        shape: 'discussion',
        say: 'What would you like to do?',
        lines: [],
        stated: {},
        open: ['intent'],
      }),
      ['I like Elon'],
    );
    expect(plan.buckets).toEqual([]);
    expect(plan.missing).toEqual(['intent']);
    expect(formatPlan(plan)).not.toContain('100%');
  });
  it('grounding uses person messages and ignores model memory', () => {
    expect(run(base(), ['Invest in Tesla']).ready).toBe(false);
    expect(run(base(), ['Invest in Tesla and SGOV', 'I have USD 1000']).ready).toBe(true);
  });
  it('bounds schema, person text and total conversation turns', () => {
    expect(() => validateMessages(['x'.repeat(LIMITS.textChars + 1)])).toThrow();
    expect(() => validateMessages(Array(LIMITS.turns + 1).fill('hello'))).toThrow();
    expect(Reply.safeParse(base({ say: 'x'.repeat(2001) })).success).toBe(false);
  });
  it('repeated unresolved yes messages consume the chat turn bound without provider calls', async () => {
    vi.resetModules();
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key');
    vi.stubEnv('RELAXED_MODEL', 'synthetic-test-model');
    const question = vi.fn().mockResolvedValue('yes');
    const close = vi.fn();
    vi.doMock('node:readline/promises', () => ({ createInterface: () => ({ question, close }) }));
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(base({ stated: {} })) }],
      }),
    } as Response);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { main } = await import('../scripts/relaxed/intake');
      await main(['--chat', user]);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(question).toHaveBeenCalledTimes(LIMITS.turns - 1);
      expect(close).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledWith('Standalone conversation budget reached.');
    } finally {
      provider.mockRestore();
      output.mockRestore();
      vi.unstubAllEnvs();
      vi.doUnmock('node:readline/promises');
    }
  });
  it('shelf has exact fixture IDs and a deterministic hash, independent of model provenance', () => {
    expect(shelf.rows.some((r) => r.id === 'robinhood:steakusdg')).toBe(true);
    expect(shelf.rows.some((r) => r.id === 'robinhood:TSLA')).toBe(false);
    expect(
      loadShelf(resolve(import.meta.dirname, '..'), 'solana').rows.some(
        (r) => r.id === 'solana:tslax',
      ),
    ).toBe(true);
    expect(loadShelf(resolve(import.meta.dirname, '..'), 'robinhood').hash).toBe(shelf.hash);
    expect(run(base(), [user]).shelfProvenance).toBe('fixture');
    expect(render(base(), shelf, 'live', [user]).shelfProvenance).toBe('fixture');
  });
  it('flags are parsed without effects and reject ambiguous chains/options', () => {
    expect(parseArgs(['--recorded', 'invest in Elon'])).toMatchObject({
      recorded: true,
      text: 'invest in Elon',
    });
    expect(() => parseArgs(['--chain', '../outside', 'test'])).toThrow();
    expect(() => parseArgs(['--recorded', '--chat'])).toThrow();
  });
  it('recording one live capture never relabels existing handmade mocks', () => {
    const fixture = base();
    expect(recordedReply(fixture, 'mock').provenance).toBe('mock');
    expect(recordedReply({ reply: fixture, provenance: 'live-recorded' }, 'mock')).toEqual({
      raw: fixture,
      provenance: 'recorded',
    });
    expect(recordedReply({ reply: fixture, provenance: 'live' }, undefined)).toEqual({
      raw: fixture,
      provenance: 'recorded',
    });
    expect(recordedReply({ reply: fixture, provenance: 'mock' }, undefined)).toEqual({
      raw: fixture,
      provenance: 'mock',
    });
    expect(() => recordedReply({ reply: fixture, provenance: 'unknown' }, 'mock')).toThrow();
    for (const [key, raw] of Object.entries(recorded).filter(([key]) =>
      key.startsWith('robinhood|'),
    )) {
      expect(recordedReply(raw, recorded.provenance).provenance, key).toBe('mock');
    }
  });
  it('imports are effect-free with provider and environment file loaders unavailable', async () => {
    vi.resetModules();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call'));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('../scripts/relaxed/intake');
    expect(fetch).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    fetch.mockRestore();
    consoleLog.mockRestore();
  });
  it('prompt explicitly distinguishes admiration and preserves preferences', () => {
    const prompt = systemPrompt(shelf, '2026-10-08');
    expect(prompt).toContain('Admiration alone');
    expect(prompt).toContain('never replace them with equal weights');
    expect(prompt).toContain('fixture; live availability unverified');
  });
});

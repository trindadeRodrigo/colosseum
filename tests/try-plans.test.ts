import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { launchShelf } from '../packages/engine/src/personal/testing';
import { fixturesSource } from '../scripts/try/data';
import { parseArgs } from '../scripts/try/main';
import { monthsOf, PromptFileError, parsePromptFile } from '../scripts/try/prompt-file';
import { renderReport } from '../scripts/try/report';
import { type GoalRun, runGoal } from '../scripts/try/run';

// The plan playground (scripts/try, try/README.md): the prompt file format, and a smoke run of
// try/prompts/examples.md on the fixtures with the model off.

const EXAMPLES = join(__dirname, '../try/prompts/examples.md');
const NOW = new Date('2026-10-06T12:00:00.000Z');

const problemsOf = (source: string): string[] => {
  try {
    parsePromptFile(source, 'test.md');
  } catch (e) {
    if (e instanceof PromptFileError) return e.problems;
    throw e;
  }
  return [];
};

describe('the prompt file', () => {
  it('reads one goal per ## heading, with its answers, chain and holdings', () => {
    const goals = parsePromptFile(
      [
        '# Notes, not read',
        'chain: base',
        '',
        '## First',
        'chain: robinhood',
        '',
        'Grow $10,000 over ten years.',
        '<!-- a note -->',
        '',
        '```yaml answers',
        'amount: 10000',
        'horizon: 10y',
        'risk: high',
        'country: gb',
        'sleeves: { goal: 50, ai: 50 }',
        'holdings: { NVDA: 2000, "solana:spyx": 500 }',
        '```',
        '',
        '## Second',
        'Income of $300 a month.',
        '```yaml answers',
        'goal: income',
        'currency: brl',
        'withdrawals: { monthly: 300, from: 2026-11, months: 3 }',
        '```',
      ].join('\n'),
    );
    expect(goals.map((g) => g.title)).toEqual(['First', 'Second']);
    const [first, second] = goals;
    expect(first?.chain).toBe('robinhood');
    expect(first?.text).toBe('Grow $10,000 over ten years.');
    expect(first?.answers).toEqual({
      amountUsd: 10_000,
      horizonMonths: 120,
      risk: 'high',
      country: 'GB',
      sleeves: [
        { kind: 'goal', shareBps: 5000 },
        { kind: 'theme', shareBps: 5000, theme: 'ai' },
      ],
    });
    expect(first?.holdings).toEqual([
      { underlying: 'NVDA', valueUsd: 2000 },
      { asset: 'solana:spyx', valueUsd: 500 },
    ]);
    expect(second?.chain).toBe('solana');
    expect(second?.answers.obligations).toEqual([
      { month: '2026-11', amount: 300, currency: 'BRL' },
      { month: '2026-12', amount: 300, currency: 'BRL' },
      { month: '2027-01', amount: 300, currency: 'BRL' },
    ]);
  });

  it('reads a time frame in years, months or as a number', () => {
    expect(monthsOf('10y')).toBe(120);
    expect(monthsOf('18 months')).toBe(18);
    expect(monthsOf('2 anos')).toBe(24);
    expect(monthsOf(36)).toBe(36);
  });

  it('names every problem by line, and runs nothing', () => {
    expect(problemsOf('just text')).toEqual([
      'no goal found: start each goal with a line `## <a short name>`',
    ]);
    const problems = problemsOf(
      [
        '## A', // 1
        'Grow some money.',
        '```yaml answers', // 3
        'amount: 10000',
        'risk: extreme',
        'colour: blue',
        '```',
        '## B', // 8
        'chain: tron',
        'Keep it safe.',
        '```json', // 11
        '{}',
        '```',
        '## C', // 14
        '```yaml answers', // 15
        'goal: [unclosed',
        '```',
        '## D', // 18
        'Some text.',
        '```yaml answers', // 20
        'horizon: soon',
        'withdrawals: { monthly: 300 }',
        '```',
      ].join('\n'),
    );
    expect(problems).toContainEqual(
      expect.stringMatching(/^line 3 .*`colour` is not an answer field/),
    );
    expect(problems).toContainEqual(expect.stringMatching(/^line 3 .*risk: /));
    expect(problems).toContainEqual(expect.stringMatching(/^line 8 .*chain `tron` is not one of/));
    expect(problems).toContainEqual(
      expect.stringMatching(/^line 11: only a ```yaml answers block is read/),
    );
    expect(problems).toContainEqual(expect.stringMatching(/^line 14 .*has no text/));
    expect(problems).toContainEqual(expect.stringMatching(/^line 15: .*not valid YAML/));
    expect(problems).toContainEqual(expect.stringMatching(/^line 20 .*horizonMonths: /));
    expect(problems).toContainEqual(expect.stringMatching(/^line 20 .*withdrawals: .*from/));
  });

  it('refuses an unclosed block, two chains that disagree, and a goal named twice', () => {
    expect(problemsOf('## A\nGrow it.\n```yaml answers\nrisk: low\n')).toContainEqual(
      expect.stringMatching(/never closed/),
    );
    expect(
      problemsOf('## A\nchain: base\nGrow it.\n```yaml answers\nchain: solana\n```'),
    ).toContainEqual(expect.stringMatching(/says base and the answers say solana/));
    expect(problemsOf('## A\nGrow it.\n## A\nKeep it.')).toContainEqual(
      expect.stringMatching(/a second goal named "A"/),
    );
  });

  it('reads the command line', () => {
    const clock = () => NOW;
    expect(parseArgs(['f.md'], clock)).toEqual({
      file: 'f.md',
      data: 'fixtures',
      now: NOW,
      open: true,
    });
    expect(
      parseArgs(['f.md', '--data', 'db', '--now', '2026-01-02T00:00:00Z', '--no-open'], clock),
    ).toEqual({
      file: 'f.md',
      data: 'db',
      now: new Date('2026-01-02T00:00:00Z'),
      open: false,
    });
    expect(() => parseArgs(['f.md', '--data', 'live'], clock)).toThrow(/fixtures or db/);
    expect(() => parseArgs(['f.md', '--now', 'tomorrow'], clock)).toThrow(/ISO time/);
    expect(() => parseArgs([], clock)).toThrow(/usage/);
  });
});

describe('a run of examples.md on the fixtures, the model off', () => {
  const run = async (): Promise<GoalRun[]> => {
    const goals = parsePromptFile(readFileSync(EXAMPLES, 'utf8'), 'examples.md');
    const data = fixturesSource();
    const runs: GoalRun[] = [];
    for (const goal of goals) runs.push(await runGoal(goal, { data, model: null, now: NOW }));
    return runs;
  };
  const meta = { file: 'examples.md', mode: 'fixtures' as const, now: NOW.toISOString() };

  it('reads every goal with the rules parser, and every complete goal yields candidates', async () => {
    const runs = await run();
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(runs.length).toBeLessThanOrEqual(8);
    for (const r of runs) {
      expect(r.reader).toEqual({
        method: 'rules',
        model: null,
        provenance: null,
        why: 'model_not_configured',
      });
      if (r.goal.answersText === '') continue;
      expect(r.open, r.goal.title).toEqual([]);
      expect(r.error, r.goal.title).toBeNull();
      expect(r.intake.readBack?.length, r.goal.title).toBeGreaterThan(0);
      expect(r.made?.shown.length, r.goal.title).toBeGreaterThan(0);
      // The fixed order, and every candidate accounted for.
      const ids = [
        ...(r.made?.shown ?? []).map((c) => c.id),
        ...(r.made?.notShown ?? []).map((c) => c.id),
      ];
      expect([...ids].sort()).toEqual(['carry', 'cover', 'spread']);
      const shown = (r.made?.shown ?? []).map((c) => c.id);
      expect(shown).toEqual(
        ['cover', 'spread', 'carry'].filter((id) => shown.includes(id as never)),
      );
      expect(r.plain).not.toBeNull();
    }
    // The vague goal is left with questions, each with the key to answer it under.
    const vague = runs.find((r) => r.goal.answersText === '');
    expect(vague?.made).toBeNull();
    expect(vague?.open.map((q) => q.key)).toEqual(
      expect.arrayContaining(['goal', 'amount', 'horizon', 'risk', 'country']),
    );
    // The 50/50 AI goal holds a theme sleeve made of the list.
    const ai = runs.find((r) => r.goal.answers.sleeves?.some((s) => s.kind === 'theme'));
    expect(
      ai?.made?.shown[0]?.plan.split?.some((s) => s.theme === 'ai' && s.holds.length > 0),
    ).toBe(true);
    // "No stocks" holds no stock or fund.
    const noStocks = runs.find((r) =>
      r.goal.answers.limits?.cannotHold?.classes?.includes('stock'),
    );
    const cls = new Map(launchShelf().assets.map((x) => [x.id, x.cls]));
    expect(noStocks?.made?.shown.length).toBeGreaterThan(0);
    for (const c of noStocks?.made?.shown ?? [])
      for (const l of c.plan.lines) expect(['stock', 'etf']).not.toContain(cls.get(l.assetId));
  });

  it('renders a self-contained report with the disclaimer and MOCK plates, the same each time', async () => {
    const [a, b] = [renderReport(await run(), meta), renderReport(await run(), meta)];
    expect(a).toBe(b);
    expect(a).toContain(DISCLAIMER.en);
    expect(a).toContain(DISCLAIMER.pt);
    expect(a).toContain('<span class="plate">MOCK</span>');
    expect(a).not.toMatch(/<script|<link|https?:\/\//);
    // Every shown candidate, by name, in each goal's section; the vague goal's questions.
    expect(a).toContain('Cover');
    expect(a).toContain('Cobertura');
    expect(a).toContain('Answer under <code>amount:</code>');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { riskForMix, riskForSleeves } from '@colosseum/engine/personal';
import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import {
  extendedHeldOut,
  extendedShelf,
  launchShelf,
} from '../packages/engine/src/personal/testing';
import { cashBps, compareGoals, compareMarkdown, parseCompareArgs } from '../scripts/try/compare';
import { type DataSource, fixturesSource } from '../scripts/try/data';
import { toJson } from '../scripts/try/json';
import { parseArgs } from '../scripts/try/main';
import {
  monthsOf,
  PromptFileError,
  type PromptGoal,
  parsePromptFile,
} from '../scripts/try/prompt-file';
import { incomeOf, incomeWords, renderReport, summary } from '../scripts/try/report';
import { type GoalRun, runGoal } from '../scripts/try/run';

// The plan playground (scripts/try, try/README.md): the prompt file format, and a smoke run of
// try/prompts/examples.md on the fixtures with the model off.

// The engine's two rules for the limits a holding takes, watched as the playground calls them. The
// calls go through to the engine unchanged; the tests read what it was handed and what it answered.
vi.mock('@colosseum/engine/personal', async (original) => {
  const actual = await original<typeof import('@colosseum/engine/personal')>();
  return {
    ...actual,
    riskForMix: vi.fn(actual.riskForMix),
    riskForSleeves: vi.fn(actual.riskForSleeves),
  };
});

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
      // `country: gb` in the file is accepted and read by nothing (gate COUNTRY-REMOVED, Oct 6); it
      // was `country: 'GB'`.
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
      expect.stringMatching(/^line 11: only a ```yaml answers or a ```json reply block is read/),
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
      shelf: 'launch',
      now: NOW,
      open: true,
      json: false,
    });
    expect(parseArgs(['f.md', '--json'], clock).json).toBe(true);
    expect(
      parseArgs(['f.md', '--data', 'db', '--now', '2026-01-02T00:00:00Z', '--no-open'], clock),
    ).toEqual({
      file: 'f.md',
      data: 'db',
      shelf: 'launch',
      now: new Date('2026-01-02T00:00:00Z'),
      open: false,
      json: false,
    });
    expect(parseArgs(['f.md', '--shelf', 'extended'], clock).shelf).toBe('extended');
    expect(parseArgs(['f.md', '--shelf', 'launch', '--data', 'fixtures'], clock).shelf).toBe(
      'launch',
    );
    expect(() => parseArgs(['f.md', '--shelf', 'wide'], clock)).toThrow(/launch or extended/);
    // The database mode lists the mock chain's tokens, so a fixture shelf cannot be asked for there.
    expect(() => parseArgs(['f.md', '--shelf', 'extended', '--data', 'db'], clock)).toThrow(
      /--data fixtures/,
    );
    expect(() => parseArgs(['f.md', '--data', 'live'], clock)).toThrow(/fixtures or db/);
    expect(() => parseArgs(['f.md', '--now', 'tomorrow'], clock)).toThrow(/ISO time/);
    expect(() => parseArgs([], clock)).toThrow(/usage/);
  });
});

// What the playground hands the intake beside the labels and the matches (the second review, Oct
// 7), as the API's route does. The fixtures are MOCK data. The engine's rule for a mix does not
// depend on the amount on this branch, so the amount is held by what the engine was handed.
describe('what the playground hands the intake', () => {
  const goalOf = (text: string, answers: PromptGoal['answers'], chain = 'solana'): PromptGoal => ({
    title: text,
    line: 1,
    text,
    chain: chain as PromptGoal['chain'],
    answers,
    holdings: [],
    answersText: '',
  });
  const run = (goal: PromptGoal, data: DataSource = fixturesSource()) =>
    runGoal(goal, { data, model: null, now: NOW });
  const lastOf = <T extends (...args: never[]) => unknown>(rule: T) => ({
    handed: vi.mocked(rule).mock.calls.at(-1)?.[0],
    answered: vi.mocked(rule).mock.results.at(-1)?.value,
  });
  const mix = { growthBps: 10_000, dollarYieldBps: 0, goldBps: 0, cashBps: 0 };

  it('asks the engine the risk of a mix at the amount of the person, and at a fixed one until it is known', async () => {
    vi.mocked(riskForMix).mockClear();
    const known = await run(
      goalOf('Grow my savings.', { goal: 'grow', amountUsd: 2000, horizonMonths: 60, mix }),
    );
    expect(known.intake.sheet).toMatchObject({ amountUsd: 2000, mix });
    expect(lastOf(riskForMix).handed).toMatchObject({ amountUsd: 2000, mix, chains: ['solana'] });
    expect(known.intake.sheet?.risk).toBe(lastOf(riskForMix).answered);
    // The plan is then made at the risk the read-back named.
    expect(known.plain?.sheet.risk).toBe(known.intake.sheet?.risk);
    vi.mocked(riskForMix).mockClear();
    const unknown = await run(goalOf('Grow my savings.', { goal: 'grow', horizonMonths: 60, mix }));
    expect(unknown.intake.questions.map((q) => q.field)).toEqual(['amountUsd']);
    expect(lastOf(riskForMix).handed).toMatchObject({ amountUsd: 10_000, mix });
  });

  it('a sheet held in themes takes the risk the engine finds for it, at the amount of the person', async () => {
    vi.mocked(riskForSleeves).mockClear();
    // With no model what the text states is asked once; the form's answer holds it.
    const themed = await run(
      goalOf('I want to invest $2,000 in AI for 5 years', {
        goal: 'grow',
        amountUsd: 2000,
        horizonMonths: 60,
        mix,
      }),
    );
    const sleeves = [{ kind: 'theme', theme: 'ai', shareBps: 10_000 }];
    expect(themed.intake.sheet?.sleeves).toEqual(sleeves);
    expect(lastOf(riskForSleeves).handed).toMatchObject({
      amountUsd: 2000,
      sleeves,
      chains: ['solana'],
    });
    expect(themed.intake.flags).toContain('risk_from_themes');
    expect(themed.intake.sheet?.risk).toBe(lastOf(riskForSleeves).answered);
    expect(themed.intake.assumptions).toContain(
      `To hold “AI”, the plan uses the limits for ${themed.intake.sheet?.risk} risk.`,
    );
    // And the plan made from that sheet holds the theme at that risk.
    expect(themed.error).toBeNull();
    expect(themed.plain?.sheet.risk).toBe(themed.intake.sheet?.risk);
  });

  it('with a shelf the source could not read, resolves nothing on the chain, makes no sheet and no plan, and says so', async () => {
    // Neither source of the playground can fail to read a shelf; a source that can says so.
    const read = fixturesSource();
    const unread: DataSource = {
      ...read,
      forChain: async (chain) => ({ ...(await read.forChain(chain)), shelfKnown: false }),
    };
    const answers = { goal: 'grow', amountUsd: 2000, horizonMonths: 60, risk: 'medium' } as const;
    const themed = await run(goalOf('I want to invest $2,000 in AI for 5 years', answers), unread);
    expect(themed.intake.sheet).toBeNull();
    expect(themed.plain).toBeNull();
    expect(themed.intake.narratives).toEqual([]);
    expect(themed.intake.flags).toEqual(
      expect.arrayContaining(['shelf_unread', 'market_unresolved:ai']),
    );
    expect(themed.intake.assumptions).toEqual([
      'What is listed on Solana could not be read just now, so nothing is held for “AI” yet.',
    ]);
    // The same goal on a shelf that was read is asked how much, as any goal with no model.
    expect(
      (await run(goalOf('I want to invest $2,000 in AI for 5 years', answers))).intake.flags,
    ).not.toContain('shelf_unread');
    // And a goal that names nothing only the shelf can settle is read as before.
    const plain = await run(
      goalOf('I want to grow $2,000 over 5 years at medium risk', answers),
      unread,
    );
    expect(plain.intake.sheet).toMatchObject({ amountUsd: 2000, risk: 'medium' });
  });

  // Gate THEMES: only a list a person confirmed fills a theme sleeve. Every list of the two chains
  // is confirmed (gate LABELS-CONFIRMED, Oct 7), so the rule is held on a MOCK list: the chain's own
  // AI list, handed in as proposed.
  it.each(['solana', 'robinhood'] as const)(
    'on %s, a split that names a theme whose list is only proposed is asked again, and no plan is made',
    async (chain) => {
      const read = fixturesSource();
      const proposed: DataSource = {
        ...read,
        forChain: async (on) => {
          const data = await read.forChain(on);
          return {
            ...data,
            labels: data.labels.map((l) =>
              l.slug === 'ai' ? { ...l, status: 'proposed' as const } : l,
            ),
            context: {
              ...data.context,
              themes: (data.context.themes ?? []).map((t) =>
                t.slug === 'ai' ? { ...t, status: 'proposed' as const } : t,
              ),
            },
          };
        },
      };
      const sleeves = [
        { kind: 'goal' as const, shareBps: 5000 },
        { kind: 'theme' as const, shareBps: 5000, theme: 'ai' },
      ];
      const half = goalOf(
        'Grow $10,000 over ten years. I want half of it in AI companies.',
        { goal: 'grow', amountUsd: 10_000, horizonMonths: 120, risk: 'high', sleeves },
        chain,
      );
      const asked = await run(half, proposed);
      expect(asked.intake.sheet).toBeNull();
      expect(asked.plain).toBeNull();
      expect(asked.intake.questions.map((q) => q.field)).toEqual(['sleeves']);
      expect(asked.intake.flags).toEqual(
        expect.arrayContaining(['label_proposed:ai', 'answer_not_on_shelf:sleeves']),
      );
      // The same goal on the lists as they are, confirmed: the split is held, and the plan holds
      // names of the list in its theme sleeve.
      const held = await run(half);
      expect(held.intake.questions).toEqual([]);
      expect(held.intake.sheet?.sleeves).toEqual(sleeves);
      expect(
        held.made?.shown[0]?.plan.split?.some((s) => s.theme === 'ai' && s.holds.length > 0),
      ).toBe(true);
    },
  );
});

describe('a model reply pasted in the file', () => {
  const source = [
    '## Pasted',
    'I have $20,000 and want it to grow over 10 years, medium risk. I live in Brazil.',
    '```json reply sonnet',
    JSON.stringify({
      goal: 'grow',
      risk: 'medium',
      amountUsd: 20000,
      incomeTargetUsdMonthly: null,
      horizonMonths: 120,
      currency: null,
      country: 'BR',
      chain: null,
      portfolios: [],
      noCredit: false,
      cannotHold: [],
      language: 'en',
      unclear: [],
    }),
    '```',
  ].join('\n');

  it("is read as the model's reply, checked the same way, and labelled mock with who wrote it", async () => {
    const [goal] = parsePromptFile(source, 'test.md');
    expect(goal?.reply?.by).toBe('sonnet');
    if (!goal) return;
    const run = await runGoal(goal, { data: fixturesSource(), model: null, now: NOW });
    expect(run.reader).toMatchObject({ method: 'model', provenance: 'mock' });
    expect(run.reader.model).toContain('sonnet');
  });

  it('refuses a reply that is not JSON, by line', () => {
    expect(problemsOf('## Bad\nGrow $1,000.\n```json reply\n{nope\n```')).toEqual([
      expect.stringMatching(/line 3: the json reply is not JSON/),
    ]);
  });
});

describe("an income goal's verdict", () => {
  // The goal of try/mine/chat.md, with its reply pasted and no answer for the time frame.
  const source = [
    '## Income for 15 years',
    "I'm 45, I have $80,000 saved and I'd like it to pay me around $500 a month for the next 15 years. I don't want anything risky and no lending stuff. I live in Portugal.",
    '```json reply sonnet',
    JSON.stringify({
      goal: 'income',
      amountUsd: 80000,
      incomeTargetUsdMonthly: 500,
      horizonMonths: 180,
      risk: 'low',
      currency: null,
      country: 'PT',
      chain: null,
      portfolios: [],
      language: 'en',
      noCredit: true,
      cannotHold: [],
      unclear: [],
    }),
    '```',
    '```yaml answers',
    'risk: low',
    '```',
  ].join('\n');
  const goalRun = async () => {
    const [goal] = parsePromptFile(source, 'test.md');
    if (!goal) throw new Error('no goal');
    return runGoal(goal, { data: fixturesSource(), model: null, now: NOW });
  };

  it('"for the next 15 years" asks no time-frame question', async () => {
    const r = await goalRun();
    expect(r.open.map((q) => q.key)).not.toContain('horizon');
    expect(r.intake.draft.horizonMonths).toBe(180);
    expect(r.made?.shown.length).toBeGreaterThan(0);
  });

  it('is read for the plain plan and each candidate: target, pay, gap, ways', async () => {
    const r = await goalRun();
    const plans = [r.plain, ...(r.made?.shown ?? []).map((c) => c.plan)];
    for (const plan of plans) {
      if (!plan?.verdict) throw new Error('no verdict');
      const inc = incomeOf(plan);
      expect(inc?.targetUsd).toBe(500);
      expect(inc?.met).toBe(plan.verdict.met);
      expect(inc?.gapUsd).toBe(plan.verdict.gapUsdMonthly);
      if (inc && !inc.met) expect(inc.paysUsd + inc.gapUsd).toBeCloseTo(500, 2);
      expect(inc?.ways).toEqual(plan.verdict.ways.map((w) => w.change));
      expect(inc?.noAmountCloses).toBe(plan.verdict.noAmountCloses ?? null);
    }
  });

  it('shows the Income block, the ways and the sentence on the page, and in the terminal line', async () => {
    const r = await goalRun();
    const page = renderReport([r], { file: 'test.md', mode: 'fixtures', now: NOW.toISOString() });
    const plain = r.plain ? incomeOf(r.plain) : null;
    if (!plain) throw new Error('no income');
    expect(page).toContain('<h5>Income</h5>');
    expect(page).toContain('Target a month');
    expect(page).toContain('$500.00');
    expect(page).toContain('Paid a month at observed yields, after haircut');
    for (const way of plain.ways) expect(page).toContain(way);
    if (plain.noAmountCloses) expect(page).toContain(plain.noAmountCloses);
    const [line] = summary([r]);
    expect(line).toContain(`income ${incomeWords(plain)}`);
    if (!plain.met) expect(line).toMatch(/income short by \$[\d,.]+\/month of \$500\.00/);
    if (plain.noAmountCloses) expect(line).toContain('no larger amount closes it');
  });

  it('words a verdict met and one short', () => {
    const base = { targetUsd: 500, ways: [], noAmountCloses: null };
    expect(incomeWords({ ...base, paysUsd: 520, met: true, gapUsd: 0 })).toBe(
      'met ($500.00/month)',
    );
    expect(
      incomeWords({
        ...base,
        paysUsd: 103,
        met: false,
        gapUsd: 397,
        ways: ['aim lower'],
        noAmountCloses: 'No larger amount closes the gap.',
      }),
    ).toBe('short by $397.00/month of $500.00, no larger amount closes it, 1 way(s)');
  });

  it('gives no Income block for a goal that is not an income', async () => {
    const [goal] = parsePromptFile(
      '## Grow\nGrow $10,000 over 10 years, high risk.\n```yaml answers\ngoal: grow\namount: 10000\nhorizon: 10y\nrisk: high\ncountry: gb\n```',
      'test.md',
    );
    if (!goal) throw new Error('no goal');
    const r = await runGoal(goal, { data: fixturesSource(), model: null, now: NOW });
    expect(r.plain).not.toBeNull();
    if (r.plain) expect(incomeOf(r.plain)).toBeNull();
    const page = renderReport([r], { file: 'test.md', mode: 'fixtures', now: NOW.toISOString() });
    expect(page).not.toContain('<h5>Income</h5>');
    expect(summary([r])[0]).not.toContain('income');
  });
});

describe('what the plans need, before an amount is given', () => {
  // Rodrigo's test of `/plan-chat` on Oct 7: "$2k a month for a sabbatical year in three years. How
  // much should I invest?" was answered "I can't size the amount for you".
  const source = (answers: string[]) =>
    [
      '## A sabbatical year',
      'I want $2,000 a month for a sabbatical year, three years from now. How much should I invest?',
      '```yaml answers',
      'goal: income',
      'income: 2000',
      'horizon: 36',
      'withdrawals: { monthly: 2000, from: 2029-10, months: 12 }',
      ...answers,
      '```',
    ].join('\n');
  const goalRun = async (answers: string[]) => {
    const [goal] = parsePromptFile(source(answers), 'test.md');
    if (!goal) throw new Error('no goal');
    return runGoal(goal, { data: fixturesSource(), model: null, now: NOW });
  };

  it('with only the amount open, says what each plan needs to the cent, and makes no plan', async () => {
    const r = await goalRun(['risk: medium']);
    expect(r.open.map((q) => q.key)).toEqual(['amount']);
    expect(r.made).toBeNull();
    expect(r.needs?.map((n) => n.id)).toEqual(['cover', 'spread', 'carry']);
    for (const n of r.needs ?? []) {
      expect(n.risk).toBeUndefined();
      // Less than the $24,000 withdrawn, since the money earns for three years first.
      expect(n.withdrawalsUsd).toBeGreaterThan(12_000);
      expect(n.withdrawalsUsd).toBeLessThan(24_000);
      expect(Number.isInteger(Math.round((n.withdrawalsUsd ?? 0) * 100))).toBe(true);
    }
    // The amount it names pays every withdrawal, and the plan made at it says so.
    const cover = r.needs?.find((n) => n.id === 'cover')?.withdrawalsUsd ?? 0;
    const at = await goalRun(['risk: medium', `amount: ${cover}`]);
    const plan = at.made?.shown.find((c) => c.id === 'cover')?.plan;
    expect(plan?.status?.met).toBe(true);
    expect(at.needs?.find((n) => n.id === 'cover')?.withdrawalsUsd).toBe(cover);
    // In the document a chat reads, plated, and on the page.
    const doc = toJson([r], { file: 'test.md', mode: 'fixtures', now: NOW.toISOString() });
    expect(doc.goals[0]?.needs?.plate).toBe('MOCK');
    expect(doc.goals[0]?.needs?.each.map((n) => n.name)).toEqual(['Cover', 'Spread', 'Carry']);
    expect(
      renderReport([r], { file: 'test.md', mode: 'fixtures', now: NOW.toISOString() }),
    ).toMatch(/What the plans need/);
  });

  it('with the risk open too, says it at each risk, and picks none', async () => {
    const r = await goalRun([]);
    expect(r.open.map((q) => q.key).sort()).toEqual(['amount', 'risk']);
    expect(r.needs?.map((n) => `${n.id}:${n.risk}`)).toEqual(
      ['low', 'medium', 'high'].flatMap((risk) =>
        ['cover', 'spread', 'carry'].map((id) => `${id}:${risk}`),
      ),
    );
    expect(r.intake.sheet).toBeNull();
  });

  it('says nothing for a goal with nothing to pay, or with more still open', async () => {
    const [grow] = parsePromptFile(
      [
        '## Grow',
        'I want to grow my money.',
        '```yaml answers',
        'goal: grow',
        'risk: low',
        'horizon: 5y',
        '```',
      ].join('\n'),
      'test.md',
    );
    if (!grow) throw new Error('no goal');
    const r = await runGoal(grow, { data: fixturesSource(), model: null, now: NOW });
    expect(r.open.map((q) => q.key)).toEqual(['amount']);
    expect(r.needs).toBeNull();
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
    // No country is asked (gate COUNTRY-REMOVED, Oct 6); the list held 'country' too.
    expect(vague?.open.map((q) => q.key)).toEqual(
      expect.arrayContaining(['goal', 'amount', 'horizon', 'risk']),
    );
    expect(vague?.open.map((q) => q.key)).not.toContain('country');
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

  it('gives the same as one JSON document with --json: questions, read-back, candidates, plates, disclaimer', async () => {
    const [runsA, runsB] = [await run(), await run()];
    const [a, b] = [toJson(runsA, meta), toJson(runsB, meta)];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.disclaimer).toEqual(DISCLAIMER);
    expect(a.plate).toMatch(/^MOCK/);
    expect(a.goals).toHaveLength(runsA.length);
    // The vague goal: its questions, each with the key to answer under and the template's text.
    const vague = a.goals.find((g) => !g.sheetWhole);
    expect(vague?.candidates).toEqual([]);
    expect(vague?.readBack).toBeNull();
    const open = runsA.find((r) => r.goal.answersText === '')?.open ?? [];
    expect(vague?.questions.map((q) => [q.key, q.text])).toEqual(open.map((q) => [q.key, q.text]));
    expect(vague?.questions.find((q) => q.key === 'risk')?.options).toEqual([
      'low',
      'medium',
      'high',
    ]);
    for (const [i, g] of a.goals.entries()) {
      const r = runsA[i];
      if (!r?.made) continue;
      expect(g.readBack).toEqual(r.intake.readBack);
      expect(g.candidates.map((c) => c.id)).toEqual(r.made.shown.map((c) => c.id));
      expect(g.notShown.map((n) => [n.id, n.why])).toEqual(
        r.made.notShown.map((n) => [n.id, n.why]),
      );
      for (const [j, c] of g.candidates.entries()) {
        const plan = r.made.shown[j]?.plan;
        expect(c.plate).toBe('MOCK');
        expect(c.lines.map((l) => [l.assetId, l.weightBps, l.amountUsd])).toEqual(
          plan?.lines.map((l) => [l.assetId, l.weightBps, l.amountUsd]),
        );
        expect(c.lines.every((l) => l.symbol.length > 0 && l.reasons.length > 0)).toBe(true);
        expect(c.scorecard).toEqual(plan?.scorecard ?? null);
        expect(c.status).toEqual(plan?.status ?? null);
        expect(c.verdict).toEqual(plan?.verdict ?? null);
        expect(c.observations.every((o) => o.plate === 'MOCK')).toBe(true);
      }
    }
    // The income goal carries its verdict and ways.
    const income = a.goals.find((g) => g.candidates.some((c) => c.verdict !== null));
    expect(income?.candidates[0]?.income?.targetUsd).toBeGreaterThan(0);
  });
});

describe('the extended shelf, with --shelf extended', () => {
  const run = async (shelf: 'launch' | 'extended'): Promise<GoalRun[]> => {
    const goals = parsePromptFile(readFileSync(EXAMPLES, 'utf8'), 'examples.md');
    const data = fixturesSource(shelf);
    const runs: GoalRun[] = [];
    for (const goal of goals) runs.push(await runGoal(goal, { data, model: null, now: NOW }));
    return runs;
  };
  const meta = (shelf: 'launch' | 'extended') => ({
    file: 'examples.md',
    mode: 'fixtures' as const,
    shelf,
    now: NOW.toISOString(),
  });

  it("lists the chain's tokens of the extended shelf, and says which shelf and what it leaves out", async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const [launch, extended] = [
        await fixturesSource('launch').forChain(chain),
        await fixturesSource('extended').forChain(chain),
      ];
      expect((await fixturesSource().forChain(chain)).shelf).toEqual(launch.shelf);
      expect(extended.shelf.assets.map((a) => a.id)).toEqual(
        extendedShelf()
          .assets.filter((a) => a.chain === chain)
          .map((a) => a.id),
      );
      expect(extended.sources[0]).toContain('the extended shelf');
      expect(extended.sources[0]).toContain(`docs/vault/research/yield-shelf/${chain}.md`);
      expect(launch.sources[0]).toContain('the launch shelf');
      expect(launch.heldOut).toEqual([]);
      expect(extended.heldOut).toEqual(
        extendedHeldOut(chain).map((row) => ({ symbol: row.asset.symbol, reason: row.heldOut })),
      );
    }
  });

  it('runs the examples, every figure plated MOCK, and the page and the JSON name the shelf', async () => {
    const runs = await run('extended');
    const page = renderReport(runs, meta('extended'));
    expect(page).toContain('shelf: extended');
    expect(page).toContain('the extended shelf');
    expect(page).toContain('<span class="plate">MOCK</span>');
    expect(page).not.toMatch(/<script|<link|https?:\/\//);
    expect(renderReport(await run('launch'), meta('launch'))).toContain('shelf: launch');
    const json = toJson(runs, meta('extended'));
    expect(json.shelf).toBe('extended');
    expect(json.plate).toMatch(/^MOCK/);
    expect(
      toJson(runs, { file: 'examples.md', mode: 'db', now: NOW.toISOString() }).shelf,
    ).toBeNull();
    for (const [i, g] of json.goals.entries()) {
      expect(g.shelfLeftOut).toEqual(runs[i]?.heldOut);
      for (const c of g.candidates) {
        expect(c.plate).toBe('MOCK');
        expect(c.observations.every((o) => o.plate === 'MOCK')).toBe(true);
      }
    }
    // A token left out of every plan is in no line, and the page says why.
    for (const r of runs) {
      const out = new Set(r.heldOut.map((h) => h.symbol));
      for (const c of r.made?.shown ?? [])
        for (const l of c.plan.lines) expect(out.has(r.symbols[l.assetId] ?? '')).toBe(false);
      // As the page writes it: the reason with its HTML escaped.
      const esc = (t: string) =>
        t
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      for (const h of r.heldOut) expect(page).toContain(esc(h.reason));
    }
  });
});

const COMPARE_TIMEOUT_MS = 30_000;

describe('the two shelves side by side, with pnpm plan:compare', () => {
  const YIELD_GOALS = join(__dirname, '../try/prompts/yield-shelf.md');
  const files = [
    { name: 'examples.md', source: readFileSync(EXAMPLES, 'utf8') },
    { name: 'yield-shelf.md', source: readFileSync(YIELD_GOALS, 'utf8') },
  ];

  it('reads its command line: the files, one chain, the time', () => {
    const clock = () => NOW;
    expect(parseCompareArgs(['a.md', 'b.md', '--chain', 'robinhood'], clock)).toEqual({
      files: ['a.md', 'b.md'],
      chain: 'robinhood',
      now: NOW,
    });
    expect(() => parseCompareArgs(['a.md'], clock)).toThrow(/usage/);
    expect(() => parseCompareArgs(['a.md', '--chain', 'mars'], clock)).toThrow(/--chain is one of/);
    // Base has one shelf: the extended shelf adds nothing there.
    expect(() => parseCompareArgs(['a.md', '--chain', 'base'], clock)).toThrow(/--chain is one of/);
    expect(() => parseCompareArgs(['a.md', '--chain', 'solana', '--wide'], clock)).toThrow(
      /unknown option/,
    );
  });

  it('the six goals written for the extended shelf are whole: each yields candidates on its chain', async () => {
    const goals = parsePromptFile(files[1]?.source ?? '', 'yield-shelf.md');
    expect(goals).toHaveLength(6);
    expect(goals.filter((g) => g.chain === 'robinhood')).toHaveLength(1);
    for (const shelf of ['launch', 'extended'] as const)
      for (const goal of goals) {
        const r = await runGoal(goal, { data: fixturesSource(shelf), model: null, now: NOW });
        expect(r.open, `${shelf}: ${goal.title}`).toEqual([]);
        expect(r.error, `${shelf}: ${goal.title}`).toBeNull();
        expect(r.made?.shown.length, `${shelf}: ${goal.title}`).toBeGreaterThan(0);
      }
  });

  it.each(['solana', 'robinhood'] as const)(
    'on %s, runs every goal on that chain on both shelves and gives the same text each time',
    async (chain) => {
      const [a, b] = [await compareGoals(files, chain, NOW), await compareGoals(files, chain, NOW)];
      const text = compareMarkdown(a, chain, NOW.toISOString());
      expect(text).toBe(compareMarkdown(b, chain, NOW.toISOString()));
      expect(text).toContain('Every figure is MOCK');
      // The count at the foot is over the goals that have a plan: the vague goal has none on either
      // shelf and is counted neither as changed nor as unchanged. "Half in AI" has one on both
      // chains: the AI list is confirmed on Solana (gate THEME-AI-SOLANA) and on Robinhood Chain
      // (gate LABELS-CONFIRMED, Oct 7), so a split that names it is held.
      const weights = (r: GoalRun) =>
        JSON.stringify([
          r.plain?.lines.map((l) => [l.assetId, l.weightBps]),
          r.made?.shown.map((c) => [c.id, c.plan.lines.map((l) => [l.assetId, l.weightBps])]),
        ]);
      const planned = a.filter((g) => g.launch.run.made || g.extended.run.made);
      const unchanged = planned.filter((g) => weights(g.launch.run) === weights(g.extended.run));
      const unplanned = a.filter((g) => !g.launch.run.made && !g.extended.run.made);
      expect(unplanned.map((g) => g.title)).toEqual(['Something vague']);
      const halfInAi = a.find((g) => g.title === 'Grow, half in AI');
      for (const shelf of [halfInAi?.launch.run, halfInAi?.extended.run])
        expect(
          shelf?.made?.shown[0]?.plan.split?.some((s) => s.theme === 'ai' && s.holds.length > 0),
        ).toBe(true);
      expect(planned.length).toBe(a.length - unplanned.length);
      expect(text).toContain(
        `Goals with a plan on either shelf: ${planned.length} of ${a.length}. Of those, no line changed in ${unchanged.length}.`,
      );
      expect(text).not.toMatch(/https?:\/\//);
      for (const g of a) {
        expect(g.launch.run.goal.chain).toBe(chain);
        expect(g.extended.run.goal.chain).toBe(chain);
        expect(text).toContain(`#### ${g.title}`);
        // The cash share is the chain's cash token and nothing else.
        const plan = g.extended.run.plain;
        if (plan) {
          const cash = plan.lines.filter((l) => g.extended.cls[l.assetId] === 'cash');
          expect(cashBps(plan, g.extended.cls)).toBe(cash.reduce((n, l) => n + l.weightBps, 0));
          expect(cash.length).toBeLessThanOrEqual(1);
        }
      }
    },
    // It makes every goal of a chain twice on both shelves: about a second alone, and past vitest's
    // default 5 s beside the whole suite (it timed out in CI on #93). What it asserts is unchanged.
    COMPARE_TIMEOUT_MS,
  );
});

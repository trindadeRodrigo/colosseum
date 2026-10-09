import type { BasketAsset, VaultAgentReply, VaultAgentSource } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createModelQuota, type ModelQuota } from '../model-quota';
import { goalFit } from './mix';
import { createRelaxedGoalAgent, splitShares } from './relaxed-goal-agent';
import type { GoalAgentContext } from './vault-agent';

// The code-held rules of the relaxed intake (gate RELAXED-INTAKE), run through the real agent's
// post-processing with the model stubbed: nothing leaves the machine. The model's reply is the JSON the
// API holds it to; everything checked here is what code does after it.

const asset = (
  id: string,
  symbol: string,
  cls: BasketAsset['cls'],
  maxWeightBps = 5000,
): BasketAsset =>
  ({
    id: `solana:${id}`,
    symbol,
    cls,
    chain: 'solana',
    underlying: symbol.replace(/x$/, ''),
    tier: 1,
    issuer: 'issuer',
    maxWeightBps,
    provenance: 'sandbox',
  }) as unknown as BasketAsset;

const ASSETS = [
  asset('tslax', 'TSLAx', 'stock'),
  asset('nvdax', 'NVDAx', 'stock'),
  asset('usdy', 'USDY', 'dollar_yield'),
  asset('syrup', 'syrupUSDC', 'dollar_yield'),
  asset('paxg', 'PAXG', 'gold'),
  asset('sol', 'SOL', 'crypto', 2000),
  asset('usdc', 'USDC', 'cash', 10_000),
];

const source = (id: string, extra: Partial<VaultAgentSource> = {}): VaultAgentSource => ({
  id,
  source: 'server registry',
  method: 'listed asset catalog',
  fetchedAt: '2026-10-08T00:00:00.000Z',
  provenance: 'sandbox',
  ...extra,
});

function context(over: Partial<GoalAgentContext> = {}): GoalAgentContext {
  return {
    person: 'person-1',
    kind: 'new_goal',
    chain: 'solana',
    state: null,
    assets: ASSETS,
    evidence: [
      ...ASSETS.map((a) => source(`catalog:${a.id}`, { assetId: a.id })),
      source('yield:solana:usdy:1:quoted', {
        assetId: 'solana:usdy',
        value: 0.04,
        source: 'issuer page',
        method: 'quoted rate',
      }),
    ],
    currentGoals: [],
    stockAttributes: null,
    liquidity: [],
    unknowns: [],
    caps: {},
    ...over,
  } as GoalAgentContext;
}

type ModelLine = { id: string; why: string; share: number | null };
type ModelReply = {
  say?: string;
  shape: 'pick' | 'grow' | 'income' | 'protect' | 'split';
  lines?: ModelLine[];
  buckets?: {
    name: string;
    shape: 'pick' | 'grow' | 'income' | 'protect' | null;
    share: number | null;
    lines: ModelLine[];
  }[];
  sources?: unknown;
  stated?: Record<string, unknown>;
  not_available?: { name: string; why: string | null }[];
  open?: string[];
};

const STATED = {
  amount: 1000,
  currency: 'USD',
  when: null,
  need_by: null,
  monthly: null,
  withdraw_months: null,
  withdraw_start: null,
  weights: null,
  risk: null,
};

async function run(model: ModelReply, words: string | string[], ctx = context()) {
  const calls: unknown[] = [];
  const agent = createRelaxedGoalAgent({
    apiKey: 'placeholder',
    log: () => {},
    create: async (params) => {
      calls.push(params);
      return {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              say: 'Here is a draft.',
              lines: [],
              buckets: null,
              stated: STATED,
              not_available: [],
              open: [],
              ...model,
            }),
            citations: null,
          },
        ],
      };
    },
  });
  const texts = Array.isArray(words) ? words : [words];
  const result = await agent.reply(
    {
      version: 1,
      language: 'en',
      messageId: 'm1',
      messages: texts.flatMap((text, i) => [
        ...(i ? [{ who: 'app' as const, text: 'Noted.' }] : []),
        { who: 'person' as const, text },
      ]),
    },
    ctx,
  );
  if (result.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(result)}`);
  lastCall = calls[0] as { system: unknown };
  return result.reply;
}
let lastCall: { system: unknown } = { system: '' };
/** The reply, and the system prompt the model was sent, as one text. */
async function prompted(model: ModelReply, words: string | string[], ctx = context()) {
  const reply = await run(model, words, ctx);
  const system = Array.isArray(lastCall.system)
    ? lastCall.system.map((block: { text: string }) => block.text).join('\n')
    : String(lastCall.system);
  return { reply, system, call: lastCall };
}

const weights = (reply: VaultAgentReply) =>
  Object.fromEntries((reply.proposal?.allocations ?? []).map((a) => [a.symbol, a.weightBps]));
const notes = (reply: VaultAgentReply) => reply.proposal?.tradeoffs.join('\n') ?? '';
const line = (id: string, share: number | null = null): ModelLine => ({
  id,
  why: `why ${id}`,
  share,
});

describe('relaxed intake: catalog ids', () => {
  it('keeps ids on the catalog, matches case and symbol, and drops and names an unknown id', async () => {
    const reply = await run(
      {
        shape: 'pick',
        lines: [line('solana:USDY'), line('syrupUSDC'), line('solana:spacex')],
      },
      'I want USDY and syrupUSDC and SpaceX',
    );
    expect(weights(reply)).toEqual({ USDY: 5000, syrupUSDC: 5000 });
    expect(notes(reply)).toContain("Dropped, not on this chain's catalog: solana:spacex.");
  });

  it('never takes a source from the model: every source and evidence id is the server’s', async () => {
    const ctx = context();
    const reply = await run(
      {
        shape: 'pick',
        lines: [line('solana:usdy'), line('solana:paxg')],
        sources: [source('yield:solana:paxg:1:quoted', { value: 0.5, source: 'the model' })],
      },
      'I want USDY and PAXG',
      ctx,
    );
    const known = new Map(ctx.evidence.map((s) => [s.id, s]));
    for (const s of reply.proposal?.sources ?? []) expect(known.get(s.id)).toEqual(s);
    for (const a of reply.proposal?.allocations ?? [])
      for (const id of a.evidenceIds) expect(known.has(id)).toBe(true);
    expect(reply.proposal?.sources.some((s) => s.source === 'the model')).toBe(false);
  });
});

describe('relaxed intake: what a plan for its goal may hold', () => {
  it('a bucket with no shape takes the plan’s: no stock token in a plan to pay income (B1)', async () => {
    const reply = await run(
      {
        shape: 'income',
        lines: [],
        buckets: [
          { name: 'all', shape: null, share: null, lines: [line('solana:tslax'), line('USDY')] },
        ],
      },
      'I need income',
    );
    expect(weights(reply)).toEqual({ USDY: 10_000 });
    expect(notes(reply)).toContain(
      'TSLAx left out: a plan to pay income holds no stock tokens unless you ask for one yourself.',
    );
  });

  it('a stock-only bucket of an income plan leaves no stock behind', async () => {
    const reply = await run(
      {
        shape: 'income',
        lines: [],
        buckets: [{ name: 'all', shape: null, share: null, lines: [line('solana:tslax')] }],
      },
      'income please',
    );
    expect(reply.proposal).toBeNull();
  });

  it('the pot’s own shape counts too: a protect pot of a split plan holds no stock', async () => {
    const reply = await run(
      {
        shape: 'split',
        buckets: [
          { name: 'reserve', shape: 'protect', share: 0.5, lines: [line('solana:tslax')] },
          { name: 'growth', shape: 'grow', share: 0.5, lines: [line('solana:nvdax')] },
        ],
      },
      'half a reserve, half growth',
    );
    expect(weights(reply).TSLAx).toBeUndefined();
    // "half" is not a share the server reads, so the model's 0.5 sets nothing: the one pot left holds it all
    expect(weights(reply).NVDAx).toBe(10_000);
    expect(notes(reply)).toContain(
      'The reserve pot has no holding left, so it is not in this draft.',
    );
  });

  it('the goal the server read wins over the model’s shape (protect read, grow said)', async () => {
    const reply = await run(
      { shape: 'grow', lines: [line('solana:sol'), line('solana:tslax'), line('solana:usdy')] },
      'I want to protect my money',
    );
    expect(weights(reply)).toEqual({ USDY: 10_000 });
    expect(notes(reply)).toContain(
      "SOL left out: a plan to protect cannot hold crypto, by the asset registry's rule.",
    );
    expect(notes(reply)).toContain('TSLAx left out: a plan to protect holds no stock tokens');
  });

  it('says the real reason for gold in an income plan: the registry, not stocks', async () => {
    const reply = await run(
      { shape: 'income', lines: [line('solana:paxg'), line('solana:usdy')] },
      'income',
    );
    expect(weights(reply)).toEqual({ USDY: 10_000 });
    expect(notes(reply)).toContain(
      "PAXG left out: a plan to pay income cannot hold gold, by the asset registry's rule.",
    );
    expect(notes(reply)).not.toContain('PAXG left out: no stock tokens');
  });

  it('keeps a stock the person asked for in their own words, with a warning (ANY-COMPOSITION)', async () => {
    const reply = await run(
      { shape: 'income', lines: [line('solana:tslax'), line('solana:usdy')] },
      ['I want income', 'add TSLAx'],
    );
    expect(weights(reply)).toEqual({ TSLAx: 5000, USDY: 5000 });
    expect(reply.warnings).toEqual([
      {
        code: 'outside_goal_requested',
        assetId: 'solana:tslax',
        evidenceId: 'catalog:solana:tslax',
      },
    ]);
    expect(notes(reply)).toContain('it is here only because you asked for it yourself');
  });

  it('never keeps a stock the model added on its own', async () => {
    const reply = await run(
      { shape: 'income', lines: [line('solana:tslax'), line('solana:usdy')] },
      ['I want income', 'what about something safe?'],
    );
    expect(weights(reply)).toEqual({ USDY: 10_000 });
    expect(reply.warnings).toEqual([]);
  });

  it('holds every line to the rule goal/accept applies (`goalFit`)', async () => {
    for (const goal of ['income', 'protect'] as const) {
      const reply = await run(
        { shape: goal, lines: ASSETS.map((a) => line(a.id)) },
        goal === 'income' ? 'I want income' : 'I want to protect my money',
      );
      for (const a of reply.proposal?.allocations ?? []) {
        const held = ASSETS.find((x) => x.id === a.assetId) as BasketAsset;
        expect(goalFit(held, goal)).toBe('fits');
      }
    }
  });
});

describe('relaxed intake: the split', () => {
  it('splits equally when no share is given, and says so', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:usdy'), line('solana:syrup'), line('solana:paxg')] },
      'USDY, syrupUSDC and PAXG',
    );
    expect(weights(reply)).toEqual({ USDY: 3334, syrupUSDC: 3333, PAXG: 3333 });
    expect(notes(reply)).toContain('Equal split until you say otherwise.');
  });

  it('applies stated shares exactly', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:usdy', 0.7), line('solana:paxg', 0.3)] },
      'I want 70% USDY and 30% PAXG',
    );
    expect(weights(reply)).toEqual({ USDY: 7000, PAXG: 3000 });
    expect(notes(reply)).toContain('The shares you gave are applied exactly.');
  });

  it('shares below the whole: applied exactly, the rest in cash, said plainly (B2)', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax', 0.3), line('solana:nvdax', 0.3)] },
      '30% TSLA and 30% NVDA',
    );
    expect(weights(reply)).toEqual({ TSLAx: 3000, NVDAx: 3000, USDC: 4000 });
    expect(notes(reply)).toContain(
      'The shares you gave came to 60%; they are applied exactly, and the other 40% of the money is held in USDC, the cash line, until you say where it goes.',
    );
    expect(notes(reply)).not.toContain('Equal split');
  });

  it('shares above the whole are scaled to it, and said', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:usdy', 0.8), line('solana:paxg', 0.4)] },
      '80% USDY and 40% PAXG',
    );
    expect(weights(reply)).toEqual({ USDY: 6667, PAXG: 3333 });
    expect(notes(reply)).toContain('The shares you gave came to 120%; scaled to the whole.');
  });

  it('a stated share and an unstated one: the rest goes to the unstated one', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:usdy', 0.25), line('solana:paxg')] },
      'I want 25% USDY, the rest in PAXG',
    );
    expect(weights(reply)).toEqual({ USDY: 2500, PAXG: 7500 });
  });

  it('pot shares below the whole leave the rest in cash; a pot with no holding left is said', async () => {
    const reply = await run(
      {
        shape: 'split',
        buckets: [
          { name: 'income', shape: 'income', share: 0.4, lines: [line('solana:usdy')] },
          { name: 'growth', shape: 'grow', share: 0.4, lines: [line('solana:nvdax')] },
          { name: 'trash', shape: 'pick', share: 0.2, lines: [line('solana:nothing')] },
        ],
      },
      'I want 40% USDY and 40% NVDA',
    );
    expect(weights(reply)).toEqual({ USDY: 4000, NVDAx: 4000, USDC: 2000 });
    expect(notes(reply)).toContain(
      'The trash pot has no holding left, so it is not in this draft.',
    );
    expect(notes(reply)).toContain('the other 20% of the money is held in USDC');
  });

  it('the preview note is true: the deposit step buys it exactly, no solver', async () => {
    const reply = await run({ shape: 'grow', lines: [line('solana:usdy')] }, 'grow');
    expect(notes(reply)).toContain(
      'The deposit step buys exactly these holdings and shares, after the server checks every line again.',
    );
    expect(notes(reply)).not.toContain('solver');
  });
});

describe('relaxed intake: one repair attempt, then the cut or the 503', () => {
  const good = {
    say: 'Here is a draft.',
    shape: 'pick',
    lines: [line('solana:tslax'), line('solana:nvdax')],
    buckets: null,
    stated: STATED,
    not_available: [],
    open: [],
  };
  const FIGURE = 'Tesla will return 40% next year, guaranteed.';
  /** The agent answering with `replies` in turn (the last one again after that). */
  const answering = async (replies: unknown[], quota?: ModelQuota) => {
    const calls: { messages: { role: string; content: string }[] }[] = [];
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      ...(quota ? { quota } : {}),
      create: async (params) => {
        calls.push(params as never);
        const reply = replies[Math.min(calls.length, replies.length) - 1];
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: typeof reply === 'string' ? reply : JSON.stringify(reply),
              citations: null,
            },
          ],
        };
      },
    });
    const result = await agent.reply(
      {
        version: 1,
        language: 'en',
        messageId: 'm1',
        messages: [{ who: 'person', text: 'Tesla and Nvidia please' }],
      },
      context(),
    );
    return { calls, result };
  };
  it('asks once more when the reply is not the sheet, and serves the second', async () => {
    const { calls, result } = await answering(['not json', good]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.slice(-2).map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(result).toMatchObject({
      kind: 'reply',
      repair: { failed: 'reply_shape', outcome: 'repaired' },
    });
  });
  it('answers the 503 when the second is not the sheet either, after two calls and no more', async () => {
    const { calls, result } = await answering([{ ...good, shape: 'nonsense' }]);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      kind: 'failure',
      reason: 'invalid',
      detail: 'reply_shape',
      repair: { failed: 'reply_shape', outcome: 'reply_shape' },
    });
  });
  it('asks once more when the reply states a figure, and serves a clean second whole', async () => {
    const { calls, result } = await answering([{ ...good, say: `Two picks. ${FIGURE}` }, good]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.at(-1)?.content).toContain('no digit');
    expect(result).toMatchObject({
      kind: 'reply',
      reply: { message: expect.stringMatching(/^Here is a draft\./) },
      repair: { failed: 'prose_figure', outcome: 'repaired' },
    });
  });
  it('cuts the figure when the second states one too', async () => {
    const { calls, result } = await answering([{ ...good, say: `Two picks. ${FIGURE}` }]);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      kind: 'reply',
      repair: { failed: 'prose_figure', outcome: 'prose_figure_trimmed', sentencesCut: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/40%|guaranteed/);
  });
  it('cuts the first reply’s figure when the budget has no call left for the repair', async () => {
    const { calls, result } = await answering(
      [{ ...good, say: `Two picks. ${FIGURE}` }, good],
      createModelQuota({ dailyCalls: 1, dailyCallsPerPerson: 1 }),
    );
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'reply', repair: { outcome: 'prose_figure_trimmed' } });
    expect(JSON.stringify(result)).not.toMatch(/40%|guaranteed/);
  });
  it('a clean reply is one call and carries no repair note', async () => {
    const { calls, result } = await answering([good]);
    expect(calls).toHaveLength(1);
    expect(result).not.toHaveProperty('repair');
  });
});

describe('relaxed intake: the context is checked before the model is paid', () => {
  const refused = async (ctx: GoalAgentContext) => {
    let calls = 0;
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      create: async () => {
        calls += 1;
        throw new Error('not reached');
      },
    });
    const result = await agent.reply(
      { version: 1, language: 'en', messageId: 'm1', messages: [{ who: 'person', text: 'USDY' }] },
      ctx,
    );
    expect(calls).toBe(0);
    return result;
  };
  it('refuses a context with a number that is not a number', async () => {
    const base = context();
    const evidence = base.evidence.map((e, i) => (i === 0 ? { ...e, value: Number.NaN } : e));
    expect(await refused({ ...base, evidence })).toEqual({
      kind: 'failure',
      reason: 'invalid',
      detail: 'context_non_finite',
    });
  });
  it('refuses evidence that repeats an id or is not a source', async () => {
    const base = context();
    for (const evidence of [
      [...base.evidence, base.evidence[0]],
      [...base.evidence, { id: 'x' }],
    ])
      expect(await refused({ ...base, evidence } as GoalAgentContext)).toEqual({
        kind: 'failure',
        reason: 'invalid',
        detail: 'context_evidence',
      });
  });
});

describe('relaxed intake: an id is matched to one listed asset or to none', () => {
  const listed = [
    asset('tqqqx', 'TQQQx', 'etf'),
    asset('qqqx', 'QQQx', 'etf'),
    asset('tslax', 'TSLAx', 'stock'),
    asset('usdc', 'USDC', 'cash', 10_000),
  ];
  const ctx = () =>
    context({
      assets: listed,
      evidence: listed.map((a) => source(`catalog:${a.id}`, { assetId: a.id })),
    });
  it('takes "QQQ" for QQQx, never for TQQQx listed before it', async () => {
    for (const id of ['QQQ', 'solana:qqq', 'qqqx', 'solana:QQQx']) {
      const reply = await run({ shape: 'pick', lines: [line(id)] }, 'the Nasdaq fund', ctx());
      expect(Object.keys(weights(reply)), id).toEqual(['QQQx']);
    }
    const leveraged = await run({ shape: 'pick', lines: [line('TQQQ')] }, 'TQQQ', ctx());
    expect(Object.keys(weights(leveraged))).toEqual(['TQQQx']);
  });
  it('still reads a wrapped symbol by its company’s ticker', async () => {
    const reply = await run({ shape: 'pick', lines: [line('solana:TSLA')] }, 'Tesla', ctx());
    expect(Object.keys(weights(reply))).toEqual(['TSLAx']);
  });
  it('drops a name two listed assets answer to, and says so', async () => {
    const twins = [asset('abcx', 'ABCx', 'stock'), asset('tabc', 'tABC', 'stock'), listed[3]];
    const reply = await run(
      { shape: 'pick', lines: [line('abc-co'), line('solana:usdc')] },
      'ABC',
      context({
        assets: twins as BasketAsset[],
        evidence: (twins as BasketAsset[]).map((a) => source(`catalog:${a.id}`, { assetId: a.id })),
      }),
    );
    expect(Object.keys(weights(reply))).toEqual(['USDC']);
  });
});

describe('relaxed intake: what a call costs', () => {
  type Sent = {
    model: string;
    max_tokens: number;
    system: { type: string; text: string; cache_control?: unknown }[];
    output_config: { effort?: string };
  };
  const sent = async (words: string, ctx = context(), model?: string) => {
    let params: Sent | undefined;
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      ...(model ? { model } : {}),
      create: async (p) => {
        params = p as unknown as Sent;
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                say: 'Here is a draft.',
                shape: 'pick',
                lines: [line('solana:usdy')],
                buckets: null,
                stated: STATED,
                not_available: [],
                open: [],
              }),
              citations: null,
            },
          ],
        };
      },
    });
    await agent.reply(
      { version: 1, language: 'en', messageId: 'm1', messages: [{ who: 'person', text: words }] },
      ctx,
    );
    if (!params) throw new Error('no call');
    return params;
  };
  it('sends the rules and the table first, the same bytes for every person, as the cached part', async () => {
    const one = await sent('I want USDY', context({ person: 'person-1' }));
    const two = await sent('Tesla and Nvidia, $5,000', context({ person: 'person-2' }));
    expect(one.system).toHaveLength(2);
    expect(one.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(one.system[0]?.text).toBe(two.system[0]?.text);
    expect(one.system[0]?.text).toContain('TABLE (id | symbol');
    expect(one.system[0]?.text).toContain('solana:usdy');
    // nothing of the person or the day in it
    expect(one.system[0]?.text).not.toMatch(/person-1|I want USDY|Today is/);
    expect(one.system[0]?.text).not.toContain(new Date().toISOString().slice(0, 10));
    // what changes comes after the breakpoint, uncached
    expect(one.system[1]?.cache_control).toBeUndefined();
    expect(one.system[1]?.text).toContain(`Today is ${new Date().toISOString().slice(0, 10)}`);
    expect(one.system[1]?.text).toContain('Answer in English');
  });
  it('sends effort only to a model that takes it, and a bounded reply length', async () => {
    expect((await sent('I want USDY')).output_config.effort).toBe('medium');
    const older = await sent('I want USDY', context(), 'claude-haiku-4-5');
    expect(older.output_config).not.toHaveProperty('effort');
    expect(older.max_tokens).toBeLessThanOrEqual(4000);
  });
});

describe('relaxed intake: the projection starts from the person’s own figures', () => {
  const yieldLines = [line('solana:usdy')];
  const sheet = (stated: Record<string, unknown>, words: string | string[]) =>
    run(
      { shape: 'grow', lines: yieldLines, stated: { ...STATED, amount: null, ...stated } },
      words,
    );
  const none = (reply: VaultAgentReply) => {
    expect(reply.message).toBe('Here is a draft.');
    expect(reply.proposal?.projection).toBeUndefined();
    expect(JSON.stringify(reply)).not.toMatch(/\$|∞|NaN|Infinity/);
  };
  it('makes none from an amount and a date the person never gave', async () => {
    const reply = await sheet(
      { amount: 50_000, need_by: '2036-10-09' },
      'something safe that grows',
    );
    none(reply);
    expect(reply.proposal?.objective).toBe('Grow');
  });
  it('projects from the amount and the year the person wrote', async () => {
    const year = new Date().getUTCFullYear() + 3;
    const reply = await sheet(
      { amount: 5000, need_by: `${year}-03-01` },
      `I have $5,000 to grow until March ${year}`,
    );
    expect(reply.message).toContain('$5,000 placed today would earn about');
    expect(reply.message).toContain(`By 1 Mar ${year}`);
    expect(reply.proposal?.projection?.months.length).toBeGreaterThan(0);
    expect(reply.proposal?.objective).toBe('Grow · 5000 USD');
  });
  it('reads a term in years, and "5k dollars"', async () => {
    const at = new Date();
    at.setUTCFullYear(at.getUTCFullYear() + 5);
    const reply = await sheet(
      { amount: 5000, need_by: at.toISOString().slice(0, 10) },
      'I can put in 5k dollars for 5 years',
    );
    expect(reply.message).toContain('$5,000 placed today would earn about');
    expect(reply.message).not.toContain('With no date given');
  });
  it('makes none when the model’s amount is not the one the person wrote', async () => {
    none(await sheet({ amount: 50_000 }, 'I have $5,000 to grow'));
  });
  it('makes none from another currency, and says the yields are dollar yields', async () => {
    for (const [stated, words] of [
      [{ amount: 5000, currency: 'BRL' }, 'Tenho R$ 5.000 para crescer'],
      [{ amount: 5000, currency: 'USD' }, 'Tenho R$ 5.000 para crescer'],
      [{ amount: 5000, currency: 'BRL' }, 'I have $5,000 to grow'],
    ] as const) {
      const reply = await sheet(stated, words);
      none(reply);
      expect(notes(reply)).toContain('dollar yields');
    }
  });
  it('holds the amount to what the deposit step accepts', async () => {
    none(await sheet({ amount: 5_000_000 }, 'I have $5,000,000 to grow'));
    none(await sheet({ amount: 5 }, 'I have $5 to grow'));
  });
  it('drops a date that is past, unreal, out of reach or not the person’s', async () => {
    for (const need_by of ['1999-01-01', '2026-02-31x', '9999-01-01', '2400-06-01', '2031-01-01'])
      expect(
        (await sheet({ amount: 5000, need_by }, 'I have $5,000 to grow')).message,
        need_by,
      ).toContain('With no date given, over five years');
  });
  it('never prints a figure that is not a number', async () => {
    const reply = await sheet(
      { amount: 5000, monthly: 1e308, withdraw_months: 1e9 },
      'I have $5,000 and want $100 a month',
    );
    expect(JSON.stringify(reply)).not.toMatch(/∞|NaN|Infinity|e\+/);
  });
});

describe('relaxed intake: the model never sets a weight on its own', () => {
  const APPLIED = 'The shares you gave are applied exactly.';
  it('splits equally when the person gave no share, whatever the model reports', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax', 0.9), line('solana:usdy', 0.1)] },
      'I like Tesla and some yield',
    );
    expect(weights(reply)).toEqual({ TSLAx: 5000, USDY: 5000 });
    expect(notes(reply)).not.toContain('The shares you gave');
    expect(notes(reply)).toContain('Equal split until you say otherwise.');
  });
  it('applies the shares the server reads in the person’s words, not the model’s version of them', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax', 0.9), line('solana:nvdax', 0.1)] },
      'I want 70% TSLA and 30% NVDA',
    );
    expect(weights(reply)).toEqual({ TSLAx: 7000, NVDAx: 3000 });
    expect(notes(reply)).toContain(APPLIED);
  });
  it('applies them when the model reports none', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax'), line('solana:nvdax')] },
      'I want 70% TSLA and 30% NVDA',
    );
    expect(weights(reply)).toEqual({ TSLAx: 7000, NVDAx: 3000 });
  });
  it('does not read a return or someone else’s view as a share', async () => {
    for (const words of [
      'Tesla and Nvidia, I hope for 70% a year',
      'My friend says 70% TSLA and 30% NVDA is too risky',
    ]) {
      const reply = await run(
        { shape: 'pick', lines: [line('solana:tslax', 0.7), line('solana:nvdax', 0.3)] },
        words,
      );
      expect(weights(reply), words).toEqual({ TSLAx: 5000, NVDAx: 5000 });
      expect(notes(reply), words).not.toContain('The shares you gave');
    }
  });
  it('a share the person withdrew no longer holds', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax', 0.7), line('solana:nvdax', 0.3)] },
      ['I want 70% TSLA and 30% NVDA', 'Split it equally'],
    );
    expect(weights(reply)).toEqual({ TSLAx: 5000, NVDAx: 5000 });
  });
  it('takes a pot’s share only where the server reads it for what the pot holds', async () => {
    const pots = (share: number) => ({
      shape: 'split' as const,
      lines: [],
      buckets: [
        {
          name: 'Stocks',
          shape: 'grow' as const,
          share,
          lines: [line('solana:tslax'), line('solana:nvdax')],
        },
        { name: 'Yield', shape: 'pick' as const, share: null, lines: [line('solana:usdy')] },
      ],
    });
    const read = await run(pots(0.4), 'I want 40% stocks');
    expect(weights(read)).toEqual({ TSLAx: 2000, NVDAx: 2000, USDY: 6000 });
    const unread = await run(pots(0.9), 'Mostly stocks, some yield');
    expect(weights(unread)).toEqual({ TSLAx: 2500, NVDAx: 2500, USDY: 5000 });
    expect(notes(unread)).not.toContain('The shares you gave');
    const other = await run(pots(0.9), 'I want 40% stocks');
    expect(weights(other)).toEqual({ TSLAx: 2500, NVDAx: 2500, USDY: 5000 });
  });
});

describe('relaxed intake: the model never states a figure', () => {
  const CUT =
    'Part of this reply was left out because it stated a figure that could not be confirmed.';
  const REMOVED =
    'This part of the draft was left out because it stated a figure that could not be confirmed.';
  const lines = [line('solana:tslax'), line('solana:nvdax')];
  /** The message without the server's projection paragraph under it. */
  const own = (reply: VaultAgentReply) => reply.message.split('\n\n')[0];
  it('cuts a sentence of the message that states a return, a price or a guarantee, and says so', async () => {
    const reply = await run(
      {
        shape: 'pick',
        lines,
        say: 'Here are the two you named. Tesla will return 40% next year, guaranteed, and NVDAx trades at $131.20 today.',
      },
      'Tesla and Nvidia please',
    );
    expect(own(reply)).toBe(`Here are the two you named.\n${CUT}`);
    expect(JSON.stringify(reply)).not.toMatch(/40%|guaranteed|131/);
  });
  it('serves the server’s note when nothing of the message is left', async () => {
    const reply = await run(
      { shape: 'pick', lines, say: 'Up 212% since January; risk-free at this price.' },
      'Tesla and Nvidia please',
    );
    expect(own(reply)).toBe(CUT);
  });
  it('cuts the same from each line’s reason, and leaves the server’s words where none is left', async () => {
    const reply = await run(
      {
        shape: 'pick',
        lines: [
          {
            id: 'solana:tslax',
            why: 'Up 212% since January; risk-free at this price.',
            share: null,
          },
          {
            id: 'solana:nvdax',
            why: 'The chip maker you named. It trades at $131.20 today.',
            share: null,
          },
        ],
      },
      'Tesla and Nvidia please',
    );
    expect(reply.proposal?.allocations.map((a) => a.why)).toEqual([
      REMOVED,
      'The chip maker you named.',
    ]);
    expect(JSON.stringify(reply)).not.toMatch(/212|risk-free|131/);
  });
  it('holds a pot’s name, what is not available and the term to the same check', async () => {
    const reply = await run(
      {
        shape: 'split',
        lines: [],
        buckets: [
          {
            name: 'Guaranteed 12% pot',
            shape: 'income',
            share: null,
            lines: [line('solana:usdy')],
          },
          { name: 'Growth', shape: 'grow', share: null, lines: [line('solana:tslax')] },
        ],
        stated: { ...STATED, when: 'five years at 12% a year' },
        not_available: [
          { name: 'SpaceX', why: 'Private. It would return 300% if listed.' },
          { name: 'a fund paying 9% guaranteed', why: null },
        ],
      },
      'Some income, some growth, and SpaceX',
    );
    const served = JSON.stringify(reply);
    expect(served).not.toMatch(/12%|Guaranteed|guaranteed|300|9%/);
    expect(notes(reply)).toContain("SpaceX is not on this chain's catalog: Private.");
    expect(reply.proposal?.summary).toContain('Pot 1 (income): USDY');
    expect(reply.proposal?.summary).toContain('Growth (grow): TSLAx');
  });
  it('keeps the person’s own words quoted back to them, and a catalog name with a digit in it', async () => {
    const say = 'You said “70% TSLA and 30% NVDA”. That is what the draft holds.';
    const reply = await run(
      { shape: 'pick', lines: [line('solana:tslax', 0.7), line('solana:nvdax', 0.3)], say },
      'I want 70% TSLA and 30% NVDA',
    );
    expect(own(reply)).toBe(say);
  });
  it('asks the model for no figure of its own', async () => {
    const { system } = await prompted({ shape: 'pick', lines }, 'Tesla and Nvidia please');
    expect(system).not.toContain("You may repeat the person's own numbers back to them");
    expect(system).not.toContain('A yield may be named');
    expect(system).not.toContain('Say back the dates you read');
    expect(system).toContain('Write no figure');
  });
});

describe('relaxed intake: what it logs', () => {
  const SECRET = 'Tesla will return 40% next year, guaranteed';
  const logged = async (text: string) => {
    const lines: string[] = [];
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: (msg, detail) => lines.push(`${msg} ${JSON.stringify(detail ?? null)}`),
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text, citations: null }],
      }),
    });
    const result = await agent.reply(
      {
        version: 1,
        language: 'en',
        messageId: 'm1',
        messages: [{ who: 'person', text: 'I want USDY' }],
      },
      context(),
    );
    return { result, log: lines.join('\n') };
  };
  const sheet = (over: object) =>
    JSON.stringify({
      say: SECRET,
      shape: 'pick',
      lines: [line('solana:usdy')],
      buckets: null,
      stated: STATED,
      not_available: [],
      open: [],
      ...over,
    });
  it('counts the ids it dropped and never writes them', async () => {
    const { result, log } = await logged(
      sheet({ lines: [line('solana:usdy'), line(`solana:${SECRET}`)] }),
    );
    expect(result.kind).toBe('reply');
    expect(log).toBe('ids not on the catalog 1');
  });
  it('names the check a reply failed, not the reply', async () => {
    const { result, log } = await logged(sheet({ shape: SECRET }));
    expect(result).toMatchObject({ kind: 'failure', reason: 'invalid', detail: 'reply_shape' });
    expect(log).toContain('reply did not fit the sheet');
    expect(log).toContain(':shape');
    expect(log).not.toContain('Tesla');
  });
  it('says a reply was not JSON without quoting it', async () => {
    const { result, log } = await logged(SECRET);
    expect(result.kind).toBe('failure');
    expect(log).toBe(
      ['model call failed "reply was not JSON"', 'model call failed "reply was not JSON"'].join(
        '\n',
      ),
    );
  });
});

describe('relaxed intake: the most a vault holds', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => asset(`s${i + 1}`, `S${i + 1}x`, 'stock'));
  const cash = asset('usdc', 'USDC', 'cash', 10_000);
  const ctx = (stocks: BasketAsset[]) =>
    context({
      assets: [...stocks, cash],
      evidence: [...stocks, cash].map((a) => source(`catalog:${a.id}`, { assetId: a.id })),
    });
  it('previews sixteen holdings besides cash', async () => {
    const stocks = many(16);
    const reply = await run(
      { shape: 'pick', lines: stocks.map((a) => line(a.id)) },
      'all the tech you have',
      ctx(stocks),
    );
    expect(reply.proposal?.allocations).toHaveLength(16);
  });
  it('sixteen and a cash line: cash is not counted', async () => {
    const stocks = many(16);
    const reply = await run(
      { shape: 'pick', lines: [...stocks.map((a) => line(a.id)), line('solana:usdc')] },
      'all the tech you have, and some cash',
      ctx(stocks),
    );
    expect(reply.proposal?.allocations).toHaveLength(17);
    expect(weights(reply).USDC).toBeGreaterThan(0);
  });
  it('previews nothing for more than sixteen, and says why', async () => {
    const stocks = many(18);
    const reply = await run(
      { shape: 'pick', lines: stocks.map((a) => line(a.id)) },
      'all the tech you have',
      ctx(stocks),
    );
    expect(reply.proposal).toBeNull();
    expect(reply.message).toBe(
      'That names 18 holdings, and a vault holds at most 16 besides cash. Tell me which to keep, or ask for a shorter list.',
    );
  });
});

describe('relaxed intake: the shared call budget', () => {
  const ask = async (quota: { reserve(person: string): ReturnType<ModelQuota['reserve']> }) => {
    const order: string[] = [];
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      quota: {
        reserve(person) {
          order.push(`reserve:${person}`);
          return quota.reserve(person);
        },
      },
      create: async () => {
        order.push('call');
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                say: 'Here is a draft.',
                shape: 'pick',
                lines: [line('solana:usdy')],
                buckets: null,
                stated: STATED,
                not_available: [],
                open: [],
              }),
              citations: null,
            },
          ],
        };
      },
    });
    const result = await agent.reply(
      {
        version: 1,
        language: 'en',
        messageId: 'm1',
        messages: [{ who: 'person', text: 'I want USDY' }],
      },
      context(),
    );
    return { order, result };
  };
  it('reserves a call for the person before the model is asked', async () => {
    const { order, result } = await ask({ reserve: () => null });
    expect(order).toEqual(['reserve:person-1', 'call']);
    expect(result.kind).toBe('reply');
  });
  it('makes no call once the budget is spent, and says which budget', async () => {
    for (const denied of ['model_budget_spent', 'model_person_budget_spent'] as const) {
      const { order, result } = await ask({ reserve: () => denied });
      expect(order).toEqual(['reserve:person-1']);
      expect(result).toEqual({ kind: 'failure', reason: 'budget', detail: denied });
    }
  });
  it('draws on the same allowance as the other conversations', async () => {
    const quota = createModelQuota({ dailyCalls: 5, dailyCallsPerPerson: 1 });
    expect((await ask(quota)).result.kind).toBe('reply');
    expect((await ask(quota)).result).toMatchObject({ kind: 'failure', reason: 'budget' });
  });
});

describe('relaxed intake: caps', () => {
  it('keeps a line above its cap as asked and names it in a warning', async () => {
    const reply = await run(
      { shape: 'pick', lines: [line('solana:sol', 0.6), line('solana:usdy', 0.4)] },
      'I want 60% SOL and 40% USDY',
      context({ caps: { 'solana:sol': 1500 } }),
    );
    expect(weights(reply)).toEqual({ SOL: 6000, USDY: 4000 });
    const first = reply.proposal?.tradeoffs[0] ?? '';
    expect(first).toContain('Above the cap listed today: SOL at 60% (cap 15%)');
    // what the deposit step does with it (`goal/accept`): a warning to confirm, never a refusal
    expect(first).toContain('The vault accepts any composition');
    expect(first).toContain('the deposit step shows this as a warning');
    expect(first).toContain('asks you to confirm it before anything is bought');
    expect(JSON.stringify(reply)).not.toMatch(/would refuse|cap is lifted/);
    expect(reply.proposal?.summary).toMatch(/^⚠ Above the cap listed today/);
  });
});

describe('splitShares', () => {
  it('cases', () => {
    expect(splitShares([null, null, null], 10_000, true)).toMatchObject({
      bps: [3334, 3333, 3333],
      kind: 'equal',
      gap: 0,
    });
    expect(splitShares([0.3, 0.3], 10_000, true)).toMatchObject({
      bps: [3000, 3000],
      kind: 'gap',
      gap: 4000,
    });
    expect(splitShares([0.3, 0.3], 10_000, false)).toMatchObject({
      bps: [5000, 5000],
      kind: 'scaled',
      gap: 0,
    });
    expect(splitShares([0.333, 0.333, 0.333], 10_000, true)).toMatchObject({
      bps: [3334, 3333, 3333],
      kind: 'stated',
      gap: 0,
    });
    expect(splitShares([1, null], 6000, true)).toMatchObject({
      bps: [6000, 0],
      kind: 'mixed',
      starved: [1],
    });
    expect(splitShares([0, 0], 10_000, true)).toMatchObject({
      bps: [5000, 5000],
      kind: 'unusable',
    });
  });

  it('always adds up to the whole with the gap', () => {
    const cases: (number | null)[][] = [
      [0.1, 0.2, null],
      [0.7, 0.7, null],
      [0.123, 0.456],
      [0.5, null, null, null],
      [0.9999, 0.0001],
    ];
    for (const given of cases)
      for (const whole of [10_000, 3333, 7])
        for (const gapAllowed of [true, false]) {
          const s = splitShares(given, whole, gapAllowed);
          expect(s.bps.reduce((a, b) => a + b, 0) + s.gap).toBe(whole);
          expect(s.bps.every((b) => b >= 0)).toBe(true);
        }
  });
});

describe('goalFit, the rule goal/accept and the preview share', () => {
  it('lets a stock outside the goal through with a warning, refuses any other class, passes cash', () => {
    const of = (symbol: string) => ASSETS.find((a) => a.symbol === symbol) as BasketAsset;
    expect(goalFit(of('TSLAx'), 'income')).toBe('stock_outside');
    expect(goalFit(of('TSLAx'), 'protect')).toBe('stock_outside');
    expect(goalFit(of('PAXG'), 'income')).toBe('barred');
    expect(goalFit(of('PAXG'), 'protect')).toBe('fits');
    expect(goalFit(of('SOL'), 'protect')).toBe('barred');
    expect(goalFit(of('USDC'), 'income')).toBe('fits');
    expect(goalFit(of('TSLAx'), 'grow')).toBe('fits');
    expect(goalFit(of('SOL'), null)).toBe('fits');
  });
});

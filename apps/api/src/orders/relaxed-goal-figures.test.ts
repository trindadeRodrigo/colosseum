import type { Price, VaultAgentResult } from '@colosseum/schemas';
import { VaultAgentReply } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import type { ChainEntry } from './chains';
import { createRelaxedGoalAgent } from './relaxed-goal-agent';
import { statedAmountUsd } from './stated-amount';
import {
  type AgentAnalyticsResult,
  buildGoalAgentContext,
  FIGURE_CUT,
  type GoalAgentContext,
  statedPurposeIn,
} from './vault-agent';

// Measured figures by reference on /goal (RELAXED-INTAKE as amended 2026-10-09, with the rules of
// FIGURES-BY-REFERENCE unchanged). The model is a stub: its reply is the JSON the API holds it to, and
// everything checked here is what the server does with it. The context is the one the route builds.

const shelf = launchShelf();
const KEEP = ['usdg', 'tsla', 'nvda', 'gld', 'sgov', 'aapl'];
const assets = shelf.assets
  .filter((asset) => asset.chain === 'robinhood' && KEEP.includes(asset.id.split(':')[1] ?? ''))
  .map((asset) => ({
    ...asset,
    provenance: 'sandbox' as const,
    // the test network's own symbol, as the hosted catalog lists it
    ...(asset.id === 'robinhood:tsla' ? { symbol: 'tTSLA' } : {}),
  }));
const TSLA = 'robinhood:tsla';
const NVDA = 'robinhood:nvda';
const SGOV = 'robinhood:sgov';
const GLD = 'robinhood:gld';
const now = '2026-10-09T15:00:00.000Z';
const pin = {
  unit: 'fraction' as const,
  source: 'Bearing fact sheet',
  method: 'hourly quotes (facts-0.1)',
  fetchedAt: '2026-10-09T14:00:00.000Z',
  provenance: 'sandbox' as const,
};
const figures = (exit: number, provenance: 'sandbox' | 'mock' = 'sandbox') => [
  {
    metric: 'exit_worst' as const,
    regime: 'us_offhours_weekday' as const,
    value: exit,
    ...pin,
    provenance,
  },
  {
    metric: 'exit' as const,
    regime: 'us_market_hours' as const,
    value: exit / 2,
    ...pin,
    provenance,
  },
  { metric: 'weekend' as const, value: null, reason: 'no_samples_in_regime' as const },
  { metric: 'lp_top1' as const, value: 0.62, ...pin, provenance },
  { metric: 'lp_exit' as const, value: 0.031, ...pin, provenance },
  { metric: 'cap_variation' as const, value: 0.4, ...pin, unit: 'ratio' as const, provenance },
  { metric: 'volume_28d' as const, value: 1_234_567.891, ...pin, unit: 'usd' as const, provenance },
  { metric: 'volatility' as const, value: 0.35, ...pin, provenance },
  { metric: 'drawdown' as const, value: 0.4, ...pin, provenance },
];
const sheet: AgentAnalyticsResult = {
  sizeUsd: 10_000,
  basis: 'reference',
  tau: 0.01,
  assets: [
    { assetId: TSLA, modelledOn: 'TSLAx', figures: figures(0.004) },
    { assetId: NVDA, modelledOn: null, figures: figures(0.006, 'mock') },
    { assetId: GLD, modelledOn: null, figures: null },
  ],
};
const prices = (stale = false): Price[] =>
  assets.map((asset) => ({
    asset: asset.id,
    usdPerToken:
      asset.cls === 'cash' || asset.id === SGOV ? '1' : asset.id === TSLA ? '250' : '100',
    ageSeconds: stale && asset.id === TSLA ? 90_000 : 0,
    maxAgeSeconds: 300,
    market: stale && asset.id === TSLA ? 'closed' : 'open',
    source: 'reference oracle',
    method: 'oracle read',
    fetchedAt: '2026-10-09T14:59:00.000Z',
    provenance: 'sandbox',
  })) as Price[];
const capacity = (id: string) =>
  id === TSLA || id === NVDA
    ? {
        capacityUsd: id === TSLA ? 42_000 : 90_000,
        lowerBound: id === NVDA,
        regime: 'us_offhours_weekday',
        samples: 30,
        dataFrom: '2026-10-06T00:00:00.000Z',
        dataTo: '2026-10-09T14:00:00.000Z',
      }
    : null;
function built(over: { stale?: boolean; analytics?: AgentAnalyticsResult | null } = {}) {
  const context = buildGoalAgentContext({
    chain: 'robinhood',
    observedAt: now,
    entry: { source: 'robinhood test network', provenance: 'sandbox' } as unknown as ChainEntry,
    prices: prices(over.stale),
    prepared: {
      shelf: { ...shelf, assets },
      figures: {
        yields: [
          {
            assetId: SGOV,
            quotedYield: 0.05,
            haircutYield: 0.04,
            source: 'issuer page',
            method: 'quoted rate',
            fetchedAt: now,
            provenance: 'sandbox',
          },
        ],
        liquidity: {
          provider: {
            entry: () => null,
            exitCapacity: capacity,
            methodVersion: 'exit-capacity-0.1',
            provenance: 'sandbox',
          },
          source: 'Bearing exit model',
        },
      },
    } as unknown as Parameters<typeof buildGoalAgentContext>[0]['prepared'],
    person: 'person-1',
    analytics: over.analytics === undefined ? sheet : over.analytics,
  });
  return {
    ...context,
    stockAttributes: {
      stocks: [
        { symbol: 'tTSLA', company: 'Tesla, Inc.' },
        { symbol: 'NVDA', company: 'NVIDIA Corporation' },
      ].map((row) => ({
        ...row,
        kind: 'company',
        sector: '',
        industry: '',
        keywords: [],
        sources: [],
      })),
    },
  } as unknown as GoalAgentContext;
}

const ref = (id: string) => `{{fact:${id}}}`;
type Line = { id: string; why: string; share: number | null };
type Model = { say: string; shape?: string; lines?: Line[]; buckets?: unknown; stated?: object };
type Turn = { who: 'person' | 'app'; text: string };
const NOTHING = {
  amount: null,
  currency: null,
  when: null,
  need_by: null,
  monthly: null,
  withdraw_months: null,
  withdraw_start: null,
  weights: null,
  risk: null,
};
type Call = {
  system: { text: string; cache_control?: unknown }[];
  messages: { content: string }[];
};
/** The agent with a stub for the model: `replies` in order, the last one again for a repair call. */
async function ask(
  replies: Model | Model[],
  turns: Turn[] | string,
  context = built(),
  language: 'en' | 'pt' = 'en',
) {
  const calls: Call[] = [];
  const queue = Array.isArray(replies) ? replies : [replies];
  const agent = createRelaxedGoalAgent({
    apiKey: 'placeholder',
    log: () => {},
    create: async (params) => {
      const model = queue[Math.min(calls.length, queue.length - 1)] as Model;
      calls.push(params as unknown as Call);
      return {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              shape: 'pick',
              lines: [],
              buckets: null,
              stated: NOTHING,
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
  const messages = typeof turns === 'string' ? [{ who: 'person' as const, text: turns }] : turns;
  const result = await agent.reply({ version: 1, language, messageId: 'm1', messages }, context);
  if (result.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(result)}`);
  expect(VaultAgentReply.safeParse(result.reply).success).toBe(true);
  return { result, reply: result.reply, calls };
}
type Served = Extract<VaultAgentResult, { kind: 'reply' }>['reply'];
const facts = (reply: Served) =>
  new Map((reply.figures?.facts ?? []).map((fact) => [fact.id, fact]));
const CUT = FIGURE_CUT.en;

// The draft of the bug report: one holding, tTSLA on Robinhood Chain, as the web keeps and resends it.
const DRAFT: Turn[] = [
  { who: 'person', text: 'I want to put my money in Tesla' },
  {
    who: 'app',
    text: 'Tesla is on this chain, so the draft holds it alone. How much will you deposit?',
  },
  {
    who: 'app',
    text: `Draft proposal:\nPick\ntTSLA (${TSLA}): 100% — the stock you named [catalog:${TSLA}]`,
  },
  { who: 'person', text: 'and about their liquidity? how deep are their pools?' },
];
const DEPTH = `For Tesla, the largest sale within the cost tolerance is ${ref(`capacity:${TSLA}`)}. Selling Tesla at the reference size costs about ${ref(`exit:${TSLA}:worst`)} in the worst measured regime.`;

describe('the Invest chat states measured figures by reference', () => {
  it('answers the liquidity question on a draft of tTSLA with the exit figures and their pins', async () => {
    const { reply, result } = await ask(
      { say: DEPTH, lines: [{ id: TSLA, why: 'The stock you named.', share: null }] },
      DRAFT,
    );
    expect(reply.message).toBe(
      'For Tesla, the largest sale within the cost tolerance is $42,000.00. Selling Tesla at the reference size costs about 0.4% in the worst measured regime.',
    );
    expect(reply.figures?.prose.message).toBe(DEPTH);
    expect(facts(reply).get(`capacity:${TSLA}`)).toMatchObject({
      assetId: TSLA,
      text: '$42,000.00',
      value: 42_000,
      unit: 'USD',
      source: 'Bearing exit model',
      method: 'exit-capacity-0.1; cost tolerance 0.01',
      fetchedAt: '2026-10-09T14:00:00.000Z',
      provenance: 'sandbox',
      staleAgeSec: null,
    });
    expect(facts(reply).get(`exit:${TSLA}:worst`)).toMatchObject({
      text: '0.4%',
      source: 'Bearing fact sheet',
      method: 'hourly quotes (facts-0.1)',
      fetchedAt: '2026-10-09T14:00:00.000Z',
      provenance: 'sandbox',
    });
    // the draft is still the server's: the one holding, whole
    expect(reply.proposal?.allocations.map((line) => [line.assetId, line.weightBps])).toEqual([
      [TSLA, 10_000],
    ]);
    // the proposal's prose is there for a client that draws figures, with no placeholder in it
    expect(reply.figures?.prose.proposal?.why).toEqual({ [TSLA]: 'The stock you named.' });
    expect(result.figures).toEqual({ resolved: 2, missing: 0, unknown: 0 });
  });

  it('serves plain words and no braces to a client that does not know figures', async () => {
    const { reply } = await ask({ say: DEPTH }, DRAFT);
    const { figures: _figures, ...older } = reply;
    expect(JSON.stringify(older)).not.toMatch(/[{}]{2}|fact:/u);
  });

  it('leaves `figures` out of a reply that states none, as before', async () => {
    const { reply, result } = await ask(
      { say: 'Tesla is on this chain. How much will you deposit?' },
      DRAFT,
    );
    expect(reply.figures).toBeUndefined();
    expect(result.figures).toBeUndefined();
  });

  it('still refuses a number the model types, beside a reference or alone', async () => {
    const typed = await ask(
      { say: 'The Tesla pool is about $40,000 deep. It trades around the clock.' },
      DRAFT,
    );
    expect(typed.reply.message).toBe(`It trades around the clock.\n${CUT}`);
    expect(typed.calls).toHaveLength(2);
    expect(typed.result.repair).toMatchObject({
      failed: 'prose_figure',
      outcome: 'prose_figure_trimmed',
    });
    const both = await ask(
      {
        say: `Selling Tesla costs about ${ref(`exit:${TSLA}:worst`)}, or 40 dollars on ten thousand.`,
      },
      DRAFT,
    );
    expect(both.reply.message).toBe(CUT);
    expect(both.reply.figures).toBeUndefined();
    const words = await ask(
      { say: 'Selling Tesla costs about five percent. It trades around the clock.' },
      DRAFT,
    );
    expect(words.reply.message).toBe(`It trades around the clock.\n${CUT}`);
  });

  it('passes a repaired reply whole', async () => {
    const { reply, result, calls } = await ask(
      [{ say: 'The Tesla pool is about $40,000 deep.' }, { say: DEPTH }],
      DRAFT,
    );
    expect(reply.message).toContain('$42,000.00');
    expect(result.repair).toEqual({ failed: 'prose_figure', outcome: 'repaired' });
    expect(calls[1]?.messages.at(-1)?.content).toContain('{{fact:<id>}}');
  });

  it('says a figure that is not measured in words, never as a number', async () => {
    const { reply, result } = await ask(
      { say: `Weekend exit capacity for Tesla is ${ref(`weekend:${TSLA}`)}.` },
      DRAFT,
    );
    expect(reply.message).toBe(
      'Weekend exit capacity for Tesla is not measured (no samples in that regime yet).',
    );
    expect(reply.message).not.toMatch(/\p{N}/u);
    expect(facts(reply).get(`weekend:${TSLA}`)).toMatchObject({
      value: null,
      reason: 'no_samples_in_regime',
    });
    expect(result.figures).toEqual({ resolved: 0, missing: 1, unknown: 0 });
  });

  it('marks a sample figure and a test-network figure as what they are', async () => {
    const turns: Turn[] = [{ who: 'person', text: 'What does it cost to sell Tesla and Nvidia?' }];
    const { reply } = await ask(
      {
        say: `Selling Tesla costs about ${ref(`exit:${TSLA}:worst`)}. Selling Nvidia costs about ${ref(`exit:${NVDA}:worst`)}.`,
      },
      turns,
    );
    expect(facts(reply).get(`exit:${TSLA}:worst`)?.label).toContain(
      'TSLAx mainnet figures on a test network',
    );
    expect(facts(reply).get(`exit:${TSLA}:worst`)).toMatchObject({ provenance: 'sandbox' });
    expect(facts(reply).get(`exit:${NVDA}:worst`)).toMatchObject({ provenance: 'mock' });
  });

  it('carries the age of a price the market has closed on, and "at least" on a lower bound', async () => {
    const turns: Turn[] = [
      { who: 'person', text: 'What is the price of Tesla, and how much Nvidia can be sold?' },
    ];
    const { reply } = await ask(
      {
        say: `Tesla trades at ${ref(`price:${TSLA}`)}. The largest sale of Nvidia within the cost tolerance is ${ref(`capacity:${NVDA}`)}.`,
      },
      turns,
      built({ stale: true }),
    );
    expect(reply.message).toBe(
      'Tesla trades at $250.00. The largest sale of Nvidia within the cost tolerance is at least $90,000.00.',
    );
    expect(facts(reply).get(`price:${TSLA}`)).toMatchObject({ staleAgeSec: 90_000 });
    expect(facts(reply).get(`capacity:${NVDA}`)).toMatchObject({ lowerBound: true });
  });

  it('writes the value in the language of the reply', async () => {
    const { reply } = await ask(
      { say: `Vender Tesla custa cerca de ${ref(`exit:${TSLA}:worst`)}.` },
      [{ who: 'person', text: 'Quanto custa vender Tesla?' }],
      built(),
      'pt',
    );
    expect(reply.message).toBe('Vender Tesla custa cerca de 0,4%.');
  });

  it('shows both figures and no verdict when asked which is deeper: a ranking sentence is not served', async () => {
    const turns: Turn[] = [{ who: 'person', text: 'Which is deeper, Tesla or Nvidia?' }];
    const rank = `Selling Tesla costs about ${ref(`exit:${TSLA}:worst`)}. Selling Nvidia costs about ${ref(`exit:${NVDA}:worst`)}. Tesla at ${ref(`exit:${TSLA}:worst`)} is cheaper than Nvidia.`;
    const { reply } = await ask({ say: rank }, turns);
    expect(reply.message).toBe(
      `Selling Tesla costs about 0.4%. Selling Nvidia costs about 0.6%.\n${CUT}`,
    );
  });
});

describe('a figure is called what it is, and set against nothing', () => {
  const two: Turn[] = [{ who: 'person', text: 'Tell me about Tesla and Nvidia' }];
  it.each([
    ['a provider’s share as a weight', `Put ${ref(`lp:${TSLA}:top1`)} in Tesla.`],
    [
      'a provider’s share as a limit',
      `Tesla can be at most ${ref(`lp:${TSLA}:top1`)} of the vault.`,
    ],
    ['an exit cost as a share', `Tesla is ${ref(`exit:${TSLA}:worst`)} of your vault.`],
    ['an exit cost as a price', `Tesla’s price is ${ref(`exit:${TSLA}:worst`)}.`],
    ['volatility as a cost to sell', `Selling Tesla costs about ${ref(`vol:${TSLA}`)}.`],
    ['a drawdown as volatility', `Tesla’s volatility is ${ref(`drawdown:${TSLA}`)}.`],
    ['volume as a price', `Tesla trades at ${ref(`volume:${TSLA}`)}.`],
    ['a price as what a holding is worth', `Your Tesla holding is worth ${ref(`price:${TSLA}`)}.`],
    [
      'an exit cost under a capacity’s name',
      `Tesla’s weekend capacity is ${ref(`exit:${TSLA}:worst`)}.`,
    ],
    ['a largest sale as a cost', `Selling Tesla costs about ${ref(`capacity:${TSLA}`)}.`],
    ['a figure with no word for it', `Tesla: ${ref(`vol:${TSLA}`)}.`],
    ['one figure set above another', `Tesla trades at ${ref(`price:${TSLA}`)}, more than Nvidia.`],
    [
      'a verdict between two',
      `Selling Tesla costs ${ref(`exit:${TSLA}:worst`)} versus ${ref(`exit:${NVDA}:worst`)} for Nvidia.`,
    ],
  ])('never %s', async (_what, say) => {
    const { reply } = await ask({ say }, two);
    expect(reply.message).toBe(CUT);
    expect(reply.figures).toBeUndefined();
  });

  it('reads a line of a list under the list’s heading, and no further than that list', async () => {
    const list = `Exit costs at the reference size:\n- Tesla: ${ref(`exit:${TSLA}:worst`)}\n- Nvidia: ${ref(`exit:${NVDA}:worst`)}`;
    expect((await ask({ say: list }, two)).reply.message).toBe(
      'Exit costs at the reference size:\n- Tesla: 0.4%\n- Nvidia: 0.6%',
    );
    // the heading's other words are read with every line, not only the first
    const promised = `Expected exit costs next year:\n- Tesla: ${ref(`exit:${TSLA}:worst`)}\n- Nvidia: ${ref(`exit:${NVDA}:worst`)}`;
    expect((await ask({ say: promised }, two)).reply.figures).toBeUndefined();
    // and a heading of another kind lends its word to no line
    const wrong = `Prices:\n- Tesla: ${ref(`exit:${TSLA}:worst`)}\n- Nvidia: ${ref(`exit:${NVDA}:worst`)}`;
    expect((await ask({ say: wrong }, two)).reply.figures).toBeUndefined();
  });
});

describe('what a reference on /goal may name', () => {
  it.each([
    ['a holding of a vault', `holding:${TSLA}:value`],
    ['a share of a vault', `holding:${TSLA}:share`],
    ['the value of a vault', 'vault:value'],
    ['an id that is no figure', `catalog:${TSLA}`],
    ['a tier', `tier:${TSLA}`],
    ['an id it made up', `depth:${TSLA}`],
    ['a listed asset the conversation has not named', `exit:${NVDA}:worst`],
  ])('never %s: its sentence is cut', async (_what, id) => {
    const { reply, result } = await ask(
      { say: `Tesla is listed here. The Tesla figure is ${ref(id)}.` },
      DRAFT,
    );
    expect(reply.message).toBe(`Tesla is listed here.\n${CUT}`);
    expect(reply.figures).toBeUndefined();
    expect(result.repair).toMatchObject({
      failed: 'figure_reference',
      outcome: 'prose_figure_trimmed',
    });
    expect(result.figures?.unknown).toBeGreaterThan(0);
  });

  it('holds no person-specific fact: there is no vault yet', () => {
    expect(built().evidence.filter((source) => /^(?:vault|holding):/u.test(source.id))).toEqual([]);
  });

  it('serves a reference in the message only: one in a reason or a pot’s name costs that text', async () => {
    const { reply } = await ask(
      {
        say: 'Here is a draft.',
        lines: [
          { id: TSLA, why: `It trades at ${ref(`price:${TSLA}`)}.`, share: null },
          { id: NVDA, why: 'A chip maker.', share: null },
        ],
      },
      [{ who: 'person', text: 'I want Tesla and Nvidia' }],
    );
    expect(JSON.stringify(reply)).not.toMatch(/fact:|\{\{/u);
    expect(reply.figures).toBeUndefined();
    expect(reply.proposal?.allocations.find((line) => line.assetId === TSLA)?.why).toBe(
      'This part of the draft was left out because it stated a figure that could not be confirmed.',
    );
  });
});

describe('the evidence the model is handed', () => {
  const system = (calls: Call[]) => calls[0]?.system ?? [];
  it('keeps the figures out of the cached prefix and loads them only for what the conversation names', async () => {
    const { calls } = await ask({ say: 'Noted.' }, DRAFT);
    const blocks = system(calls);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0]?.text).not.toContain(`exit:${TSLA}:worst`);
    const rest = blocks.slice(1);
    expect(rest.every((block) => block.cache_control === undefined)).toBe(true);
    const loaded = rest.map((block) => block.text).join('\n');
    for (const id of [
      `price:${TSLA}`,
      `capacity:${TSLA}`,
      `exit:${TSLA}:worst`,
      `exit:${TSLA}:us_market_hours`,
      `lp:${TSLA}:top1`,
      `lpexit:${TSLA}`,
      `capvar:${TSLA}`,
      `volume:${TSLA}`,
      `vol:${TSLA}`,
      `drawdown:${TSLA}`,
    ])
      expect(loaded).toContain(id);
    expect(loaded).toMatch(new RegExp(`weekend:${TSLA}[^\\n]*not measured`, 'u'));
    // not the rest of the catalog's, which is only named as having figures
    expect(loaded).not.toContain(`exit:${NVDA}`);
    expect(loaded).not.toContain(`yield:${SGOV}`);
    expect(loaded).toMatch(/NVDA/u);
    // an id and what it measures, never its value
    expect(loaded).not.toMatch(/42[,.]?000|0\.004|0\.4%|250/u);
    expect(loaded).not.toMatch(/(?:vault|holding):/u);
  });

  it('is the same cached prefix whatever the conversation names', async () => {
    const one = await ask({ say: 'Noted.' }, DRAFT);
    const other = await ask({ say: 'Noted.' }, 'Tell me about Nvidia and the reserve');
    expect(system(one.calls)[0]?.text).toBe(system(other.calls)[0]?.text);
  });

  it('loads a holding named by its symbol, its company, its id in a kept draft, or its class in the latest words', async () => {
    const loaded = async (turns: Turn[] | string) =>
      system((await ask({ say: 'Noted.' }, turns)).calls)
        .slice(1)
        .map((block) => block.text)
        .join('\n');
    expect(await loaded('what about tTSLA?')).toContain(`exit:${TSLA}:worst`);
    expect(await loaded('what about Nvidia?')).toContain(`exit:${NVDA}:worst`);
    expect(await loaded('how good is the yield on SGOV?')).toContain(`yield:${SGOV}:0:quoted`);
    expect(
      await loaded([
        { who: 'person', text: 'something in chips' },
        {
          who: 'app',
          text: `Draft proposal:\nPick\nNVDA (${NVDA}): 100% — chips [catalog:${NVDA}]`,
        },
        { who: 'person', text: 'how deep is its pool?' },
      ]),
    ).toContain(`capacity:${NVDA}`);
    const stocks = await loaded('how liquid are the stocks here?');
    expect(stocks).toContain(`exit:${TSLA}:worst`);
    expect(stocks).toContain(`exit:${NVDA}:worst`);
    // a class word loads so many and no more; the rest are named as not loaded
    const many = built();
    const more = Array.from({ length: 9 }, (_, at) => ({
      ...(many.assets.find((asset) => asset.id === NVDA) as (typeof many.assets)[number]),
      id: `robinhood:extra${at}`,
      symbol: `XTR${at}`,
      underlying: `XTR${at}`,
    }));
    const wide = {
      ...many,
      assets: [...many.assets, ...more],
      evidence: [
        ...many.evidence,
        ...more.map((asset) => ({
          id: `price:${asset.id}`,
          assetId: asset.id,
          label: 'Reference price',
          value: 10,
          unit: 'USD',
          source: 'reference oracle',
          method: 'oracle read',
          fetchedAt: now,
          provenance: 'sandbox' as const,
        })),
      ],
    } as GoalAgentContext;
    const { calls } = await ask({ say: 'Noted.' }, 'how liquid are the stocks here?', wide);
    const block = system(calls)[1]?.text ?? '';
    expect((block.match(/^\S.*\):$/gmu) ?? []).length).toBe(6);
    expect(block).toMatch(/Not loaded[^\n]*XTR8/u);
    // a class word in older words loads nothing: only the newest question does
    expect(
      await loaded([
        { who: 'person', text: 'I like stocks' },
        { who: 'app', text: 'Which ones?' },
        { who: 'person', text: 'you choose' },
      ]),
    ).not.toContain('exit:');
  });

  it('says so when Bearing has no sheet, and offers no figure it does not have', async () => {
    const { calls, reply } = await ask(
      { say: `Selling gold costs about ${ref(`exit:${GLD}:worst`)}. Gold is listed here.` },
      'what does it cost to sell GLD?',
    );
    const loaded = system(calls)
      .slice(1)
      .map((block) => block.text)
      .join('\n');
    expect(loaded).toContain(`price:${GLD}`);
    expect(loaded).not.toContain(`exit:${GLD}`);
    expect(reply.message).toBe(`Gold is listed here.\n${CUT}`);
  });

  it('tells the model when to use a reference, and never to rank, compare or promise', async () => {
    const { calls } = await ask({ say: 'Noted.' }, DRAFT);
    const rules = system(calls)[0]?.text ?? '';
    expect(rules).toContain('{{fact:<id>}}');
    expect(rules).toMatch(/never type/iu);
    expect(rules).toMatch(/no verdict/iu);
    expect(rules).toMatch(/never promise/iu);
  });

  it('sends the model its own earlier turn with the placeholders it wrote, as the web resends it', async () => {
    const { calls } = await ask({ say: 'Noted.' }, [
      ...DRAFT,
      { who: 'app', text: DEPTH },
      { who: 'person', text: 'thanks' },
    ]);
    const history = calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(history).toContain(ref(`capacity:${TSLA}`));
    expect(history).not.toContain('42,000');
  });
});

describe('a served figure is never read back as the person’s', () => {
  // An older web resends the plain reply, values and all; a newer one the placeholders. Either way
  // the server's readers take shares, sums and limits from the person's turns alone.
  const SAID =
    'Tesla trades at $250.00. Selling Tesla costs about 70% in the worst measured regime, and at most 20% in Nvidia is the largest provider’s share.';
  const turns: Turn[] = [
    { who: 'person', text: 'I want Tesla and Nvidia' },
    { who: 'app', text: SAID },
    { who: 'person', text: 'ok, go on' },
  ];
  const lines = [
    { id: TSLA, why: 'Named.', share: 0.7 },
    { id: NVDA, why: 'Named.', share: 0.3 },
  ];
  it('not as a share, a limit, an amount or a projection’s start', async () => {
    const context = built();
    const { reply } = await ask(
      {
        say: 'Here is the draft.',
        lines,
        stated: { ...NOTHING, amount: 250, currency: 'USD', need_by: '2030-01-01' },
      },
      turns,
      context,
    );
    expect(reply.proposal?.allocations.map((line) => line.weightBps)).toEqual([5000, 5000]);
    expect(reply.proposal?.tradeoffs.join('\n')).not.toMatch(/does not yet meet|applied exactly/u);
    expect(reply.proposal?.projection).toBeUndefined();
    expect(reply.proposal?.objective).toBe('Pick');
    expect(reply.message).toBe('Here is the draft.');
    expect(statedAmountUsd(turns)).toBeNull();
    expect(statedPurposeIn(turns, context)).toEqual({ goal: null, risk: null });
  });
  it('and the person’s own share beside it still is', async () => {
    const mine: Turn[] = [
      ...turns.slice(0, 2),
      { who: 'person', text: 'I want 70% Tesla and 30% Nvidia' },
      { who: 'app', text: 'Noted.' },
      { who: 'person', text: 'I will start with $2,000' },
    ];
    const { reply } = await ask({ say: 'Here is the draft.', lines }, mine);
    expect(reply.proposal?.allocations.map((line) => line.weightBps)).toEqual([7000, 3000]);
    expect(statedAmountUsd(mine)).toBe(2000);
  });
});

describe('a long message keeps every placeholder whole', () => {
  it('ends before a figure it has no room for, and never mid-reference', async () => {
    const sentence = `Selling Tesla costs about ${ref(`exit:${TSLA}:worst`)} in the worst measured regime. `;
    const { reply } = await ask({ say: sentence.repeat(60).trim() }, DRAFT);
    expect(reply.message.length).toBeLessThanOrEqual(2400);
    expect(reply.message).not.toMatch(/[{}]|fact:/u);
    const template = reply.figures?.prose.message ?? '';
    expect(template.replace(/\{\{fact:[^{}\s]+\}\}/gu, '')).not.toMatch(/[{}]/u);
    expect(template.replace(/\{\{fact:[^{}\s]+\}\}/gu, '0.4%')).toBe(reply.message);
  });
});

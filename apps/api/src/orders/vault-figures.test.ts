import type { Price, VaultAgentStatedShare, VaultState } from '@colosseum/schemas';
import { VaultAgentReplyShape } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel, vaultAgentContent } from '../vault-agent-model';
import {
  type AgentAnalyticsResult,
  buildGoalAgentContext,
  buildVaultAgentContext,
  replyToVaultConversation,
  type VaultAgentPrompt,
} from './vault-agent';
import { figureText } from './vault-figures';

// Figures by reference (gate FIGURES-BY-REFERENCE). Model replies are fixtures: no model is called.
const shelf = launchShelf();
const assets = shelf.assets.filter((asset) => asset.chain === 'solana');
const cash = assets.find((asset) => asset.cls === 'cash');
const stock = assets.find((asset) => asset.cls === 'stock');
const reserve = assets.find((asset) => asset.cls === 'dollar_yield');
if (!cash || !stock || !reserve) throw new Error('Incomplete offline catalog fixture');
const now = '2026-10-07T20:00:00.000Z';
const state: VaultState = {
  chain: 'solana',
  address: cash.address,
  owner: cash.address,
  basketId: '1',
  keeper: cash.address,
  recipeOnchainId: null,
  acceptedVersion: 0,
  autoFollow: false,
  cash: { asset: cash.id, raw: '1000000000', display: '1000', multiplier: '1' },
  positions: [
    {
      asset: stock.id,
      raw: (10n * 10n ** BigInt(stock.decimals)).toString(),
      display: '10',
      multiplier: '1',
      targetBps: 2000,
      lastKeeperAt: null,
    },
  ],
  lossUsedBps: 0,
  observedAt: now,
  pending: null,
};
const priced = (over: Partial<Price> = {}): Price[] =>
  [cash, stock].map((asset) => ({
    asset: asset.id,
    usdPerToken: asset.cls === 'cash' ? '1' : '100',
    ageSeconds: 0,
    maxAgeSeconds: 300,
    market: 'open',
    source: 'offline reference fixture',
    method: 'fixture',
    fetchedAt: '2026-10-07T19:59:00.000Z',
    provenance: 'mock',
    ...(asset.cls === 'cash' ? {} : over),
  }));
const pin = {
  unit: 'fraction' as const,
  source: 'offline fact sheet',
  method: 'fixture (facts-0.1)',
  fetchedAt: '2026-10-07T19:00:00.000Z',
  provenance: 'mock' as const,
};
type Sheet = Extract<AgentAnalyticsResult, { assets: unknown }>;
const sheet = (over: Partial<Sheet> = {}): Sheet => ({
  sizeUsd: 10_000,
  basis: 'reference',
  tau: 0.01,
  assets: [
    {
      assetId: stock.id,
      modelledOn: null,
      figures: [
        { metric: 'exit_worst', regime: 'us_offhours_weekday', value: 0.004, ...pin },
        { metric: 'weekend', value: null, reason: 'no_samples_in_regime' },
        { metric: 'volume_28d', value: 1234567.891, ...pin, unit: 'usd' },
        { metric: 'drawdown', value: 0.35, ...pin, lowerBound: true },
      ],
    },
  ],
  ...over,
});
type Built = Parameters<typeof buildVaultAgentContext>[0];
const offline = { source: 'offline adapter', provenance: 'mock' } as Built['entry'];
const built = (over: Partial<Built> = {}) =>
  buildVaultAgentContext({
    state,
    entry: offline,
    prices: priced(),
    prepared: { shelf, figures: {} },
    person: 'owner-fixture',
    currentGoals: [{ goal: 'grow' }],
    analytics: sheet(),
    ...over,
  });
const request = (text = 'What would it cost to sell my stock?', language: 'en' | 'pt' = 'en') => ({
  version: 1 as const,
  language,
  messageId: 'person-turn',
  messages: [{ who: 'person' as const, text }],
});
const said = (message: string) => ({ message, question: null, proposal: null });
const fake = (...replies: unknown[]): VaultAgentModel => {
  const read = vi.fn<VaultAgentModel['read']>();
  for (const reply of replies) read.mockResolvedValueOnce({ reply });
  read.mockResolvedValue({ reply: replies.at(-1) });
  return { read };
};
const exit = `exit:${stock.id}:worst`;
const ref = (id: string) => `{{fact:${id}}}`;
const FIGURE_CUT =
  'Part of this reply was left out because it stated a figure that could not be confirmed.';
const served = (out: Awaited<ReturnType<typeof replyToVaultConversation>>) => {
  if (out.kind !== 'reply') throw new Error(`Rejected: ${JSON.stringify(out)}`);
  return out;
};

describe('the vault conversation states a measured figure by reference', () => {
  it('writes the measured value where the reference stood, with its source', async () => {
    const model = fake(said(`Selling it all today would cost about ${ref(exit)}.`));
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(out.reply.message).toBe('Selling it all today would cost about 0.4%.');
    expect(out.reply.figures).toEqual({
      prose: {
        message: `Selling it all today would cost about ${ref(exit)}.`,
        question: null,
        proposal: null,
      },
      facts: [
        {
          id: exit,
          assetId: stock.id,
          label: 'Exit cost at the reference size, worst measured regime (weekday off-hours)',
          text: '0.4%',
          value: 0.004,
          unit: 'fraction',
          source: 'offline fact sheet',
          method: 'fixture (facts-0.1)',
          fetchedAt: '2026-10-07T19:00:00.000Z',
          provenance: 'mock',
          staleAgeSec: null,
        },
      ],
    });
    expect(out.figures).toEqual({ resolved: 1, missing: 0, unknown: 0 });
    expect(out.repair).toBeUndefined();
  });

  it('leaves a reply with no reference exactly as before: no figures field', async () => {
    const out = served(await replyToVaultConversation(request(), built(), fake(said('Hello.'))));
    expect(out).toEqual({
      kind: 'reply',
      reply: {
        version: 1,
        messageId: 'person-turn',
        message: 'Hello.',
        question: null,
        proposal: null,
        warnings: [],
        weightNotes: [],
      },
    });
  });

  it('asks once for the repair of an id it never gave, and serves the corrected reply', async () => {
    const model = fake(
      said(`It would cost about ${ref(`exit:${stock.id}:lunar`)}. A reserve helps.`),
      said(`It would cost about ${ref(exit)}. A reserve helps.`),
    );
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(2);
    const repair = vi.mocked(model.read).mock.calls[1]?.[2];
    expect(repair?.problems.join('\n')).toContain('{{fact:<id>}}');
    expect(repair?.problems.join('\n')).toContain(`exit:${stock.id}:lunar`);
    expect(out.reply.message).toBe('It would cost about 0.4%. A reserve helps.');
    expect(out.repair).toEqual({ failed: 'figure_reference', outcome: 'repaired' });
    expect(out.figures).toEqual({ resolved: 1, missing: 0, unknown: 1 });
  });

  it.each([
    ['an id it never gave', ref(`exit:${stock.id}:lunar`)],
    ['an id that carries no value', ref(`catalog:${stock.id}`)],
    ['an empty reference', '{{fact:}}'],
    ['a reference with a space in it', `{{fact:${exit} now}}`],
    ['single braces', `{fact:${exit}}`],
    ['an unclosed reference', `{{fact:${exit}`],
    ['another kind of token', `{{price:${stock.id}}}`],
  ])(
    'cuts the sentence of %s when the repair still has it, and shows no number',
    async (_, token) => {
      const model = fake(said(`It would cost about ${token}. A reserve helps.`));
      const out = served(await replyToVaultConversation(request(), built(), model));
      expect(model.read).toHaveBeenCalledTimes(2);
      expect(out.reply.message).toBe(`A reserve helps.\n${FIGURE_CUT}`);
      expect(out.reply.figures).toBeUndefined();
      expect(out.repair).toEqual({
        failed: 'figure_reference',
        outcome: 'prose_figure_trimmed',
        sentencesCut: 1,
      });
      expect(out.reply.message).not.toMatch(/[{}\d]/u);
      expect(out.figures).toEqual({ resolved: 0, missing: 0, unknown: 2 });
    },
  );

  it('says why a figure is not measured, in the reason’s words, and shows no number', async () => {
    const weekend = `weekend:${stock.id}`;
    const model = fake(said(`Weekend capacity against market hours is ${ref(weekend)}.`));
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(out.reply.message).toBe(
      'Weekend capacity against market hours is not measured (no samples in that regime yet).',
    );
    expect(out.reply.message).not.toMatch(/\d/u);
    expect(out.reply.figures?.facts).toEqual([
      {
        id: weekend,
        assetId: stock.id,
        label: 'Weekend ÷ market-hours exit capacity',
        text: 'not measured (no samples in that regime yet)',
        value: null,
        reason: 'no_samples_in_regime',
      },
    ]);
    expect(out.figures).toEqual({ resolved: 0, missing: 1, unknown: 0 });
  });

  it('still refuses a digit typed beside a valid reference, then cuts its sentence', async () => {
    const typed = said(`It costs about ${ref(exit)}, roughly 12% a year. A reserve helps.`);
    const model = fake(typed);
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(model.read).mock.calls[1]?.[2]?.problems[0]).toContain(
      'Prose contained a financial figure',
    );
    expect(out.reply.message).toBe(`A reserve helps.\n${FIGURE_CUT}`);
    expect(out.repair).toEqual({
      failed: 'prose_figure',
      outcome: 'prose_figure_trimmed',
      sentencesCut: 1,
    });
    expect(out.reply.figures).toBeUndefined();
    // The value typed by hand beside the reference, without a sign, is a typed figure too.
    const bare = said(`It costs about ${ref(exit)} or 0.4 of the trade. A reserve helps.`);
    expect(
      served(await replyToVaultConversation(request(), built(), fake(bare))).reply.message,
    ).toBe(`A reserve helps.\n${FIGURE_CUT}`);
  });

  it.each([
    ['two references with no word between them', (a: string, b: string) => `You hold ${a}${b}.`],
    ['two references joined by a point', (a: string, b: string) => `You hold ${a}.${b} of it.`],
    ['a magnitude after a reference', (a: string) => `The vault is worth ${a} million.`],
    ['another unit after a reference', (a: string) => `You hold ${a} dollars of it.`],
    ['a multiplier before a reference', (a: string) => `It could reach double ${a}.`],
    ['a count of times before a reference', (a: string) => `It is worth several times ${a}.`],
  ])('cuts a reference made into another number: %s', async (_, sentence) => {
    const amount = ref(`holding:${stock.id}:amount`);
    const model = fake(
      said(`${sentence(amount, ref(`holding:${cash.id}:amount`))} A reserve helps.`),
    );
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(2);
    expect(out.reply.message).toBe(`A reserve helps.\n${FIGURE_CUT}`);
    expect(out.repair).toMatchObject({ failed: 'figure_reference' });
  });

  it('lets two references stand side by side with words between them, and a count keep its noun', async () => {
    const model = fake(
      said(
        `You hold ${ref(`holding:${stock.id}:amount`)} tokens, worth ${ref(`holding:${stock.id}:value`)} of the vault's ${ref('vault:value')}.`,
      ),
    );
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(out.reply.message).toBe("You hold 10 tokens, worth $1,000.00 of the vault's $2,000.00.");
    // One sentence may end in a figure and the next begin with one.
    const two = fake(
      said(
        `The vault is worth ${ref('vault:value')}. ${ref(exit)} is what selling the stock costs.`,
      ),
    );
    expect(served(await replyToVaultConversation(request(), built(), two)).reply.message).toBe(
      'The vault is worth $2,000.00. 0.4% is what selling the stock costs.',
    );
  });

  it('resolves a reference in every prose field, and the plain reply holds no braces', async () => {
    const volume = `volume:${stock.id}`;
    const drawdown = `drawdown:${stock.id}`;
    const value = `holding:${stock.id}:value`;
    const model = fake({
      message: `Your holding is worth about ${ref(value)}.`,
      question: `Is an exit cost of ${ref(exit)} acceptable to you?`,
      proposal: {
        objective: `Keep the stock, now ${ref(`holding:${stock.id}:share`)} of the vault`,
        summary: `The vault is worth ${ref('vault:value')} in all.`,
        allocations: [
          {
            assetId: stock.id,
            why: `It trades often: ${ref(volume)} over four weeks.`,
            evidenceIds: [volume],
          },
          {
            assetId: reserve.id,
            why: 'A reserve beside it.',
            evidenceIds: [`catalog:${reserve.id}`],
          },
        ],
        stated: [] as VaultAgentStatedShare[],
        tradeoffs: [`Its largest fall so far was ${ref(drawdown)}.`],
        unknowns: [`Weekend capacity is ${ref(`weekend:${stock.id}`)}.`],
      },
    });
    const out = served(await replyToVaultConversation(request(), built(), model));
    expect(model.read).toHaveBeenCalledTimes(1);
    const { figures, ...plain } = out.reply;
    // What a client that does not know `figures` shows: words and the server's values, never a brace.
    expect(JSON.stringify(plain)).not.toMatch(/\{\{|fact:/u);
    expect(VaultAgentReplyShape.omit({ figures: true }).safeParse(plain).success).toBe(true);
    expect(plain.message).toBe('Your holding is worth about $1,000.00.');
    expect(plain.question).toBe('Is an exit cost of 0.4% acceptable to you?');
    expect(plain.proposal?.objective).toBe('Keep the stock, now 50% of the vault');
    expect(plain.proposal?.summary).toBe('The vault is worth $2,000.00 in all.');
    expect(plain.proposal?.allocations[0]?.why).toBe(
      'It trades often: $1,234,567.89 over four weeks.',
    );
    expect(plain.proposal?.tradeoffs).toEqual(['Its largest fall so far was at least 35%.']);
    expect(plain.proposal?.unknowns.at(-1)).toBe(
      'Weekend capacity is not measured (no samples in that regime yet).',
    );
    // The same prose with each figure a placeholder, field by field, and each placeholder a fact.
    expect(figures?.prose.message).toBe(`Your holding is worth about ${ref(value)}.`);
    expect(figures?.prose.question).toContain(ref(exit));
    expect(figures?.prose.proposal?.objective).toContain(ref(`holding:${stock.id}:share`));
    expect(figures?.prose.proposal?.summary).toContain(ref('vault:value'));
    expect(figures?.prose.proposal?.why).toEqual({
      [stock.id]: `It trades often: ${ref(volume)} over four weeks.`,
      [reserve.id]: 'A reserve beside it.',
    });
    expect(figures?.prose.proposal?.tradeoffs).toEqual([
      `Its largest fall so far was ${ref(drawdown)}.`,
    ]);
    expect(figures?.prose.proposal?.unknowns).toHaveLength(plain.proposal?.unknowns.length ?? 0);
    expect(figures?.prose.proposal?.unknowns.at(-1)).toContain(ref(`weekend:${stock.id}`));
    expect(figures?.facts.map((fact) => fact.id).sort()).toEqual(
      [
        value,
        exit,
        `holding:${stock.id}:share`,
        'vault:value',
        volume,
        drawdown,
        `weekend:${stock.id}`,
      ].sort(),
    );
    expect(figures?.facts.find((fact) => fact.id === drawdown)).toMatchObject({
      lowerBound: true,
      text: 'at least 35%',
    });
    expect(out.figures).toEqual({ resolved: 6, missing: 1, unknown: 0 });
  });

  it('keeps each figure’s own provenance: a test-network read is not shown as live', async () => {
    const ctx = built({
      entry: { source: 'chain read', provenance: 'live' } as Built['entry'],
      prices: priced({ provenance: 'live', source: 'oracle' }),
      analytics: sheet({
        assets: [
          {
            assetId: stock.id,
            modelledOn: 'NVDA',
            figures: [
              {
                metric: 'exit_worst',
                regime: 'weekend',
                value: 0.01,
                ...pin,
                provenance: 'sandbox',
              },
            ],
          },
        ],
      }),
    });
    const model = fake(
      said(`It is priced at ${ref(`price:${stock.id}`)} and costs ${ref(exit)} to sell.`),
    );
    const out = served(await replyToVaultConversation(request(), ctx, model));
    const byId = new Map(out.reply.figures?.facts.map((fact) => [fact.id, fact]));
    expect(byId.get(`price:${stock.id}`)).toMatchObject({ provenance: 'live', source: 'oracle' });
    expect(byId.get(exit)).toMatchObject({ provenance: 'sandbox', text: '1%' });
  });

  it('writes the value in the language of the reply', async () => {
    const model = fake(said(`O cofre vale ${ref('vault:value')} e vender custa ${ref(exit)}.`));
    const out = served(
      await replyToVaultConversation(request('Quanto vale o meu cofre?', 'pt'), built(), model),
    );
    expect(out.reply.message).toBe('O cofre vale US$ 2.000,00 e vender custa 0,4%.');
    expect(figureText(0.5, 'ratio', 'pt')).toBe('0,5');
    expect(figureText(12, 'hours', 'pt')).toBe('12 horas');
    expect(figureText(0.00042, 'fraction', 'en')).toBe('0.042%');
  });

  it('states no figure in a new goal’s conversation: a reference there names nothing', async () => {
    const goal = buildGoalAgentContext({
      chain: 'solana',
      observedAt: now,
      entry: offline,
      prices: priced(),
      prepared: { shelf, figures: {} },
      person: 'owner-fixture',
      analytics: sheet(),
    });
    const model = fake(said(`It would cost about ${ref(exit)}. A reserve helps.`));
    const out = served(await replyToVaultConversation(request(), goal, model));
    expect(out.reply.message).toBe(`A reserve helps.\n${FIGURE_CUT}`);
    expect(out.reply.figures).toBeUndefined();
  });
});

describe('the vault’s own state as figures', () => {
  const sources = (ctx: ReturnType<typeof built>) =>
    new Map(ctx.evidence.map((source) => [source.id, source]));

  it('gives what the vault holds, what it is worth and each share, each with its read', () => {
    const got = sources(built());
    expect(got.get(`holding:${stock.id}:value`)).toEqual({
      id: `holding:${stock.id}:value`,
      assetId: stock.id,
      label: 'Value of this holding at its reference price',
      value: 1000,
      unit: 'USD',
      source: 'offline reference fixture',
      // the older of the vault's read and the price's
      fetchedAt: '2026-10-07T19:59:00.000Z',
      method: 'amount read from the vault, times its reference price (fixture)',
      provenance: 'mock',
    });
    expect(got.get(`holding:${stock.id}:amount`)).toMatchObject({
      value: 10,
      unit: 'units',
      source: 'offline adapter',
      fetchedAt: now,
    });
    expect(got.get(`holding:${stock.id}:share`)).toMatchObject({ value: 0.5, unit: 'fraction' });
    expect(got.get(`holding:${stock.id}:target`)).toMatchObject({ value: 0.2, unit: 'fraction' });
    expect(got.get(`holding:${cash.id}:value`)).toMatchObject({ value: 1000, unit: 'USD' });
    expect(got.get(`holding:${cash.id}:share`)).toMatchObject({ value: 0.5 });
    expect(got.get('vault:value')).toMatchObject({
      value: 2000,
      unit: 'USD',
      source: 'offline reference fixture',
      fetchedAt: '2026-10-07T19:59:00.000Z',
      provenance: 'mock',
    });
  });

  it('says a holding with no price is not measured, and the vault’s value with it', async () => {
    const ctx = built({ prices: priced().filter((price) => price.asset !== stock.id) });
    expect(sources(ctx).has(`holding:${stock.id}:value`)).toBe(false);
    expect(sources(ctx).has('vault:value')).toBe(false);
    const model = fake(
      said(
        `Your holding is worth ${ref(`holding:${stock.id}:value`)}; the vault, ${ref('vault:value')}.`,
      ),
    );
    const out = served(await replyToVaultConversation(request(), ctx, model));
    expect(out.reply.message).toBe(
      'Your holding is worth not measured (no reference prices collected); the vault, not measured (no reference prices collected).',
    );
    expect(out.figures).toEqual({ resolved: 0, missing: 2, unknown: 0 });
  });

  it('flags a value whose price is past the age the chain accepts', async () => {
    const ctx = built({ prices: priced({ ageSeconds: 900, maxAgeSeconds: 300 }) });
    const model = fake(
      said(
        `It is worth ${ref(`holding:${stock.id}:value`)} at ${ref(`price:${stock.id}`)}, with ${ref('vault:value')} in all; you hold ${ref(`holding:${stock.id}:amount`)}.`,
      ),
    );
    const out = served(await replyToVaultConversation(request(), ctx, model));
    const stale = Object.fromEntries(
      (out.reply.figures?.facts ?? []).map((fact) => [
        fact.id,
        fact.value === null ? undefined : fact.staleAgeSec,
      ]),
    );
    expect(stale).toEqual({
      [`holding:${stock.id}:value`]: 900,
      [`price:${stock.id}`]: 900,
      'vault:value': 900,
      [`holding:${stock.id}:amount`]: null,
    });
  });
});

describe('what the model is sent', () => {
  const sent = async (ctx: ReturnType<typeof built>) => {
    const model = fake(said('Hello.'));
    await replyToVaultConversation(request(), ctx, model);
    return vaultAgentContent(vi.mocked(model.read).mock.calls[0]?.[1] as VaultAgentPrompt);
  };

  it('tells the model, in the constant instruction, to state a figure only by reference', () => {
    expect(VAULT_AGENT_SYSTEM).toContain('{{fact:<id>}}');
    expect(VAULT_AGENT_SYSTEM).toContain('never type the number');
    expect(VAULT_AGENT_SYSTEM).toContain('Do not add, subtract');
    expect(VAULT_AGENT_SYSTEM).toContain('When kind is new_goal, write no reference');
  });

  it('keeps the cached blocks byte-identical across two people: their vault figures come after', async () => {
    const one = await sent(built());
    const other = await sent(
      built({
        person: 'another-owner',
        state: {
          ...state,
          address: stock.address,
          observedAt: '2026-10-08T09:30:00.000Z',
          cash: { ...state.cash, raw: '77000000', display: '77' },
          positions: state.positions.map((position) => ({
            ...position,
            display: '3',
            targetBps: 6000,
          })),
        },
        prices: priced({ usdPerToken: '311', fetchedAt: '2026-10-08T09:29:00.000Z' }),
      }),
    );
    expect(one).toHaveLength(3);
    expect(other[0]).toEqual(one[0]);
    expect(other[1]).toEqual(one[1]);
    expect(other[0]?.text).toBe(one[0]?.text);
    expect(other[1]?.text).toBe(one[1]?.text);
    for (const block of [one[0], one[1]]) {
      expect(block?.text).not.toContain('holding:');
      expect(block?.text).not.toContain('vault:value');
      expect(block?.text).not.toContain('price:');
    }
    expect(one[2]?.text).toContain(`holding:${stock.id}:value`);
    expect(other[2]?.text).not.toBe(one[2]?.text);
  });
});

// The review of #216: every input here was served with a pin before the fix.
describe('a reference stands alone, as the figure it is', () => {
  const tesla = assets.find((asset) => asset.id === 'solana:tslax');
  const fund = assets.find((asset) => asset.id === 'solana:spyx');
  if (!tesla || !fund) throw new Error('Incomplete offline catalog fixture');
  const yielded = `yield:${reserve.id}:0:quoted`;
  const ctx = () => {
    const base = built({
      analytics: sheet({
        assets: [
          {
            assetId: stock.id,
            modelledOn: null,
            figures: [
              { metric: 'exit_worst', regime: 'us_offhours_weekday', value: 0.004, ...pin },
              { metric: 'volatility', value: 0.35, ...pin },
              { metric: 'drawdown', value: 0.35, ...pin },
            ],
          },
        ],
      }),
      prepared: {
        shelf,
        figures: {
          yields: [
            {
              assetId: reserve.id,
              quotedYield: 0.05,
              haircutYield: 0.04,
              source: 'offline yield fixture',
              method: 'fixture',
              fetchedAt: now,
              provenance: 'mock',
            },
          ],
        },
      } as Built['prepared'],
    });
    // a listed fund whose registered name holds digits
    return {
      ...base,
      stockAttributes: {
        stocks: [{ symbol: fund.symbol, company: 'SPDR S&P 500 ETF Trust', sources: [] }],
      },
    } as unknown as typeof base;
  };
  const A = ref(`holding:${stock.id}:amount`);
  const S = ref(`holding:${stock.id}:share`);
  const V = ref(`holding:${stock.id}:value`);
  const W = ref('vault:value');
  const Y = ref(yielded);
  const X = ref(exit);
  const sym = stock.symbol;
  const reply = async (
    sentence: string,
    person = 'What is it worth?',
    language: 'en' | 'pt' = 'en',
  ) => {
    const model = fake(said(`${sentence} A reserve helps.`));
    const out = served(await replyToVaultConversation(request(person, language), ctx(), model));
    return out.reply.message;
  };
  const CUT = `A reserve helps.\n${FIGURE_CUT}`;

  it.each([
    // inside quotation marks: a quote is the person's words, and a figure is never theirs
    [`You said “${A}70% in ${sym}”.`, `I want 70% in ${sym}`],
    [`You said “I want${A}70% in ${sym}”.`, `I want 70% in ${sym}`],
    [`You said “${W}”.`, `{{fact:vault:value}}`],
    [`You asked: "${W}".`, 'x'],
    [`It is «${W}».`, 'x'],
    // inside or touching a catalog name that holds digits
    [`It tracks the SPDR S&P${A}500 ETF Trust.`, 'x'],
    [`It tracks the SPDR S&P ${A} 500 ETF Trust.`, 'x'],
    [`You hold ${A} SPDR S&P 500 ETF Trust.`, 'x'],
    [`The SPDR S&P 500 ETF Trust: ${A}.`, 'x'],
  ])('refuses a reference in a quote or at a name with digits: %s', async (sentence, person) => {
    expect(await reply(sentence, person)).toBe(CUT);
  });

  it.each([
    `Your vault is worth ${W}B.`,
    `Your holding is down -${V}.`,
    `Your holding is down - ${V}.`,
    `Your holding moved +${V}.`,
    `Worth ${A}e${A}.`,
    `You hold ${A}OO shares.`,
    `You hold ${A}x more.`,
    `You hold ${A}\u200bmillion.`,
    `You hold **${A}** tokens.`,
    `Worth ${A}**${A}.`,
    `It costs ${V}/day.`,
    `It costs ${V} /day.`,
    `You hold ${A}, ${A} tokens.`,
    `You hold ${A} ${A} tokens.`,
    `Between ${A}\u3164${A} tokens.`,
    `Between ${A} \u3164 ${A} tokens.`,
    `Worth ${A}.${A} tokens.`,
    `Worth ${A},${A} tokens.`,
    `It is ~${V} today.`,
    `It is #${A} today.`,
    `It is ${A}th today.`,
    `Worth \uff5b\uff5bfact:vault:value\uff5d\uff5d today.`,
  ])('refuses a reference something touches, or two with no word between: %s', async (sentence) => {
    expect(await reply(sentence)).toBe(CUT);
  });

  it.each([
    `You hold ${A} hundred shares.`,
    `You hold ${A} dozen shares.`,
    `Your vault is worth ${A} grand.`,
    `Your vault is worth ${W} bi.`,
    `Your vault is worth ${W} mi.`,
    `Your vault is worth ${W} (million).`,
    `Your vault is worth ${W}, million.`,
    `Your vault is worth ${W} k.`,
    `Seu cofre vale ${W} mil.`,
    `Seu cofre vale ${W} milhões.`,
    `Three thousand, like ${W}.`,
    `Weekend capacity is ${A} percent.`,
    `Weekend capacity is ${A} pp.`,
    `Weekend capacity is ${A} bp.`,
    `It is up to ${A} cents.`,
    `You hold ${A} dollars of it.`,
    `It could be ten ${W}.`,
    `It could be ${W} ten.`,
    // a multiplier, a fraction or arithmetic in words
    `A fifth of ${W} is in the stock.`,
    `Quadruple ${W} is possible.`,
    `Um quarto de ${W}.`,
    `About half of all ${W} is cash.`,
    `It is worth ${A} point ${A} tokens.`,
    `It is ${A} to the power of ${A}.`,
    `It is worth ${A} times that.`,
    `It is worth double: ${W}.`,
    `It is minus ${V}.`,
    `The sum is ${V} and ${W}.`,
  ])('cuts a sentence that scales a reference or works on it in words: %s', async (sentence) => {
    expect(await reply(sentence)).toBe(CUT);
  });

  it.each([
    `It should return about ${S} a year.`,
    `It pays ${S} APY.`,
    `It pays out ${S}.`,
    `You will earn ${V} per month.`,
    `You earn ${V} monthly.`,
    `${sym} fell ${S} last week.`,
    `Your holding lost ${V}.`,
    `Your holding is up ${S}.`,
    `Its yield is ${S}.`,
    `It grows ${S} annually.`,
    `It moves ${S} a year.`,
    `Rende ${S} ao ano.`,
    `O retorno é de ${S}.`,
    // a real yield, but promised
    `It will pay ${Y} a year.`,
    `You should earn ${Y}.`,
    `It always yields ${Y}.`,
    `Vai render ${Y} ao ano.`,
    `Renderá ${Y} ao ano.`,
    // a forecast, with any figure
    `Your vault will be worth ${W}.`,
    `It is expected to reach ${W}.`,
    `Seu cofre vai valer ${W}.`,
  ])(
    'cuts a rate, a return or a forecast pinned to a figure that is not one: %s',
    async (sentence) => {
      expect(await reply(sentence)).toBe(CUT);
    },
  );

  it.each([
    [`${tesla.symbol} trades at ${ref(`price:${stock.id}`)}.`],
    [`Your ${tesla.symbol} is worth ${V}.`],
  ])(
    'cuts a sentence that names one asset and references another\u2019s figure: %s',
    async (sentence) => {
      expect(await reply(sentence)).toBe(CUT);
    },
  );

  it.each([
    [`Selling it all today would cost about ${X}.`, 'Selling it all today would cost about 0.4%.'],
    [
      `You hold ${A} tokens (${V}), which is ${S} of the vault.`,
      'You hold 10 tokens ($1,000.00), which is 50% of the vault.',
    ],
    [`Its value: ${V}; the vault's: ${W}.`, "Its value: $1,000.00; the vault's: $2,000.00."],
    [
      `Its quoted yield is ${Y} a year, measured from past rates.`,
      'Its quoted yield is 5% a year, measured from past rates.',
    ],
    [
      `Its annualised volatility is ${ref(`vol:${stock.id}`)}.`,
      'Its annualised volatility is 35%.',
    ],
    [
      `Its largest fall so far was ${ref(`drawdown:${stock.id}`)}.`,
      'Its largest fall so far was 35%.',
    ],
    [
      `Compared with ${tesla.symbol}, ${sym} costs ${X} to sell.`,
      `Compared with ${tesla.symbol}, ${sym} costs 0.4% to sell.`,
    ],
    [
      `${sym} is ${S} of the vault.\nIts price is ${ref(`price:${stock.id}`)}`,
      `${sym} is 50% of the vault.\nIts price is $100.00`,
    ],
    // marks that reorder or hide text are taken out of what is served
    [`Worth \u202e${V}\u202c today.`, 'Worth $1,000.00 today.'],
  ])('serves a reference that stands alone: %s', async (sentence, shown) => {
    const model = fake(said(`${sentence} A reserve helps.`));
    const out = served(await replyToVaultConversation(request(), ctx(), model));
    expect(model.read).toHaveBeenCalledTimes(1);
    expect(out.reply.message).toBe(`${shown} A reserve helps.`);
  });

  it('tells the model what was wrong on the repair call, by kind', async () => {
    const model = fake(said(`It pays ${S} APY. A reserve helps.`));
    await replyToVaultConversation(request(), ctx(), model);
    const problems = vi.mocked(model.read).mock.calls[1]?.[2]?.problems.join('\n') ?? '';
    expect(problems).toContain('a rate or a return');
  });
});

describe('a measured value that is not zero is never written as zero', () => {
  it.each([
    [0.004, 'USD', '$0.004', 'pelo menos US$ 0,004'],
    [0.00002, 'USD', '$0.00002', 'pelo menos US$ 0,00002'],
    [-0.004, 'USD', '-$0.004', 'pelo menos -US$ 0,004'],
    [0.0000004, 'fraction', '0.00004%', 'pelo menos 0,00004%'],
    [0.004, 'ratio', '0.004', 'pelo menos 0,004'],
    [0.0000001, 'units', '0.0000001', 'pelo menos 0,0000001'],
    [0.4, 'count', '0.4', 'pelo menos 0,4'],
    [0.01, 'hours', '0.01 hours', 'pelo menos 0,01 horas'],
    [0.0000001, 'bps', '0.0000001 bps', 'pelo menos 0,0000001 bps'],
    // a true zero stays one, and an ordinary value keeps its fixed format
    [0, 'USD', '$0.00', 'pelo menos US$ 0,00'],
    [0, 'fraction', '0%', 'pelo menos 0%'],
    [1234.5, 'USD', '$1,234.50', 'pelo menos US$ 1.234,50'],
  ])('%s %s', (value, unit, en, ptAtLeast) => {
    expect(figureText(value, unit, 'en')).toBe(en);
    expect(figureText(value, unit, 'en', true)).toBe(`at least ${en}`);
    expect(figureText(value, unit, 'pt', true)).toBe(ptAtLeast);
    if (value !== 0) expect(figureText(value, unit, 'en')).toMatch(/[1-9]/u);
  });

  it('serves dust and a small ratio with their digits', async () => {
    const ctx = built({
      prices: priced({ usdPerToken: '0.0004' }),
      analytics: sheet({
        assets: [
          {
            assetId: stock.id,
            modelledOn: null,
            figures: [
              { metric: 'cap_variation', value: 0.004, ...pin, unit: 'ratio' },
              { metric: 'exit_worst', regime: 'weekend', value: 0.0000004, ...pin },
            ],
          },
        ],
      }),
    });
    const model = fake(
      said(
        `Its price is ${ref(`price:${stock.id}`)} and your holding is worth ${ref(`holding:${stock.id}:value`)}. Its capacity varies by ${ref(`capvar:${stock.id}`)} between snapshots. Selling would cost about ${ref(exit)}.`,
      ),
    );
    const out = served(await replyToVaultConversation(request(), ctx, model));
    expect(out.reply.message).toBe(
      'Its price is $0.0004 and your holding is worth $0.004. Its capacity varies by 0.004 between snapshots. Selling would cost about 0.00004%.',
    );
  });

  it('says what the amount is: units of the underlying, the balance times its multiplier', () => {
    const amount = built().evidence.find((row) => row.id === `holding:${stock.id}:amount`);
    expect(amount).toMatchObject({ unit: 'units' });
    expect(amount?.label).toContain('underlying');
    expect(amount?.method).toContain('multiplier');
    expect(amount?.label).not.toContain('tokens');
  });
});

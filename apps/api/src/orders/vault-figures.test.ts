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
        // under the tradeoff about a fall, it names its own subject
        unknowns: [`${stock.symbol} weekend capacity is ${ref(`weekend:${stock.id}`)}.`],
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
      `${stock.symbol} weekend capacity is not measured (no samples in that regime yet).`,
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
      `${sym} is ${S} of the vault.\nIts price is ${ref(`price:${stock.id}`)}.`,
      `${sym} is 50% of the vault.\nIts price is $100.00.`,
    ],
    // emphasis marks around a reference are not served
    [`You hold **${A}** tokens.`, 'You hold 10 tokens.'],
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

// The second review of #216 (the re-check at 5b74904d): its probes, and its 24 natural answers.
describe('a figure is read with what stands around it', () => {
  const tesla = assets.find((asset) => asset.id === 'solana:tslax');
  if (!tesla) throw new Error('Incomplete offline catalog fixture');
  const position = (asset: typeof stock, units: bigint, targetBps: number) => ({
    asset: asset.id,
    raw: (units * 10n ** BigInt(asset.decimals)).toString(),
    display: units.toString(),
    multiplier: '1',
    targetBps,
    lastKeeperAt: null,
  });
  const figures = (exitCost: number) => [
    {
      metric: 'exit_worst' as const,
      regime: 'us_offhours_weekday' as const,
      value: exitCost,
      ...pin,
    },
    { metric: 'weekend' as const, value: null, reason: 'no_samples_in_regime' as const },
    { metric: 'volatility' as const, value: 0.35, ...pin },
    { metric: 'drawdown' as const, value: 0.4, ...pin },
  ];
  const ctx = () => {
    const base = buildVaultAgentContext({
      state: {
        ...state,
        positions: [
          position(stock, 10n, 3000),
          position(tesla, 5n, 3000),
          position(reserve, 500n, 2000),
        ],
      },
      entry: offline,
      prices: [cash, stock, tesla, reserve].map((asset) => ({
        asset: asset.id,
        usdPerToken: asset === stock ? '100' : asset === tesla ? '200' : '1',
        ageSeconds: 0,
        maxAgeSeconds: 300,
        market: 'open' as const,
        source: 'fixture',
        method: 'fixture',
        fetchedAt: '2026-10-07T19:59:00.000Z',
        provenance: 'mock' as const,
      })),
      prepared: {
        shelf,
        figures: {
          yields: [
            {
              assetId: reserve.id,
              quotedYield: 0.05,
              haircutYield: 0.04,
              source: 'y',
              method: 'fixture',
              fetchedAt: now,
              provenance: 'mock',
            },
          ],
        },
      } as Built['prepared'],
      person: 'p',
      currentGoals: [{ goal: 'grow' }],
      analytics: sheet({
        assets: [
          { assetId: stock.id, modelledOn: null, figures: figures(0.004) },
          { assetId: tesla.id, modelledOn: null, figures: figures(0.006) },
        ],
      }),
    });
    return {
      ...base,
      stockAttributes: {
        stocks: [
          { symbol: stock.symbol, company: 'NVIDIA Corporation', sources: [] },
          { symbol: tesla.symbol, company: 'Tesla, Inc.', sources: [] },
        ],
      },
    } as unknown as typeof base;
  };
  const F: Record<string, string> = {
    NV: ref(`holding:${stock.id}:value`),
    NA: ref(`holding:${stock.id}:amount`),
    NS: ref(`holding:${stock.id}:share`),
    NT: ref(`holding:${stock.id}:target`),
    NP: ref(`price:${stock.id}`),
    NX: ref(`exit:${stock.id}:worst`),
    TX: ref(`exit:${tesla.id}:worst`),
    TV: ref(`holding:${tesla.id}:value`),
    NW: ref(`weekend:${stock.id}`),
    ND: ref(`drawdown:${stock.id}`),
    TD: ref(`drawdown:${tesla.id}`),
    NVOL: ref(`vol:${stock.id}`),
    W: ref('vault:value'),
    CV: ref(`holding:${cash.id}:value`),
    CS: ref(`holding:${cash.id}:share`),
    Y: ref(`yield:${reserve.id}:0:quoted`),
    RV: ref(`holding:${reserve.id}:value`),
    RS: ref(`holding:${reserve.id}:share`),
    TS: ref(`holding:${tesla.id}:share`),
    YH: ref(`yield:${reserve.id}:0:haircut`),
  };
  const fill = (text: string) =>
    text.replace(/\[(\w+)\]/g, (whole, key: string) => F[key] ?? whole);
  const ask = async (reply: unknown) => {
    const model = fake(reply);
    const out = await replyToVaultConversation(request('Tell me about my vault.'), ctx(), model);
    return { out, calls: vi.mocked(model.read).mock.calls.length };
  };
  /** What is left of `sentence` when it is followed by a sentence that is always served. */
  const left = async (sentence: string) => {
    const { out } = await ask(said(`${fill(sentence)} A new line follows.`));
    return served(out).reply.message;
  };
  const CUT = `A new line follows.\n${FIGURE_CUT}`;

  it.each([
    'You can count on [Y] a year from the reserve.',
    'The reserve locks in [Y] a year.',
    'The reserve pays [Y] every year.',
    'The reserve pays [Y] a year, like clockwork.',
    'A steady [Y] a year comes from the reserve.',
    'The reserve reliably pays [Y] a year.',
    'You get [Y] a year from the reserve, no matter what.',
    'The reserve pays a fixed [Y] a year.',
    'Your money earns [Y] a year in the reserve, with no risk of loss.',
    'The reserve pays [Y] a year for as long as you hold it.',
    'Put it in the reserve and collect [Y] a year.',
    'The reserve can not pay less than [Y] a year.',
    'Next year the reserve pays [Y] again.',
    'You get at least [Y] from the reserve.',
    'You are sure to get [Y] from it.',
    'The reserve gives you [Y] each and every time.',
    'The reserve earns [Y] a year on top of [NV] you hold in Nvidia.',
    // framed as a measurement, and still a promise
    'The quoted yield of [Y] a year is one you can count on.',
    'The current yield, [Y] a year, is locked in.',
    'Its measured yield is a steady [Y] a year.',
    'The quoted yield is [Y] now and at least that next year.',
    'O rendimento cotado de [Y] ao ano é garantido.',
  ])('cuts a yield that is not said as a measurement, or is promised: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  it.each([
    [
      'Its quoted yield is [Y] a year, measured from past rates.',
      'Its quoted yield is 5% a year, measured from past rates.',
    ],
    ['The reserve’s quoted yield is [Y] a year.', 'The reserve’s quoted yield is 5% a year.'],
    ['Its yield at the last reading was [Y].', 'Its yield at the last reading was 5%.'],
    ['The reserve currently yields [Y] a year.', 'The reserve currently yields 5% a year.'],
    ['So far the reserve has paid [Y] a year.', 'So far the reserve has paid 5% a year.'],
  ])('serves a yield said as a measurement: %s', async (sentence, shown) => {
    expect(await left(sentence)).toBe(`${shown} A new line follows.`);
  });

  it.each([
    'What does Nvidia return in a year? About [NS] of it is yours to keep.',
    'Expected yearly return on Nvidia. It comes to [NS] or so.',
    'Nvidia will keep rising. Think of it as [NS] here.',
    'Nvidia returns a lot… [NS] to be exact.',
    'Nvidia returns, e.g. [NS].',
    'Nvidia annual return (approx. [NS]) is strong.',
    'Nvidia grows every year by about\n\n[NS]\n\nand that is a lot.',
    'Nvidia return, year after year: about [NS].',
    'Yearly return on Nvidia:\n- [NS] is the figure.',
    'Tesla is volatile. It trades at [NP].',
  ])('reads the words of the sentence before a reference too: %s', async (sentence) => {
    const shown = await left(sentence);
    expect(shown).not.toMatch(/\d/u);
    expect(shown).toContain(FIGURE_CUT);
  });

  it.each(['About [NS].', 'Think [NS].', '[NS].', 'USDC: [NV].', 'Nvidia. [NS].'])(
    'cuts a reference with too few words of its own to say what it is: %s',
    async (sentence) => {
      const shown = await left(`Something about your vault. ${sentence}`);
      expect(shown).not.toMatch(/\d/u);
      expect(shown).toContain(FIGURE_CUT);
    },
  );

  it('reads fields that are shown together as one: a heading and the figure under it', async () => {
    const { out, calls } = await ask({
      message: 'Here is the plan.',
      question: null,
      proposal: {
        objective: 'Expected return per year:',
        summary: fill('It stands at [NS] of the whole.'),
        allocations: [
          { assetId: stock.id, why: fill('Nvidia. [NS].'), evidenceIds: [`price:${stock.id}`] },
        ],
        stated: [],
        tradeoffs: ['Yearly return on Nvidia you can count on:', fill('It is [NS] of the vault.')],
        unknowns: [],
      },
    });
    expect(calls).toBe(2);
    const proposal = served(out).reply.proposal;
    expect(
      JSON.stringify([proposal?.summary, proposal?.tradeoffs, proposal?.allocations]),
    ).not.toMatch(/28\.57%/u);
    expect(proposal?.objective).toBe('Expected return per year:');
    // the question is shown under the message
    const asked = await ask({
      message: 'What does Nvidia return in a year?',
      question: fill('Is [NS] of the vault enough for you?'),
      proposal: null,
    });
    expect(served(asked.out).reply.question).toBeNull();
  });

  it.each([
    'You make [NV] each on Nvidia.',
    'You stand to make [NV] on Nvidia.',
    'Nvidia made you [NV] so far.',
    'Nvidia is [NV] in the red.',
    'Nvidia is [NV] in the black.',
    'Nvidia is [NV] above what you put in.',
    'Nvidia is [NS] overvalued.',
    'Nvidia is [NS] undervalued.',
    'Nvidia has a [NS] chance of beating the market.',
    'The odds are [NS] for Nvidia.',
    'Its probability is [NS] for Nvidia.',
    'Your money is [NS] safe in Nvidia.',
    'Nvidia beats the market by [NS] in a typical twelvemonth.',
    'You owe [NV] in tax on Nvidia.',
    'The fee on Nvidia is [NS] of what you hold.',
    'Nvidia is worth less than [NV] today.',
    'Nvidia is worth more than [NV] today.',
    'You earned [NV] on Nvidia.',
    'Your profit on Nvidia is [NV].',
    'Nvidia vale [NV] millones.',
    'Nvidia holds [NA] Mio units.',
    'Nvidia holds [NA] lakh units.',
    'Nvidia holds [NA] crore units.',
  ])('cuts a claim the figure does not measure: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  it.each([
    'Nvidia re͏turns about [NS] a ye͏ar.',
    'Nvidia holds [NA] mil͏lion units.',
    'Nvidia holds [NA] mil️lion units.',
    'Nvidia rеturns about [NS] a yеar.',
    'Nvidia holds [NA] miᅠllion units.',
    'Nvidia holds [NA] mіllion units.',
    'Nvidia holds [NA] μnits today.',
  ])('cuts a referenced sentence with a hidden or a look-alike letter: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  it.each([
    ['Tesla trades at [NP].'],
    ['Your gold is worth [NV].'],
    ['Your biggest stock is Tesla, worth [NV].'],
    ['Your cash is worth [NV].'],
    ['The reserve is worth [NV].'],
    ['Nvidia is up [NS] today.'],
    ['Nvidia went down and is now [NS] of the vault.'],
    ['Nvidia is down [NS] today.'],
    ['Nvidia, [NS] up on the day, leads.'],
    ['Its high-yield days pay [NS] to you.'],
    ['Nvidia fell, and its annualised volatility is [NVOL].'],
    ['Tesla’s largest drawdown was [TD], and Nvidia’s annualised volatility is [NVOL].'],
  ])('still cuts what the relaxed rules must not let through: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  // The reviewer's 24 natural answers to the five questions of the description: 17 were served whole,
  // 5 trimmed and 2 emptied. Each is served whole.
  it.each([
    'Your Nvidia holding is worth [NV] right now. That is [NA] units at a reference price of [NP] each.',
    'Your Nvidia is worth about [NV] at the current reference price.',
    'You hold [NA] NVDAx, worth [NV] at today’s reference price. That’s about [NS] of your vault.',
    'Selling all of your Nvidia today would cost about [NX] in the worst measured conditions.',
    'Selling everything at once would cost roughly [NX] for Nvidia and [TX] for Tesla, based on the worst regime Bearing has measured. Your dollar-yield reserve and cash have no measured exit cost.',
    'About [CS] of your vault is cash, which is [CV] in USDC.',
    'Cash makes up [CS] of your vault ([CV]). The rest is split between Nvidia, Tesla and the reserve.',
    'Weekend exit capacity for Nvidia is [NW], so I can’t tell you how it compares to weekdays yet.',
    'There are no weekend samples for NVDAx yet, so that figure is unknown rather than zero.',
    'I can’t rank them for you, but here are the measured figures: selling Nvidia would cost about [NX], and selling Tesla about [TX]. Both are worst-case measurements.',
    'Nvidia’s measured exit cost is [NX] and Tesla’s is [TX], so you can compare them directly.',
    'Your vault is worth [W] in total. Nvidia is [NV], Tesla is [TV], the reserve is [RV] and cash is [CV].',
    'Your vault is worth [W]. Nvidia is the largest stock position at [NS], against a target of [NT].',
    'Nvidia is currently [NS] of your vault, and its target is [NT], so it is close to where you set it.',
    'The reserve’s quoted yield is [Y] a year. That is a past observation, not a promise.',
    'Nvidia’s largest measured drawdown was [ND], and its annualised volatility is [NVOL]. It can move a lot.',
    'Nvidia has dropped as much as [ND] in the past, which gives you a sense of the downside.',
    'At the current price of [NP], your [NA] units of Nvidia come to [NV].',
    'Right now Nvidia trades at [NP]. You hold [NA] units, for a total value of [NV].',
    'Your Nvidia position: **[NV]** ([NS] of the vault).',
    'Your dollar-yield reserve is worth [RV].',
    'If you sold it all today, the cost would be about [NX] of the amount sold. That is the worst case measured; it would likely be lower during market hours.',
    'Your Nvidia holding is up to date as of the last read: [NV]. I don’t have a figure for how much it has gained since you bought it.',
    'Tesla would cost about [TX] to sell and Nvidia about [NX]. I can’t say which is cheaper, but both figures are measured at the reference size.',
  ])('serves a natural answer whole: %s', async (answer) => {
    const { out, calls } = await ask(said(fill(answer)));
    expect(calls).toBe(1);
    const message = served(out).reply.message;
    expect(message).not.toContain(FIGURE_CUT);
    expect(message).not.toMatch(/[{}*]/u);
  });

  it('serves a reference the model set in bold without the marks', async () => {
    const { out } = await ask(
      said(fill('Your Nvidia position: **[NV]** and __[NS]__ of the vault.')),
    );
    expect(served(out).reply.message).toBe(
      'Your Nvidia position: $1,000.00 and 28.57% of the vault.',
    );
    expect(served(out).reply.figures?.prose.message).toBe(
      fill('Your Nvidia position: [NV] and [NS] of the vault.'),
    );
  });

  // The review of #227.
  /** The served message of a reply that is `text` alone, or the code it was refused with. */
  const shown = async (text: string) => {
    const { out } = await ask(said(fill(text)));
    return out.kind === 'reply' ? out.reply.message : `refused: ${out.detail}`;
  };

  it.each([
    'Its quoted yield is [Y] a year. Nvidia: about [NS] too.',
    'Its quoted yield is [Y] a year. Nvidia about [NS] as well.',
    'Its quoted yield is [Y] a year. For Nvidia it is [NS].',
    'Its quoted yield is [Y] a year. Nvidia does [NS].',
    'Its quoted yield is [Y] a year. Nvidia comes in at [NS], Tesla at [TS].',
    'Nvidia’s largest measured drawdown was [ND]. Tesla: about [TS] too.',
    'Nvidia’s annualised volatility is [NVOL]. Tesla: about [TS] too.',
    'What does Nvidia return in a year? Good question. About [NS], roughly speaking.',
    'Yearly return on Nvidia.\n\nHere it is.\n\nAbout [NS] by my read.',
  ])('does not let a share read as the rate of the sentence before: %s', async (text) => {
    expect(await shown(text)).not.toContain('28.57%');
  });

  it.each([
    'Its quoted yield is [Y] a year. Your reserve is worth [RV].',
    'Nvidia’s largest measured drawdown was [ND]. Nvidia is worth [NV].',
    'Your goal is to grow this money. Right now Nvidia is worth [NV].',
    'You told me you want growth. Nvidia is [NS] of your vault today.',
    'I can’t predict returns. What I can say is that your vault is worth [W] today.',
    'Nobody can promise a return. Your vault is worth [W] right now.',
    'Stocks can fall a lot. Nvidia is [NS] of your vault.',
    'Here’s the breakdown:\n- Nvidia: [NV]\n- Tesla: [TV]\n- Reserve: [RV]\n- Cash: [CV]\n\nAltogether the vault is worth [W].',
    'Your Nvidia position is worth [NV] at the latest reference price of [NP] per unit. That makes it [NS] of the vault, against a target of [NT].',
    'Nvidia and Tesla make up [NS] and [TS] of the vault.',
    'Your Nvidia \u2014 worth [NV] \u2014 is your largest stock.',
    'The reserve has a quoted yield of [Y] a year. Nvidia is [NS] of your vault.',
    '⚠️ Selling Nvidia would cost about [NX].',
    'Good news ❤️. Your vault is worth [W].',
    'You have [CV] in cash — that’s [CS] of the vault.',
    'Selling everything today wouldn’t be free. In the worst conditions Bearing has measured, Nvidia would cost about [NX] of the amount sold and Tesla about [TX]. There’s no measured exit cost for the reserve or for cash.',
    'I don’t have weekend figures for Nvidia yet: its weekend capacity is [NW]. On weekdays, the worst measured exit cost is [NX].',
    'The reserve is the steadier part of your vault. It’s worth [RV], and its quoted yield is currently [Y] a year. That’s a measured rate, not a promise.',
    'Tesla is the more expensive one to sell: about [TX] in the worst measured regime, compared with [NX] for Nvidia. Both figures are for the reference size, not your exact amount.',
  ])(
    'serves whole a value that says what it is, whatever the sentence before: %s',
    async (text) => {
      const message = await shown(text);
      expect(message).not.toContain(FIGURE_CUT);
      expect(message).not.toMatch(/^refused|[{}]/u);
    },
  );

  it.each([
    'Nvidia is a high-yield holding at [NS].',
    'Nvidia is yield-bearing at [NS].',
    'Nvidia has a dollar-yield of [NS].',
    'The yield-to-date on Nvidia is [NS].',
    'Your dollar-yield reserve yields [RS].',
    'Nvidia is down to [NV].',
    'Nvidia went down to [NV].',
    'Nvidia shot up to [NV].',
    'Nvidia is now down to [NS] of the vault.',
    'Nvidia: up a solid [NS].',
    'Nvidia has been heading up, by [NS].',
    'Nvidia is way up: [NV] now.',
    'Nvidia climbed [NS] this week.',
    'Nvidia sank [NS].',
    'Nvidia rallied [NS].',
    'Nvidia is [NV] cheaper than before.',
    'Nvidia is [NS] higher than last week.',
    'Nvidia rinde [NS] al año.',
    'Nvidia rapporte [NS] par an.',
    'You make [NV] each on Nvidia.',
    'Nvidia, year after year, makes about [NS].',
    'Roughly [NV], give or take.',
    'About [NS], roughly speaking, I would say.',
  ])('cuts what the last round let back in: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  it.each([
    'Its current yield of [Y] is yours every year.',
    'Measured at [Y], and that is what you will get.',
    'So far it has paid [Y] and it keeps paying.',
    'Currently [Y], risk-free.',
    'Its current yield is [Y], and you get that.',
    'Its current yield is [Y], yours to keep.',
    'You earn the current [Y] a year on your reserve.',
    'The past is the past: from now on the reserve pays [Y] a year.',
    'Its quoted yield is [Y] a year, and that holds going forward.',
    'The current yield is [Y] a year, and it is here to stay.',
    'Quoted at [Y] a year, and you can bank on it.',
    'The current [Y] a year is what you take home.',
    'Unlike past rates, [Y] a year is what the reserve pays from here.',
    'Currently [Y] a year, for life.',
    'At the current [Y] a year you are set for retirement.',
    'The reserve currently pays you [Y] a year on every dollar.',
    'Its quoted yield is [Y] a year, forever.',
    'Its quoted yield is [Y] a year, come rain or shine.',
    'Its quoted yield is [Y] a year, and it does not change.',
    'Its quoted yield is [Y] a year, and nothing can take that away.',
    'Its quoted yield is [Y] a year, with zero downside.',
    'Its quoted yield is [Y] a year, and your money is protected.',
    'Its quoted yield is [Y] a year, without fail.',
    'Its quoted yield is [Y] a year, so you may rely on it.',
    'Its quoted yield is [Y] a year, and you can depend on that.',
    'Its quoted yield is [Y] a year, sem risco.',
    'O rendimento atual é [Y] ao ano, e isso não muda.',
    'Rende [Y] ao ano atualmente, sem risco.',
    'O rendimento cotado é [Y] ao ano, livre de risco.',
    'O rendimento cotado é [Y] ao ano, e pode contar com isso.',
    'O rendimento cotado é [Y] ao ano, todo ano.',
    'O rendimento cotado é [Y] ao ano, para sempre.',
    'The reserve yields [Y] a year.',
    'Right now the reserve yields about [Y] a year, and more to come.',
    'Its quoted yield is [Y] a year and Nvidia is [NS] of the vault.',
  ])('cuts a yield whose sentence is more than the measurement: %s', async (sentence) => {
    expect(await left(sentence)).toBe(CUT);
  });

  it.each([
    ['Its quoted yield is [Y] a year. You may rely on it.'],
    ['You can rely on it. Its quoted yield is [Y] a year.'],
  ])('cuts a yield promised by the sentence beside it: %s', async (text) => {
    expect(await shown(text)).not.toContain('5%');
  });

  it.each([
    ['The reserve’s quoted yield is [Y] a year.', 'The reserve’s quoted yield is 5% a year.'],
    ['Its quoted yield is [Y].', 'Its quoted yield is 5%.'],
    [
      'The quoted yield of the reserve is [Y] a year.',
      'The quoted yield of the reserve is 5% a year.',
    ],
    ['The reserve’s yield is [Y] a year right now.', 'The reserve’s yield is 5% a year right now.'],
    [
      'The reserve’s yield is [Y] a year, based on the latest quote.',
      'The reserve’s yield is 5% a year, based on the latest quote.',
    ],
    ['Its yield is currently [Y] a year.', 'Its yield is currently 5% a year.'],
    [
      'The reserve currently yields about [Y] a year.',
      'The reserve currently yields about 5% a year.',
    ],
    ['Right now the reserve yields [Y] a year.', 'Right now the reserve yields 5% a year.'],
    [
      'Its measured yield was [Y] a year, measured from past rates.',
      'Its measured yield was 5% a year, measured from past rates.',
    ],
    ['O rendimento cotado é [Y] ao ano.', 'O rendimento cotado é 5% ao ano.'],
    [
      'A reserva rende [Y] ao ano, segundo a última cotação.',
      'A reserva rende 5% ao ano, segundo a última cotação.',
    ],
    [
      'After the haircut its quoted yield is [YH] a year.',
      'After the haircut its quoted yield is 4% a year.',
    ],
  ])(
    'serves a yield whose sentence is the measurement and nothing more: %s',
    async (sentence, expected) => {
      expect(await left(sentence)).toBe(`${expected} A new line follows.`);
    },
  );

  // The re-check of #227.
  it.each([
    ['What will you earn in a year? In all, [W].', '3,500'],
    ['What does Nvidia return in a year? A share of about [NS].', '28.57%'],
    ['Next year’s gain on Nvidia. Target: [NT].', '30%'],
    ['What does it pay a year? Total: [W].', '3,500'],
    ['Quanto rende ao ano? No total, [W].', '3,500'],
    ['Yearly return you can count on. It is [NS] of the vault.', '28.57%'],
    ['Your cut of the gains each year. A portion of [NS].', '28.57%'],
    ['What is the yearly profit? The amount is [NA].', '10'],
    ['How much does it pay a year? The cost is [NX].', '0.4%'],
    ['What will it return in a year?\n\nWorth [NV].', '1,000'],
    ['Its quoted yield is [Y] a year. It is [RS] of your vault.', '14.29%'],
  ])(
    'reads a sentence with no subject of its own with the one before: %s',
    async (text, figure) => {
      expect(await shown(text)).not.toContain(figure);
    },
  );

  it.each([
    'Yearly return on Nvidia. Nvidia is [NS] of the vault.',
    'What will you earn in a year? The vault is worth [W].',
    'How much will Nvidia gain this year? Nvidia’s target is [NT].',
  ])('lets a sentence that names its kind and its subject stand: %s', async (text) => {
    const message = await shown(text);
    expect(message).not.toContain(FIGURE_CUT);
    expect(message).not.toMatch(/^refused/u);
  });

  it.each([
    'Its current yield is [Y] a year from tomorrow.',
    'Its current yield is [Y] a year from January.',
    'Its quoted yield is [Y] a year for decades.',
    'Its quoted yield is [Y] a year for ever.',
    'Its quoted yield is [Y] a year for eternity.',
    'Its current yield is [Y] a year for you.',
    'Its current yield is [Y] a year of profit.',
    'Its current yield is [Y] a year on autopilot.',
    'Its current yield is [Y] a year for free.',
    'The current rate of return is [Y] a year.',
    'The current yield of waiting is [Y] a year.',
    'The current yield on your money is [Y] a year.',
    'The current rate for you is [Y] a year.',
    'The latest yield for holders is now [Y] a year right now at the last reading for everyone.',
    'Your current yield is [Y] a year.',
    'Your current rate is now about [Y] a year.',
    'Its current yield is [Y] a month.',
    'A taxa atual é de [Y] ao mês.',
    'O rendimento atual do seu-dinheiro é [Y] ao ano.',
    // any word as the subject
    'Tenonfi now pays [Y] a year.',
    'Bearing now pays [Y] a year.',
    'Saving now pays [Y] a year.',
    'Patience now pays [Y] a year.',
    'Everyone now pays [Y] a year.',
    'Money now pays [Y] a year.',
    'Now, retirement pays [Y] a year.',
    'Risklessly pays [Y] a year now.',
    'Hoje, tudo rende [Y] ao ano.',
    'Agora poupar paga [Y] ao ano.',
    'This now pays [Y] a month.',
    // free text beside the clause
    'There is no way to lose, and its current yield is [Y] a year.',
    'It never goes down, and its quoted yield is currently [Y] a year.',
    'This is free money: its current rate is [Y] a year.',
    'Your money is insured, and its current yield is [Y] a year.',
    'You can retire on it, and its quoted yield is currently [Y] a year.',
    'Year after year without exception: its current yield is [Y] a year.',
    'Yours to enjoy in perpetuity: its current yield is [Y] a year.',
    'Sit back and relax: the reserve now pays [Y] a year.',
    'It is the smart choice, and its current yield is [Y] a year.',
    'The reserve is the steadier part of your vault, and its quoted yield is currently [Y] a year.',
    'Você não perde nada, e a reserva hoje rende [Y] ao ano.',
    'Fique tranquilo: o rendimento atual é [Y] ao ano.',
    'Dinheiro fácil: a reserva hoje rende [Y] ao ano.',
  ])(
    'cuts a yield clause with a word after the figure, a stranger as its subject, or free text beside it: %s',
    async (sentence) => {
      expect(await left(sentence)).toBe(CUT);
    },
  );

  it.each([
    ['The reserve now pays [Y] a year.', 'The reserve now pays 5% a year.'],
    ['It pays [Y] a year now.', 'It pays 5% a year now.'],
    [
      `${reserve.symbol} currently yields [Y] a year.`,
      `${reserve.symbol} currently yields 5% a year.`,
    ],
    [
      `The current yield of ${reserve.symbol} is [Y] a year.`,
      `The current yield of ${reserve.symbol} is 5% a year.`,
    ],
    [
      'The quoted yield on the reserve is [Y] a year.',
      'The quoted yield on the reserve is 5% a year.',
    ],
    [
      'O rendimento atual da reserva é de cerca de [Y] ao ano.',
      'O rendimento atual da reserva é de cerca de 5% ao ano.',
    ],
    [
      'It’s worth [RV], and its quoted yield is currently [Y] a year.',
      'It’s worth $500.00, and its quoted yield is currently 5% a year.',
    ],
    [
      'Its current rate is now about [Y] a year at the last reading.',
      'Its current rate is now about 5% a year at the last reading.',
    ],
  ])('still serves the measurement itself: %s', async (sentence, expected) => {
    expect(await left(sentence)).toBe(`${expected} A new line follows.`);
  });

  it('reads every field with the one shown above it', async () => {
    const plan = (over: Record<string, unknown>, message = 'Here is the plan.') =>
      ask({
        message,
        question: null,
        proposal: {
          objective: 'Keep the vault as it is.',
          summary: 'No change.',
          allocations: [
            {
              assetId: stock.id,
              why: 'A stock you asked for.',
              evidenceIds: [`price:${stock.id}`],
            },
          ],
          stated: [],
          tradeoffs: [],
          unknowns: [],
          ...over,
        },
      });
    const why = (text: string) => [
      { assetId: stock.id, why: fill(text), evidenceIds: [`price:${stock.id}`] },
    ];
    const told = (result: Awaited<ReturnType<typeof plan>>) =>
      JSON.stringify(served(result.out).reply.proposal);
    // a pick's reason under the summary, the objective under the message, the first tradeoff under
    // the summary, the first unknown under the last tradeoff
    for (const result of [
      await plan({
        summary: 'Expected yearly return of each pick, as a forecast:',
        allocations: why('Nvidia about [NS].'),
      }),
      await plan({ objective: fill('Nvidia about [NS].') }, 'What will Nvidia return a year?'),
      await plan({
        summary: 'Expected yearly returns follow.',
        tradeoffs: [fill('Nvidia about [NS].')],
      }),
      await plan({
        tradeoffs: ['Expected yearly return on Nvidia:'],
        unknowns: [fill('Nvidia about [NS].')],
      }),
    ])
      expect(told(result)).not.toContain('28.57%');
    // and what the product's own goal words must not cost
    for (const result of [
      await plan({
        objective: 'Grow the money over the years.',
        summary: fill('Nvidia stays at [NT] of the vault.'),
      }),
      await plan({
        objective: 'Keep a steady income from the vault.',
        summary: fill('The reserve stays at [RS] of the vault.'),
      }),
      await plan({
        tradeoffs: [
          'Stocks can fall a lot in a bad month.',
          fill('Nvidia is [NS] of the vault, above its target of [NT].'),
        ],
      }),
    ]) {
      expect(result.calls).toBe(1);
      expect(told(result)).not.toContain('left out');
    }
    const asked = await ask({
      message: 'I can’t promise any return on it.',
      question: fill('Do you want to keep Nvidia at its target of [NT]?'),
      proposal: null,
    });
    expect(served(asked.out).reply.question).toBe(
      'Do you want to keep Nvidia at its target of 30%?',
    );
  });
});

import { VaultAgentReply, type VaultState } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { VAULT_AGENT_SYSTEM, type VaultAgentModel } from '../vault-agent-model';
import { replyToVaultConversation, type VaultAgentContext } from './vault-agent';

// Which stocks the person asked for, read from their own words (gate ANY-COMPOSITION). Offline model
// replies are fixtures. No model, node, database, order builder, or allocator is called.
const shelf = launchShelf();
const assets = shelf.assets.filter((asset) => asset.chain === 'solana');
const cash = assets.find((asset) => asset.cls === 'cash');
const stock = assets.find((asset) => asset.cls === 'stock');
const reserves = assets.filter((asset) => asset.cls === 'dollar_yield');
const reserve = reserves[0];
const otherReserve = reserves[1];
if (!cash || !stock || !reserve || !otherReserve)
  throw new Error('Incomplete offline catalog fixture');
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
      raw: '10000000',
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
const context: VaultAgentContext = {
  person: 'owner-fixture',
  state,
  assets,
  currentGoals: [{ goal: 'grow', objective: 'Keep a liquid cushion while seeking growth' }],
  evidence: [stock, reserve, otherReserve].map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog',
    method: 'listed assets',
    fetchedAt: now,
    provenance: 'mock',
  })),
  stockAttributes: null,
  liquidity: [],
  unknowns: ['Measured exit cost is unavailable for this preview.'],
};
const proposal = () => ({
  message: 'Here is a possible direction for your vault. This is a preview for discussion.',
  question: null,
  proposal: {
    objective: 'Seek growth while keeping a liquid cushion',
    summary: 'Increase exposure to the named stock and retain a reserve.',
    allocations: [
      {
        assetId: stock.id,
        why: 'This expresses your stated stock preference.',
        evidenceIds: [`catalog:${stock.id}`],
      },
      {
        assetId: reserve.id,
        why: 'This reserve diversifies the proposed holdings.',
        evidenceIds: [`catalog:${reserve.id}`],
      },
      {
        assetId: otherReserve.id,
        why: 'This retains exposure outside the named stock.',
        evidenceIds: [`catalog:${otherReserve.id}`],
      },
    ],
    stated: [],
    tradeoffs: ['Stock concentration can increase losses.'],
    unknowns: ['The future price path is unknown.'],
  },
});
const fake = (reply: unknown): VaultAgentModel => ({ read: vi.fn(async () => ({ reply })) });

const symbol = (ticker: string) => {
  const asset = assets.find((candidate) => candidate.underlying === ticker);
  if (!asset) throw new Error(`No ${ticker} in the offline catalog`);
  return asset.id;
};
const STOCKS = 'every listed stock';
type Turn = string | ['app' | 'person', string];
async function read(
  goal: 'income' | 'protect',
  turns: Turn[],
  language: 'en' | 'pt' = 'en',
  extra: Partial<VaultAgentContext> = {},
) {
  const model = fake(proposal());
  const messages = turns.map((turn) =>
    Array.isArray(turn) ? { who: turn[0], text: turn[1] } : { who: 'person' as const, text: turn },
  );
  const out = await replyToVaultConversation(
    { version: 1, language, messageId: 'turn', messages },
    { ...context, currentGoals: [{ goal }], ...extra },
    model,
  );
  const sent = vi.mocked(model.read).mock.calls[0]?.[1];
  return { out, requested: sent?.requestedOutsideGoal ?? [] };
}
const stocks = assets
  .filter((asset) => asset.cls === 'stock' || asset.cls === 'etf')
  .map((asset) => asset.id);

describe('a refusal, a question, a withdrawal or an everyday word is not a request', () => {
  it.each<['income' | 'protect', Turn[], ('en' | 'pt')?, string[]?]>([
    ['protect', ['I want AAPL, not TSLA.'], 'en', ['AAPL']],
    ['protect', ['I want no stocks.']],
    ['protect', ['I want everything except stocks.']],
    ['protect', ['Quero tudo menos ações.'], 'pt'],
    ['protect', ['I want to avoid stocks, they scare me.']],
    ['protect', ['I want something safe; stocks are too risky for me.']],
    ['protect', ['Quero algo seguro, ações são arriscadas demais.'], 'pt'],
    ['protect', ['Keep stocks out of it.']],
    ['protect', ['I want to sell my TSLA.']],
    [
      'protect',
      [
        'I want AAPL in it.',
        ['app', 'Added.'],
        'Actually, scratch that. No AAPL, just safe things.',
      ],
    ],
    ['protect', ['I want stocks.', ['app', 'Noted.'], 'No TSLA though.'], 'en', [STOCKS, '-TSLA']],
    ['protect', ['Why did you add AAPL?']],
    ['protect', ['Is it smart to buy TSLA right now?']],
    ['protect', ['The preview suggests to hold TSLA; why?']],
    ['income', ['Quero renda mensal para a minha meta de aposentadoria.'], 'pt'],
    ['protect', ['Quero proteger o dinheiro da minha meta.'], 'pt'],
    ['income', ['I want my income needs met every month.']],
    ['protect', ['I want to hold a coin that never loses value.']],
    ['protect', ['I want to pump up my emergency savings.']],
    ['income', ['Quero renda, sem ações.'], 'pt'],
    ['protect', ['I want at most 5% stocks.']],
    ['protect', ['"I want TSLA", my brother told me.']],
    ['protect', ['I want to know more about TSLA.']],
    ['protect', ['I want to understand AAPL first.']],
    ['protect', ['Quero saber mais sobre a TSLA.'], 'pt'],
    ['protect', ['I want to compare AAPL and TSLA.']],
    ['protect', ['I want to see what AAPL would look like.']],
    ['protect', ['I want something like AAPL but safer.']],
    ['protect', ['I want my savings safe from TSLA-style crashes.']],
    ['protect', ['Quero investir como a TSLA investe em inovação.'], 'pt'],
    ['protect', ['Quero ações, mas só se for seguro.'], 'pt'],
  ])('%s: %j', async (goal, turns, language = 'en', expected = []) => {
    const { out, requested } = await read(goal, turns, language);
    const want = expected.includes(STOCKS)
      ? stocks.filter(
          (id) =>
            !expected.some((ticker) => ticker.startsWith('-') && id === symbol(ticker.slice(1))),
        )
      : expected.map(symbol);
    expect(requested).toEqual(want);
    // The fixture's model adds a stock the person did not name: refused unless they asked for stocks.
    if (!requested.includes(symbol('NVDA')))
      expect(out).toMatchObject({ detail: 'allocation_ineligible' });
  });
});

describe('a plain request for a stock counts', () => {
  it.each<[Turn[], 'en' | 'pt', string[]]>([
    [["I'd like some AAPL."], 'en', ['AAPL']],
    [['Gostaria de ter AAPL.'], 'pt', ['AAPL']],
    [['I understand the risk, add AAPL.'], 'en', ['AAPL']],
    [['Pode colocar AAPL?'], 'pt', ['AAPL']],
    [['Can you add AAPL?'], 'en', ['AAPL']],
    [['Quero AAPL, não me importo com o risco.'], 'pt', ['AAPL']],
    [['Quero colocar mais no AAPL.'], 'pt', ['AAPL']],
    [['Add AAPLx.'], 'en', ['AAPL']],
    [['I want no stocks, just AAPL.'], 'en', ['AAPL']],
    [['I want NVDA.'], 'en', ['NVDA']],
    [['Coloca ações também.'], 'pt', [STOCKS]],
    [['No stocks.', ['app', 'Understood.'], 'Actually I want stocks after all.'], 'en', [STOCKS]],
  ])('%j', async (turns, language, expected) => {
    const { out, requested } = await read('protect', turns, language);
    expect(requested).toEqual(expected.includes(STOCKS) ? stocks : expected.map(symbol));
    if (requested.includes(symbol('NVDA')))
      expect(out.kind === 'reply' && out.reply.warnings).toEqual([
        {
          code: 'outside_goal_requested',
          assetId: symbol('NVDA'),
          evidenceId: `catalog:${symbol('NVDA')}`,
        },
      ]);
  });

  it('misses rather than invents: a condition, a "without" or a company name it was not given', async () => {
    for (const turn of [
      'Add AAPL even if it is outside the goal.',
      'Add AAPL without touching the rest.',
      'I want some Apple.',
    ])
      expect((await read('protect', [turn])).requested).toEqual([]);
    // The model is told to ask the person to confirm instead.
    expect(VAULT_AGENT_SYSTEM).toContain('do not propose it: ask in question');
  });

  it('reads company names without case and skips the ones that are everyday words', async () => {
    const stockAttributes = {
      stocks: [
        { symbol: 'AAPLx', company: 'Apple Inc.' },
        { symbol: 'METAx', company: 'Meta Platforms, Inc.' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'];
    expect(
      (await read('protect', ['I want some apple.'], 'en', { stockAttributes })).requested,
    ).toEqual([symbol('AAPL')]);
    expect(
      (await read('protect', ['Quero bater a minha Meta.'], 'pt', { stockAttributes })).requested,
    ).toEqual([]);
    expect(
      (await read('protect', ['I want Meta Platforms.'], 'en', { stockAttributes })).requested,
    ).toEqual([symbol('META')]);
  });

  it('keeps every class but stocks refused outside the goal, asked for or not', async () => {
    for (const turn of ['Put some SOL in.', 'I want some crypto too.', 'I want SOL.'])
      expect((await read('protect', [turn])).requested).toEqual([]);
  });
});

describe("a stated share reads tickers as written, so the person's shares drive only what they named", () => {
  it('sets no limit on METAx from "my meta", and one from META or Meta Platforms', async () => {
    const stockAttributes = {
      stocks: [{ symbol: 'METAx', company: 'Meta Platforms, Inc.' }],
    } as unknown as VaultAgentContext['stockAttributes'];
    const limits = async (text: string, language: 'en' | 'pt' = 'en') => {
      const model = fake(proposal());
      await replyToVaultConversation(
        { version: 1, language, messageId: 'turn', messages: [{ who: 'person', text }] },
        { ...context, stockAttributes },
        model,
      );
      return vi.mocked(model.read).mock.calls[0]?.[1].allocationConstraints;
    };
    expect(await limits('I want 10% for my meta.')).toEqual([]);
    expect(await limits('Quero 10% na minha meta de aposentadoria.', 'pt')).toEqual([]);
    for (const said of ['10% META', '10% Meta Platforms', '10% Meta'])
      expect(await limits(`I want ${said}.`)).toEqual([
        { assetIds: [symbol('META')], minWeightBps: 1000, maxWeightBps: 1000, personQuote: said },
      ]);
    // Beside a number too, the everyday word is not the ticker.
    expect(await limits('Quero colocar 10% na meta de aposentadoria.', 'pt')).toEqual([]);
    expect(await limits('I want 10% in meta.')).toEqual([]);
  });
});

// Gate ANY-COMPOSITION: the weights follow only the shares the person's words hold. The model reports
// each with the person's quote; the server checks the quote, its number, that it is not a return, and
// the assets it names. Cases from the second review of #189.
describe("the person's stated shares, as their words hold them", () => {
  const pick = (ticker: string) => ({
    assetId: symbol(ticker),
    why: 'The person named it.',
    evidenceIds: [`catalog:${symbol(ticker)}`],
  });
  const evidence = assets.map((asset) => ({
    id: `catalog:${asset.id}`,
    assetId: asset.id,
    source: 'offline catalog',
    method: 'listed assets',
    fetchedAt: now,
    provenance: 'mock' as const,
  }));
  const shareOf = (
    tickers: string[],
    kind: 'exact' | 'min' | 'max',
    bps: number,
    quote: string,
  ) => ({ assetIds: tickers.map(symbol), kind, bps, quote });
  async function served(
    turns: Turn[],
    tickers: string[],
    stated: ReturnType<typeof shareOf>[],
    language: 'en' | 'pt' = 'en',
    extra: Partial<VaultAgentContext> = {},
  ) {
    const value = proposal();
    value.proposal.allocations = tickers.map(pick);
    (value.proposal as { stated: unknown[] }).stated = stated;
    const messages = turns.map((turn) =>
      Array.isArray(turn)
        ? { who: turn[0], text: turn[1] }
        : { who: 'person' as const, text: turn },
    );
    const out = await replyToVaultConversation(
      { version: 1, language, messageId: 'turn', messages },
      { ...context, evidence, ...extra },
      fake(value),
    );
    if (out.kind !== 'reply') throw new Error(`refused: ${JSON.stringify(out)}`);
    return {
      weights: out.reply.proposal?.allocations.map((line) => line.weightBps),
      notes: out.reply.weightNotes,
      repair: out.repair,
      reply: out.reply,
    };
  }
  const three = ['AAPL', 'TSLA', 'GLD'];

  it.each<[string, ReturnType<typeof shareOf>[], ('en' | 'pt')?]>([
    ['I want 10% a year, mostly stocks.', [shareOf(['AAPL', 'TSLA'], 'min', 1000, '10% a year')]],
    [
      'Quero render 10% ao ano com ouro.',
      [shareOf(['GLD'], 'exact', 1000, 'render 10% ao ano com ouro')],
      'pt',
    ],
    [
      'I want 8% a year with some TSLA.',
      [shareOf(['TSLA'], 'exact', 800, '8% a year with some TSLA')],
    ],
    [
      'I want TSLA to grow 20% a year.',
      [shareOf(['TSLA'], 'exact', 2000, 'TSLA to grow 20% a year')],
    ],
    [
      'I want to lose at most 10% with TSLA.',
      [shareOf(['TSLA'], 'max', 1000, 'lose at most 10% with TSLA')],
    ],
  ])('sets no weight from a return or a loss: %s', async (text, stated, language = 'en') => {
    const out = await served([text], three, stated, language);
    expect(out.weights).toEqual([3334, 3333, 3333]);
    // Refused once, with the reason, then ignored: the repair sent the same share again.
    expect(out.repair).toEqual({ failed: 'stated_ungrounded', outcome: 'repaired' });
    expect(out.notes[0]).toEqual({ code: 'equal_split', assetIds: three.map(symbol) });
  });

  it('says that "mostly stocks" was not applied, rather than splitting in silence', async () => {
    const out = await served(['I want 10% a year, mostly stocks.'], three, []);
    expect(out.weights).toEqual([3334, 3333, 3333]);
    expect(out.notes).toEqual([
      { code: 'equal_split', assetIds: three.map(symbol) },
      { code: 'share_unread', assetIds: [], quote: 'mostly stocks' },
    ]);
    expect(out.repair).toBeUndefined();
    // A preference with no number reported as a share is refused for its number.
    const mostly = await served(
      ['I want mostly TSLA.'],
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'min', 7000, 'mostly TSLA')],
    );
    expect(mostly.weights).toEqual([5000, 5000]);
    expect(mostly.notes).toContainEqual({
      code: 'share_unread',
      assetIds: [],
      quote: 'I want mostly TSLA',
    });
  });

  it.each<[string, string[], ReturnType<typeof shareOf>[], number[], ('en' | 'pt')?]>([
    [
      'I want 70/30 TSLA and NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['TSLA'], 'exact', 7000, '70/30 TSLA and NVDA'),
        shareOf(['NVDA'], 'exact', 3000, '70/30 TSLA and NVDA'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70% tsla.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% tsla')],
      [7000, 3000],
    ],
    [
      '70% em TSLA',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% em TSLA')],
      [7000, 3000],
      'pt',
    ],
    [
      'Put 70 percent in TSLA.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70 percent in TSLA')],
      [7000, 3000],
    ],
    [
      'Quero 70 por cento em TSLA.',
      ['TSLA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70 por cento em TSLA')],
      [7000, 3000],
      'pt',
    ],
    [
      'I want half in AAPL.',
      ['AAPL', 'GLD', 'TSLA'],
      [shareOf(['AAPL'], 'exact', 5000, 'half in AAPL')],
      [5000, 2500, 2500],
    ],
    ['I want 50% SOL.', ['SOL', 'GLD'], [shareOf(['SOL'], 'exact', 5000, '50% SOL')], [5000, 5000]],
    [
      'I want at least 30% gold.',
      three,
      [shareOf(['GLD'], 'min', 3000, 'at least 30% gold')],
      [3334, 3333, 3333],
    ],
    [
      'I want at least 40% gold.',
      three,
      [shareOf(['GLD'], 'min', 4000, 'at least 40% gold')],
      [3000, 3000, 4000],
    ],
  ])(
    'follows a share the words hold: %s',
    async (text, tickers, stated, weights, language = 'en') => {
      const out = await served([text], tickers, stated, language);
      expect(out.weights).toEqual(weights);
      expect(out.repair).toBeUndefined();
      expect(out.notes.filter((note) => note.code === 'share_unread')).toEqual([]);
    },
  );

  it('reads company names in a quote: "metade em Apple", "70% Tesla", "70% Meta"', async () => {
    const stockAttributes = {
      stocks: [
        { symbol: 'AAPLx', company: 'Apple Inc.' },
        { symbol: 'TSLAx', company: 'Tesla, Inc.' },
        { symbol: 'METAx', company: 'Meta Platforms, Inc.' },
      ],
    } as unknown as VaultAgentContext['stockAttributes'];
    const apple = await served(
      ['Quero metade em Apple.'],
      ['AAPL', 'GLD'],
      [shareOf(['AAPL'], 'exact', 5000, 'metade em Apple')],
      'pt',
      { stockAttributes },
    );
    expect(apple.weights).toEqual([5000, 5000]);
    expect(apple.notes).toEqual([
      { code: 'stated', assetIds: [symbol('AAPL')], quote: 'metade em Apple' },
      { code: 'equal_split', assetIds: [symbol('GLD')] },
    ]);
    for (const [name, ticker] of [
      ['Tesla', 'TSLA'],
      ['Meta', 'META'],
    ] as const) {
      const out = await served(
        [`I want 70% ${name}.`],
        [ticker, 'GLD'],
        [shareOf([ticker], 'exact', 7000, `70% ${name}`)],
        'en',
        { stockAttributes },
      );
      expect(out.weights).toEqual([7000, 3000]);
    }
  });

  it('gives the same weights whatever order the shares come in', async () => {
    const text = 'I want at least 20% AAPL and 60% NVDA.';
    const stated = [
      shareOf(['AAPL'], 'min', 2000, 'at least 20% AAPL'),
      shareOf(['NVDA'], 'exact', 6000, '60% NVDA'),
    ];
    const picks = ['AAPL', 'NVDA', 'TSLA', 'GLD'];
    const forward = await served([text], picks, stated);
    const backward = await served([text], picks, [...stated].reverse());
    expect(forward.weights).toEqual([2000, 6000, 1000, 1000]);
    expect(backward.weights).toEqual(forward.weights);
  });

  it('never scales or drops in silence', async () => {
    const twice = [
      shareOf(['TSLA'], 'exact', 6000, '60% TSLA'),
      shareOf(['NVDA'], 'exact', 6000, '60% NVDA'),
    ];
    const scaled = await served(['I want 60% TSLA and 60% NVDA.'], ['TSLA', 'NVDA'], twice);
    expect(scaled.weights).toEqual([5000, 5000]);
    expect(scaled.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: '60% TSLA' },
      { code: 'stated', assetIds: [symbol('NVDA')], quote: '60% NVDA' },
      { code: 'scaled', assetIds: [symbol('TSLA'), symbol('NVDA')] },
    ]);
    // Over three picks the two shares cannot both hold: the person is asked, with the quote.
    const value = proposal();
    value.proposal.allocations = ['TSLA', 'NVDA', 'GLD'].map(pick);
    (value.proposal as { stated: unknown[] }).stated = twice;
    const asked = await replyToVaultConversation(
      {
        version: 1,
        language: 'en',
        messageId: 'turn',
        messages: [{ who: 'person', text: 'I want 60% TSLA and 60% NVDA.' }],
      },
      { ...context, evidence },
      fake(value),
    );
    expect(asked).toMatchObject({
      kind: 'reply',
      reply: { proposal: null, weightNotes: [{ code: 'share_unmet', quote: '60% NVDA' }] },
    });
    const dropped = await served(
      ['I want 99.99% TSLA.'],
      ['TSLA', 'NVDA', 'AAPL'],
      [shareOf(['TSLA'], 'exact', 9999, '99.99% TSLA')],
    );
    expect(dropped.weights).toEqual([9999, 1]);
    expect(dropped.notes).toContainEqual({ code: 'pick_dropped', assetIds: [symbol('AAPL')] });
  });

  it('holds a share to the person: their message, their number, their assets, the latest word', async () => {
    const cases: Array<[Turn[], ReturnType<typeof shareOf>[]]> = [
      // Not in any person message (an app message does not count).
      [
        [['app', 'Shall I put 70% TSLA?'], 'Yes please.'],
        [shareOf(['TSLA'], 'exact', 7000, '70% TSLA')],
      ],
    ];
    for (const [turns, stated] of cases) {
      const out = await served(turns, ['TSLA', 'NVDA'], stated);
      expect(out.weights).toEqual([5000, 5000]);
      expect(out.repair).toEqual({ failed: 'stated_ungrounded', outcome: 'repaired' });
    }
    // A number or an asset the person's words do not hold: the model's report is refused once, and
    // the weights are the person's own 70% TSLA either way.
    for (const stated of [
      [shareOf(['TSLA'], 'exact', 9000, '70% TSLA')],
      [shareOf(['NVDA'], 'exact', 7000, '70% TSLA')],
    ]) {
      const out = await served(['I want 70% TSLA.'], ['TSLA', 'NVDA'], stated);
      expect(out.weights).toEqual([7000, 3000]);
      expect(out.repair).toEqual({ failed: 'stated_ungrounded', outcome: 'repaired' });
      expect(out.notes[0]).toEqual({
        code: 'stated',
        assetIds: [symbol('TSLA')],
        quote: '70% TSLA',
      });
    }
    // A later share on the same asset replaces the earlier one.
    const later = await served(
      ['I want 70% TSLA.', ['app', 'Noted.'], 'Make it 50% TSLA.'],
      ['TSLA', 'NVDA', 'GLD'],
      [shareOf(['TSLA'], 'exact', 7000, '70% TSLA'), shareOf(['TSLA'], 'exact', 5000, '50% TSLA')],
    );
    expect(later.weights).toEqual([5000, 2500, 2500]);
    expect(later.notes[0]).toEqual({
      code: 'stated',
      assetIds: [symbol('TSLA')],
      quote: '50% TSLA',
    });
  });

  // Third review of #189: the server reads the number and its asset itself, so nothing the model
  // reports in `stated` can set, move or swap a weight. Picks are TSLA, NVDA, GLD unless noted.
  const equal = [3334, 3333, 3333];
  const tng = ['TSLA', 'NVDA', 'GLD'];
  const unreadOf = (out: Awaited<ReturnType<typeof served>>) =>
    out.notes.filter((note) => note.code === 'share_unread').map((note) => note.quote);

  it.each<[string, string[], ReturnType<typeof shareOf>[], number[], (string | null)?]>([
    [
      "I don't want 70% TSLA, keep it small.",
      tng,
      [shareOf(['TSLA'], 'exact', 7000, '70% TSLA')],
      equal,
      "I don't want 70% TSLA",
    ],
    [
      'Never put 70% in TSLA.',
      tng,
      [shareOf(['TSLA'], 'exact', 7000, '70% in TSLA')],
      equal,
      'Never put 70% in TSLA',
    ],
    [
      'I want 70% TSLA and 30% NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['NVDA'], 'exact', 7000, 'I want 70% TSLA and 30% NVDA.'),
        shareOf(['TSLA'], 'exact', 3000, 'I want 70% TSLA and 30% NVDA.'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70/30 TSLA and NVDA.',
      ['TSLA', 'NVDA'],
      [
        shareOf(['NVDA'], 'exact', 7000, '70/30 TSLA and NVDA'),
        shareOf(['TSLA'], 'exact', 3000, '70/30 TSLA and NVDA'),
      ],
      [7000, 3000],
    ],
    [
      'I want 70% TSLA, rest in gold.',
      tng,
      [shareOf(['GLD'], 'exact', 7000, '70% TSLA, rest in gold')],
      [7000, 1500, 1500],
    ],
    ['I want 15% TSLA.', tng, [shareOf(['TSLA'], 'exact', 500, '5% TSLA')], [1500, 4250, 4250]],
    ['I want 10% TSLA.', tng, [shareOf(['TSLA'], 'max', 0, '0% TSLA')], [1000, 4500, 4500]],
    ['I want at most 70% TSLA.', tng, [shareOf(['TSLA'], 'min', 7000, 'at most 70% TSLA')], equal],
    ['I want at least 40% stocks.', tng, [shareOf(['TSLA'], 'exact', 4000, '40% stocks')], equal],
  ])(
    "serves the person's share, not what the model reports: %s",
    async (text, tickers, stated, weights, unread = null) => {
      const out = await served([text], tickers, stated);
      expect(out.weights).toEqual(weights);
      // The misreport is refused once and changes nothing: the same reply as with no report at all.
      expect(out.repair).toEqual({ failed: 'stated_ungrounded', outcome: 'repaired' });
      const silent = await served([text], tickers, []);
      expect(silent.repair).toBeUndefined();
      expect([silent.weights, silent.notes]).toEqual([out.weights, out.notes]);
      expect(unreadOf(out)).toEqual(unread ? [unread] : []);
    },
  );

  it('says whose words each applied share came from, with its bound', async () => {
    const most = await served(['I want at most 70% TSLA.'], tng, []);
    expect(most.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: 'at most 70% TSLA' },
      { code: 'equal_split', assetIds: [symbol('NVDA'), symbol('GLD')] },
    ]);
    const least = await served(['I want at least 40% stocks.'], tng, []);
    expect(least.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA'), symbol('NVDA')], quote: 'at least 40% stocks' },
      { code: 'equal_split', assetIds: [symbol('GLD')] },
    ]);
    const capped = await served(['I want at most 10% TSLA.'], tng, []);
    expect(capped.weights).toEqual([1000, 4500, 4500]);
    const swapped = await served(['I want 70/30 TSLA and NVDA.'], ['TSLA', 'NVDA'], []);
    expect(swapped.notes).toEqual([
      { code: 'stated', assetIds: [symbol('TSLA')], quote: '70/30 TSLA and NVDA' },
      { code: 'stated', assetIds: [symbol('NVDA')], quote: '70/30 TSLA and NVDA' },
    ]);
  });

  it.each<[string, string, string, ('en' | 'pt')?]>([
    ['I want to earn 10% with TSLA.', 'TSLA', '10% with TSLA'],
    ['I want 10% upside in gold.', 'GLD', '10% upside in gold'],
    ['I want 10% APY on gold.', 'GLD', '10% APY on gold'],
    ['I want a 4% dividend from TSLA.', 'TSLA', 'a 4% dividend from TSLA'],
    ['TSLA fell 30%.', 'TSLA', 'TSLA fell 30%'],
    ['I accept a 2% fee on TSLA.', 'TSLA', 'a 2% fee on TSLA'],
    ['TSLA up 20%.', 'TSLA', 'TSLA up 20%'],
    ['Quero que o ouro renda 10%.', 'GLD', 'o ouro renda 10%', 'pt'],
    ['Quero 10% de rentabilidade no ouro.', 'GLD', '10% de rentabilidade no ouro', 'pt'],
    ['Quero que TSLA valorize 20%.', 'TSLA', 'TSLA valorize 20%', 'pt'],
    ['Quero 90% do CDI com ouro.', 'GLD', '90% do CDI com ouro', 'pt'],
  ])(
    'sets no weight from a return, a price move or a fee, and says so: %s',
    async (text, ticker, quote, language = 'en') => {
      const figure = Number(/(\d+)%/u.exec(quote)?.[1]) * 100;
      const out = await served([text], tng, [shareOf([ticker], 'exact', figure, quote)], language);
      expect(out.weights).toEqual(equal);
      expect(out.repair).toEqual({ failed: 'stated_ungrounded', outcome: 'repaired' });
      expect(out.notes).toEqual([
        { code: 'equal_split', assetIds: tng.map(symbol) },
        { code: 'share_unread', assetIds: [], quote: text.replace(/\.$/u, '') },
      ]);
    },
  );

  it.each<[string, ('en' | 'pt')?]>([
    ['I want 60% TSLA for growth.'],
    ['I want 30% gold to limit losses.'],
    ['Quero 60% em TSLA para crescer.', 'pt'],
  ])(
    'says back a share it leaves unapplied for a return or loss word: %s',
    async (text, language = 'en') => {
      const out = await served([text], tng, [], language);
      expect(out.weights).toEqual(equal);
      expect(out.repair).toBeUndefined();
      expect(out.notes).toEqual([
        { code: 'equal_split', assetIds: tng.map(symbol) },
        { code: 'share_unread', assetIds: [], quote: text.replace(/\.$/u, '') },
      ]);
    },
  );

  it.each<[string, number[], ('en' | 'pt')?]>([
    ['TSLA 70%.', [7000, 1500, 1500]],
    ['I want TSLA at 70% and the rest spread out.', [7000, 1500, 1500]],
    ['TSLA: 50%, NVDA: 30%, GLD: 20%', [5000, 3000, 2000]],
    ['TSLA 50% NVDA 30%', [5000, 3000, 2000]],
    ['Put 70% of my portfolio in TSLA.', [7000, 1500, 1500]],
    ['Quero 70% no TSLA.', [7000, 1500, 1500], 'pt'],
    ['Quero 70% da carteira em TSLA.', [7000, 1500, 1500], 'pt'],
    ['I want 12,5% TSLA.', [1250, 4375, 4375]],
    ['I want 0,5% TSLA.', [50, 4975, 4975]],
    ['I want no more than 10% TSLA.', [1000, 4500, 4500]],
    ['I want less than 10% TSLA.', [1000, 4500, 4500]],
    ['Quero mais de 50% em TSLA.', [5000, 2500, 2500], 'pt'],
    ["I don't want NVDA to dominate, but I want 70% TSLA.", [7000, 1500, 1500]],
  ])('reads the fixed patterns: %s', async (text, weights, language = 'en') => {
    const out = await served([text], tng, [], language);
    expect(out.weights).toEqual(weights);
    expect(unreadOf(out)).toEqual([]);
  });

  it.each<[string, string[], ('en' | 'pt')?]>([
    ['I want $70 in TSLA.', []],
    ['I want TSLA in 70 days.', []],
    ['I want 60/30 TSLA and NVDA.', ['I want 60/30 TSLA and NVDA']],
    ['I want 40% in TSLA and NVDA.', ['I want 40% in TSLA and NVDA']],
    ['I want between 20% and 30% TSLA.', ['I want between 20% and 30% TSLA']],
    ['TSLA 70% NVDA', ['TSLA 70% NVDA']],
    ['Should I put 70% in TSLA?', ['Should I put 70% in TSLA']],
    ['If it is safe, I want 70% TSLA.', ['I want 70% TSLA']],
    ['My friend said I want 70% TSLA.', ['My friend said I want 70% TSLA']],
    ['"I want 70% TSLA"', ['"I want 70% TSLA"']],
    ['I want 70% TSLA, not NVDA.', ['I want 70% TSLA']],
    ['Não quero 70% em TSLA.', ['Não quero 70% em TSLA'], 'pt'],
    ['Quero tudo menos 70% em TSLA.', ['Quero tudo menos 70% em TSLA'], 'pt'],
    ['I want half.', ['I want half']],
  ])(
    'sets nothing from what the patterns do not hold, and says so: %s',
    async (text, unread, language = 'en') => {
      const out = await served([text], tng, [], language);
      expect(out.weights).toEqual(equal);
      expect(unreadOf(out)).toEqual(unread);
    },
  );

  it('reads an app message, or a share stitched across two messages, as no share', async () => {
    const app = await served([['app', 'Shall I put 70% in TSLA?'], 'Yes, do that.'], tng, [
      shareOf(['TSLA'], 'exact', 7000, '70% in TSLA'),
    ]);
    expect(app.weights).toEqual(equal);
    const stitched = await served(['I want 70%', 'TSLA and gold please.'], tng, [
      shareOf(['TSLA'], 'exact', 7000, '70% TSLA'),
    ]);
    expect(stitched.weights).toEqual(equal);
  });

  it("withdraws a share on the person's word, and keeps it until then", async () => {
    const first = 'I want 70% TSLA.';
    // A later turn that says nothing about the share leaves it standing, whatever the model reports.
    const kept = await served([first, ['app', 'Noted.'], 'Add gold too.'], tng, []);
    expect(kept.weights).toEqual([7000, 1500, 1500]);
    expect(kept.notes[0]).toEqual({
      code: 'stated',
      assetIds: [symbol('TSLA')],
      quote: '70% TSLA',
    });
    for (const [next, language] of [
      ['Forget TSLA.', 'en'],
      ['No more TSLA, just NVDA and GLD.', 'en'],
      ["Actually I don't want 70% TSLA.", 'en'],
      ['Drop that limit.', 'en'],
      ['Just split it equally.', 'en'],
      ['Não quero mais TSLA.', 'pt'],
      ['Divida em partes iguais.', 'pt'],
    ] as const) {
      const out = await served([first, ['app', 'Noted.'], next], ['NVDA', 'GLD'], [], language);
      expect(out.weights, next).toEqual([5000, 5000]);
    }
    // A return sentence or a question about the asset withdraws nothing.
    for (const next of ['I hope TSLA does not lose 20%.', 'Is TSLA not too risky?']) {
      const out = await served([first, ['app', 'Noted.'], next], tng, []);
      expect(out.weights, next).toEqual([7000, 1500, 1500]);
    }
    // In one message the shares stand together; a later message's share replaces what it covers.
    const together = await served(['I want 50% TSLA and at least 80% stocks.'], tng, []);
    expect(together.weights).toEqual([5000, 3000, 2000]);
    const replaced = await served([first, 'I want at most 20% stocks.'], tng, []);
    expect(replaced.weights).toEqual([1000, 1000, 8000]);
  });
});

describe('the reply schema ties warnings to the proposal', () => {
  it('refuses a warning without a proposal, or on an asset or source the proposal lacks', () => {
    const warning = {
      code: 'outside_goal_requested' as const,
      assetId: stock.id,
      evidenceId: `catalog:${stock.id}`,
    };
    const base = { version: 1, messageId: 'turn', message: 'Hi.', question: null, weightNotes: [] };
    expect(VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [] }).success).toBe(true);
    expect(
      VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [warning] }).success,
    ).toBe(false);
    const withProposal = {
      ...base,
      proposal: {
        ...(({ stated, ...rest }) => rest)(proposal().proposal),
        allocations: proposal().proposal.allocations.map((line, i) => ({
          ...line,
          symbol: 'X',
          weightBps: [3334, 3333, 3333][i] ?? 0,
        })),
        sources: context.evidence,
      },
    };
    expect(VaultAgentReply.safeParse({ ...withProposal, warnings: [warning] }).success).toBe(true);
    expect(
      VaultAgentReply.safeParse({
        ...withProposal,
        warnings: [{ ...warning, evidenceId: `liquidity:${stock.id}` }],
      }).success,
    ).toBe(false);
    expect(
      VaultAgentReply.safeParse({ ...withProposal, warnings: [{ ...warning, assetId: cash.id }] })
        .success,
    ).toBe(false);
  });
});

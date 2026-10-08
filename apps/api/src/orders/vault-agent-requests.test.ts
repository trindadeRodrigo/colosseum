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

describe('the reply schema ties warnings to the proposal', () => {
  it('refuses a warning without a proposal, or on an asset or source the proposal lacks', () => {
    const warning = {
      code: 'outside_goal_requested' as const,
      assetId: stock.id,
      evidenceId: `catalog:${stock.id}`,
    };
    const base = { version: 1, messageId: 'turn', message: 'Hi.', question: null };
    expect(VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [] }).success).toBe(true);
    expect(
      VaultAgentReply.safeParse({ ...base, proposal: null, warnings: [warning] }).success,
    ).toBe(false);
    const withProposal = {
      ...base,
      proposal: {
        ...proposal().proposal,
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

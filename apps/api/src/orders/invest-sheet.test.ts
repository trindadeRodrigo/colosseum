import type { BasketAsset, VaultAgentSource } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { createRelaxedGoalAgent, investSheetOf } from './relaxed-goal-agent';
import type { GoalAgentContext } from './vault-agent';

// The engine's sheet behind "Invest in this plan" (gate RELAXED-INTAKE), with the model stubbed:
// nothing leaves the machine. The sheet is what /v1/baskets/personalize builds the plan from, so what
// it does not carry, the plan the person invests in cannot keep.

const asset = (id: string, symbol: string, cls: BasketAsset['cls']): BasketAsset =>
  ({
    id: `solana:${id}`,
    symbol,
    cls,
    chain: 'solana',
    underlying: symbol.replace(/x$/, ''),
    tier: 1,
    issuer: 'issuer',
    maxWeightBps: cls === 'cash' ? 10_000 : 5000,
    provenance: 'sandbox',
  }) as unknown as BasketAsset;

const NVDA = asset('nvdax', 'NVDAx', 'stock');
const TSLA = asset('tslax', 'TSLAx', 'stock');
const USDY = asset('usdy', 'USDY', 'dollar_yield');
const USDC = asset('usdc', 'USDC', 'cash');
const ASSETS = [NVDA, TSLA, USDY, USDC];
const THEMES = [{ slug: 'ai', members: [{ symbol: 'NVDA' }, { symbol: 'TSLA' }] }];
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

describe('the engine’s sheet for "Invest in this plan"', () => {
  it('carries the stocks as one theme sleeve: the share of each stock in the preview is not in it', () => {
    // the preview shows NVDAx 50%, TSLAx 20%, cash 30%
    const made = investSheetOf({
      lines: [
        { asset: NVDA, bps: 5000 },
        { asset: TSLA, bps: 2000 },
        { asset: USDC, bps: 3000 },
      ],
      catalog: ASSETS,
      themes: THEMES,
      shape: 'pick',
      potShapes: [],
      stated: STATED,
      chain: 'solana',
      language: 'en',
      today: new Date('2026-10-09T00:00:00.000Z'),
    });
    if (!('sheet' in made)) throw new Error(made.why);
    // one sleeve of 70% for both stocks, which the engine splits by its own rules, and the rest to
    // the goal's sleeve, which the engine fills itself: 50/20 is nowhere in what personalize receives
    expect(made.sheet.sleeves).toEqual([
      { kind: 'theme', theme: 'ai', shareBps: 7000 },
      { kind: 'goal', shareBps: 3000 },
    ]);
    expect(made.sheet.mix).toBeUndefined();
    expect(made.sheet.amountUsd).toBe(1000);
    // the engine may hold only the assets of the preview (cash is never on the cannot-hold list)
    expect(made.sheet.limits?.cannotHold?.assets).toEqual([USDY.id]);
  });

  it('is on no plan without an amount in dollars', () => {
    const base = {
      lines: [{ asset: USDY, bps: 10_000 }],
      catalog: ASSETS,
      themes: THEMES,
      shape: 'income' as const,
      potShapes: [],
      chain: 'solana',
      language: 'en' as const,
      today: new Date('2026-10-09T00:00:00.000Z'),
    };
    expect(investSheetOf({ ...base, stated: { ...STATED, amount: null } })).toEqual({
      why: 'no amount yet',
    });
    expect(investSheetOf({ ...base, stated: { ...STATED, currency: 'BRL' } })).toEqual({
      why: 'not in dollars',
    });
  });

  it('is on the relaxed agent’s proposal once the person named an amount', async () => {
    const source = (id: string, extra: Partial<VaultAgentSource> = {}): VaultAgentSource => ({
      id,
      source: 'server registry',
      method: 'listed asset catalog',
      fetchedAt: '2026-10-08T00:00:00.000Z',
      provenance: 'sandbox',
      ...extra,
    });
    const agent = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      create: async () => ({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              say: 'Here is a draft.',
              shape: 'pick',
              lines: [
                { id: NVDA.id, why: 'You asked for it.', share: null },
                { id: TSLA.id, why: 'You asked for it.', share: null },
              ],
              buckets: null,
              stated: STATED,
              not_available: [],
              open: [],
            }),
            citations: null,
          },
        ],
      }),
    });
    const result = await agent.reply(
      {
        version: 1,
        language: 'en',
        messageId: 'm1',
        messages: [{ who: 'person', text: 'Put $1,000 in NVDA and TSLA' }],
      },
      {
        person: 'person-1',
        kind: 'new_goal',
        chain: 'solana',
        state: null,
        assets: ASSETS,
        themes: THEMES,
        evidence: ASSETS.map((a) => source(`catalog:${a.id}`, { assetId: a.id })),
        currentGoals: [],
        stockAttributes: null,
        liquidity: [],
        unknowns: [],
        caps: {},
      } as unknown as GoalAgentContext,
    );
    if (result.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(result)}`);
    expect(result.reply.proposal?.investSheet).toMatchObject({
      goal: 'grow',
      amountUsd: 1000,
      chains: ['solana'],
      sleeves: [{ kind: 'theme', theme: 'ai', shareBps: 10_000 }],
    });
  });
});

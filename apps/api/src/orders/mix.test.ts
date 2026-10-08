import { mockAddress } from '@colosseum/chain-mock';
import {
  type Address,
  type BasketAsset,
  type BasketProposal,
  type BuiltTx,
  type Principal,
  BasketProposal as ProposalSchema,
  parseChainConfigs,
  parseFlags,
  type VaultState,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { fixtureLiquidity } from '../../../../packages/engine/src/personal/testing';
import { createChainRegistry } from './chains';
import { Refusal } from './errors';
import {
  buildRetarget,
  checkMix,
  MIX_VERSION,
  mixContext,
  mixProposal,
  planRetarget,
  reviewMix,
  vaultValueUsd,
} from './mix';
import { prepareOrder, slippageOf } from './prepare';

// Gate ANY-COMPOSITION (Thom, Oct 8): any composition of listed assets is checked again by the
// server, warned about where it goes past an exit or a goal, stored as a plan the buy takes unchanged,
// or ordered onto a vault the person owns.

const NOW = '2026-10-08T12:00:00.000Z';

async function setup(chain: 'solana' | 'robinhood' = 'solana') {
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), {
    seed: `mix:${chain}`,
  });
  const entry = chains.get(chain);
  const ctx = await mixContext(
    entry,
    async () => ({
      // NVDA is measured thin: $2,000 of exit. Nothing else is measured, so its tier stands in.
      liquidity: {
        provider: fixtureLiquidity({ [`${chain}:nvda`]: 2000 }),
        source: 'fixture exit table',
      },
    }),
    NOW,
  );
  const mock = entry.mock;
  if (!mock) throw new Error('the test chain is the mock');
  return { chains, entry, ctx, mock, cash: `${chain}:usdc` };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (e) {
    if (e instanceof Refusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const issuesOf = async (work: Promise<unknown>) => {
  const r = await refusal(work);
  expect(r.status).toBe(422);
  expect(r.extra.code).toBe('MIX_NOT_VALID');
  return r.extra.details?.issues ?? [];
};

/** A vault the owner holds on the mock chain: $1,000 into SPY and TSLA, 60/40. */
async function heldVault(s: Setup, owner: Address, autoFollow = false): Promise<VaultState> {
  const { entry, mock, cash } = s;
  mock.fund(owner, { gasRaw: '100000000000', assets: { [cash]: '1000000000' } });
  const send = (tx: BuiltTx) => mock.send(tx);
  await send(
    await entry.adapter.buildCreateVault({
      owner,
      basketId: '7',
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:tsla', weightBps: 4000 },
      ],
      autoFollow,
      depositRaw: '1000000000',
      slippageBps: 100,
    }),
  );
  const [opened] = await entry.adapter.getVaults(owner);
  if (!opened) throw new Error('no vault');
  for (const [buy, amountInRaw] of [
    ['solana:spy', '600000000'],
    ['solana:tsla', '400000000'],
  ] as const)
    await send(
      await entry.adapter.buildOwnerSwap({
        vault: opened.address,
        trades: [{ sell: cash, buy, amountInRaw }],
        slippageBps: 100,
      }),
    );
  const vault = await entry.adapter.getVault(opened.address);
  if (!vault) throw new Error('no vault');
  return vault;
}

describe('checkMix: what a mix must be before money follows it', () => {
  it('takes any listed composition, cash first and as the rest, the targets without it', async () => {
    const { ctx } = await setup();
    const checked = await checkMix(ctx, [
      { assetId: 'solana:nvda', weightBps: 7000 },
      { assetId: 'solana:usdc', weightBps: 500 },
      { assetId: 'solana:gold', weightBps: 2500 },
    ]);
    expect(checked.picks.map((p) => [p.asset.id, p.weightBps])).toEqual([
      ['solana:usdc', 500],
      ['solana:nvda', 7000],
      ['solana:gold', 2500],
    ]);
    expect(checked.targets).toEqual([
      { asset: 'solana:nvda', weightBps: 7000 },
      { asset: 'solana:gold', weightBps: 2500 },
    ]);
    expect(checked.cashBps).toBe(500);
    expect([...checked.prices.keys()].sort()).toEqual(['solana:gold', 'solana:nvda']);
  });

  it('refuses tampered weights: not whole, zero, below zero, or not adding up to 10,000', async () => {
    const { ctx } = await setup();
    expect(
      await issuesOf(
        checkMix(ctx, [
          { assetId: 'solana:nvda', weightBps: 2500.5 },
          { assetId: 'solana:usdc', weightBps: 7499.5 },
        ]),
      ),
    ).toEqual(['WEIGHT_NOT_WHOLE:solana:nvda', 'WEIGHT_NOT_WHOLE:solana:usdc']);
    expect(
      await issuesOf(
        checkMix(ctx, [
          { assetId: 'solana:nvda', weightBps: 0 },
          { assetId: 'solana:spy', weightBps: -1 },
          { assetId: 'solana:usdc', weightBps: 10_000 },
        ]),
      ),
    ).toEqual(['WEIGHT_NOT_WHOLE:solana:nvda', 'WEIGHT_NOT_WHOLE:solana:spy']);
    expect(
      await issuesOf(
        checkMix(ctx, [
          { assetId: 'solana:nvda', weightBps: 6001 },
          { assetId: 'solana:usdc', weightBps: 4000 },
        ]),
      ),
    ).toEqual(['SUM_NOT_10000']);
    expect(await issuesOf(checkMix(ctx, [{ assetId: 'solana:nvda', weightBps: 9999 }]))).toEqual([
      'SUM_NOT_10000',
    ]);
  });

  it('refuses an asset that is not listed on the chain, a repeat, and another cash token', async () => {
    const { ctx } = await setup();
    expect(
      await issuesOf(
        checkMix(ctx, [
          { assetId: 'robinhood:nvda', weightBps: 2000 },
          { assetId: 'solana:bonk', weightBps: 2000 },
          { assetId: 'solana:usdc', weightBps: 6000 },
        ]),
      ),
    ).toEqual(['NOT_LISTED:robinhood:nvda', 'NOT_LISTED:solana:bonk']);
    expect(
      await issuesOf(
        checkMix(ctx, [
          { assetId: 'solana:nvda', weightBps: 5000 },
          { assetId: 'solana:nvda', weightBps: 5000 },
        ]),
      ),
    ).toEqual(['DUPLICATE:solana:nvda']);
    const usdt = { ...ctx.cash, id: 'solana:usdt', symbol: 'USDT' } as BasketAsset;
    expect(
      await issuesOf(
        checkMix({ ...ctx, assets: [...ctx.assets, usdt] }, [
          { assetId: 'solana:usdt', weightBps: 5000 },
          { assetId: 'solana:nvda', weightBps: 5000 },
        ]),
      ),
    ).toEqual(['FOREIGN_CASH:solana:usdt']);
  });

  it('refuses more than 16 lines that are not cash', async () => {
    const { ctx } = await setup();
    const nvda = ctx.assets.find((a) => a.id === 'solana:nvda') as BasketAsset;
    const many = Array.from({ length: 17 }, (_, i) => ({
      ...nvda,
      id: `solana:stock-${i}`,
      symbol: `S${i}`,
    }));
    const lines = [
      ...many.map((a) => ({ assetId: a.id, weightBps: 500 })),
      { assetId: 'solana:usdc', weightBps: 1500 },
    ];
    expect(await issuesOf(checkMix({ ...ctx, assets: [...ctx.assets, ...many] }, lines))).toEqual([
      'TOO_MANY_LINES',
    ]);
    // Sixteen and the cash is a vault's whole.
    const sixteen = [
      ...many.slice(0, 16).map((a) => ({ assetId: a.id, weightBps: 500 })),
      { assetId: 'solana:usdc', weightBps: 2000 },
    ];
    // The mock lists none of these: their prices come from a stand-in feed.
    const wide = {
      ...ctx,
      assets: [...ctx.assets, ...many],
      entry: {
        ...ctx.entry,
        adapter: {
          ...ctx.entry.adapter,
          getPrices: async (ids: string[]) =>
            ids.map((id) => ({
              asset: id,
              usdPerToken: '10',
              ageSeconds: 0,
              maxAgeSeconds: 120,
              market: 'open' as const,
              source: 'chain-mock',
              method: 'fixed mock price',
              fetchedAt: NOW,
              provenance: 'mock' as const,
            })),
        },
      },
    };
    expect((await checkMix(wide, sixteen)).targets).toHaveLength(16);
  });

  it('refuses an asset with no price the vault can trade on now', async () => {
    const s = await setup();
    s.mock.setPriceAge('solana:nvda', 10_000);
    expect(
      await issuesOf(
        checkMix(s.ctx, [
          { assetId: 'solana:nvda', weightBps: 5000 },
          { assetId: 'solana:gold', weightBps: 5000 },
        ]),
      ),
    ).toEqual(['NO_PRICE:solana:nvda']);
  });

  it('refuses all cash for a vault that is open: its targets cannot be emptied', async () => {
    const s = await setup();
    const vault = await heldVault(s, mockAddress('solana', 'all-cash'));
    expect(
      await issuesOf(checkMix(s.ctx, [{ assetId: 'solana:usdc', weightBps: 10_000 }], vault)),
    ).toEqual(['ALL_CASH']);
    // A new vault may be all cash: the plan holds no target and the buy trades nothing.
    expect(
      (await checkMix(s.ctx, [{ assetId: 'solana:usdc', weightBps: 10_000 }])).targets,
    ).toEqual([]);
  });
});

describe('reviewMix: warnings the person confirms, never refusals', () => {
  const mix = [
    { assetId: 'solana:usdc', weightBps: 1000 },
    { assetId: 'solana:nvda', weightBps: 4000 },
    { assetId: 'solana:yield', weightBps: 5000 },
  ];

  it('warns of a line over its measured exit, with the figure and its source, until it is accepted', async () => {
    const { ctx } = await setup();
    const checked = await checkMix(ctx, mix);
    const at = (accepted: string[]) =>
      reviewMix(ctx, checked, {
        origin: 'model',
        goal: 'grow',
        risk: 'medium',
        amountUsd: 10_000,
        language: 'en',
        accepted,
      }).review;
    const review = at([]);
    expect(review.warnings.map((w) => w.id)).toEqual(['EXIT_OVER_CAPACITY:solana:nvda']);
    const [warning] = review.warnings;
    expect(warning?.figures).toEqual([
      expect.objectContaining({
        label: 'exit ceiling',
        unit: 'USD',
        source: 'fixture exit table',
        method: 'fixture-0.1',
        provenance: 'fixture',
      }),
    ]);
    expect(warning?.text).toMatch(/^NVDAx at \$4,000 is more than \$/);
    expect(review.unconfirmed).toEqual(['EXIT_OVER_CAPACITY:solana:nvda']);
    expect(at(['EXIT_OVER_CAPACITY:solana:nvda']).unconfirmed).toEqual([]);
    // The lines split the amount by the weights to the cent, each with the server's price.
    expect(review.lines.map((l) => [l.assetId, l.amountUsd])).toEqual([
      ['solana:usdc', 1000],
      ['solana:nvda', 4000],
      ['solana:yield', 5000],
    ]);
    expect(review.lines[1]?.price).toMatchObject({ source: 'chain-mock', usdPerToken: '50' });
    expect(review.lines[2]?.exitCeiling).toMatchObject({ measured: false, provenance: 'mock' });
    expect(review.lines[0]).toMatchObject({ price: null, exitCeiling: null });
  });

  it('a smaller line under the same exit is no warning', async () => {
    const { ctx } = await setup();
    const review = reviewMix(ctx, await checkMix(ctx, mix), {
      origin: 'person',
      goal: 'grow',
      risk: 'medium',
      amountUsd: 100,
      language: 'en',
      accepted: [],
    }).review;
    expect(review.warnings).toEqual([]);
  });

  it('warns of a stock in an income or protect plan and of a cap on the asset list; grow has neither', async () => {
    const { ctx } = await setup();
    const checked = await checkMix(ctx, [
      { assetId: 'solana:tsla', weightBps: 6000 },
      { assetId: 'solana:yield', weightBps: 4000 },
    ]);
    const ids = (goal: 'grow' | 'income' | 'protect') =>
      reviewMix(ctx, checked, {
        origin: 'model',
        goal,
        risk: 'low',
        amountUsd: 1000,
        language: 'pt',
        accepted: [],
      }).review.warnings.map((w) => w.id);
    expect(ids('grow')).toEqual(['OVER_LISTED_CAP:solana:tsla']);
    expect(ids('income')).toEqual(['OVER_LISTED_CAP:solana:tsla', 'NOT_FOR_GOAL:solana:tsla']);
    expect(ids('protect')).toEqual(['OVER_LISTED_CAP:solana:tsla', 'NOT_FOR_GOAL:solana:tsla']);
    const text = reviewMix(ctx, checked, {
      origin: 'model',
      goal: 'income',
      risk: 'low',
      amountUsd: 1000,
      language: 'pt',
      accepted: [],
    }).review.warnings.find((w) => w.code === 'NOT_FOR_GOAL')?.text;
    expect(text).toMatch(/^TSLAx está na divisão que você escolheu/);
  });
});

describe('reviewMix: what an income or protect plan may hold', () => {
  it('refuses crypto outside a growth goal, and takes it in one', async () => {
    const { ctx } = await setup();
    const nvda = ctx.assets.find((a) => a.id === 'solana:nvda') as BasketAsset;
    const coin = {
      ...nvda,
      id: 'solana:coin',
      symbol: 'COIN',
      underlying: 'coin',
      cls: 'crypto',
    } as BasketAsset;
    const wide = {
      ...ctx,
      assets: [...ctx.assets, coin],
      prepared: {
        ...ctx.prepared,
        shelf: { ...ctx.prepared.shelf, assets: [...ctx.prepared.shelf.assets, coin] },
      },
    };
    const checked = {
      picks: [
        { asset: ctx.cash, weightBps: 5000 },
        { asset: coin, weightBps: 5000 },
      ],
      targets: [{ asset: coin.id, weightBps: 5000 }],
      cashBps: 5000,
      prices: new Map(),
    };
    const at = (goal: 'grow' | 'income' | 'protect') =>
      reviewMix(wide, checked, {
        origin: 'person',
        goal,
        risk: 'high',
        amountUsd: 100,
        language: 'en',
        accepted: [],
      });
    for (const goal of ['income', 'protect'] as const) {
      const r = await refusal(Promise.resolve().then(() => at(goal)));
      expect(r.extra.code).toBe('MIX_NOT_VALID');
      expect(r.extra.details?.issues).toEqual(['NOT_FOR_GOAL:solana:coin']);
    }
    expect(at('grow').review.warnings).toEqual([]);
  });
});

describe('reviewMix: a ceiling with no source is not printed', () => {
  it('says the line is over its exit and states no figure', async () => {
    const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'mix:bare' });
    const ctx = await mixContext(
      chains.get('solana'),
      async () => ({
        liquidity: { provider: fixtureLiquidity({ 'solana:nvda': 2000 }), source: '' },
      }),
      NOW,
    );
    const checked = await checkMix(ctx, [
      { assetId: 'solana:usdc', weightBps: 6000 },
      { assetId: 'solana:nvda', weightBps: 4000 },
    ]);
    const { review } = reviewMix(ctx, checked, {
      origin: 'model',
      goal: 'grow',
      risk: 'medium',
      amountUsd: 10_000,
      language: 'en',
      accepted: [],
    });
    const [warning] = review.warnings;
    expect(warning?.id).toBe('EXIT_OVER_CAPACITY:solana:nvda');
    expect(warning?.figures).toEqual([]);
    expect(warning?.text).toBe(
      'NVDAx at $4,000 is more than the part of its exit a plan counts on. That measurement names no source, so its limit is not stated.',
    );
    expect(review.lines[1]?.exitCeiling).toBeNull();
  });
});

describe('slippageOf: a rebalance builds and shows its trades at its own slippage', () => {
  it('reads maxSlippageBps of a rebalance as of a buy', () => {
    const vaults = [mockAddress('solana', 'v')];
    expect(slippageOf({ type: 'rebalance', vaults, reason: 'manual', maxSlippageBps: 250 })).toBe(
      250,
    );
    expect(slippageOf({ type: 'rebalance', vaults, reason: 'manual' })).toBe(100);
  });
});

describe('mixProposal: a stored plan the buy takes unchanged', () => {
  const lines = [
    { assetId: 'solana:usdc', weightBps: 1500 },
    { assetId: 'solana:nvda', weightBps: 3500 },
    { assetId: 'solana:yield', weightBps: 5000 },
  ];

  async function stored(person = 'did:privy:a', chain: 'solana' | 'robinhood' = 'solana') {
    const s = await setup(chain);
    const sent = lines.map((l) => ({ ...l, assetId: l.assetId.replace('solana', chain) }));
    const checked = await checkMix(s.ctx, sent);
    const reviewed = reviewMix(s.ctx, checked, {
      origin: 'model',
      goal: 'grow',
      risk: 'high',
      amountUsd: 2500,
      horizonMonths: 36,
      language: 'en',
      accepted: [`EXIT_OVER_CAPACITY:${chain}:nvda`],
    });
    const proposal = mixProposal(s.ctx, reviewed, checked, {
      person,
      origin: 'model',
      accepted: reviewed.review.warnings.map((w) => w.id),
      language: 'en',
    });
    return { s, proposal, reviewed };
  }

  it('keeps the weights, the cash share out of the recipe, the origin and every figure sourced', async () => {
    const { proposal } = await stored();
    expect(ProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.engineVersion).toBe(MIX_VERSION);
    expect(proposal.origin).toBe('model');
    expect(proposal.lines.map((l) => [l.assetId, l.weightBps, l.amountUsd])).toEqual([
      ['solana:usdc', 1500, 375],
      ['solana:nvda', 3500, 875],
      ['solana:yield', 5000, 1250],
    ]);
    expect(proposal.recipes).toEqual([
      {
        chain: 'solana',
        amountUsd: 2500,
        components: [
          { kind: 'asset', asset: 'solana:nvda', weightBps: 3500 },
          { kind: 'asset', asset: 'solana:yield', weightBps: 5000 },
        ],
      },
    ]);
    expect(proposal.sheet).toMatchObject({ goal: 'grow', risk: 'high', horizonMonths: 36 });
    expect(proposal.sheet.horizonOpen).toBeUndefined();
    expect(proposal.flags).toContain('origin:model');
    expect(proposal.flags).toContain('confirmed:EXIT_OVER_CAPACITY:solana:nvda');
    expect(proposal.lines[0]?.reasons[0]?.text).toBe(
      'USDC at 15%: proposed in your conversation, and confirmed by you.',
    );
    for (const o of proposal.observations) expect(o.source.length).toBeGreaterThan(0);
    expect(proposal.observations.map((o) => `${o.kind} ${o.id}`)).toEqual(
      expect.arrayContaining(['liquidity solana:nvda', 'price solana:nvda', 'price solana:yield']),
    );
  });

  it('is the same plan for the same person, and another for anybody else', async () => {
    const a = await stored('did:privy:a');
    const again = await stored('did:privy:a');
    const b = await stored('did:privy:b');
    expect(again.proposal.inputsHash).toBe(a.proposal.inputsHash);
    expect(b.proposal.inputsHash).not.toBe(a.proposal.inputsHash);
  });

  it.each([
    ['solana', ['create_vault', 'swap', 'swap']],
    ['robinhood', ['approve', 'create_vault']],
  ] as const)(
    'is bought by the existing buy on %s, into legs that buy exactly its targets',
    async (chain, kinds) => {
      const { s, proposal } = await stored('did:privy:a', chain);
      const plans = new Map<string, BasketProposal>([
        ['00000000-0000-4000-8000-000000000001', proposal],
      ]);
      const owner = { [chain === 'solana' ? 'solana' : 'evm']: mockAddress(chain, 'buyer') };
      const principal: Principal = {
        kind: 'user',
        userId: 'did:privy:a',
        wallets: [
          {
            family: chain === 'solana' ? 'solana' : 'evm',
            address: mockAddress(chain, 'buyer'),
          },
        ] as Principal['wallets'],
        ip: '127.0.0.1',
      };
      const { order } = await prepareOrder(
        {
          type: 'buy',
          owner,
          amountUsd: 2500,
          proposalId: '00000000-0000-4000-8000-000000000001',
        },
        {
          principal,
          chains: s.chains,
          loadProposal: async (id) => plans.get(id) ?? null,
          homeChain: async () => chain,
          loadFamilies: async () => [],
          now: NOW,
        },
      );
      expect(order.legs.map((l) => l.kind)).toEqual(kinds);
      const trades = order.legs.flatMap((l) => l.trades);
      // The vault takes its targets largest first (`targetsOf`): the same weights, in another order.
      expect(trades.map((t) => t.buy)).toEqual([`${chain}:yield`, `${chain}:nvda`]);
      // The invested share is 85%; the 15% cash share stays in the vault.
      const invested = trades.reduce((n, t) => n + BigInt(t.amountInRaw), 0n);
      expect(invested).toBe((BigInt(order.depositRaw ?? '0') * 8500n) / 10_000n);
      for (const leg of order.legs) expect(leg.expected).toHaveLength(leg.trades.length);
    },
  );
});

describe('planRetarget: a vault the person owns, to its new targets', () => {
  it('sets the targets, then sells and buys to them, each trade held to its stated minimum', async () => {
    const s = await setup();
    const owner = mockAddress('solana', 'retarget');
    const vault = await heldVault(s, owner);
    const checked = await checkMix(
      s.ctx,
      [
        { assetId: 'solana:usdc', weightBps: 2000 },
        { assetId: 'solana:spy', weightBps: 3000 },
        { assetId: 'solana:gold', weightBps: 5000 },
      ],
      vault,
    );
    expect(checked.prices.has('solana:tsla')).toBe(true);
    expect(vaultValueUsd(vault, checked.prices)).toBeCloseTo(999, 0);
    const { order, request } = await planRetarget(s.ctx, vault, checked, {
      slippageBps: 100,
      now: NOW,
      owner: vault.owner,
    });
    expect(order.type).toBe('rebalance');
    expect(order.basketId).toBe(vault.basketId);
    expect(order.depositRaw).toBeUndefined();
    expect(order.legs.map((l) => [l.kind, l.description])).toEqual([
      ['set_targets', "Set your vault's targets: SPYx 30%, mGOLD 50%, and 20% in cash"],
      ['swap', 'Sell TSLAx for cash'],
      ['swap', 'Sell SPYx for cash'],
      ['swap', 'Buy mGOLD'],
    ]);
    expect(request).toEqual({
      type: 'rebalance',
      vaults: [vault.address],
      reason: 'manual',
      targets: checked.targets,
      maxSlippageBps: 100,
    });
    for (const leg of order.legs) {
      expect(leg.expected).toHaveLength(leg.trades.length);
      await s.mock.send(await buildRetarget(request, leg, s.entry, owner, undefined));
    }
    const after = await s.entry.adapter.getVault(vault.address);
    expect(after?.autoFollow).toBe(false);
    const weights = new Map(after?.positions.map((p) => [p.asset, p.targetBps]));
    expect([...weights]).toEqual(
      expect.arrayContaining([
        ['solana:spy', 3000],
        ['solana:gold', 5000],
      ]),
    );
    const held = new Map(after?.positions.map((p) => [p.asset, Number(p.display)]));
    expect(held.get('solana:tsla') ?? 0).toBe(0);
    // At the mock's prices: SPY at $100 near $300, gold at $200 near $500, never past them.
    expect((held.get('solana:spy') ?? 0) * 100).toBeLessThanOrEqual(300);
    expect((held.get('solana:spy') ?? 0) * 100).toBeGreaterThan(295);
    expect((held.get('solana:gold') ?? 0) * 200).toBeLessThanOrEqual(500);
    expect((held.get('solana:gold') ?? 0) * 200).toBeGreaterThan(485);
  });

  it('warns that own targets end following and auto-follow', async () => {
    const s = await setup();
    const vault = await heldVault(s, mockAddress('solana', 'follows'), true);
    const checked = await checkMix(
      s.ctx,
      [
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'solana:spy', weightBps: 5000 },
      ],
      vault,
    );
    const { review } = reviewMix(s.ctx, checked, {
      origin: 'person',
      goal: null,
      risk: 'medium',
      amountUsd: vaultValueUsd(vault, checked.prices),
      language: 'en',
      accepted: [],
      vault,
    });
    expect(review.warnings.map((w) => w.id)).toEqual(['STOPS_FOLLOWING']);
    expect(review.goal).toBeNull();
  });

  it('builds no step for a vault the order owner does not own', async () => {
    const s = await setup();
    const vault = await heldVault(s, mockAddress('solana', 'mine'));
    const checked = await checkMix(
      s.ctx,
      [
        { assetId: 'solana:usdc', weightBps: 5000 },
        { assetId: 'solana:spy', weightBps: 5000 },
      ],
      vault,
    );
    const { order, request } = await planRetarget(s.ctx, vault, checked, {
      slippageBps: 100,
      now: NOW,
      owner: vault.owner,
    });
    const [first] = order.legs;
    if (!first) throw new Error('no step');
    const r = await refusal(
      buildRetarget(request, first, s.entry, mockAddress('solana', 'stranger'), undefined),
    );
    expect(r.status).toBe(404);
  });
});

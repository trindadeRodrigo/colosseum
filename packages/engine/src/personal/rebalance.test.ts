import type {
  BasketAsset,
  LiquidityAssessment,
  PlanSplitSleeve,
  Price,
  Trade,
  VaultState,
  YieldObservation,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './compose';
import {
  proposeSleeveRebalances,
  type SleeveProposal,
  type SleeveRebalanceContext,
  type StoredPlan,
} from './rebalance';
import { fixtureContext, launchShelf, sheet } from './testing';
import type { PersonalSheet } from './types';

// ENG-3 slice 4, rebalancing per sleeve (docs/vault/PROMPT-BUILD-SOLVER.md). Proposals the person
// taps, never sent here: drift at the band, deposits and withdrawals first, the safe-yield switch on
// the 7-day rule, the goal's set-aside refilled each month, the split restored only when the person
// chose it, and a likely liquidity breach before everything.

const ADDRESS = '11111111111111111111111111111111';
const NOW = '2026-10-20T15:00:00.000Z';
const shelfAssets = launchShelf().assets;
const listed = (id: string): BasketAsset => {
  const a = shelfAssets.find((x) => x.id === id);
  if (!a) throw new Error(`${id} is not on the launch shelf`);
  return a;
};
/** MOCK: rate-only tokens on Solana, for these tests only; the launch shelf lists none there. */
const rateToken = (symbol: string, issuer: string): BasketAsset => ({
  ...listed('solana:syrupusdc'),
  id: `solana:${symbol.toLowerCase()}`,
  symbol,
  underlying: symbol,
  issuer,
  provenance: 'fixture',
});
const ASSETS: BasketAsset[] = [
  listed('solana:usdc'),
  listed('solana:spyx'),
  listed('solana:nvdax'),
  listed('solana:syrupusdc'),
  rateToken('USDY', 'Ondo'),
  rateToken('SGOV', 'iShares'),
  rateToken('mYIELD', 'mock'),
];
const CASH = 'solana:usdc';
const SPY = 'solana:spyx';
const NVDA = 'solana:nvdax';
const SYRUP = 'solana:syrupusdc';
const USDY = 'solana:usdy';
const SGOV = 'solana:sgov';
const MYIELD = 'solana:myield';
const PRICE: Record<string, number> = {
  [SPY]: 500,
  [NVDA]: 100,
  [SYRUP]: 1,
  [USDY]: 1,
  [SGOV]: 1,
  [MYIELD]: 1,
};
const decimalsOf = (id: string) => ASSETS.find((a) => a.id === id)?.decimals ?? 0;

const price = (asset: string, usd: number): Price => ({
  source: 'test fixture',
  method: 'fixed in the test',
  fetchedAt: NOW,
  provenance: 'fixture',
  asset,
  usdPerToken: String(usd),
  ageSeconds: 0,
  maxAgeSeconds: 120,
  market: 'open',
});
const PRICES = Object.entries(PRICE).map(([id, usd]) => price(id, usd));

/** Raw units of `usd` of a token at the fixture price. */
const rawOf = (id: string, usd: number): bigint =>
  (BigInt(Math.round(usd * 100)) * 10n ** BigInt(decimalsOf(id))) /
  (BigInt(Math.round((id === CASH ? 1 : (PRICE[id] ?? 1)) * 100)) * 1n);

/** A vault on Solana holding these dollars of each token; the cash under `solana:usdc`. */
function vault(usd: Record<string, number>): VaultState {
  const holding = (asset: string, raw: bigint) => ({
    asset,
    raw: raw.toString(),
    multiplier: '1',
    display: '0',
  });
  return {
    chain: 'solana',
    address: ADDRESS,
    owner: ADDRESS,
    basketId: '1',
    recipeOnchainId: null,
    acceptedVersion: 0,
    autoFollow: false,
    keeper: ADDRESS,
    cash: holding(CASH, rawOf(CASH, usd[CASH] ?? 0)),
    positions: Object.entries(usd)
      .filter(([id]) => id !== CASH)
      .map(([id, v]) => ({ ...holding(id, rawOf(id, v)), targetBps: 0, lastKeeperAt: null })),
    lossUsedBps: 0,
    observedAt: NOW,
    pending: null,
  };
}

/** What a vault holds, in dollars, at the fixture prices. */
function dollarsIn(v: VaultState): Record<string, number> {
  const usd = (id: string, raw: string) =>
    (Number(raw) / 10 ** decimalsOf(id)) * (id === CASH ? 1 : (PRICE[id] ?? 0));
  return Object.fromEntries([
    [CASH, usd(CASH, v.cash.raw)],
    ...v.positions.map((p) => [p.asset, usd(p.asset, p.raw)]),
  ]);
}

/** The vault after the trades land at the fixture prices, at no cost. */
function applied(v: VaultState, trades: Trade[]): VaultState {
  const usd = dollarsIn(v);
  for (const t of trades) {
    const inUsd =
      (Number(t.amountInRaw) / 10 ** decimalsOf(t.sell)) *
      (t.sell === CASH ? 1 : (PRICE[t.sell] ?? 0));
    usd[t.sell] = (usd[t.sell] ?? 0) - inUsd;
    usd[t.buy] = (usd[t.buy] ?? 0) + inUsd;
  }
  return vault(usd);
}

const plan = (
  lines: Record<string, number>,
  over: Partial<PersonalSheet> = {},
  split?: PlanSplitSleeve[],
): StoredPlan => ({
  sheet: sheet({ chains: ['solana'], ...over }),
  lines: Object.entries(lines).map(([assetId, amountUsd]) => ({ assetId, amountUsd })),
  ...(split ? { split } : {}),
});

const context = (
  v: VaultState,
  over: Partial<SleeveRebalanceContext> = {},
): SleeveRebalanceContext => ({
  now: NOW,
  vault: v,
  prices: PRICES,
  assets: ASSETS,
  ...over,
});

const sold = (p: SleeveProposal) => p.plan.trades.filter((t) => t.buy === CASH).map((t) => t.sell);
const bought = (p: SleeveProposal) =>
  p.plan.trades.filter((t) => t.sell === CASH).map((t) => t.buy);
const usdOf = (t: Trade) =>
  (Number(t.amountInRaw) / 10 ** decimalsOf(t.sell)) * (t.sell === CASH ? 1 : (PRICE[t.sell] ?? 0));

// One goal sleeve: 50% SPYx, 40% syrupUSDC, 10% cash.
const ONE = plan({ [SPY]: 5000, [SYRUP]: 4000, [CASH]: 1000 });

describe('drift inside a sleeve', () => {
  it('proposes nothing under 5 points, and a rebalance at 5', () => {
    const under = proposeSleeveRebalances(
      ONE,
      context(vault({ [SPY]: 5490, [SYRUP]: 3510, [CASH]: 1000 })),
    );
    expect(under.proposals).toEqual([]);
    const at = vault({ [SPY]: 5500, [SYRUP]: 3500, [CASH]: 1000 });
    const out = proposeSleeveRebalances(ONE, context(at));
    expect(out.proposals).toHaveLength(1);
    const [p] = out.proposals as [SleeveProposal];
    expect(p).toMatchObject({ kind: 'drift', sleeve: { kind: 'goal' }, driftBps: 500 });
    expect(sold(p)).toEqual([SPY]);
    expect(bought(p)).toEqual([SYRUP]);
    expect(p.reasons.map((r) => r.rule)).toEqual(['REBALANCE_DRIFT']);
    // Once the trades land, the sleeve is back inside the band and nothing more is proposed.
    const after = proposeSleeveRebalances(ONE, context(applied(at, p.plan.trades)));
    expect(after.proposals).toEqual([]);
  });

  it('brings a sleeve far off back to its targets', () => {
    const far = vault({ [SPY]: 7000, [SYRUP]: 2000, [CASH]: 1000 });
    const [p] = proposeSleeveRebalances(ONE, context(far)).proposals as [SleeveProposal];
    expect(p.driftBps).toBe(2000);
    const usd = dollarsIn(applied(far, p.plan.trades));
    // Within a point of each target: the purchases keep a margin for a 1% cost (tau).
    expect(Math.abs((usd[SPY] ?? 0) - 5000)).toBeLessThan(100);
    expect(Math.abs((usd[SYRUP] ?? 0) - 4000)).toBeLessThan(100);
  });
});

describe('deposits and withdrawals come first', () => {
  it('new money buys what is under target, and nothing is sold', () => {
    // syrupUSDC is 6.7 points under: a deposit that fills the gap moves no other token.
    const v = vault({ [SPY]: 5000, [SYRUP]: 3000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(ONE, context(v, { deposit: String(rawOf(CASH, 1000)) }));
    const [p] = out.proposals as [SleeveProposal];
    expect(p.kind).toBe('flow');
    expect(sold(p)).toEqual([]);
    expect(bought(p)).toEqual([SYRUP]);
    expect(p.reasons.map((r) => r.rule)).toEqual(['REBALANCE_DEPOSIT']);
  });

  it('a withdrawal comes from what is over target, and nothing is bought', () => {
    const v = vault({ [SPY]: 5500, [SYRUP]: 4000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(ONE, context(v, { withdrawal: String(rawOf(CASH, 500)) }));
    const [p] = out.proposals as [SleeveProposal];
    expect(p.kind).toBe('flow');
    expect(sold(p)).toEqual([SPY]);
    expect(bought(p)).toEqual([]);
    // At least the withdrawal, and no more than a target's rounding to whole basis points over it.
    const out500 = usdOf(p.plan.trades[0] as Trade);
    expect(out500).toBeGreaterThanOrEqual(500);
    expect(out500).toBeLessThan(502);
  });

  it('a deposit too small to close the drift places what it can, then rebalances the rest', () => {
    const v = vault({ [SPY]: 7000, [SYRUP]: 2000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(ONE, context(v, { deposit: String(rawOf(CASH, 500)) }));
    const [p] = out.proposals as [SleeveProposal];
    expect(p.kind).toBe('flow');
    expect(p.reasons.map((r) => r.rule)).toEqual(['REBALANCE_DEPOSIT', 'REBALANCE_DRIFT']);
    expect(sold(p)).toEqual([SPY]);
  });

  it('refuses a withdrawal larger than the vault', () => {
    const v = vault({ [SPY]: 500, [CASH]: 100 });
    expect(() =>
      proposeSleeveRebalances(ONE, context(v, { withdrawal: String(rawOf(CASH, 1000)) })),
    ).toThrow(/InvalidContext/);
  });
});

// The safe-yield sleeve: 30% in USDY. The goal sleeve: SPYx and cash.
const SAFE_SPLIT: PlanSplitSleeve[] = [
  { kind: 'goal', shareBps: 7000, amountUsd: 7000, holds: [] },
  {
    kind: 'safe_yield',
    shareBps: 3000,
    amountUsd: 3000,
    holds: [{ assetId: USDY, amountUsd: 3000 }],
  },
];
const SAFE = plan({ [SPY]: 6000, [USDY]: 3000, [CASH]: 1000 }, {}, SAFE_SPLIT);
const SAFE_VAULT = vault({ [SPY]: 6000, [USDY]: 3000, [CASH]: 1000 });

const DAY = '2026-10-';
/** A reading on day `d` of October 2026. */
const reading = (assetId: string, d: number, haircutYield: number): YieldObservation => ({
  assetId,
  quotedYield: haircutYield,
  haircutYield,
  haircutRule: 'none (test)',
  source: 'test fixture',
  method: 'fixed in the test',
  fetchedAt: `${DAY}${String(d).padStart(2, '0')}T12:00:00.000Z`,
  provenance: 'fixture',
});
/** Readings for `days` days ending on the 20th (the day of NOW), skipping `gaps` for `ahead`. */
function history(
  days: number,
  ahead: string[] = [SGOV],
  gaps: number[] = [],
  aheadYield = 0.05,
): YieldObservation[] {
  const out: YieldObservation[] = [];
  for (let d = 20 - days + 1; d <= 20; d++) {
    out.push(reading(USDY, d, 0.04));
    for (const id of ahead) if (!gaps.includes(d)) out.push(reading(id, d, aheadYield));
  }
  // Before the run: a day when USDY was ahead, so the run cannot start earlier.
  out.push(reading(USDY, 20 - days, 0.06), ...ahead.map((id) => reading(id, 20 - days, 0.05)));
  return out;
}

describe('the safe-yield sleeve switches only on the 7-day rule', () => {
  const run = (yields: YieldObservation[], over: Partial<SleeveRebalanceContext> = {}) =>
    proposeSleeveRebalances(SAFE, context(SAFE_VAULT, { yields, ...over }));

  it('6 days ahead: no switch', () => {
    expect(run(history(6)).proposals).toEqual([]);
  });

  it('7 days ahead: switch, with the readings it was decided on', () => {
    const out = run(history(7));
    const [p] = out.proposals as [SleeveProposal];
    expect(p).toMatchObject({ kind: 'safe_yield_switch', sleeve: { kind: 'safe_yield' } });
    expect(sold(p)).toEqual([USDY]);
    expect(bought(p)).toEqual([SGOV]);
    expect(p.targets.map((t) => t.asset)).toEqual([SGOV]);
    expect(p.reasons.map((r) => r.rule)).toEqual(['SAFE_YIELD_SWITCH']);
    expect(p.observations).toHaveLength(14);
    for (const o of p.observations ?? [])
      expect(o).toMatchObject({ source: expect.any(String), method: expect.any(String) });
  });

  it('a gap day breaks the run', () => {
    expect(run(history(7, [SGOV], [17])).proposals).toEqual([]);
  });

  it('a day not yet read counts from the day before', () => {
    // The 21st has no reading yet: the run ends on the 20th.
    expect(run(history(7), { now: '2026-10-21T01:00:00.000Z' }).proposals).toHaveLength(1);
  });

  it('ahead by exactly the band is not ahead', () => {
    expect(run(history(7, [SGOV], [], 0.045)).proposals).toEqual([]);
  });

  it('ties break by id', () => {
    const [p] = run(history(7, [SGOV, MYIELD])).proposals as [SleeveProposal];
    expect(bought(p)).toEqual([MYIELD]);
  });

  it('stops at the cap per asset of the plan, and says so', () => {
    const big: PlanSplitSleeve[] = [
      { kind: 'goal', shareBps: 4000, amountUsd: 4000, holds: [] },
      {
        kind: 'safe_yield',
        shareBps: 6000,
        amountUsd: 6000,
        holds: [{ assetId: USDY, amountUsd: 6000 }],
      },
    ];
    const out = proposeSleeveRebalances(
      plan({ [SPY]: 3000, [USDY]: 6000, [CASH]: 1000 }, {}, big),
      context(vault({ [SPY]: 3000, [USDY]: 6000, [CASH]: 1000 }), { yields: history(7) }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(p.reasons.map((r) => r.rule)).toEqual(['SAFE_YIELD_SWITCH', 'SAFE_YIELD_SWITCH_CAPPED']);
    // A rate leg takes at most 40% of the plan: $4,000 of the $6,000 moves.
    expect(p.targets).toEqual([
      { asset: SGOV, weightBps: 6666 },
      { asset: USDY, weightBps: 3333 },
    ]);
  });
});

describe('the goal sleeve refills its set-aside each month', () => {
  const obligations = Array.from({ length: 12 }, (_, i) => ({
    month: `${2026 + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}`,
    amount: 500,
    currency: 'USD',
  }));
  // Made in October: six months of $500 set aside in cash, and SPYx.
  const withdrawing = plan({ [SPY]: 7000, [CASH]: 3000 }, { obligations });

  it('refills what this month paid out, from the rest of the sleeve', () => {
    // November: October's withdrawal paid from the cash, so $2,500 is left for $3,000 owed.
    const v = vault({ [SPY]: 7000, [CASH]: 2500 });
    const out = proposeSleeveRebalances(
      withdrawing,
      context(v, { now: '2026-11-03T12:00:00.000Z', paidThrough: '2026-10' }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(p.kind).toBe('set_aside_refill');
    expect(sold(p)).toEqual([SPY]);
    expect(bought(p)).toEqual([]);
    expect(usdOf(p.plan.trades[0] as Trade)).toBeGreaterThan(450);
    const said = p.reasons.find((r) => r.rule === 'SET_ASIDE_REFILL');
    expect(said?.params).toMatchObject({
      from: '2026-11',
      to: '2027-04',
      owedUsd: 3000,
      heldUsd: 2500,
    });
    // December: the same again, a month on.
    const next = applied(v, p.plan.trades);
    const dec = dollarsIn(next);
    const paid = vault({ [SPY]: dec[SPY] ?? 0, [CASH]: (dec[CASH] ?? 0) - 500 });
    const again = proposeSleeveRebalances(
      withdrawing,
      context(paid, { now: '2026-12-02T12:00:00.000Z', paidThrough: '2026-11' }),
    );
    expect(again.proposals.map((x) => x.kind)).toEqual(['set_aside_refill']);
  });

  it('proposes nothing when the set-aside is whole', () => {
    const v = vault({ [SPY]: 7000, [CASH]: 3000 });
    const out = proposeSleeveRebalances(
      withdrawing,
      context(v, { now: '2026-10-03T12:00:00.000Z' }),
    );
    expect(out.proposals).toEqual([]);
  });

  it('a withdrawal in another currency with no FX reading is not counted, and is flagged', () => {
    const inReais = plan(
      { [SPY]: 7000, [CASH]: 3000 },
      {
        obligations: [{ month: '2026-11', amount: 3000, currency: 'BRL' }],
      },
    );
    const out = proposeSleeveRebalances(
      inReais,
      context(vault({ [SPY]: 7000, [CASH]: 100 }), { now: '2026-11-03T12:00:00.000Z' }),
    );
    expect(out.flags).toContain('refill_no_fx:BRL');
    expect(out.proposals.map((p) => p.kind)).not.toContain('set_aside_refill');
  });
});

// Half for the goal (SPYx and cash), half for the AI theme (NVDAx and syrupUSDC to make drift possible).
const THEME_SPLIT: PlanSplitSleeve[] = [
  { kind: 'goal', shareBps: 5000, amountUsd: 5000, holds: [] },
  {
    kind: 'theme',
    theme: 'ai',
    shareBps: 5000,
    amountUsd: 5000,
    holds: [
      { assetId: NVDA, amountUsd: 4000 },
      { assetId: SYRUP, amountUsd: 1000 },
    ],
  },
];
const THEMED = { [SPY]: 4000, [CASH]: 1000, [NVDA]: 4000, [SYRUP]: 1000 };
const tokensOf = (p: SleeveProposal) => new Set([...sold(p), ...bought(p)]);

describe('between sleeves, nothing moves unless the person chose to restore the split', () => {
  it('with restoreSplit off, a theme that has grown is left grown', () => {
    // NVDAx doubled: the theme is now 9,000 of 14,000. Inside each sleeve, nothing is off.
    const grown = vault({ ...THEMED, [NVDA]: 8000, [SYRUP]: 2000 });
    const out = proposeSleeveRebalances(plan(THEMED, {}, THEME_SPLIT), context(grown));
    expect(out.splitDriftBps).toBeGreaterThan(500);
    expect(out.proposals).toEqual([]);
  });

  it('with restoreSplit off, each sleeve trades only its own tokens and spends only its own cash', () => {
    const off = vault({ [SPY]: 5000, [CASH]: 500, [NVDA]: 3000, [SYRUP]: 2000 });
    const out = proposeSleeveRebalances(plan(THEMED, {}, THEME_SPLIT), context(off));
    expect(out.proposals.map((p) => p.sleeve?.kind)).toEqual(['goal', 'theme']);
    const [goal, theme] = out.proposals as [SleeveProposal, SleeveProposal];
    expect([...tokensOf(goal)]).toEqual([SPY]);
    expect([...tokensOf(theme)].sort()).toEqual([NVDA, SYRUP]);
    for (const p of out.proposals) {
      const salesUsd = p.plan.trades
        .filter((t) => t.buy === CASH)
        .reduce((n, t) => n + usdOf(t), 0);
      const buysUsd = p.plan.trades
        .filter((t) => t.sell === CASH)
        .reduce((n, t) => n + usdOf(t), 0);
      // What a sleeve buys is what it sold plus the cash it holds: the theme holds none.
      if (p.sleeve?.kind === 'theme') expect(buysUsd).toBeLessThanOrEqual(salesUsd + 0.01);
    }
  });

  it('with restoreSplit on, the split is restored at the band, in one proposal for the plan', () => {
    const grown = vault({ ...THEMED, [NVDA]: 8000, [SYRUP]: 2000 });
    const out = proposeSleeveRebalances(
      plan(THEMED, { restoreSplit: true }, THEME_SPLIT),
      context(grown),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(out.proposals).toHaveLength(1);
    expect(p).toMatchObject({ kind: 'restore_split', sleeve: null });
    expect(sold(p).sort()).toEqual([NVDA, SYRUP]);
    expect(bought(p)).toEqual([SPY]);
    const usd = dollarsIn(applied(grown, p.plan.trades));
    // Back to half and half, within the margin the purchases keep.
    expect(((usd[NVDA] ?? 0) + (usd[SYRUP] ?? 0)) / 14_000).toBeCloseTo(0.5, 1);
  });

  it('with restoreSplit on and the split inside the band, nothing moves between sleeves', () => {
    const near = vault({ ...THEMED, [NVDA]: 4300 });
    const out = proposeSleeveRebalances(
      plan(THEMED, { restoreSplit: true }, THEME_SPLIT),
      context(near),
    );
    expect(out.splitDriftBps).toBeLessThan(500);
    expect(out.proposals.map((p) => p.kind)).not.toContain('restore_split');
  });
});

describe('a likely liquidity breach comes before everything', () => {
  const assessment: LiquidityAssessment = {
    breach: false,
    likelyBreach: true,
    shortfallUsd: 812.4,
    monthsAtRisk: ['2027-01'],
    orders: [{ fromAssetId: SPY, toAssetId: 'usdc', amountUsd: 1000, reason: 'liquidity_breach' }],
    params: { tau: 0.01 },
    methodVersion: 'risk-0.2',
  };

  it('its sales come first and alone, and the drift proposal waits', () => {
    const drifted = vault({ [SPY]: 7000, [SYRUP]: 2000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(ONE, context(drifted, { liquidity: assessment }));
    expect(out.proposals.map((p) => p.kind)).toEqual(['liquidity_breach']);
    const [p] = out.proposals as [SleeveProposal];
    expect(p.plan.trades).toEqual([
      { sell: SPY, buy: CASH, amountInRaw: String(rawOf(SPY, 1000)) },
    ]);
    expect(p.reasons[0]?.text).toMatch(/January 2027/);
    expect(out.waiting).toEqual([{ kind: 'drift', sleeve: { kind: 'goal' } }]);
  });

  it('an assessment with no likely breach changes nothing', () => {
    const drifted = vault({ [SPY]: 7000, [SYRUP]: 2000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(
      ONE,
      context(drifted, { liquidity: { ...assessment, likelyBreach: false } }),
    );
    expect(out.proposals.map((p) => p.kind)).toEqual(['drift']);
  });
});

describe('the same inputs give the same proposals, in any order', () => {
  const shuffle = <T>(xs: T[]) => [...xs].reverse();
  it('is deterministic and does not depend on the order of anything', () => {
    const v = vault({ [SPY]: 5000, [CASH]: 500, [NVDA]: 3000, [SYRUP]: 2000 });
    const stored = plan(THEMED, {}, THEME_SPLIT);
    const ctx = context(v, { yields: history(7), deposit: String(rawOf(CASH, 300)) });
    const once = proposeSleeveRebalances(stored, ctx);
    expect(proposeSleeveRebalances(stored, ctx)).toEqual(once);
    const shuffled = proposeSleeveRebalances(
      { ...stored, lines: shuffle(stored.lines), split: shuffle(THEME_SPLIT) },
      {
        ...ctx,
        vault: { ...v, positions: shuffle(v.positions) },
        prices: shuffle(PRICES),
        assets: shuffle(ASSETS),
        yields: shuffle(ctx.yields ?? []),
      },
    );
    expect(shuffled).toEqual(once);
  });
});

describe('every proposal is explained, in English and Portuguese', () => {
  it('writes its reasons in the language of the sheet', () => {
    const pt = plan({ [SPY]: 6000, [USDY]: 3000, [CASH]: 1000 }, { language: 'pt' }, SAFE_SPLIT);
    const [p] = proposeSleeveRebalances(pt, context(SAFE_VAULT, { yields: history(7) }))
      .proposals as [SleeveProposal];
    expect(p.reasons[0]?.text).toBe(
      'Na parte do seu plano em rendimento em dólar só de taxa, USDY passa para SGOV: em cada um dos últimos 7 dias de leituras, SGOV rendeu mais que USDY após o deságio, por mais de 0,5% ao ano.',
    );
    const [en] = proposeSleeveRebalances(SAFE, context(SAFE_VAULT, { yields: history(7) }))
      .proposals as [SleeveProposal];
    expect(en.reasons[0]?.text).toBe(
      'In the part of your plan in dollar yield from a rate alone, USDY moves to SGOV: on each of the last 7 days of readings, SGOV yielded more than USDY after haircut, by over 0.5% a year.',
    );
  });
});

describe('a plan as compose makes it', () => {
  it('held as made, proposes nothing', () => {
    const shelf = launchShelf();
    const made = compose(
      sheet({
        chains: ['solana'],
        sleeves: [
          { kind: 'goal', shareBps: 6000 },
          { kind: 'safe_yield', shareBps: 4000 },
        ],
      }),
      shelf,
      fixtureContext(),
    );
    const assets = shelf.assets.filter((a) => a.chain === 'solana');
    const prices = made.lines.filter((l) => l.assetId !== CASH).map((l) => price(l.assetId, 1));
    const held: VaultState = {
      ...vault({}),
      cash: {
        asset: CASH,
        raw: String(Math.round((made.lines.find((l) => l.assetId === CASH)?.amountUsd ?? 0) * 1e6)),
        multiplier: '1',
        display: '0',
      },
      positions: made.lines
        .filter((l) => l.assetId !== CASH)
        .map((l) => ({
          asset: l.assetId,
          raw: String(
            BigInt(Math.round(l.amountUsd * 100)) *
              10n ** BigInt((assets.find((a) => a.id === l.assetId)?.decimals ?? 2) - 2),
          ),
          multiplier: '1',
          display: '0',
          targetBps: l.weightBps,
          lastKeeperAt: null,
        })),
    };
    const out = proposeSleeveRebalances(made, { now: NOW, vault: held, prices, assets });
    expect(made.split?.map((x) => x.kind)).toEqual(['goal', 'safe_yield']);
    expect(out.proposals).toEqual([]);
    expect(out.splitDriftBps).toBeLessThan(10);
  });
});

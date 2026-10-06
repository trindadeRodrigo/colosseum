import type {
  BasketAsset,
  LiquidityAssessment,
  LiquidityProvider,
  PlanSplitSleeve,
  Price,
  Trade,
  VaultState,
  YieldObservation,
} from '@colosseum/schemas';
import { BasketProposalBase, PlanCandidateId } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './compose';
import {
  proposeSleeveRebalances,
  type SleeveBook,
  type SleeveProposal,
  type SleeveProposals,
  type SleeveRebalanceContext,
  type StoredPlan,
  settleBook,
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

/** Raw units of a vault, by token, cash included. */
function rawIn(v: VaultState): Map<string, bigint> {
  const m = new Map<string, bigint>([[CASH, BigInt(v.cash.raw)]]);
  for (const p of v.positions) m.set(p.asset, (m.get(p.asset) ?? 0n) + BigInt(p.raw));
  return m;
}
/** A vault from raw units, by token. */
function vaultOfRaw(raw: Map<string, bigint>): VaultState {
  const v = vault({});
  return {
    ...v,
    cash: { ...v.cash, raw: (raw.get(CASH) ?? 0n).toString() },
    positions: [...raw.keys()]
      .filter((k) => k !== CASH && (raw.get(k) ?? 0n) > 0n)
      .sort()
      .map((asset) => ({
        asset,
        raw: (raw.get(asset) ?? 0n).toString(),
        multiplier: '1',
        display: '0',
        targetBps: 0,
        lastKeeperAt: null,
      })),
  };
}
const priceInt = (id: string) => BigInt(id === CASH ? 1 : (PRICE[id] ?? 0));
const unitOf = (id: string) => 10n ** BigInt(decimalsOf(id));
/**
 * What each trade really takes in and brings out at the fixture prices, exactly in raw units, with
 * `costBps` taken off what it brings out, as a pool would.
 */
const fillsOf = (trades: Trade[], costBps = 0n) =>
  trades.map((t) => {
    const amount = BigInt(t.amountInRaw);
    const out =
      t.buy === CASH
        ? (amount * priceInt(t.sell) * unitOf(CASH)) / unitOf(t.sell)
        : (amount * unitOf(t.buy)) / (priceInt(t.buy) * unitOf(CASH));
    return { inRaw: amount.toString(), outRaw: ((out * (10_000n - costBps)) / 10_000n).toString() };
  });
function applyFills(v: VaultState, trades: Trade[], fills: { inRaw: string; outRaw: string }[]) {
  const raw = rawIn(v);
  trades.forEach((t, i) => {
    raw.set(t.sell, (raw.get(t.sell) ?? 0n) - BigInt(fills[i]?.inRaw ?? '0'));
    raw.set(t.buy, (raw.get(t.buy) ?? 0n) + BigInt(fills[i]?.outRaw ?? '0'));
  });
  return vaultOfRaw(raw);
}
/** The vault after the trades land at the fixture prices, less `costBps` on what each brings out. */
const applied = (v: VaultState, trades: Trade[], costBps = 0n) =>
  applyFills(v, trades, fillsOf(trades, costBps));
const withCash = (v: VaultState, delta: bigint): VaultState => ({
  ...v,
  cash: { ...v.cash, raw: (BigInt(v.cash.raw) + delta).toString() },
});

/** A sleeve book from dollars of each token per sleeve. */
const bookOf = (rows: Record<string, Record<string, number>>): SleeveBook =>
  Object.entries(rows).map(([sleeve, usd]) => ({
    sleeve,
    holds: Object.entries(usd).map(([asset, v]) => ({ asset, raw: rawOf(asset, v).toString() })),
  }));
/** A vault holding what the book holds. */
const vaultOfBook = (book: SleeveBook): VaultState => {
  const raw = new Map<string, bigint>();
  for (const r of book)
    for (const h of r.holds) raw.set(h.asset, (raw.get(h.asset) ?? 0n) + BigInt(h.raw));
  return vaultOfRaw(raw);
};
/** A sleeve's dollars in a book, at the fixture prices. */
const sleeveUsd = (book: SleeveBook, sleeve: string) =>
  (book.find((r) => r.sleeve === sleeve)?.holds ?? []).reduce(
    (n, h) => n + (Number(h.raw) / 10 ** decimalsOf(h.asset)) * Number(priceInt(h.asset)),
    0,
  );
/**
 * Every proposal of an answer carried out in one batch, each trade at its own fill, then the book
 * settled once from the book as given (`book`, or the answer's when none was given), with the
 * answer's flows when `deposit` says the deposit landed.
 */
function carryOut(
  out: SleeveProposals,
  v: VaultState,
  opts: { book?: SleeveBook; costBps?: bigint; deposit?: boolean } = {},
) {
  let now = opts.deposit
    ? withCash(
        v,
        out.flows.reduce((n, f) => n + BigInt(f.depositRaw), 0n),
      )
    : v;
  const executions = out.proposals.map((p) => {
    const fills = fillsOf(p.plan.trades, opts.costBps);
    now = applyFills(now, p.plan.trades, fills);
    return { proposal: p, fills };
  });
  const before = opts.book ?? out.book;
  const settled = settleBook(before, executions, now, opts.deposit ? out.flows : []);
  return { book: settled.book, unowned: settled.unowned, vault: now };
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
    expect(out.bookFrom).toBe('one_sleeve');
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
    // The book as read has the deposit in the sleeve's cash.
    expect(sleeveUsd(out.book, 'goal')).toBeCloseTo(10_000, 2);
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
    // After the trades and the withdrawal, the book holds $10,000.
    expect(sleeveUsd(p.bookAfter, 'goal')).toBeCloseTo(10_000, 0);
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
/** A reading on day `d` of October 2026, labelled a fixture: it is not live. */
const reading = (
  assetId: string,
  d: number,
  haircutYield: number,
  over: Partial<YieldObservation> = {},
): YieldObservation => ({
  assetId,
  quotedYield: haircutYield,
  haircutYield,
  haircutRule: 'none (test)',
  source: 'test fixture',
  method: 'fixed in the test',
  fetchedAt: `${DAY}${String(d).padStart(2, '0')}T12:00:00.000Z`,
  provenance: 'fixture',
  ...over,
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
/** The fixture readings are not live: the tests let them count, and the proposal says MOCK. */
const FIXTURE_READINGS: Partial<SleeveRebalanceContext> = { readingsFrom: ['fixture'] };
/** The caller's word that the vault has not traded since it was bought as the plan. */
const JUST_BOUGHT = { boughtAsPlanned: true as const };

/** A liquidity provider with these exit capacities, in dollars, at any cost. */
const provider = (capacityUsd: Record<string, number>): LiquidityProvider =>
  ({
    methodVersion: 'test',
    provenance: 'fixture',
    covers: (id: string) => id in capacityUsd,
    exitCapacity: (id: string) =>
      id in capacityUsd
        ? {
            capacityUsd: capacityUsd[id] ?? 0,
            lowerBound: false,
            regime: 'weekend',
            samples: 10,
            dataFrom: null,
            dataTo: null,
          }
        : null,
    exitCost: () => null,
    entry: () => null,
    assess: () => {
      throw new Error('not used');
    },
  }) as unknown as LiquidityProvider;

describe('the safe-yield sleeve switches only on the 7-day rule', () => {
  const run = (yields: YieldObservation[], over: Partial<SleeveRebalanceContext> = {}) =>
    proposeSleeveRebalances(
      SAFE,
      context(SAFE_VAULT, { yields, ...FIXTURE_READINGS, ...JUST_BOUGHT, ...over }),
    );

  it('6 days ahead: no switch', () => {
    expect(run(history(6)).proposals).toEqual([]);
  });

  it('7 days ahead: switch, with the readings it was decided on, said MOCK when they are not live', () => {
    const out = run(history(7));
    expect(out.bookFrom).toBe('plan');
    const [p] = out.proposals as [SleeveProposal];
    expect(p).toMatchObject({
      kind: 'safe_yield_switch',
      sleeve: { kind: 'safe_yield' },
      provenance: 'mock',
    });
    expect(sold(p)).toEqual([USDY]);
    expect(bought(p)).toEqual([SGOV]);
    expect(p.targets.map((t) => t.asset)).toEqual([SGOV]);
    expect(p.reasons.map((r) => r.rule)).toEqual(['SAFE_YIELD_SWITCH', 'SWITCH_MOCK']);
    expect(p.observations).toHaveLength(14);
    for (const o of p.observations ?? [])
      expect(o).toMatchObject({ source: expect.any(String), method: expect.any(String) });
  });

  // Gate COUNTRY-REMOVED (Oct 6): a token blocked in the person's country is switched to all the
  // same; the switch read `blockedCountries` until then.
  it('switches to a token blocked in the person’s country: the country is not read', () => {
    const country = SAFE.sheet.country ?? 'BR';
    const assets = ASSETS.map((a) => (a.id === SGOV ? { ...a, blockedCountries: [country] } : a));
    const [p] = run(history(7), { assets }).proposals as [SleeveProposal];
    expect(bought(p)).toEqual([SGOV]);
  });

  it('readings that are not live never trigger it by default', () => {
    expect(run(history(7), { readingsFrom: undefined }).proposals).toEqual([]);
    const live = history(7).map((o) => ({ ...o, provenance: 'live' as const }));
    const [p] = run(live, { readingsFrom: undefined }).proposals as [SleeveProposal];
    expect(p.provenance).toBeUndefined();
    expect(p.reasons.map((r) => r.rule)).toEqual(['SAFE_YIELD_SWITCH']);
  });

  it('a gap day breaks the run', () => {
    expect(run(history(7, [SGOV], [17])).proposals).toEqual([]);
  });

  it('a day not yet read counts from the day before', () => {
    // The 21st has no reading yet: the run ends on the 20th.
    expect(run(history(7), { now: '2026-10-21T01:00:00.000Z' }).proposals).toHaveLength(1);
  });

  it('whether today is read looks only at the two tokens compared', () => {
    // Another token read on the 21st does not make the 21st count for USDY and SGOV.
    const other = [...history(7), reading(MYIELD, 21, 0.01)];
    expect(run(other, { now: '2026-10-21T18:00:00.000Z' }).proposals).toHaveLength(1);
  });

  it('ahead by exactly the band is not ahead', () => {
    expect(run(history(7, [SGOV], [], 0.045)).proposals).toEqual([]);
  });

  it('ties break by id', () => {
    const [p] = run(history(7, [SGOV, MYIELD])).proposals as [SleeveProposal];
    expect(bought(p)).toEqual([MYIELD]);
  });

  it('two readings of one time give one answer, in any order', () => {
    // On the 20th SGOV has two readings at the same time; the higher counts, whatever the order.
    const twice = [...history(7), reading(SGOV, 20, 0.041, { source: 'a second feed' })];
    const a = run(twice);
    const b = run([...twice].reverse());
    expect(a).toEqual(b);
    expect(a.proposals).toHaveLength(1);
  });

  const big: PlanSplitSleeve[] = [
    { kind: 'goal', shareBps: 4000, amountUsd: 4000, holds: [] },
    {
      kind: 'safe_yield',
      shareBps: 6000,
      amountUsd: 6000,
      holds: [{ assetId: USDY, amountUsd: 6000 }],
    },
  ];
  const bigPlan = plan({ [SPY]: 3000, [USDY]: 6000, [CASH]: 1000 }, {}, big);
  const bigVault = vault({ [SPY]: 3000, [USDY]: 6000, [CASH]: 1000 });

  it('stops at the cap per asset of the plan, and says so', () => {
    const out = proposeSleeveRebalances(
      bigPlan,
      context(bigVault, { yields: history(7), ...FIXTURE_READINGS, ...JUST_BOUGHT }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(p.reasons.map((r) => r.rule)).toEqual([
      'SAFE_YIELD_SWITCH',
      'SAFE_YIELD_SWITCH_CAPPED',
      'SWITCH_MOCK',
    ]);
    // A rate leg takes at most 40% of the plan: $4,000 of the $6,000 moves.
    expect(p.targets).toEqual([
      { asset: SGOV, weightBps: 6666 },
      { asset: USDY, weightBps: 3333 },
    ]);
    // Nothing is measured for SGOV: its tier stood in, and the answer says so.
    expect(out.flags).toContain(`ceiling_from_tier:${SGOV}`);
  });

  it("stops at the token's measured exit ceiling (EXIT-SOURCE), and says so", () => {
    // $4,000 of capacity: a quarter of it, $1,000, may go to SGOV.
    const out = run(history(7), { liquidity: provider({ [SGOV]: 4000 }) });
    const [p] = out.proposals as [SleeveProposal];
    expect(p.reasons.map((r) => r.rule)).toEqual([
      'SAFE_YIELD_SWITCH',
      'SAFE_YIELD_SWITCH_EXIT',
      'SWITCH_MOCK',
    ]);
    expect(p.targets).toEqual([
      { asset: SGOV, weightBps: 3333 },
      { asset: USDY, weightBps: 6666 },
    ]);
    expect(out.flags).not.toContain(`ceiling_from_tier:${SGOV}`);
  });

  it('stops at the room left with its issuer across the plan, and says so', () => {
    // mYIELD shares SGOV's issuer and holds $3,000 of the goal sleeve: 50% of $10,000 leaves $2,000.
    const shared: BasketAsset[] = ASSETS.map((a) =>
      a.id === MYIELD ? { ...a, issuer: 'iShares' } : a,
    );
    const out = proposeSleeveRebalances(
      plan({ [MYIELD]: 3000, [SPY]: 3000, [USDY]: 3000, [CASH]: 1000 }, {}, SAFE_SPLIT),
      context(vault({ [MYIELD]: 3000, [SPY]: 3000, [USDY]: 3000, [CASH]: 1000 }), {
        assets: shared,
        yields: history(7),
        ...JUST_BOUGHT,
        ...FIXTURE_READINGS,
      }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(p.reasons.map((r) => r.rule)).toEqual([
      'SAFE_YIELD_SWITCH',
      'SAFE_YIELD_SWITCH_ISSUER',
      'SWITCH_MOCK',
    ]);
    expect(p.targets).toEqual([
      { asset: SGOV, weightBps: 6666 },
      { asset: USDY, weightBps: 3333 },
    ]);
  });

  it('after the switch, the next call proposes nothing for the goal sleeve (review, repro B)', () => {
    const first = run(history(7));
    const done = carryOut(first, SAFE_VAULT);
    expect(done.unowned).toEqual([]);
    const again = proposeSleeveRebalances(
      SAFE,
      context(done.vault, { book: done.book, yields: history(7), ...FIXTURE_READINGS }),
    );
    expect(again.proposals.filter((p) => p.sleeve?.kind === 'goal')).toEqual([]);
    expect(again.proposals).toEqual([]);
    // SGOV is the safe-yield sleeve's, and the goal sleeve still holds what it held.
    expect(done.book.find((r) => r.sleeve === 'safe_yield')?.holds.map((h) => h.asset)).toContain(
      SGOV,
    );
    expect(sleeveUsd(done.book, 'goal')).toBeCloseTo(7000, 0);
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
    const paid = withCash(next, -rawOf(CASH, 500));
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

  const inReais = plan(
    { [SPY]: 7000, [CASH]: 3000 },
    { obligations: [{ month: '2026-11', amount: 5500, currency: 'BRL' }] },
  );
  const usdBrl = (fetchedAt: string) => ({
    pair: 'USDBRL',
    value: 5.5,
    source: 'test fixture',
    method: 'fixed in the test',
    fetchedAt,
    provenance: 'fixture' as const,
  });

  it('a withdrawal in another currency with no FX reading is not counted, and is flagged', () => {
    const out = proposeSleeveRebalances(
      inReais,
      context(vault({ [SPY]: 7000, [CASH]: 100 }), { now: '2026-11-03T12:00:00.000Z' }),
    );
    expect(out.flags).toContain('refill_no_fx:BRL');
    expect(out.proposals.map((p) => p.kind)).not.toContain('set_aside_refill');
  });

  it('counts it at a recent FX reading, carried in the proposal; a stale one is refused', () => {
    const v = vault({ [SPY]: 7000, [CASH]: 100 });
    const fresh = usdBrl('2026-11-02T09:00:00.000Z');
    const out = proposeSleeveRebalances(
      inReais,
      context(v, { now: '2026-11-03T12:00:00.000Z', fx: [fresh] }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(p.kind).toBe('set_aside_refill');
    expect(p.fx).toEqual([fresh]);
    expect(p.reasons.find((r) => r.rule === 'SET_ASIDE_REFILL')?.params.owedUsd).toBe(1000);
    const stale = proposeSleeveRebalances(
      inReais,
      context(v, { now: '2026-11-03T12:00:00.000Z', fx: [usdBrl('2026-10-28T09:00:00.000Z')] }),
    );
    expect(stale.flags).toContain('refill_fx_stale:BRL');
    expect(stale.proposals.map((x) => x.kind)).not.toContain('set_aside_refill');
  });
});

describe('the sleeve book: who owns what', () => {
  // Goal 70% (SPYx and cash), safe yield 30% (USDY $2,000 and cash $1,000), $500 a month.
  const obligations = Array.from({ length: 12 }, (_, i) => ({
    month: `${2026 + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}`,
    amount: 500,
    currency: 'USD',
  }));
  const split: PlanSplitSleeve[] = [
    { kind: 'goal', shareBps: 7000, amountUsd: 7000, holds: [] },
    {
      kind: 'safe_yield',
      shareBps: 3000,
      amountUsd: 3000,
      holds: [
        { assetId: USDY, amountUsd: 2000 },
        { assetId: CASH, amountUsd: 1000 },
      ],
    },
  ];
  const stored = plan({ [SPY]: 4000, [USDY]: 2000, [CASH]: 4000 }, { obligations }, split);
  const november = { now: '2026-11-03T12:00:00.000Z', paidThrough: '2026-10' };

  it('settles, and no value crosses sleeves (review, repro A)', () => {
    const book = bookOf({
      goal: { [SPY]: 6000, [CASH]: 500 },
      safe_yield: { [USDY]: 2000, [CASH]: 1000 },
    });
    const v = vaultOfBook(book);
    const first = proposeSleeveRebalances(stored, context(v, { book, ...november }));
    expect(first.proposals.map((p) => [p.kind, p.sleeve?.kind])).toEqual([
      ['set_aside_refill', 'goal'],
    ]);
    const done = carryOut(first, v, { book });
    expect(sleeveUsd(done.book, 'goal')).toBeCloseTo(6500, 0);
    expect(sleeveUsd(done.book, 'safe_yield')).toBeCloseTo(3000, 0);
    // The set-aside is in the goal sleeve's cash, not the safe-yield sleeve's.
    const goalCash = done.book
      .find((r) => r.sleeve === 'goal')
      ?.holds.find((h) => h.asset === CASH);
    expect(Number(goalCash?.raw) / 1e6).toBeGreaterThanOrEqual(3000);
    const second = proposeSleeveRebalances(
      stored,
      context(done.vault, { book: done.book, ...november }),
    );
    expect(second.proposals).toEqual([]);
  });

  it('is derived from the plan only on the word that nothing traded since; otherwise it is asked for', () => {
    // The re-review's repro: the goal sold $400 of SPYx to cash. Within the band of the plan, but
    // reading the book from the plan would move $100 of the goal's money to the safe-yield sleeve.
    const sold400 = vault({ [SPY]: 3600, [USDY]: 2000, [CASH]: 4400 });
    expect(() => proposeSleeveRebalances(stored, context(sold400))).toThrow(
      /pass the sleeve book, or boughtAsPlanned/,
    );
    const moved = vault({ [SPY]: 6000, [USDY]: 2000, [CASH]: 1500 });
    expect(() =>
      proposeSleeveRebalances(stored, context(moved, { ...november, ...JUST_BOUGHT })),
    ).toThrow(/pass the sleeve book/);
    const bought = vault({ [SPY]: 4000, [USDY]: 2000, [CASH]: 4000 });
    expect(() => proposeSleeveRebalances(stored, context(bought))).toThrow(/boughtAsPlanned/);
    const out = proposeSleeveRebalances(stored, context(bought, JUST_BOUGHT));
    expect(out.bookFrom).toBe('plan');
    expect(out.flags).toContain('book_from_plan');
    expect(sleeveUsd(out.book, 'safe_yield')).toBeCloseTo(3000, 2);
  });

  it('adds up to the vault: more than it holds is refused, what no sleeve owns is reported', () => {
    const book = bookOf({
      goal: { [SPY]: 4000, [CASH]: 3000 },
      safe_yield: { [USDY]: 2000, [CASH]: 1000 },
    });
    const extra = vaultOfBook(
      bookOf({ x: { [SPY]: 4000, [CASH]: 4000, [USDY]: 2000, [NVDA]: 100 } }),
    );
    const out = proposeSleeveRebalances(stored, context(extra, { book }));
    expect(out.unowned).toEqual([{ asset: NVDA, raw: String(rawOf(NVDA, 100)) }]);
    expect(out.flags).toContain(`unowned:${NVDA}`);
    const short = vault({ [SPY]: 3000, [USDY]: 2000, [CASH]: 4000 });
    expect(() => proposeSleeveRebalances(stored, context(short, { book }))).toThrow(
      /holds more solana:spyx than the vault/,
    );
    expect(() =>
      proposeSleeveRebalances(
        stored,
        context(extra, { book: [...book, { sleeve: 'theme:ai', holds: [] }] }),
      ),
    ).toThrow(/not a sleeve of this plan/);
  });

  it('settleBook puts a trade’s real cost on the sleeve that traded, and adds up exactly', () => {
    const book = bookOf({
      goal: { [SPY]: 6000, [CASH]: 500 },
      safe_yield: { [USDY]: 2000, [CASH]: 1000 },
    });
    const v = vaultOfBook(book);
    const first = proposeSleeveRebalances(stored, context(v, { book, ...november }));
    const done = carryOut(first, v, { book, costBps: 100n });
    const sums = new Map<string, bigint>();
    for (const r of done.book)
      for (const h of r.holds) sums.set(h.asset, (sums.get(h.asset) ?? 0n) + BigInt(h.raw));
    expect(sums).toEqual(new Map([...rawIn(done.vault)].filter(([, n]) => n > 0n)));
    expect(sleeveUsd(done.book, 'safe_yield')).toBeCloseTo(3000, 2);
    expect(sleeveUsd(done.book, 'goal')).toBeLessThan(6500);
  });

  it('shares a gain no trade explains (10 USDY accrued) by what each sleeve held of it', () => {
    const book = bookOf({
      goal: { [USDY]: 3000, [CASH]: 500 },
      safe_yield: { [USDY]: 1000, [CASH]: 500 },
    });
    const v = vaultOfBook(book);
    const accrued = vaultOfRaw(
      new Map([...rawIn(v)].map(([k, n]) => [k, k === USDY ? n + rawOf(USDY, 10) : n])),
    );
    const settled = settleBook(book, [], accrued);
    expect(settled.unowned).toEqual([]);
    const usdy = (key: string) =>
      settled.book.find((r) => r.sleeve === key)?.holds.find((h) => h.asset === USDY)?.raw;
    expect(usdy('goal')).toBe(String(rawOf(USDY, 3007.5)));
    expect(usdy('safe_yield')).toBe(String(rawOf(USDY, 1002.5)));
    // A token no sleeve held is still unowned.
    const airdrop = vaultOfRaw(new Map([...rawIn(v), [NVDA, rawOf(NVDA, 100)]]));
    expect(settleBook(book, [], airdrop).unowned).toEqual([
      { asset: NVDA, raw: String(rawOf(NVDA, 100)) },
    ]);
  });

  it('refuses boughtAsPlanned when the vault shows it has traded since', () => {
    const bought = vault({ [SPY]: 4000, [USDY]: 2000, [CASH]: 4000 });
    const traded = {
      ...bought,
      positions: bought.positions.map((p, i) =>
        i === 0 ? { ...p, lastKeeperAt: 1_790_000_000 } : p,
      ),
    };
    expect(() => proposeSleeveRebalances(stored, context(traded, JUST_BOUGHT))).toThrow(
      /keeper trade/,
    );
    expect(() =>
      proposeSleeveRebalances(stored, context({ ...bought, acceptedVersion: 2 }, JUST_BOUGHT)),
    ).toThrow(/accepted version/);
  });

  it('settles a batch trade by trade: two sleeves sharing the cash, each keeps its own cost', () => {
    // The goal refills its set-aside (sells SPYx) and the safe-yield sleeve is 10 points off (buys
    // USDY with its own cash), carried out together at a 1% cost and settled once.
    const book = bookOf({
      goal: { [SPY]: 6000, [CASH]: 500 },
      safe_yield: { [USDY]: 1700, [CASH]: 1300 },
    });
    const v = vaultOfBook(book);
    const out = proposeSleeveRebalances(stored, context(v, { book, ...november }));
    expect(out.proposals.map((p) => [p.kind, p.sleeve?.kind])).toEqual([
      ['set_aside_refill', 'goal'],
      ['drift', 'safe_yield'],
    ]);
    const done = carryOut(out, v, { book, costBps: 100n });
    expect(done.unowned).toEqual([]);
    const costOf = (p: SleeveProposal) => p.plan.trades.reduce((n, t) => n + usdOf(t) * 0.01, 0);
    const [goal, safe] = out.proposals as [SleeveProposal, SleeveProposal];
    expect(sleeveUsd(done.book, 'goal')).toBeCloseTo(6500 - costOf(goal), 1);
    expect(sleeveUsd(done.book, 'safe_yield')).toBeCloseTo(3000 - costOf(safe), 1);
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
const themedBook = (goal: Record<string, number>, theme: Record<string, number>) =>
  bookOf({ goal, 'theme:ai': theme });
const tokensOf = (p: SleeveProposal) => new Set([...sold(p), ...bought(p)]);

describe('between sleeves, nothing moves unless the person chose to restore the split', () => {
  const grownBook = themedBook({ [SPY]: 4000, [CASH]: 1000 }, { [NVDA]: 8000, [SYRUP]: 2000 });

  it('with restoreSplit off, a theme that has grown is left grown', () => {
    // NVDAx doubled: the theme is now 10,000 of 15,000. Inside each sleeve, nothing is off.
    const out = proposeSleeveRebalances(
      plan(THEMED, {}, THEME_SPLIT),
      context(vaultOfBook(grownBook), { book: grownBook }),
    );
    expect(out.splitDriftBps).toBeGreaterThan(500);
    expect(out.proposals).toEqual([]);
  });

  it('with restoreSplit off, every sleeve trades only its own tokens and spends only its own cash', () => {
    const book = themedBook({ [SPY]: 5000, [CASH]: 500 }, { [NVDA]: 3000, [SYRUP]: 2000 });
    const out = proposeSleeveRebalances(
      plan(THEMED, {}, THEME_SPLIT),
      context(vaultOfBook(book), { book }),
    );
    expect(out.proposals.map((p) => p.sleeve?.kind)).toEqual(['goal', 'theme']);
    const [goal, theme] = out.proposals as [SleeveProposal, SleeveProposal];
    expect([...tokensOf(goal)]).toEqual([SPY]);
    expect([...tokensOf(theme)].sort()).toEqual([NVDA, SYRUP]);
    const cashOf = { goal: 500, theme: 0 };
    for (const p of out.proposals) {
      const salesUsd = p.plan.trades
        .filter((t) => t.buy === CASH)
        .reduce((n, t) => n + usdOf(t), 0);
      const buysUsd = p.plan.trades
        .filter((t) => t.sell === CASH)
        .reduce((n, t) => n + usdOf(t), 0);
      // What a sleeve buys is at most what it sold plus the cash it owns.
      const own = cashOf[p.sleeve?.kind as 'goal' | 'theme'];
      expect(buysUsd, p.sleeve?.kind).toBeLessThanOrEqual(salesUsd + own + 0.01);
    }
    const done = carryOut(out, vaultOfBook(book), { book });
    expect(sleeveUsd(done.book, 'goal')).toBeCloseTo(5500, 0);
    expect(sleeveUsd(done.book, 'theme:ai')).toBeCloseTo(5000, 0);
  });

  it('with restoreSplit on, the split is restored at the band, in one proposal for the plan', () => {
    const grown = vaultOfBook(grownBook);
    const out = proposeSleeveRebalances(
      plan(THEMED, { restoreSplit: true }, THEME_SPLIT),
      context(grown, { book: grownBook }),
    );
    const [p] = out.proposals as [SleeveProposal];
    expect(out.proposals).toHaveLength(1);
    expect(p).toMatchObject({ kind: 'restore_split', sleeve: null });
    expect(sold(p).sort()).toEqual([NVDA, SYRUP]);
    expect(bought(p)).toEqual([SPY]);
    const usd = dollarsIn(applied(grown, p.plan.trades));
    // Back to half and half, within the margin the purchases keep.
    expect(((usd[NVDA] ?? 0) + (usd[SYRUP] ?? 0)) / 15_000).toBeCloseTo(0.5, 1);
    expect(sleeveUsd(p.bookAfter, 'theme:ai') / 15_000).toBeCloseTo(0.5, 1);
  });

  it('with restoreSplit on and the split inside the band, nothing moves between sleeves', () => {
    const book = themedBook({ [SPY]: 4000, [CASH]: 1000 }, { [NVDA]: 4300, [SYRUP]: 1000 });
    const out = proposeSleeveRebalances(
      plan(THEMED, { restoreSplit: true }, THEME_SPLIT),
      context(vaultOfBook(book), { book }),
    );
    expect(out.splitDriftBps).toBeLessThan(500);
    expect(out.proposals.map((p) => p.kind)).not.toContain('restore_split');
  });

  it('with restoreSplit on, a deposit and a withdrawal together never take more than a sleeve holds', () => {
    const book = themedBook({ [SPY]: 9000, [CASH]: 1000 }, { [NVDA]: 300, [SYRUP]: 200 });
    const out = proposeSleeveRebalances(
      plan(THEMED, { restoreSplit: true }, THEME_SPLIT),
      context(vaultOfBook(book), {
        book,
        deposit: String(rawOf(CASH, 2000)),
        withdrawal: String(rawOf(CASH, 10_000)),
      }),
    );
    const [goal, theme] = out.flows;
    const usd = (raw: string | undefined) => Number(raw) / 1e6;
    expect(usd(goal?.depositRaw) + usd(theme?.depositRaw)).toBeCloseTo(2000, 6);
    expect(usd(goal?.withdrawalRaw) + usd(theme?.withdrawalRaw)).toBeCloseTo(10_000, 6);
    expect(usd(theme?.withdrawalRaw)).toBeLessThanOrEqual(500 + usd(theme?.depositRaw));
    expect(usd(goal?.withdrawalRaw)).toBeLessThanOrEqual(10_000 + usd(goal?.depositRaw));
  });
});

describe('with restoreSplit off, a sleeve’s value moves only through its own trades and money', () => {
  // A small generator: the same seed gives the same cases.
  const rng = (seed: number) => {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  it('holds on 40 random plans, round after round, and settles', () => {
    const next = rng(20261006);
    const between = (lo: number, hi: number) => Math.round(lo + next() * (hi - lo));
    for (let c = 0; c < 40; c++) {
      // Goal: SPYx, NVDAx, syrupUSDC, cash. Theme: NVDAx and syrupUSDC (shared with the goal).
      const goalPlan = {
        [SPY]: between(1000, 4000),
        [NVDA]: between(0, 2000),
        [SYRUP]: between(0, 2000),
        [CASH]: between(100, 1000),
      };
      const themePlan = { [NVDA]: between(500, 3000), [SYRUP]: between(0, 1000) };
      const goalUsd = Object.values(goalPlan).reduce((n, x) => n + x, 0);
      const themeUsd = Object.values(themePlan).reduce((n, x) => n + x, 0);
      const total = goalUsd + themeUsd;
      const goalShare = Math.round((goalUsd * 10_000) / total);
      const lines: Record<string, number> = { ...goalPlan };
      for (const [k, x] of Object.entries(themePlan)) lines[k] = (lines[k] ?? 0) + x;
      const stored = plan(lines, {}, [
        { kind: 'goal', shareBps: goalShare, amountUsd: goalUsd, holds: [] },
        {
          kind: 'theme',
          theme: 'ai',
          shareBps: 10_000 - goalShare,
          amountUsd: themeUsd,
          holds: Object.entries(themePlan).map(([assetId, amountUsd]) => ({ assetId, amountUsd })),
        },
      ]);
      // Each sleeve has drifted from its plan by a random factor per token.
      const drift = (row: Record<string, number>) =>
        Object.fromEntries(
          Object.entries(row).map(([k, x]) => [k, Math.round(x * (0.6 + next() * 0.8))]),
        );
      let book = bookOf({ goal: drift(goalPlan), 'theme:ai': drift(themePlan) });
      let v = vaultOfBook(book);
      const deposit = c % 3 === 0 ? rawOf(CASH, between(10, 500)) : 0n;
      for (let round = 0; round < 3; round++) {
        const out = proposeSleeveRebalances(
          stored,
          context(v, {
            book,
            ...(round === 0 && deposit > 0n ? { deposit: String(deposit) } : {}),
          }),
        );
        const before = {
          goal: sleeveUsd(out.book, 'goal'),
          theme: sleeveUsd(out.book, 'theme:ai'),
        };
        // All proposals in one batch, each trade losing 0.3%, the book settled once.
        const done = carryOut(out, v, { book, costBps: 30n, deposit: round === 0 && deposit > 0n });
        expect(done.unowned, `case ${c}`).toEqual([]);
        // Each sleeve's value moves only by the cost of its own trades, to the cent per trade.
        for (const [key, was] of [
          ['goal', before.goal],
          ['theme:ai', before.theme],
        ] as const) {
          const own = out.proposals.filter(
            (p) => (p.sleeve?.kind === 'theme' ? 'theme:ai' : p.sleeve?.kind) === key,
          );
          const traded = own.flatMap((p) => p.plan.trades);
          const cost = traded.reduce((n, t) => n + usdOf(t) * 0.003, 0);
          const moved = sleeveUsd(done.book, key) - was;
          expect(Math.abs(moved + cost), `case ${c} ${key}`).toBeLessThan(
            0.01 * (traded.length + 1),
          );
        }
        book = done.book;
        v = done.vault;
      }
      // By the third round there is nothing left to propose.
      expect(proposeSleeveRebalances(stored, context(v, { book })).proposals, `case ${c}`).toEqual(
        [],
      );
    }
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
    const out = proposeSleeveRebalances(ONE, context(drifted, { assessment }));
    expect(out.proposals.map((p) => p.kind)).toEqual(['liquidity_breach']);
    const [p] = out.proposals as [SleeveProposal];
    expect(p.plan.trades).toEqual([
      { sell: SPY, buy: CASH, amountInRaw: String(rawOf(SPY, 1000)) },
    ]);
    expect(p.reasons[0]?.text).toMatch(/January 2027/);
    expect(out.waiting).toEqual([{ kind: 'drift', sleeve: { kind: 'goal' } }]);
    expect(sleeveUsd(p.bookAfter, 'goal')).toBeCloseTo(10_000, 2);
  });

  it('an assessment with no likely breach changes nothing', () => {
    const drifted = vault({ [SPY]: 7000, [SYRUP]: 2000, [CASH]: 1000 });
    const out = proposeSleeveRebalances(
      ONE,
      context(drifted, { assessment: { ...assessment, likelyBreach: false } }),
    );
    expect(out.proposals.map((p) => p.kind)).toEqual(['drift']);
  });
});

describe('the same inputs give the same proposals, in any order', () => {
  const shuffle = <T>(xs: T[]) => [...xs].reverse();
  it('is deterministic and does not depend on the order of anything', () => {
    const book = themedBook({ [SPY]: 5000, [CASH]: 500 }, { [NVDA]: 3000, [SYRUP]: 2000 });
    const v = vaultOfBook(book);
    const stored = plan(THEMED, {}, THEME_SPLIT);
    const ctx = context(v, {
      book,
      yields: history(7),
      ...FIXTURE_READINGS,
      deposit: String(rawOf(CASH, 300)),
    });
    const once = proposeSleeveRebalances(stored, ctx);
    expect(once.proposals.length).toBeGreaterThan(0);
    expect(proposeSleeveRebalances(stored, ctx)).toEqual(once);
    const shuffled = proposeSleeveRebalances(
      { ...stored, lines: shuffle(stored.lines), split: shuffle(THEME_SPLIT) },
      {
        ...ctx,
        vault: { ...v, positions: shuffle(v.positions) },
        book: shuffle(book).map((r) => ({ ...r, holds: shuffle(r.holds) })),
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
    const [p] = proposeSleeveRebalances(
      pt,
      context(SAFE_VAULT, { yields: history(7), ...FIXTURE_READINGS, ...JUST_BOUGHT }),
    ).proposals as [SleeveProposal];
    expect(p.reasons[0]?.text).toBe(
      'Na parte do seu plano em rendimento em dólar só de taxa, USDY passa para SGOV: em cada um dos últimos 7 dias de leituras, SGOV rendeu mais que USDY após o deságio, por mais de 0,5% ao ano.',
    );
    expect(p.reasons.at(-1)?.text).toMatch(/^MOCK: /);
    const [en] = proposeSleeveRebalances(
      SAFE,
      context(SAFE_VAULT, { yields: history(7), ...FIXTURE_READINGS, ...JUST_BOUGHT }),
    ).proposals as [SleeveProposal];
    expect(en.reasons[0]?.text).toBe(
      'In the part of your plan in dollar yield from a rate alone, USDY moves to SGOV: on each of the last 7 days of readings, SGOV yielded more than USDY after haircut, by over 0.5% a year.',
    );
  });
});

describe('the table is the one the plan was made with', () => {
  const yields = history(7);
  const ctx = (over: Partial<SleeveRebalanceContext> = {}) =>
    context(SAFE_VAULT, {
      yields,
      ...FIXTURE_READINGS,
      ...JUST_BOUGHT,
      liquidity: provider({ [SGOV]: 4000 }),
      ...over,
    });

  it("Cover's half share of depth holds the switch to $500 of $4,000 measured, not $1,000", () => {
    const [p] = proposeSleeveRebalances({ ...SAFE, candidate: 'cover' }, ctx()).proposals as [
      SleeveProposal,
    ];
    expect(p.reasons.map((r) => r.rule)).toContain('SAFE_YIELD_SWITCH_EXIT');
    expect(p.targets).toEqual([
      { asset: SGOV, weightBps: 1666 },
      { asset: USDY, weightBps: 8333 },
    ]);
  });

  it('Spread holds every rate token in one band, so it never switches', () => {
    expect(proposeSleeveRebalances({ ...SAFE, candidate: 'spread' }, ctx()).proposals).toEqual([]);
  });

  it('a plan made with another table is refused, not rebalanced on this one', () => {
    expect(() =>
      proposeSleeveRebalances({ ...SAFE, candidate: 'cover', paramsHash: 'another' }, ctx()),
    ).toThrow(/another parameter table/);
  });

  it('the shared candidate ids are the candidates', () => {
    expect(BasketProposalBase.shape.candidate.unwrap().options).toEqual(PlanCandidateId.options);
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
    const out = proposeSleeveRebalances(made, {
      now: NOW,
      vault: held,
      prices,
      assets,
      boughtAsPlanned: true,
    });
    expect(made.split?.map((x) => x.kind)).toEqual(['goal', 'safe_yield']);
    expect(out.proposals).toEqual([]);
    expect(out.splitDriftBps).toBeLessThan(10);
  });
});

// Gate COUNTRY-REMOVED (Oct 6): this test held that a stored plan with country ZZ was refused. The
// plan reads no country: it is answered like any other.
describe('a stored plan with any country, or none', () => {
  it('is answered the same', () => {
    const at = vault({ [SPY]: 5500, [SYRUP]: 3500, [CASH]: 1000 });
    const unknown = { ...ONE, sheet: { ...ONE.sheet, country: 'ZZ' } };
    expect(proposeSleeveRebalances(unknown, context(at)).proposals).toHaveLength(1);
  });
});

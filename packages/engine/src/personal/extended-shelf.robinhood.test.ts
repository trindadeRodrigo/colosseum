import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates, compose } from './index';
import { CREDIT_LEG_TYPES, LEG_TYPES } from './leg-types';
import {
  editShelf,
  extendedContext,
  extendedHeldOut,
  extendedRows,
  extendedShelf,
  fixtureContext,
  launchShelf,
  sheet,
  shelfGrid,
  sleeveBps,
  violations,
} from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';

// The extended shelf on Robinhood Chain (docs/vault/research/yield-shelf/robinhood.md): what the
// added tokens do to a plan, against the launch shelf. Every figure is a fixture. The rows are read as
// written, so a row that changes verdict or tier is read here as it is.

const launch = launchShelf();
const extended = extendedShelf();
const [onLaunch, onExtended] = [fixtureContext(), extendedContext()];
const symbolOf = new Map(extended.assets.map((a) => [a.id, a.symbol]));
const held = (plan: PersonalProposal) => plan.lines.map((l) => symbolOf.get(l.assetId) ?? '');
const typesOf = (symbol: string) => LEG_TYPES[symbol]?.types ?? [];
const isRate = (symbol: string) =>
  typesOf(symbol).length > 0 && typesOf(symbol).every((t) => t === 'rate');
const isCredit = (symbol: string) => typesOf(symbol).some((t) => CREDIT_LEG_TYPES.includes(t));
const usdg = (over: Partial<PersonalSheet> = {}) => sheet({ chains: ['robinhood'], ...over });
const run = (s: PersonalSheet, shelf: Shelf = extended, ctx: ComposeContext = onExtended) => {
  const plan = compose(s, shelf, ctx);
  expect(violations(plan, shelf, ctx)).toEqual([]);
  return plan;
};
const inPlans = extendedRows('robinhood').filter((row) => row.heldOut === undefined);

describe('the rows of the extended shelf on Robinhood Chain', () => {
  it('add three dollar-yield tokens a plan may hold, none of them a rate leg', () => {
    expect(inPlans.map((row) => row.asset.symbol)).toEqual(['steakUSDG', 'syrupUSDG', 'spUSDG']);
    expect(inPlans.map((row) => row.asset.symbol).filter(isRate)).toEqual([]);
    // syrupUSDG is typed as syrupUSDC is, and shares its issuer.
    expect(LEG_TYPES.syrupUSDG?.types).toEqual(LEG_TYPES.syrupUSDC?.types);
    const issuerOf = (symbol: string) => extended.assets.find((a) => a.symbol === symbol)?.issuer;
    expect(issuerOf('syrupUSDG')).toBe(issuerOf('syrupUSDC'));
    // The two vaults have no market route: each is held to the thinnest tier, whatever it redeems.
    for (const symbol of ['steakUSDG', 'spUSDG'])
      expect(inPlans.find((row) => row.asset.symbol === symbol)?.asset.tier, symbol).toBe('C');
    // No list of blocked countries was read for any of them, and each row says so.
    for (const row of inPlans) {
      expect(row.asset.blockedCountries, row.asset.id).toEqual([]);
      expect(row.unverified, row.asset.id).toContain('geo-blocks');
    }
  });

  it('list the PT with its maturity and keep it out of every plan; list no pool share', () => {
    const out = extendedHeldOut('robinhood');
    expect(out.map((row) => row.asset.symbol)).toEqual(['PT-USDG-25MAR2027', 'rUSDG']);
    const pt = out[0];
    expect(pt?.maturity).toBe('2027-03-25');
    expect(pt?.heldOut).toMatch(/maturity/);
    expect(out[1]?.verdict).toBe('hold');
    // A pool share is not listed until a vault can hold one: there is none it can.
    for (const row of extendedRows('robinhood')) expect(row.asset.symbol).not.toMatch(/LP|UNI/i);
    const ids = new Set(extended.assets.map((a) => a.id));
    for (const row of out) expect(ids.has(row.asset.id)).toBe(false);
  });
});

describe('plans on the extended shelf on Robinhood Chain', () => {
  it('an income goal at low risk in USDG keeps its rate token and leaves less in cash', () => {
    for (const amountUsd of [1000, 10_000, 50_000]) {
      const s = usdg({ goal: 'income', risk: 'low', amountUsd });
      const [before, after] = [run(s, launch, onLaunch), run(s)];
      expect(held(before)).toEqual(['SGOV', 'USDG']);
      expect(sleeveBps(before, launch, 'cash')).toBe(6000);
      expect(held(after)).toContain('SGOV');
      expect(held(after).filter((x) => ['steakUSDG', 'spUSDG'].includes(x))).toHaveLength(2);
      expect(sleeveBps(after, extended, 'cash')).toBeLessThan(6000);
    }
    // The two vaults take $1,500 each, the ceiling of their tier: at $50,000 most of what they
    // could hold by their cap stays in cash.
    const large = run(usdg({ goal: 'income', risk: 'low', amountUsd: 50_000 }));
    for (const l of large.lines)
      if (['steakUSDG', 'spUSDG'].includes(symbolOf.get(l.assetId) ?? ''))
        expect(l.amountUsd).toBe(1500);
    expect(large.flags).toContain('unplaced');
  });

  it('the safe-yield sleeve is what it was: the chain still has one rate token', () => {
    const s = usdg({ sleeves: [{ kind: 'safe_yield', shareBps: 10_000 }] });
    const [before, after] = [run(s, launch, onLaunch), run(s)];
    expect(after.lines.map((l) => [l.assetId, l.weightBps])).toEqual(
      before.lines.map((l) => [l.assetId, l.weightBps]),
    );
    expect(held(after).filter(isRate)).toEqual(['SGOV']);
  });

  it('"no lending" leaves out the credit and basis token and still holds the rate token', () => {
    for (const goal of ['income', 'protect', 'grow'] as const) {
      const s = usdg({ goal, risk: 'low', amountUsd: 10_000, limits: { creditTolerance: 'none' } });
      for (const { plan } of candidates(s, extended, onExtended).shown) {
        expect(violations(plan, extended, onExtended)).toEqual([]);
        expect(held(plan).filter(isCredit), `${goal} ${plan.candidate}`).toEqual([]);
        expect(held(plan), `${goal} ${plan.candidate}`).toContain('SGOV');
      }
    }
    // With a limit on credit and none on lending, syrupUSDG is held up to the limit.
    const limited = run(usdg({ goal: 'income', risk: 'low' }));
    const syrup = limited.lines.find((l) => symbolOf.get(l.assetId) === 'syrupUSDG');
    expect(syrup?.weightBps).toBe(2500);
  });

  it('a token blocked in a country is never held for a person there', () => {
    // No row of this chain has a list yet, so the rule is held on a copy that blocks Spain.
    const shelf = editShelf(extended, (a) =>
      ['steakUSDG', 'syrupUSDG'].includes(a.symbol) ? { ...a, blockedCountries: ['ES'] } : a,
    );
    for (const s of shelfGrid('robinhood').map((g) => ({ ...g, country: 'ES' })))
      for (const { plan } of candidates(s, shelf, onExtended).shown) {
        expect(violations(plan, shelf, onExtended)).toEqual([]);
        expect(held(plan)).not.toContain('steakUSDG');
        expect(held(plan)).not.toContain('syrupUSDG');
      }
    expect(held(run(usdg({ goal: 'income', risk: 'low', country: 'ES' })))).toContain('steakUSDG');
  });

  it('on the grid, the share left in cash falls from 47.69% to 20.06% of a plan, and rises in none', () => {
    let [before, after, n] = [0, 0, 0];
    for (const s of shelfGrid('robinhood')) {
      const [a, b] = [candidates(s, launch, onLaunch), candidates(s, extended, onExtended)];
      for (const id of ['cover', 'spread', 'carry'] as const) {
        const [x, y] = [a.shown.find((c) => c.id === id), b.shown.find((c) => c.id === id)];
        if (!x || !y) continue;
        const [was, is] = [sleeveBps(x.plan, launch, 'cash'), sleeveBps(y.plan, extended, 'cash')];
        expect(is, `${s.goal}:${s.risk}:${s.amountUsd} ${id}`).toBeLessThanOrEqual(was);
        before += was;
        after += is;
        n += 1;
      }
    }
    // The mean over the 39 candidates both shelves show, in basis points of a plan.
    expect(n).toBe(39);
    expect(Math.round(before / n)).toBe(4769);
    expect(Math.round(after / n)).toBe(2006);
  });
});

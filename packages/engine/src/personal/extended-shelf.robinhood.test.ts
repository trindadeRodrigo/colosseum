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
const weightOf = (plan: PersonalProposal, symbol: string) =>
  plan.lines.find((l) => symbolOf.get(l.assetId) === symbol)?.weightBps ?? 0;
const usdg = (over: Partial<PersonalSheet> = {}) => sheet({ chains: ['robinhood'], ...over });
const run = (s: PersonalSheet, shelf: Shelf = extended, ctx: ComposeContext = onExtended) => {
  const plan = compose(s, shelf, ctx);
  expect(violations(plan, shelf, ctx)).toEqual([]);
  return plan;
};
const inPlans = extendedRows('robinhood').filter((row) => row.heldOut === undefined);

describe('the rows of the extended shelf on Robinhood Chain', () => {
  it('add two dollar-yield tokens a plan may hold, neither of them a rate leg', () => {
    expect(inPlans.map((row) => row.asset.symbol)).toEqual(['steakUSDG', 'syrupUSDG']);
    expect(inPlans.map((row) => row.asset.symbol).filter(isRate)).toEqual([]);
    expect(LEG_TYPES.steakUSDG?.types).toEqual(['market_deposit']);
    // syrupUSDG is typed as syrupUSDC is, and shares its issuer.
    expect(LEG_TYPES.syrupUSDG?.types).toEqual(LEG_TYPES.syrupUSDC?.types);
    const issuerOf = (symbol: string) => extended.assets.find((a) => a.symbol === symbol)?.issuer;
    expect(issuerOf('syrupUSDG')).toBe(issuerOf('syrupUSDC'));
    // The vault has no market route: it is held to the thinnest tier, whatever it redeems.
    expect(inPlans.find((row) => row.asset.symbol === 'steakUSDG')?.asset.tier).toBe('C');
    // No list of blocked countries was read for either, and each row says so.
    for (const row of inPlans) {
      expect(row.asset.blockedCountries, row.asset.id).toEqual([]);
      expect(row.unverified, row.asset.id).toContain('geo-blocks');
    }
  });

  it('list spUSDG, the PT with its maturity and rUSDG, and keep each out of every plan; list no pool share', () => {
    const out = extendedHeldOut('robinhood');
    expect(out.map((row) => row.asset.symbol)).toEqual(['spUSDG', 'PT-USDG-25MAR2027', 'rUSDG']);
    // What funds spUSDG's rate is not verified, so no leg type is recorded for it: its kind is not guessed.
    expect(out[0]?.verdict).toBe('hold');
    expect(out[0]?.heldOut).toMatch(/leg type is not settled/);
    for (const symbol of ['spUSDG', 'rUSDG', 'PT-USDG-25MAR2027'])
      expect(LEG_TYPES[symbol], symbol).toBeUndefined();
    const pt = out[1];
    expect(pt?.maturity).toBe('2027-03-25');
    expect(pt?.heldOut).toMatch(/maturity/);
    expect(out[2]?.verdict).toBe('hold');
    // A pool share is not listed until a vault can hold one, and none can be held: no row is one.
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
      expect(weightOf(after, 'SGOV')).toBe(4000);
      expect(weightOf(after, 'steakUSDG')).toBeGreaterThan(0);
      expect(weightOf(after, 'syrupUSDG')).toBeGreaterThan(0);
      expect(sleeveBps(after, extended, 'cash')).toBeLessThan(6000);
    }
    // The vault takes $1,500, the ceiling of its tier: at $50,000 most of what it could hold by
    // its cap stays in cash, and the plan says money is left unplaced.
    const large = run(usdg({ goal: 'income', risk: 'low', amountUsd: 50_000 }));
    expect(large.lines.find((l) => symbolOf.get(l.assetId) === 'steakUSDG')?.amountUsd).toBe(1500);
    expect(sleeveBps(large, extended, 'cash')).toBe(3200);
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

  it('"no lending" leaves out the credit and basis token and holds the rate token; it still holds the market deposit', () => {
    for (const goal of ['income', 'protect', 'grow'] as const) {
      const s = usdg({ goal, risk: 'low', amountUsd: 10_000, limits: { creditTolerance: 'none' } });
      for (const { plan } of candidates(s, extended, onExtended).shown) {
        expect(violations(plan, extended, onExtended)).toEqual([]);
        expect(held(plan).filter(isCredit), `${goal} ${plan.candidate}`).toEqual([]);
        expect(held(plan), `${goal} ${plan.candidate}`).toContain('SGOV');
        // What the engine does today with a market deposit, on every chain: the credit budget
        // counts credit and basis legs only, so a person who refuses credit still holds a deposit
        // in a lending market (jlUSDC on Solana's launch shelf, steakUSDG here). The note brings
        // it to Rodrigo (robinhood.md, section 5.4); this line holds what is, not what should be.
        expect(weightOf(plan, 'steakUSDG'), `${goal} ${plan.candidate}`).toBe(1500);
      }
    }
    // With a limit on credit and none on lending, syrupUSDG is held up to the limit.
    expect(weightOf(run(usdg({ goal: 'income', risk: 'low' })), 'syrupUSDG')).toBe(2500);
  });

  // Gate COUNTRY-REMOVED (Rodrigo, Oct 6): this test held that steakUSDG and syrupUSDG, blocked in
  // Spain on a copy, were never held for a person there. A block is information only now.
  it('a token blocked in a country is held all the same: the plan reads no country', () => {
    const shelf = editShelf(extended, (a) =>
      ['steakUSDG', 'syrupUSDG'].includes(a.symbol) ? { ...a, blockedCountries: ['ES'] } : a,
    );
    const inSpain = run(usdg({ goal: 'income', risk: 'low', country: 'ES' }));
    expect(held(inSpain)).toContain('steakUSDG');
    for (const s of shelfGrid('robinhood')
      .slice(0, 6)
      .map((g) => ({ ...g, country: 'ES' })))
      for (const { plan } of candidates(s, shelf, onExtended).shown) {
        expect(violations(plan, shelf, onExtended)).toEqual([]);
        const { country: _, ...none } = s;
        expect(plan.lines, JSON.stringify(s)).toEqual(
          candidates(none, shelf, onExtended).shown.find((c) => c.id === plan.candidate)?.plan
            .lines,
        );
      }
  });

  // These figures moved on Oct 7, with the cap per issuer by risk counting all a plan holds with one
  // issuer (docs/vault/DESIGN-VAULT.md, section 7, row Risk). Every stock, SGOV and GLD on this
  // chain have the same issuer, so on the launch shelf Cover of a goal to grow of $1,000 to $50,000
  // leaves 50% in cash at low risk and 30% at medium, where it left 40% and 5%. In those six goals
  // Spread is then no better than Cover and is not shown: 36 candidates where there were 42, and a
  // mean cash share of 50.42% where it was 45.71%. On the extended shelf the two added tokens have
  // issuers of their own and take part of that cash: 71 candidates where there were 73, and 26.20%
  // where it was 21.57%. The other thirty goals are as they were on both shelves.
  it('on the grid, every candidate the launch shelf shows is still shown, and its cash share falls from 50.42% to 26.20% of a plan', () => {
    let [before, after, n, shownBefore, shownAfter] = [0, 0, 0, 0, 0];
    for (const s of shelfGrid('robinhood')) {
      const [a, b] = [candidates(s, launch, onLaunch), candidates(s, extended, onExtended)];
      shownBefore += a.shown.length;
      shownAfter += b.shown.length;
      for (const x of a.shown) {
        const y = b.shown.find((c) => c.id === x.id);
        // No candidate is lost: what the launch shelf shows, the extended shelf shows.
        expect(y, `${s.goal}:${s.risk}:${s.amountUsd} ${x.id}`).toBeDefined();
        if (!y) continue;
        const [was, is] = [sleeveBps(x.plan, launch, 'cash'), sleeveBps(y.plan, extended, 'cash')];
        expect(is, `${s.goal}:${s.risk}:${s.amountUsd} ${x.id}`).toBeLessThanOrEqual(was);
        before += was;
        after += is;
        n += 1;
      }
    }
    // The 36 candidates the launch shelf shows over the 36 goals; the extended shelf shows 71.
    expect([shownBefore, shownAfter, n]).toEqual([36, 71, 36]);
    // The mean cash share over those 36, in basis points of a plan.
    expect(Math.round(before / n)).toBe(5042);
    expect(Math.round(after / n)).toBe(2620);
  });
});

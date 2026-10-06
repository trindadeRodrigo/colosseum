import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { candidates, compose } from './index';
import { CREDIT_LEG_TYPES, LEG_TYPES } from './leg-types';
import {
  extendedContext,
  extendedHeldOut,
  extendedRows,
  extendedShelf,
  fixtureContext,
  launchShelf,
  sheet,
  shelfGrid,
  sleeveBps,
  usdBrl,
  violations,
} from './testing';
import type { ComposeContext, PersonalProposal, PersonalSheet } from './types';

// The extended shelf on Solana (docs/vault/research/yield-shelf/solana.md): what the added tokens do
// to a plan, against the launch shelf. Every figure is a fixture. The rows are read as written, so a
// row that changes verdict or tier is read here as it is.

const launch = launchShelf();
const extended = extendedShelf();
const [onLaunch, onExtended] = [fixtureContext(), extendedContext()];
const symbolOf = new Map(extended.assets.map((a) => [a.id, a.symbol]));
const held = (plan: PersonalProposal) => plan.lines.map((l) => symbolOf.get(l.assetId) ?? '');
const typesOf = (symbol: string) => LEG_TYPES[symbol]?.types ?? [];
const isRate = (symbol: string) =>
  typesOf(symbol).length > 0 && typesOf(symbol).every((t) => t === 'rate');
const isCredit = (symbol: string) => typesOf(symbol).some((t) => CREDIT_LEG_TYPES.includes(t));
const solana = (over: Partial<PersonalSheet> = {}) => sheet({ chains: ['solana'], ...over });
const run = (s: PersonalSheet, shelf: Shelf = extended, ctx: ComposeContext = onExtended) => {
  const plan = compose(s, shelf, ctx);
  expect(violations(plan, shelf, ctx)).toEqual([]);
  return plan;
};
const inPlans = extendedRows('solana').filter((row) => row.heldOut === undefined);

describe('the rows of the extended shelf on Solana', () => {
  it('add seven dollar-yield tokens a plan may hold, two of them rate legs', () => {
    expect(inPlans.map((row) => row.asset.symbol)).toEqual([
      'USDY',
      'wYLDS',
      'kUSDC',
      'jlJupUSD',
      'PST',
      'PRIME',
      'AUTO',
    ]);
    expect(inPlans.map((row) => row.asset.symbol).filter(isRate)).toEqual(['USDY', 'wYLDS']);
    // A token with no market route is held to the thinnest tier, whatever its redemption allows.
    expect(inPlans.find((row) => row.asset.symbol === 'kUSDC')?.asset.tier).toBe('C');
    // The deposit tokens of one lending market share its issuer, so the issuer cap counts them as one.
    const issuerOf = (symbol: string) => extended.assets.find((a) => a.symbol === symbol)?.issuer;
    expect(issuerOf('jlJupUSD')).toBe(issuerOf('jlUSDC'));
    expect(issuerOf('PRIME')).toBe(issuerOf('wYLDS'));
    expect(issuerOf('AUTO')).toBe(issuerOf('wYLDS'));
  });

  it('list the local-currency bonds in their own currency and keep each out of every plan', () => {
    const out = extendedHeldOut('solana');
    const bonds = out.filter((row) => row.asset.currency !== undefined);
    expect(bonds.map((row) => [row.asset.symbol, row.asset.currency])).toEqual([
      ['TESOURO', 'BRL'],
      ['CETES', 'MXN'],
      ['GILTS', 'GBP'],
      ['KTB', 'KRW'],
      ['EUROB', 'EUR'],
    ]);
    expect(bonds.find((row) => row.asset.symbol === 'TESOURO')?.heldOut).toBe(
      'a bond in reais is not a cash leg yet',
    );
    // A token counted in a currency of its own that is not cash is never on the shelf the engine takes.
    for (const row of extendedRows('solana'))
      if (row.asset.currency !== undefined && row.asset.cls !== 'cash')
        expect(row.heldOut, row.asset.id).toBeDefined();
    // The tokens on hold say so, and none of them has a leg type passed off as settled.
    const onHold = out.filter((row) => row.verdict === 'hold').map((row) => row.asset.symbol);
    expect(onHold).toEqual(['USTRY', 'EUROB', 'sUSD', 'sUSDe', 'ONyc', 'USD*', 'eUSX', 'oTFY']);
    for (const symbol of ['ONyc', 'USD*']) expect(LEG_TYPES[symbol], symbol).toBeUndefined();
  });
});

describe('plans on the extended shelf on Solana', () => {
  it('an income goal at low risk holds a rate token, where the launch shelf left a quarter or more in cash', () => {
    for (const amountUsd of [10_000, 50_000]) {
      const s = solana({ goal: 'income', risk: 'low', amountUsd });
      const [before, after] = [run(s, launch, onLaunch), run(s)];
      expect(held(before).some(isRate)).toBe(false);
      expect(sleeveBps(before, launch, 'cash')).toBeGreaterThanOrEqual(2500);
      expect(held(after).filter(isRate).length).toBeGreaterThan(0);
      expect(sleeveBps(after, extended, 'cash')).toBeLessThan(sleeveBps(before, launch, 'cash'));
    }
  });

  it('the safe-yield sleeve holds rate tokens only, where the launch shelf had none to hold', () => {
    const s = solana({ sleeves: [{ kind: 'safe_yield', shareBps: 10_000 }] });
    const before = run(s, launch, onLaunch);
    expect(before.flags).toContain('safe_yield_no_rate_leg');
    const after = run(s);
    expect(after.flags).not.toContain('safe_yield_no_rate_leg');
    const yieldLines = after.lines.filter(
      (l) => extended.assets.find((a) => a.id === l.assetId)?.cls === 'dollar_yield',
    );
    expect(yieldLines.length).toBeGreaterThan(0);
    for (const l of yieldLines) expect(isRate(symbolOf.get(l.assetId) ?? ''), l.assetId).toBe(true);
  });

  it('"no lending" leaves out every credit and basis token, and an income or protect plan still holds a rate token', () => {
    for (const goal of ['income', 'protect', 'grow'] as const) {
      const s = solana({
        goal,
        risk: 'low',
        amountUsd: 50_000,
        limits: { creditTolerance: 'none' },
      });
      for (const { plan } of candidates(s, extended, onExtended).shown) {
        expect(violations(plan, extended, onExtended)).toEqual([]);
        expect(held(plan).filter(isCredit), `${goal} ${plan.candidate}`).toEqual([]);
        // A goal to grow at this size keeps its small dollar-yield sleeve in the deposits that pay
        // more; a plan that is mostly dollar yield runs past their caps and holds a rate token.
        if (goal !== 'grow')
          expect(held(plan).some(isRate), `${goal} ${plan.candidate}`).toBe(true);
      }
    }
  });

  // Gate COUNTRY-REMOVED (Rodrigo, Oct 6): this test held that USDY, wYLDS, PRIME and AUTO were never
  // held for a person in a country that blocks them (Canada held wYLDS, not USDY). The blocks stay
  // in the rows as information; the plan reads no country.
  it('the geo-blocks stay as information, and a person in a blocking country gets the same plan', () => {
    const blocked = inPlans.filter((row) => row.asset.blockedCountries.length > 0);
    expect(blocked.map((row) => row.asset.symbol)).toEqual(['USDY', 'wYLDS', 'PRIME', 'AUTO']);
    const anywhere = run(solana({ goal: 'income', risk: 'low' }));
    expect(held(anywhere)).toContain('USDY');
    for (const country of ['CA', 'US', 'RU'])
      expect(run(solana({ goal: 'income', risk: 'low', country })).lines, country).toEqual(
        anywhere.lines,
      );
  });

  it('a goal in reais holds no bond yet, and says it has no matching leg, as on the launch shelf', () => {
    const s = solana({
      goal: 'protect',
      risk: 'low',
      amountUsd: 20_000,
      currency: 'BRL',
      obligations: [{ month: '2027-06', amount: 9000, currency: 'BRL' }],
    });
    const fx = { fx: [usdBrl()] };
    const before = run(s, launch, { ...onLaunch, ...fx });
    const after = run(s, extended, { ...onExtended, ...fx });
    expect(before.flags).toContain('no_matching_leg:BRL');
    expect(after.flags).toContain('no_matching_leg:BRL');
    const bonds = new Set(extendedHeldOut('solana').map((row) => row.asset.id));
    for (const l of after.lines) expect(bonds.has(l.assetId)).toBe(false);
    expect(extended.assets.some((a) => a.currency !== undefined)).toBe(false);
  });

  it('on the grid, the share left in cash falls from 25.38% to 3.12% of a plan, and rises in no income or protect plan', () => {
    let [before, after, n] = [0, 0, 0];
    for (const s of shelfGrid('solana')) {
      const [a, b] = [candidates(s, launch, onLaunch), candidates(s, extended, onExtended)];
      for (const id of ['cover', 'spread', 'carry'] as const) {
        const [x, y] = [a.shown.find((c) => c.id === id), b.shown.find((c) => c.id === id)];
        if (!x || !y) continue;
        const [was, is] = [sleeveBps(x.plan, launch, 'cash'), sleeveBps(y.plan, extended, 'cash')];
        if (s.goal !== 'grow')
          expect(is, `${s.goal}:${s.risk}:${s.amountUsd} ${id}`).toBeLessThanOrEqual(was);
        before += was;
        after += is;
        n += 1;
      }
    }
    // The mean over the 69 candidates both shelves show, in basis points of a plan.
    expect(n).toBe(69);
    expect(Math.round(before / n)).toBe(2538);
    expect(Math.round(after / n)).toBe(312);
  });
});

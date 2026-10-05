import type { Shelf } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { compose } from './index';
import { fixtureContext, launchShelf, sheet, violations } from './testing';
import type { PersonalProposal, PersonalSheet } from './types';

// Decided on Oct 5 (gate GOLD-PAXG, Thom): the gold a plan holds when no shared portfolio fills its
// gold sleeve is PAXG where the chain lists it, and GLD where it does not. The launch shelf's seed was
// measured before the gate and lists GLDx on Solana; here Solana also lists PAXG, as devnet's tPAXG
// (`deployments/solana-devnet.json`: kind gold, modelOf PAXG).

const seed = launchShelf();
const gldx = seed.assets.find((a) => a.id === 'solana:gldx');
if (!gldx) throw new Error('the launch shelf lists no GLDx on Solana');
const shelf: Shelf = {
  ...seed,
  assets: [
    ...seed.assets,
    {
      ...gldx,
      id: 'solana:paxg',
      symbol: 'PAXG',
      underlying: 'PAXG',
      issuer: 'Paxos',
      sheet: 'paxg',
      session: 'always',
    },
  ],
};

function protect(over: Partial<PersonalSheet>, on: Shelf = shelf): PersonalProposal {
  const ctx = fixtureContext();
  const made = compose(sheet({ goal: 'protect', amountUsd: 25_000, ...over }), on, ctx);
  expect(violations(made, on, ctx)).toEqual([]);
  return made;
}
const goldOf = (made: PersonalProposal) =>
  made.lines.filter(
    (l) => l.assetId.endsWith(':paxg') || l.assetId.endsWith(':gld') || l.assetId.endsWith(':gldx'),
  );
const removedOf = (made: PersonalProposal) =>
  made.removed.map((r) => [r.ref, r.reasons.map((x) => x.rule)]);

describe('the gold a plan starts from (gate GOLD-PAXG)', () => {
  it('is PAXG on Solana, before GLD', () => {
    const made = protect({ chains: ['solana'] });
    expect(goldOf(made).map((l) => [l.assetId, l.weightBps])).toEqual([['solana:paxg', 2500]]);
    expect(
      made.lines.find((l) => l.assetId === 'solana:paxg')?.reasons.map((r) => r.text),
    ).toContain('PAXG: where a goal to protect starts when you choose no shared portfolio.');
    expect(made.removed).toEqual([]);
  });

  it('is GLD on Robinhood Chain, which does not list PAXG, and nothing says PAXG is missing', () => {
    // At high risk: Robinhood issues GLD and SGOV, and at medium risk one issuer holds at most 70%.
    const made = protect({ chains: ['robinhood'], risk: 'high' });
    expect(goldOf(made).map((l) => [l.assetId, l.weightBps])).toEqual([['robinhood:gld', 2500]]);
    expect(made.removed).toEqual([]);
  });

  it('is the next one the person can hold: GLDx on Solana when they cannot hold PAXG', () => {
    const made = protect({ chains: ['solana'], limits: { cannotHold: { underlyings: ['PAXG'] } } });
    expect(goldOf(made).map((l) => [l.assetId, l.weightBps])).toEqual([['solana:gldx', 2500]]);
  });

  it('on a chain that lists neither, is held in dollar yield or cash, and the plan says why', () => {
    const made = protect({ chains: ['base'] });
    expect(goldOf(made)).toEqual([]);
    expect(made.sleeves.find((s) => s.sleeve === 'gold')?.weightBps).toBe(0);
    expect(removedOf(made)).toEqual([
      ['GLD', ['NOT_ON_CHAIN']],
      ['PAXG', ['NOT_ON_CHAIN']],
    ]);
    expect(made.lines.flatMap((l) => l.reasons).map((r) => r.text)).toContain(
      '$6,250 meant for GLD and PAXG is held in dollar yield or cash instead: Base does not list it.',
    );
  });

  it('names only what the chain lists when the person cannot hold it: GLD on Robinhood Chain', () => {
    const made = protect({
      chains: ['robinhood'],
      risk: 'high',
      limits: { cannotHold: { underlyings: ['GLD'] } },
    });
    expect(goldOf(made)).toEqual([]);
    expect(removedOf(made)).toEqual([['GLD', ['EXCLUDED']]]);
  });
});

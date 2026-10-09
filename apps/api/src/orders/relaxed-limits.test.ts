import type { BasketAsset, VaultAgentRequest } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { catalogCap, holdingConstraints } from './relaxed-limits';

// The relaxed intake's guards on a line (gate RELAXED-INTAKE): the cap beside each holding and the
// limits a person wrote in their own words. Guards only: nothing here sets a weight.

const asset = (id: string, symbol: string, cls: BasketAsset['cls'], maxWeightBps = 2500) =>
  ({
    id: `solana:${id}`,
    symbol,
    underlying: symbol.replace(/x$/, ''),
    cls,
    chain: 'solana',
    maxWeightBps,
  }) as unknown as BasketAsset;

const ASSETS = [
  asset('tslax', 'TSLAx', 'stock'),
  asset('paxg', 'PAXG', 'gold'),
  asset('usdc', 'USDC', 'cash', 3000),
];
const said = (...texts: string[]): VaultAgentRequest['messages'] =>
  texts.map((text) => ({ who: 'person' as const, text }));
const limits = (...texts: string[]) =>
  holdingConstraints(said(...texts), ASSETS).map(({ key, min, max }) => ({ key, min, max }));

describe('catalogCap', () => {
  it('is the listed cap, and the whole for cash, the residual balance', () => {
    expect(catalogCap(ASSETS[0] as BasketAsset)).toBe(2500);
    expect(catalogCap(ASSETS[2] as BasketAsset)).toBe(10_000);
  });
});

describe('holdingConstraints', () => {
  it('reads an upper, a lower and an exact limit the person asked for', () => {
    expect(limits('I want at most 20% in TSLA')).toEqual([
      { key: 'solana:tslax', min: 0, max: 2000 },
    ]);
    expect(limits('Keep at least 10% gold')).toEqual([{ key: 'gold', min: 1000, max: 10_000 }]);
    expect(limits('Put 30% in stocks')).toEqual([{ key: 'stocks', min: 3000, max: 3000 }]);
  });

  it('reads nothing from a question, someone else’s words, a refusal or a figure that is no share', () => {
    expect(limits('Should I put 20% in TSLA?')).toEqual([]);
    expect(limits('My friend said 20% in TSLA')).toEqual([]);
    expect(limits("I don't want 20% in TSLA")).toEqual([]);
    expect(limits('TSLA fell 20% last year')).toEqual([]);
    expect(limits('I want 150% in TSLA')).toEqual([]);
  });

  it('a later limit on the same holding replaces the earlier, and "drop that limit" withdraws it', () => {
    expect(limits('I want at most 20% in TSLA', 'Make that 30%')).toEqual([
      { key: 'solana:tslax', min: 3000, max: 3000 },
    ]);
    expect(limits('I want at most 20% in TSLA', 'Drop that limit')).toEqual([]);
    expect(limits('I want at most 20% in TSLA', 'Remove the TSLA limit')).toEqual([]);
  });
});

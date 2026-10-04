import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCOPE_ENTRIES } from '@colosseum/chain-solana/vault';
import { SCOPE_MAINNET } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './world';

// Where the ten stock tokens sit in Kamino Scope's price account on mainnet: the price entry and its
// one-hour average. The table is what the deploy step writes into the asset list (`upsert_asset`) and
// what programs/tests uses for its test assets. It is cut from the lending registry the risk layer
// froze, so it cannot drift from it.

type Row = {
  symbol: string;
  mint: string;
  decimals: number;
  priceIndex: number;
  twapIndex: number;
};
type Table = {
  source: string;
  method: string;
  fetchedAt: string;
  provenance: string;
  priceAccount: string;
  assets: Row[];
};
type Reserve = {
  venue: string;
  role: string;
  symbol: string;
  mint: string;
  decimals: number;
  method: string;
  fetchedAt: string;
  oracles: { scopePriceFeed: string; scopePriceChain: number[]; scopeTwapChain: number[] } | null;
};

const read = <T>(...path: string[]): T =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', ...path), 'utf8'));
const table = read<Table>('solana-vault', 'scope-indexes.json');
const registry = read<{ registry: Reserve[] }>('risk', 'lending', 'import.json').registry;

describe('the Scope positions of the stock tokens', () => {
  it('lists the ten, with where the numbers came from', () => {
    expect(table.assets.map((a) => a.symbol)).toEqual([
      'AAPLx',
      'CRCLx',
      'GOOGLx',
      'HOODx',
      'METAx',
      'MSTRx',
      'NVDAx',
      'QQQx',
      'SPYx',
      'TSLAx',
    ]);
    expect(table.source).toContain('fixtures/risk/lending/import.json');
    expect(table.method).not.toBe('');
    expect(Number.isNaN(Date.parse(table.fetchedAt))).toBe(false);
  });

  it('is what the frozen lending registry says of each, in every reserve that holds it', () => {
    for (const row of table.assets) {
      const reserves = registry.filter(
        (r) => r.venue === 'kamino' && r.role === 'collateral' && r.symbol === row.symbol,
      );
      expect(reserves.length, row.symbol).toBeGreaterThan(0);
      for (const reserve of reserves) {
        expect([reserve.mint, reserve.decimals], row.symbol).toEqual([row.mint, row.decimals]);
        expect(reserve.oracles, row.symbol).toMatchObject({
          scopePriceFeed: table.priceAccount,
          scopePriceChain: [row.priceIndex],
          scopeTwapChain: [row.twapIndex],
        });
        expect([reserve.method, reserve.fetchedAt]).toEqual([table.method, table.fetchedAt]);
      }
    }
  });

  it('names the price account the mainnet config names', () => {
    expect(table.priceAccount).toBe(SCOPE_MAINNET.prices);
  });

  it('gives every token an entry of its own and an average that is another entry', () => {
    const indexes = table.assets.flatMap((a) => [a.priceIndex, a.twapIndex]);
    expect(new Set(indexes).size).toBe(indexes.length);
    for (const index of indexes) {
      expect(Number.isInteger(index) && index >= 0 && index < SCOPE_ENTRIES).toBe(true);
    }
  });
});

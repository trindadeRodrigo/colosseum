import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCOPE_ENTRIES } from '@colosseum/chain-solana/vault';
import { SCOPE_MAINNET } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './world';

// Where the ten stock tokens and PAXG sit in Kamino Scope's price account on mainnet: the price entry
// and its one-hour average. The table is what the deploy step writes into the asset list
// (`upsert_asset`) and what programs/tests uses for its test assets. The stock rows are cut from the
// lending registry the risk layer froze, so they cannot drift from it. PAXG (gate GOLD-PAXG) is not in
// that registry: its row was decoded from its Kamino reserve on its own and says so.

type Row = {
  symbol: string;
  mint: string;
  decimals: number;
  priceIndex: number;
  twapIndex: number;
  /** A row read apart from the registry carries where it came from. */
  source?: string;
  method?: string;
  fetchedAt?: string;
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
const stocks = table.assets.filter((a) => a.symbol !== 'PAXG');
const registry = read<{ registry: Reserve[] }>('risk', 'lending', 'import.json').registry;

describe('the Scope positions of the stock tokens', () => {
  it('lists the ten and PAXG, with where the numbers came from', () => {
    expect(stocks.map((a) => a.symbol)).toEqual([
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
    expect(table.assets.map((a) => a.symbol)).toEqual([...stocks.map((a) => a.symbol), 'PAXG']);
    expect(table.source).toContain('fixtures/risk/lending/import.json');
    expect(table.method).not.toBe('');
    expect(Number.isNaN(Date.parse(table.fetchedAt))).toBe(false);
  });

  it('is what the frozen lending registry says of each, in every reserve that holds it', () => {
    for (const row of stocks) {
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

  it("gives PAXG the mint of gate GOLD-PAXG and the entries of its Kamino reserve, with the reading's source", () => {
    const paxg = table.assets.find((a) => a.symbol === 'PAXG');
    expect(paxg).toMatchObject({
      mint: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW',
      decimals: 6,
      priceIndex: 454,
      twapIndex: 168,
    });
    expect(paxg?.source).toContain('5MHbdvbQTegtPfFikifciBopmdEmZvWXDUpcHkQaz1w4');
    expect(paxg?.method).toBe('kamino_reserve_decode');
    expect(Number.isNaN(Date.parse(paxg?.fetchedAt ?? ''))).toBe(false);
    // The registry was frozen before the gate: were PAXG in it, its row would be checked above.
    expect(registry.some((r) => r.symbol === 'PAXG')).toBe(false);
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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalInputError } from '@colosseum/engine/personal';
import { ChainId } from '@colosseum/schemas';
import { afterAll, describe, expect, it } from 'vitest';
import { bearingPlanInputs } from './plan-inputs';
import { loadStockAttributes } from './stock-attributes';
import mockStocks from './testing/fixtures/mock-stocks.json';

// The stock attributes the server hands the engine (gate THEME-MATCHED): the file of the person's
// chain, validated. The rows here are a fixture labelled mock, written into a scratch folder.

const scratch = mkdtempSync(join(tmpdir(), 'stocks-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const write = (chain: string, content: unknown) =>
  writeFileSync(join(scratch, `${chain}.json`), JSON.stringify(content));

describe('loadStockAttributes', () => {
  it('reads the file of the chain, and nothing for a chain or a folder with none', () => {
    write('solana', mockStocks);
    const read = loadStockAttributes('solana', scratch);
    expect(read).toEqual(mockStocks);
    expect(read?.stocks.map((s) => [s.symbol, s.kind])).toEqual([
      ['NVDAx', 'common'],
      ['AVGOx', 'common'],
      ['TSLAx', 'common'],
      ['SPYx', 'fund'],
    ]);
    expect(loadStockAttributes('robinhood', scratch)).toBeNull();
    expect(loadStockAttributes('base', scratch)).toBeNull();
    expect(loadStockAttributes('solana', join(scratch, 'nowhere'))).toBeNull();
  });

  it('refuses a file that does not validate, or that holds another chain’s stocks', () => {
    write('solana', { ...mockStocks, version: 0 });
    expect(() => loadStockAttributes('solana', scratch)).toThrow(PersonalInputError);
    expect(() => loadStockAttributes('solana', scratch)).toThrow(
      /content\/stocks\/solana\.json\.version/,
    );
    const [first] = mockStocks.stocks;
    write('solana', { ...mockStocks, stocks: [{ ...first, keywords: ['gpus'] }] });
    expect(() => loadStockAttributes('solana', scratch)).toThrow(
      /content\/stocks\/solana\.json\.stocks\.0\.keywords/,
    );
    write('solana', { ...mockStocks, stocks: [{ ...first, pick: true }] });
    expect(() => loadStockAttributes('solana', scratch)).toThrow(PersonalInputError);
    // Solana's rows under another chain's name.
    write('base', mockStocks);
    expect(() => loadStockAttributes('base', scratch)).toThrow(
      'content/stocks/base.json holds the stocks of solana',
    );
    // A file that is not JSON is never half read.
    writeFileSync(join(scratch, 'robinhood.json'), '{ "chain": "robinhood", ');
    expect(() => loadStockAttributes('robinhood', scratch)).toThrow(SyntaxError);
  });

  it('whatever content/stocks holds for a chain validates, and is what the server hands the route', async () => {
    // The files come with the content. Each chain's is read here if it is there: one that does not
    // validate fails this, and a chain with none hands the route no attributes.
    for (const chain of ChainId.options) {
      const read = loadStockAttributes(chain);
      expect(read === null || read.chain === chain, chain).toBe(true);
      const figures = await bearingPlanInputs({ db: {} as never, chain, assets: [] });
      expect(figures.stocks ?? null, chain).toEqual(read);
    }
  });
});

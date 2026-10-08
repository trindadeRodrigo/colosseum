import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalInputError } from '@colosseum/engine/personal';
import { ChainId } from '@colosseum/schemas';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../packages/engine/src/personal/testing';
import {
  buildGoalAgentContext,
  replyToVaultConversation,
  type VaultAgentPrompt,
} from './orders/vault-agent';
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

  it.each(['solana', 'robinhood'] as const)(
    'passes Tesla’s dated primary-source affiliation through the %s conversation context',
    async (chain) => {
      const stocks = loadStockAttributes(chain);
      const tesla = stocks?.stocks.find((row) => row.underlying === 'TSLA');
      if (!stocks || !tesla) throw new Error(`Missing Tesla attributes on ${chain}`);
      expect(tesla.note).toContain('bitcoin held as digital assets');
      expect(tesla.note).toContain('Elon Musk as its co-founder and CEO');
      expect(tesla.note).toContain('does not establish future investment benefit');
      const primarySources = tesla.sources.filter((source) =>
        ['https://www.tesla.com/elon-musk', 'https://ir.tesla.com/corporate'].includes(source.url),
      );
      expect(primarySources.map((source) => [source.url, source.readOn])).toEqual([
        ['https://www.tesla.com/elon-musk', '2026-10-08'],
        ['https://ir.tesla.com/corporate', '2026-10-08'],
      ]);

      // The catalog uses production asset IDs from the launch shelf, with fixture provenance here.
      // No provider, adapter, database or financial confirmation is called by this fixture.
      const shelf = launchShelf();
      const asset = shelf.assets.find(
        (candidate) => candidate.chain === chain && candidate.symbol === tesla.symbol,
      );
      if (!asset) throw new Error(`Missing catalog asset for ${tesla.symbol}`);
      expect(asset.provenance).toBe('fixture');
      const context = buildGoalAgentContext({
        chain,
        observedAt: '2026-10-08T00:00:00.000Z',
        person: 'source-context-fixture',
        prices: [],
        prepared: { shelf, figures: { stocks } },
        entry: { source: 'offline catalog fixture', provenance: 'mock' } as Parameters<
          typeof buildGoalAgentContext
        >[0]['entry'],
      });
      let sent: VaultAgentPrompt | undefined;
      const model = {
        read: vi.fn(async (_person: string, prompt: VaultAgentPrompt) => {
          sent = prompt;
          return {
            reply: {
              message: 'The supplied company affiliation does not establish future benefit.',
              question: null,
              proposal: null,
            },
          };
        }),
      };
      const out = await replyToVaultConversation(
        {
          version: 1,
          language: 'en',
          messageId: 'source-context-turn',
          messages: [{ who: 'person', text: 'I want to explore stocks related to Elon Musk.' }],
        },
        context,
        model,
      );
      expect(out.kind).toBe('reply');
      expect(sent?.stockAttributes?.stocks.find((row) => row.symbol === tesla.symbol)).toEqual(
        tesla,
      );
      expect(sent?.catalog.find((candidate) => candidate.id === asset.id)).toMatchObject({
        symbol: tesla.symbol,
        maxWeightBps: asset.maxWeightBps,
      });
      for (const source of primarySources) {
        const sourceIndex = tesla.sources.indexOf(source);
        expect(sent?.evidence).toContainEqual(
          expect.objectContaining({
            id: `stock:${asset.id}:${sourceIndex}`,
            assetId: asset.id,
            source: source.url,
            fetchedAt: '2026-10-08T00:00:00.000Z',
            provenance: 'fixture',
          }),
        );
      }
    },
  );
});

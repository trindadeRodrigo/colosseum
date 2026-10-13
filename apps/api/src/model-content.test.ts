import { EvmDeploymentRecord, deploymentAssets as evmAssets } from '@colosseum/chain-evm/vault';
import {
  SolanaDeploymentRecord,
  deploymentAssets as solanaAssets,
} from '@colosseum/chain-solana/vault';
import {
  attributeVocabularyOf,
  type ComposeContext,
  compose,
  filterMatchOf,
  matchStocks,
  parseStockAttributes,
  parseThemeList,
  riskForMix,
  riskForSleeves,
  shelfLabelsOf,
} from '@colosseum/engine/personal';
import type { ChainId, Provenance } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import robinhoodRecord from '../../../deployments/robinhood-testnet.json';
import solanaRecord from '../../../deployments/solana-devnet.json';
import tierFile from '../../../fixtures/risk/launch-shelf-tiers.json';
import { fixtureLiquidity, sheet } from '../../../packages/engine/src/personal/testing';
import { modelContent } from './model-content';
import { asSandbox, issuerTwins, shelfTiers, standIns, tierTwins } from './model-exits';
import { type PlanInputs, preparePersonalInputs, shelfVersionOf } from './orders/personalize';
import { loadStockAttributes } from './stock-attributes';
import { loadThemeLists } from './theme-lists';

// Public committed deployment records, not RPC reads. The content remains the sourced model data.
const cases = [
  {
    chain: 'solana' as const,
    assets: solanaAssets(SolanaDeploymentRecord.parse(solanaRecord)),
    ai: 5,
    tech: 4,
  },
  {
    chain: 'robinhood' as const,
    assets: evmAssets(EvmDeploymentRecord.parse(robinhoodRecord)),
    ai: 7,
    tech: 3,
  },
];
const contentOf = (chain: ChainId) => ({
  themes: loadThemeLists(chain),
  stocks: loadStockAttributes(chain) ?? undefined,
});
const tierShelf = shelfTiers(tierFile);
const fixture = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('required public fixture is absent');
  return value;
};

describe.each(cases)(
  'model content on the committed $chain test network',
  ({ chain, assets, ai, tech }) => {
    it('makes only the deployed curated and matched names available, without renaming an asset', () => {
      const source = contentOf(chain);
      const before = JSON.stringify({ source, assets });
      const adapted = modelContent(chain, assets, 'sandbox', source);
      const labels = shelfLabelsOf(adapted.themes ?? [], assets);
      expect(shelfLabelsOf(source.themes, assets).every((list) => list.listed === 0)).toBe(true);
      expect(labels.find((list) => list.slug === 'ai')?.listed).toBe(ai);
      expect(labels.find((list) => list.slug === 'big-tech')?.listed).toBe(ai);
      expect(labels.find((list) => list.slug === 'broad-market')?.listed).toBe(2);
      for (const slug of ['space', 'defense'])
        expect(labels.find((list) => list.slug === slug)?.listed).toBe(0);
      expect(labels.find((list) => list.slug === 'semiconductors')?.listed).toBe(1);
      expect(
        filterMatchOf({ by: 'sector', value: 'Information Technology' }, adapted.stocks, assets)
          ?.listed,
      ).toBe(tech);
      expect(JSON.stringify({ source, assets })).toBe(before);
      expect(assets.every((asset) => asset.provenance === 'sandbox')).toBe(true);
    });

    it('retains every member, stock, sourced field and keyword, including unlisted companies', () => {
      const source = contentOf(chain);
      const adapted = modelContent(chain, assets, 'sandbox', source);
      expect(
        adapted.themes?.map((list) => ({
          ...list,
          members: list.members.map(({ symbol: _s, ...m }) => m),
        })),
      ).toEqual(
        source.themes.map((list) => ({
          ...list,
          members: list.members.map(({ symbol: _s, ...m }) => m),
        })),
      );
      const withoutSymbol = (rows: NonNullable<typeof adapted.stocks>['stocks']) =>
        rows.map(({ symbol: _s, ...row }) => row);
      expect(withoutSymbol(adapted.stocks?.stocks ?? [])).toEqual(
        withoutSymbol(source.stocks?.stocks ?? []),
      );
      expect({ ...adapted.stocks, stocks: [] }).toEqual({ ...source.stocks, stocks: [] });
      expect(attributeVocabularyOf(adapted.stocks)).toEqual(attributeVocabularyOf(source.stocks));
      const unlisted = chain === 'solana' ? ['MSFTx', 'AMZNx', 'GLDx'] : ['AMD', 'RKLB'];
      for (const symbol of unlisted) {
        expect(adapted.stocks?.stocks.find((row) => row.symbol === symbol)).toEqual(
          source.stocks?.stocks.find((row) => row.symbol === symbol),
        );
        expect(assets.some((asset) => asset.symbol === symbol)).toBe(false);
      }
      for (const list of adapted.themes ?? []) expect(parseThemeList(list)).toEqual(list);
      if (adapted.stocks) expect(parseStockAttributes(adapted.stocks)).toEqual(adapted.stocks);
    });

    it.each(['live', 'mock', undefined] as const)(
      'borrows no content when the chain provenance is %s',
      (provenance) => {
        const source = contentOf(chain);
        expect(modelContent(chain, assets, provenance, source)).toBe(source);
        const live = assets.map((asset) => ({ ...asset, provenance: 'live' as const }));
        expect(modelContent(chain, live, 'sandbox', source)).toBe(source);
      },
    );

    it.each([false, true])(
      'prepares identical risk inputs for read-back and construction, measured exits: %s',
      async (measured) => {
        const provider = measured
          ? asSandbox(
              fixtureLiquidity(
                Object.fromEntries(
                  assets.filter((a) => a.cls !== 'cash').map((a) => [a.id, 1_000_000]),
                ),
              ),
            )
          : undefined;
        const load = vi.fn(
          async (
            readChain: ChainId,
            listed: typeof assets,
            provenance: Provenance,
          ): Promise<Awaited<ReturnType<PlanInputs>>> => {
            const tokens = standIns(listed, provenance);
            return {
              ...modelContent(readChain, listed, provenance, contentOf(readChain)),
              ...(provider
                ? { liquidity: { provider, source: 'sample measurements on a test network' } }
                : {}),
              tiers: tierTwins(
                tokens.filter((a) => !provider?.covers(a.id)),
                tierShelf,
              ).map((t) => ({
                assetId: t.id,
                tier: t.tier,
                source: tierFile.source,
                method: tierFile.method,
                fetchedAt: tierFile.fetchedAt,
                provenance: 'sandbox',
              })),
              issuers: issuerTwins(tokens, tierShelf).map((t) => ({
                assetId: t.id,
                issuer: t.issuer,
                of: t.twinSymbol,
              })),
            };
          },
        );
        const intake = await preparePersonalInputs(chain, assets, [], 'sandbox', load);
        const personalization = await preparePersonalInputs(chain, assets, [], 'sandbox', load);
        expect(load).toHaveBeenNthCalledWith(1, chain, assets, 'sandbox');
        expect(intake.shelf).toEqual(personalization.shelf);
        expect(intake.shelf.version).toBe(shelfVersionOf(chain, intake.shelf.assets, []));
        expect(intake.shelf.version).not.toBe(shelfVersionOf(chain, assets, []));
        expect(intake.shelf.assets.map(({ tier: _t, issuer: _i, ...a }) => a)).toEqual(
          assets.map(({ tier: _t, issuer: _i, ...a }) => a),
        );
        expect(
          intake.shelf.assets
            .filter((a) => a.cls === 'stock')
            .every((a) => a.issuer !== 'test network'),
        ).toBe(true);
        const context = (p: typeof intake): ComposeContext => ({
          now: '2026-10-07T12:00:00.000Z',
          themes: p.figures.themes,
          stocks: p.figures.stocks,
          liquidity: p.figures.liquidity?.provider,
          liquiditySource: p.figures.liquidity?.source,
        });
        const mix = sheet({
          chains: [chain],
          themes: [],
          rules: { useHoldings: false, glide: false },
          mix: { growthBps: 8000, dollarYieldBps: 0, goldBps: 0, cashBps: 2000 },
        });
        expect(riskForMix(mix, intake.shelf, context(intake))).toBe(
          compose(mix, personalization.shelf, context(personalization)).sheet.risk,
        );
        for (const theme of ['ai', 'matched-sector-information-technology']) {
          const themed = sheet({
            chains: [chain],
            themes: [],
            rules: { useHoldings: false, glide: false },
            sleeves: [{ kind: 'theme', theme, shareBps: 10_000 }],
          });
          const risk = riskForSleeves(themed, intake.shelf, context(intake));
          const plan = compose(
            { ...themed, risk },
            personalization.shelf,
            context(personalization),
          );
          expect(plan.sheet.risk).toBe(risk);
          const held =
            plan.split?.filter((part) => part.kind === 'theme').flatMap((part) => part.holds) ?? [];
          expect(
            held.some((line) => assets.find((a) => a.id === line.assetId)?.cls === 'stock'),
          ).toBe(true);
          expect(held.every((line) => assets.some((a) => a.id === line.assetId))).toBe(true);
          if (provider)
            expect(
              plan.observations
                .filter((o) => o.kind === 'liquidity')
                .every((o) => o.provenance === 'sandbox'),
            ).toBe(true);
        }
      },
    );
  },
);

describe('model identity cannot add companies or keyword carriers', () => {
  const { assets } = fixture(cases[0]);
  const source = contentOf('solana');
  const nvda = fixture(assets.find((a) => a.underlying === 'NVDA'));
  const sourceStocks = fixture(source.stocks);
  it('rejects two tokens of the same model and translated symbol collisions', () => {
    expect(() =>
      modelContent(
        'solana',
        [...assets, { ...nvda, id: 'solana:other', symbol: 'otherNVDA' }],
        'sandbox',
        source,
      ),
    ).toThrow(/more than one listed token models/);
    const row = fixture(sourceStocks.stocks.find((row) => row.symbol === 'NVDAx'));
    expect(() =>
      modelContent('solana', assets, 'sandbox', {
        ...source,
        stocks: {
          ...sourceStocks,
          stocks: [...sourceStocks.stocks, { ...row, symbol: nvda.symbol }],
        },
      }),
    ).toThrow(/repeat a symbol/);
    const list = fixture(source.themes.find((list) => list.slug === 'ai'));
    const member = fixture(list.members.find((member) => member.symbol === 'NVDAx'));
    expect(() =>
      modelContent('solana', assets, 'sandbox', {
        themes: [{ ...list, members: [...list.members, { ...member, symbol: nvda.symbol }] }],
      }),
    ).toThrow(/repeat a symbol/);
  });
  it('rejects a content row that names another model and content of another chain', () => {
    const stocks = {
      ...sourceStocks,
      stocks: sourceStocks.stocks.map((row) =>
        row.symbol === 'NVDAx' ? { ...row, underlying: 'AMD' } : row,
      ),
    };
    expect(() => modelContent('solana', assets, 'sandbox', { ...source, stocks })).toThrow(
      /differs from the attributes/,
    );
    expect(() => modelContent('solana', assets, 'sandbox', contentOf('robinhood'))).toThrow(
      /own chain/,
    );
  });
  it('keeps an unlisted keyword carrier, so the existing keyword and single-listed-name rules still run', () => {
    const rows = sourceStocks.stocks
      .filter((row) => ['NVDAx', 'MSFTx'].includes(row.symbol))
      .map((row) => ({
        ...row,
        keywords: ['shared label', 'another label', 'one more'],
        unverified: [],
      }));
    const file = { ...sourceStocks, stocks: rows };
    const adapted = fixture(modelContent('solana', [nvda], 'sandbox', { stocks: file }).stocks);
    expect(adapted.stocks).toHaveLength(2);
    expect(matchStocks({ by: 'keyword', value: 'shared label' }, adapted.stocks)).toHaveLength(2);
    expect(filterMatchOf({ by: 'keyword', value: 'shared label' }, adapted, [nvda])?.listed).toBe(
      1,
    );
    const onlyOne = { ...adapted, stocks: [fixture(adapted.stocks[0])] };
    expect(matchStocks({ by: 'keyword', value: 'shared label' }, onlyOne.stocks)).toEqual([]);
    const unverified = {
      ...adapted,
      stocks: adapted.stocks.map((row) => ({ ...row, unverified: ['keywords' as const] })),
    };
    expect(filterMatchOf({ by: 'keyword', value: 'shared label' }, unverified, [nvda])).toBeNull();
  });
  it('does not borrow another chain’s stand-ins or fabricate a model from a t-prefix', () => {
    expect(modelContent('solana', fixture(cases[1]).assets, 'sandbox', source)).toBe(source);
    const unknown = { ...nvda, underlying: 'not-a-model', symbol: 'tNVDAx' };
    expect(modelContent('solana', [unknown], 'sandbox', source).stocks?.stocks).toEqual(
      source.stocks?.stocks,
    );
  });
  it('preserves the source’s fund, preferred-stock and unverified-field matching rules', () => {
    const common = fixture(sourceStocks.stocks.find((row) => row.symbol === 'NVDAx'));
    const preferred = { ...sourceStocks, stocks: [{ ...common, kind: 'preferred' as const }] };
    const read = fixture(modelContent('solana', [nvda], 'sandbox', { stocks: preferred }).stocks);
    expect(matchStocks({ by: 'sector', value: common.sector ?? '' }, read.stocks)).toEqual([]);
    const unverified = {
      ...sourceStocks,
      stocks: [{ ...common, unverified: ['sector' as const] }],
    };
    const notSupported = fixture(
      modelContent('solana', [nvda], 'sandbox', { stocks: unverified }).stocks,
    );
    expect(matchStocks({ by: 'sector', value: common.sector ?? '' }, notSupported.stocks)).toEqual(
      [],
    );
    const adapted = fixture(modelContent('solana', assets, 'sandbox', source).stocks);
    const fund = fixture(adapted.stocks.find((row) => row.symbol === 'tQQQx'));
    expect(fund.kind).toBe('fund');
    expect(fund.sector).toBeNull();
    expect(fund.tracks).not.toBeNull();
  });
  it('uses the EVM model identity without changing the deployed symbol’s case', () => {
    const { assets } = fixture(cases[1]);
    const source = contentOf('robinhood');
    const lower = assets.map((a) => ({ ...a, underlying: a.underlying.toLowerCase() }));
    const adapted = modelContent('robinhood', lower, 'sandbox', source);
    expect(adapted.stocks?.stocks.some((row) => row.symbol === 'tNVDA')).toBe(true);
    expect(adapted.stocks?.stocks.find((row) => row.symbol === 'tNVDA')?.underlying).toBe('NVDA');
  });
});

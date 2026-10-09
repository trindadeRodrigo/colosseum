import {
  PersonalInputError,
  type StockAttributesFile,
  type ThemeList,
} from '@colosseum/engine/personal';
import { type BasketAsset, type ChainId, chainFamily, type Provenance } from '@colosseum/schemas';
import { standIns, twinSymbols } from './model-exits';

type Content = { themes?: ThemeList[]; stocks?: StockAttributesFile };

/** Sourced model membership under the symbols the test network actually lists; no asset is renamed. */
export function modelContent(
  chain: ChainId,
  assets: BasketAsset[],
  provenance: Provenance | undefined,
  content: Content,
): Content {
  const tokens = standIns(assets, provenance).filter((a) => a.chain === chain);
  if (!tokens.length) return content;
  const invalid = (message: string): never => {
    throw new PersonalInputError('InvalidContext', [{ path: 'modelContent', message }]);
  };
  if (
    content.themes?.some((list) => list.chain !== chain) ||
    (content.stocks && content.stocks.chain !== chain)
  )
    invalid('content must be of the stand-ins’ own chain');
  const key = (symbol: string) => (chainFamily(chain) === 'evm' ? symbol.toLowerCase() : symbol);
  const symbols = new Set([
    ...(content.themes ?? []).flatMap((list) => list.members.map((m) => m.symbol)),
    ...(content.stocks?.stocks ?? []).map((row) => row.symbol),
  ]);
  const aliases = new Map<string, BasketAsset>();
  for (const token of tokens) {
    const symbol = twinSymbols(token)
      .map((name) => [...symbols].find((symbol) => key(symbol) === key(name)))
      .find((symbol) => symbol !== undefined);
    if (!symbol) continue;
    const row = content.stocks?.stocks.find((row) => key(row.symbol) === key(symbol));
    if (row && key(row.underlying) !== key(token.underlying))
      invalid(`the model of ${token.symbol} differs from the attributes of ${symbol}`);
    const prior = aliases.get(key(symbol));
    if (
      (prior && prior.id !== token.id) ||
      assets.some((a) => a.chain === chain && key(a.symbol) === key(symbol) && a.id !== token.id)
    )
      invalid(`more than one listed token models ${symbol}`);
    aliases.set(key(symbol), token);
  }
  const listedSymbol = (symbol: string) => aliases.get(key(symbol))?.symbol ?? symbol;
  const unique = (symbols: string[], where: string) => {
    if (new Set(symbols.map(key)).size !== symbols.length)
      invalid(`model aliases repeat a symbol in ${where}`);
  };
  const themes = content.themes?.map((list) => {
    const members = list.members.map((member) => ({
      ...member,
      symbol: listedSymbol(member.symbol),
    }));
    unique(
      members.map((member) => member.symbol),
      list.slug,
    );
    return { ...list, members };
  });
  const stocks = content.stocks && {
    ...content.stocks,
    // Replace a row, never append one: a second alias is not another keyword carrier or company.
    stocks: content.stocks.stocks.map((row) => ({ ...row, symbol: listedSymbol(row.symbol) })),
  };
  if (stocks)
    unique(
      stocks.stocks.map((row) => row.symbol),
      'stock attributes',
    );
  return { ...(themes ? { themes } : {}), ...(stocks ? { stocks } : {}) };
}

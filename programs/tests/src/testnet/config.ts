import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Address, address } from '@solana/kit';
import type { Params } from '../basket';
import { REPO_ROOT } from '../env';

// What a person decides about a test network, read from one JSON file
// (scripts/testnet/solana/devnet.config.json): who holds each role, the keeper's parameters, and the
// test tokens with their first prices, their spreads and, for those the keeper may trade, their
// price ranges. A stock token's decimals and the two entries of its price come from
// fixtures/solana-vault/scope-indexes.json, the same table the mainnet asset list is built from.

/** A figure that is not measured here says where it came from, like every price in this repository. */
export type SourcedPrice = { usd: string; source: string; fetchedAt: string; method: string };

type TokenFile = {
  /** `solana:<slug>`: the asset's id everywhere else in the product. */
  id: string;
  /** The real token this one stands in for. */
  modelOf: string;
  kind: 'stock' | 'gold' | 'dollar_yield';
  tokenProgram?: 'token' | 'token-2022';
  decimals?: number;
  /** Where its price and its one-hour average sit in the price account. A stock's come from the table. */
  priceIndex?: number;
  twapIndex?: number;
  /** 0 trades at all hours, 1 in US market hours. */
  session?: 0 | 1;
  /** Token-2022 stock set only: the multiplier the mint starts with. */
  multiplier?: number;
  /** A Token-2022 token's extension set, in the real mint's order: the stock tokens' (the default)
   * or PAXG's (`paxgExtensions` in programs/tests/src/tokens.ts). */
  extensions?: 'stock' | 'paxg';
  /** The real token's name, where its symbol does not say it: "Test <name> (test network, no value)". */
  realName?: string;
  /** `scope-indexes` when `priceIndex` and `twapIndex` are the real token's entries in Scope. */
  indexSource?: 'scope-indexes';
  maxWeightBps?: number;
  spreadBps?: number;
  /** What the exchange's reserve is filled to, in dollars at the first price. */
  reserveUsd?: string;
  initialPrice: SourcedPrice;
  /** The token's price range, which switches the keeper on for it unless `on` is false (a token
   * the vault does not rebalance, as gate UNIVERSE keeps a stock with no oracle); null: no range. */
  keeper: { minUsd: string; maxUsd: string; on?: boolean } | null;
};

type ConfigFile = {
  network: string;
  roles: { guardian: string | null; defaultKeeper: string | null; priceWriter: string | null };
  params: Params;
  cash: { id: string; modelOf: string; decimals: number; reserve: string };
  defaults: { spreadBps: number; maxWeightBps: number; reserveUsd: string };
  tokens: TokenFile[];
};

export type TokenPlan = {
  id: string;
  modelOf: string;
  /** What the token calls itself: both say it is a test token. */
  symbol: string;
  name: string;
  kind: 'stock' | 'gold' | 'dollar_yield' | 'cash';
  tokenProgram: 'token' | 'token-2022';
  /** The Token-2022 extension set, in the order the real mint has it; null on the classic program. */
  extensionSet: 'stock' | 'paxg' | null;
  decimals: number;
  multiplier: number;
  priceIndex: number;
  twapIndex: number;
  /** `scope-indexes`: the real token's entries. `test-network`: entries only this network uses. */
  indexSource: 'scope-indexes' | 'test-network';
  session: 0 | 1;
  maxWeightBps: number;
  spreadBps: number;
  /** Raw units the exchange's reserve is filled to. */
  reserveRaw: bigint;
  initialPrice: SourcedPrice;
  /** In millionths of a dollar for one whole token, as the asset list holds it; null: no range. */
  range: { minPrice: bigint; maxPrice: bigint } | null;
  /** The keeper's switch: on only with a range, and only when the config does not say off. */
  keeperOn: boolean;
};

export type SetupPlan = {
  network: string;
  /** `admin` in the file means the key that runs the set-up. */
  roles: {
    guardian: Address | 'admin';
    defaultKeeper: Address | 'admin';
    priceWriter: Address | null;
  };
  params: Params;
  cash: TokenPlan;
  tokens: TokenPlan[];
};

const PARAM_KEYS: (keyof Params)[] = [
  'toleranceBps',
  'lossCapBps',
  'bandBps',
  'twapDevBps',
  'maxPriceAgeS',
  'assetCooldownS',
  'publishDelayS',
  'sessionOpenUtcS',
  'sessionCloseUtcS',
];

/** A decimal string as an integer scaled by 10^places, rounded down. No floats: these are amounts. */
export function scaled(decimal: string, places: number): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) throw new Error(`"${decimal}" is not a decimal`);
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole + fraction.slice(0, places).padEnd(places, '0'));
}

function scopeTable(): Map<string, { decimals: number; priceIndex: number; twapIndex: number }> {
  const file = join(REPO_ROOT, 'fixtures', 'solana-vault', 'scope-indexes.json');
  const table: {
    assets: { symbol: string; decimals: number; priceIndex: number; twapIndex: number }[];
  } = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(table.assets.map((row) => [row.symbol, row]));
}

const fail = (message: string): never => {
  throw new Error(`test-network config: ${message}`);
};

function role(value: string | null, name: string): Address | 'admin' {
  if (value === null || value === '')
    return fail(
      `roles.${name} is not set. Give the address of the key that holds the role, or "admin" for the key that runs the set-up`,
    );
  return value === 'admin' ? 'admin' : address(value);
}

/** Reads and checks a config file, and fills in what the index table and the defaults say. */
export function loadPlan(path: string): SetupPlan {
  return planOf(JSON.parse(readFileSync(path, 'utf8')) as ConfigFile);
}

export function planOf(file: ConfigFile): SetupPlan {
  for (const key of PARAM_KEYS)
    if (!Number.isInteger(file.params?.[key])) fail(`params.${key} is not a whole number`);
  const table = scopeTable();
  const slug = (id: string) => {
    if (!/^solana:[a-z0-9][a-z0-9-]*$/.test(id)) fail(`"${id}" is not an asset id (solana:<slug>)`);
    return id.slice('solana:'.length);
  };
  slug(file.cash.id);
  const cash: TokenPlan = {
    id: file.cash.id,
    modelOf: file.cash.modelOf,
    symbol: `t${file.cash.modelOf}`,
    name: `Test ${file.cash.modelOf} (test network, no value)`,
    kind: 'cash',
    tokenProgram: 'token',
    extensionSet: null,
    decimals: file.cash.decimals,
    multiplier: 1,
    priceIndex: 0,
    twapIndex: 0,
    indexSource: 'test-network',
    session: 0,
    maxWeightBps: 0,
    spreadBps: 0,
    reserveRaw: scaled(file.cash.reserve, file.cash.decimals),
    initialPrice: { usd: '1', source: 'cash counts as one dollar', fetchedAt: '', method: 'none' },
    range: null,
    keeperOn: false,
  };

  const tokens = file.tokens.map((token): TokenPlan => {
    slug(token.id);
    const real = table.get(token.modelOf);
    const stock = token.kind === 'stock';
    if (stock && !real)
      fail(`${token.modelOf} has no entry in fixtures/solana-vault/scope-indexes.json`);
    const priceIndex = real?.priceIndex ?? token.priceIndex;
    const twapIndex = real?.twapIndex ?? token.twapIndex;
    const decimals = real?.decimals ?? token.decimals;
    if (priceIndex === undefined || twapIndex === undefined || decimals === undefined)
      return fail(`${token.id} needs priceIndex, twapIndex and decimals: the index table has none`);
    const tokenProgram = token.tokenProgram ?? (stock ? 'token-2022' : 'token');
    const price = scaled(token.initialPrice.usd, 6);
    if (price === 0n) fail(`${token.id} has no first price`);
    for (const key of ['source', 'fetchedAt', 'method'] as const)
      if (!token.initialPrice[key]) fail(`${token.id}: initialPrice.${key} is empty`);
    if (token.keeper?.on !== undefined && typeof token.keeper.on !== 'boolean')
      fail(`${token.id}: keeper.on is true or false`);
    const range = token.keeper && {
      minPrice: scaled(token.keeper.minUsd, 6),
      maxPrice: scaled(token.keeper.maxUsd, 6),
    };
    if (range && !(range.minPrice < range.maxPrice && range.maxPrice <= 2n * range.minPrice))
      fail(`${token.id}: a range has its ceiling above its floor and at most twice it`);
    if (range && (price < range.minPrice || price > range.maxPrice))
      fail(`${token.id}: the first price is outside the range`);
    const reserveUsd = scaled(token.reserveUsd ?? file.defaults.reserveUsd, 6);
    return {
      id: token.id,
      modelOf: token.modelOf,
      symbol: `t${token.modelOf}`,
      name: `Test ${token.realName ?? token.modelOf} (test network, no value)`,
      kind: token.kind,
      tokenProgram,
      extensionSet: tokenProgram === 'token-2022' ? (token.extensions ?? 'stock') : null,
      decimals,
      multiplier: token.multiplier ?? 1,
      priceIndex,
      twapIndex,
      indexSource: real ? 'scope-indexes' : (token.indexSource ?? 'test-network'),
      session: token.session ?? (stock ? 1 : 0),
      maxWeightBps: token.maxWeightBps ?? file.defaults.maxWeightBps,
      spreadBps: token.spreadBps ?? file.defaults.spreadBps,
      // Dollars over dollars per token, in raw units.
      reserveRaw: (reserveUsd * 10n ** BigInt(decimals)) / price,
      initialPrice: token.initialPrice,
      range,
      keeperOn: range !== null && token.keeper?.on !== false,
    };
  });

  const seen = new Set<string>();
  for (const token of [cash, ...tokens]) {
    if (seen.has(token.id)) fail(`${token.id} is listed twice`);
    seen.add(token.id);
  }
  const entries = new Map<number, string>();
  for (const token of tokens)
    for (const index of [token.priceIndex, token.twapIndex]) {
      if (!Number.isInteger(index) || index < 0 || index > 511)
        fail(`${token.id}: a price index runs from 0 to 511`);
      const other = entries.get(index);
      if (other) fail(`${token.id} and ${other} share price entry ${index}`);
      entries.set(index, token.id);
    }
  return {
    network: file.network,
    roles: {
      guardian: role(file.roles.guardian, 'guardian'),
      defaultKeeper: role(file.roles.defaultKeeper, 'defaultKeeper'),
      priceWriter: file.roles.priceWriter ? address(file.roles.priceWriter) : null,
    },
    params: Object.fromEntries(PARAM_KEYS.map((key) => [key, file.params[key]])) as Params,
    cash,
    tokens,
  };
}

/** The slug of an asset id: `spyx` for `solana:spyx`. */
export const slugOf = (id: string) => id.slice(id.indexOf(':') + 1);

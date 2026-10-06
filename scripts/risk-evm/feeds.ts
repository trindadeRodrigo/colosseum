// The oracle of each tracked stock on a chain (PLAN-UNIVERSE RU.5): Chainlink's reference directory
// matched to the tokens, each feed confirmed by what its contract answers. No I/O here; `runOracles`
// reads through the client and the fetch it is given.
import { type Regime, type RegimeParams, regimeAt } from '@colosseum/risk';
import { type Call, decodeSymbol, SEL, words, wordToAddress } from './abi';
import type { ChainConfig } from './config';
import { multicall, type Reply } from './multicall';
import type { Rpc } from './rpc';

/** Chainlink's reference directory per chain id of config.ts. A public GET, no key. */
export const DIRECTORY_URL: Record<string, string> = {
  robinhood: 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json',
};
export const ORACLES_METHOD = 'evm-oracles-0.1';

/**
 * How a feed names a stock token, before the quote: the symbol alone ("GLD / USD"), "RH" and the
 * symbol ("RHSPY / USD"), or "Robinhood" and the symbol ("Robinhood QQQ / USD", "Robinhood DELL-USD").
 * With the two ways of writing the quote, these are the forms the directory and the contracts used on
 * Robinhood Chain on 2026-10-05.
 */
const NAME_FORMS = [(s: string) => s, (s: string) => `RH${s}`, (s: string) => `Robinhood ${s}`];

/**
 * True when `text` (a directory name or a contract's description()) is a US dollar price of the token
 * `symbol`. The whole text must be one of the forms above, then "/ USD" or "-USD": a feed of another
 * quote ("… / USDC Exchange Rate") or of a longer symbol never passes. Letters are compared as written.
 */
export function namesToken(text: string, symbol: string): boolean {
  const m = /^(.+?)\s*(?:\/|-)\s*USD$/.exec(text.trim());
  if (!m || symbol === '') return false;
  const base = (m[1] as string).trim();
  return NAME_FORMS.some((form) => form(symbol) === base);
}

export type DirectoryFeed = {
  /** The directory's `name`: the one field a feed is matched to a token by. */
  name: string;
  path: string | null;
  /** The address a consumer reads, and the one stored: it stays when the aggregator behind it is replaced. */
  proxyAddress: string;
  /** The aggregator the directory lists behind the proxy (`contractAddress`); null when absent. */
  contractAddress: string | null;
  /** A second proxy of the same aggregator (the directory's "Shared SVR"). Recorded, never read. */
  secondaryProxyAddress: string | null;
  decimals: number | null;
  heartbeatSeconds: number | null;
  /** What the directory says of the feed, as given; null where it says nothing. */
  assetName: string | null;
  baseAsset: string | null;
  marketHours: string | null;
  productTypeCode: string | null;
  attributeType: string | null;
  assetClass: string | null;
};
export type Skipped = { name: string; reason: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const whole = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** The directory's feeds, in its order. An entry with no name, no proxy, or a proxy already listed is left out. */
export function parseDirectory(json: unknown): { feeds: DirectoryFeed[]; skipped: Skipped[] } {
  if (!Array.isArray(json)) throw new Error('directory: the answer is not a list of feeds');
  const feeds: DirectoryFeed[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const f of json as Array<Record<string, unknown> | null>) {
    const name = text(f?.name);
    const proxy = f?.proxyAddress;
    const docs = (f?.docs ?? {}) as Record<string, unknown>;
    if (name === null) skipped.push({ name: '?', reason: 'no_name' });
    else if (!isAddress(proxy)) skipped.push({ name, reason: 'no_proxy_address' });
    else if (seen.has(proxy.toLowerCase())) skipped.push({ name, reason: 'proxy_listed_twice' });
    else {
      seen.add(proxy.toLowerCase());
      feeds.push({
        name,
        path: text(f?.path),
        proxyAddress: proxy,
        contractAddress: isAddress(f?.contractAddress) ? f.contractAddress : null,
        secondaryProxyAddress: isAddress(f?.secondaryProxyAddress) ? f.secondaryProxyAddress : null,
        decimals: whole(f?.decimals),
        heartbeatSeconds: whole(f?.heartbeat),
        assetName: text(f?.assetName),
        baseAsset: text(docs.baseAsset),
        marketHours: text(docs.marketHours),
        productTypeCode: text(docs.productTypeCode),
        attributeType: text(docs.attributeType),
        assetClass: text(docs.assetClass),
      });
    }
  }
  return { feeds, skipped };
}

/** Reads per feed, whatever it is matched to: the calls depend on the directory alone. */
export const CALLS_PER_FEED = 5;
/**
 * description(), decimals(), latestRoundData() and aggregator() of the proxy, then latestRoundData()
 * of the listed aggregator itself, which shows whether it can be read without the proxy.
 */
export const feedCalls = (feeds: DirectoryFeed[]): Call[] =>
  feeds.flatMap((f) => [
    { target: f.proxyAddress, callData: `0x${SEL.description}` },
    { target: f.proxyAddress, callData: `0x${SEL.decimals}` },
    { target: f.proxyAddress, callData: `0x${SEL.latestRoundData}` },
    { target: f.proxyAddress, callData: `0x${SEL.aggregator}` },
    { target: f.contractAddress ?? f.proxyAddress, callData: `0x${SEL.latestRoundData}` },
  ]);

export type Round = {
  roundId: string;
  /** The answer as the contract gave it, an integer in the feed's decimals. */
  answer: string;
  /** Unix seconds. */
  startedAt: number;
  updatedAt: number;
  answeredInRound: string;
};
/** The five words of latestRoundData(), or null when the answer is not that. */
export function decodeRound(reply: Reply): Round | null {
  if (!reply.success || reply.data.length !== 2 + 5 * 64) return null;
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = words(reply.data) as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  // a time past what a number holds is no time
  if (startedAt > 2n ** 48n || updatedAt > 2n ** 48n) return null;
  return {
    roundId: roundId.toString(),
    answer: BigInt.asIntN(256, answer).toString(),
    startedAt: Number(startedAt),
    updatedAt: Number(updatedAt),
    answeredInRound: answeredInRound.toString(),
  };
}

export type OnchainFeed = {
  description: string | null;
  decimals: number | null;
  round: Round | null;
  /** aggregator() of the proxy. */
  aggregator: string | null;
  /** Whether the listed aggregator answers latestRoundData() when called directly; null when none is listed. */
  aggregatorAnswersDirectly: boolean | null;
};
const oneWord = (r: Reply) => r.success && r.data.length === 66;

/** What each feed's contract answered. `replies` are the answers to feedCalls(feeds). */
export function readFeeds(feeds: DirectoryFeed[], replies: Reply[]): OnchainFeed[] {
  if (replies.length !== feeds.length * CALLS_PER_FEED)
    throw new Error(`readFeeds: ${feeds.length} feeds, ${replies.length} answers`);
  return feeds.map((f, i) => {
    const [desc, dec, round, agg, direct] = replies.slice(
      i * CALLS_PER_FEED,
      (i + 1) * CALLS_PER_FEED,
    ) as [Reply, Reply, Reply, Reply, Reply];
    const decimals = oneWord(dec) ? (words(dec.data)[0] as bigint) : null;
    return {
      description: desc.success ? decodeSymbol(desc.data) : null,
      decimals: decimals !== null && decimals <= 255n ? Number(decimals) : null,
      round: decodeRound(round),
      aggregator: oneWord(agg) ? wordToAddress(words(agg.data)[0] as bigint) : null,
      aggregatorAnswersDirectly: f.contractAddress === null ? null : decodeRound(direct) !== null,
    };
  });
}

/** An integer in `decimals` decimals as a decimal string, digit for digit: no rounding, no float. */
export function unitsToDecimal(value: string, decimals: number): string {
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}${decimals > 0 ? `.${digits.slice(cut)}` : ''}`;
}

/** Why a token has no confirmed feed. `no_feed`: the directory lists none. The others: a feed was refused. */
export type NoFeedReason =
  | 'no_feed'
  | 'symbol_shared_by_tokens'
  | 'two_feeds_name_the_token'
  | 'feed_names_two_tokens'
  | 'no_answer_from_the_feed'
  | 'description_does_not_name_the_token'
  | 'decimals_differ_from_directory'
  | 'answer_not_positive'
  | 'round_time_not_in_the_past';

export type ConfirmedFeed = {
  /** The proxy: the address the vault would read. */
  address: string;
  /** description() and decimals() as the contract answered at the block. */
  description: string;
  decimals: number;
  /** aggregator() of the proxy at the block, and whether it is the one the directory lists. */
  aggregator: string | null;
  aggregatorIsTheListedOne: boolean | null;
  aggregatorAnswersDirectly: boolean | null;
  secondaryProxyAddress: string | null;
  directory: Omit<DirectoryFeed, 'proxyAddress' | 'secondaryProxyAddress' | 'decimals'>;
  round: {
    roundId: string;
    /** As read, in the feed's decimals. Never compared with a pool price here (gate ORACLE-VS-DEX). */
    answer: string;
    /** The same answer with the decimal point placed. */
    price: string;
    startedAt: string;
    updatedAt: string;
    answeredInRound: string;
  };
  /** Block time less updatedAt. A feed is not refused for its age. */
  ageSeconds: number;
  /** The US session at the block's time, by the calendar of packages/risk. */
  session: Regime;
  inSession: boolean;
};

export type Wanted = { address: string; symbol: string };
export type OracleRow = Wanted & {
  tracked: boolean;
  feed: ConfirmedFeed | null;
  /** Null with a feed; otherwise why there is none. */
  reason: NoFeedReason | null;
  /** The reason in words, with what was read. */
  detail: string | null;
  /** The directory's feeds that name the token, each with what its contract calls itself. */
  candidates: Array<{ name: string; proxyAddress: string; description: string | null }>;
  source: string;
  fetchedAt: string;
  method: string;
  provenance: 'live';
};

export type MatchContext = {
  /** Every token of the issuer's registry on the chain: where two tokens sharing a symbol are seen. */
  registry: Wanted[];
  feeds: DirectoryFeed[];
  onchain: OnchainFeed[];
  /** Unix seconds of the block the feeds were read at. */
  blockTime: number;
  regime: RegimeParams;
  source: string;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * The row of one token, keyed on its address. The directory names no token address, so a feed is tied
 * to a token by the token's symbol alone, which is why every tie that is not one to one is refused:
 * a symbol two tokens carry, two feeds naming one token, one feed naming two tokens. What the contract
 * then answers decides the rest. Nothing here picks between two candidates.
 */
export function matchToken(token: Wanted, tracked: boolean, ctx: MatchContext): OracleRow {
  const named = ctx.feeds.flatMap((f, i) => (namesToken(f.name, token.symbol) ? [i] : []));
  const candidates = named.map((i) => ({
    name: (ctx.feeds[i] as DirectoryFeed).name,
    proxyAddress: (ctx.feeds[i] as DirectoryFeed).proxyAddress,
    description: (ctx.onchain[i] as OnchainFeed).description,
  }));
  const row = (
    feed: ConfirmedFeed | null,
    reason: NoFeedReason | null,
    detail: string | null,
  ): OracleRow => ({
    address: token.address,
    symbol: token.symbol,
    tracked,
    feed,
    reason,
    detail,
    candidates,
    source: ctx.source,
    fetchedAt: iso(ctx.blockTime),
    method: ORACLES_METHOD,
    provenance: 'live',
  });

  const twins = ctx.registry.filter(
    (t) => t.symbol === token.symbol && !same(t.address, token.address),
  );
  if (twins.length > 0)
    return row(
      null,
      'symbol_shared_by_tokens',
      `${twins.length + 1} tokens of the registry carry the symbol ${token.symbol} (also ${twins.map((t) => t.address).join(', ')}); the directory names no address, so no feed is tied to any of them`,
    );
  if (named.length === 0) return row(null, 'no_feed', null);
  if (named.length > 1)
    return row(
      null,
      'two_feeds_name_the_token',
      `the directory lists ${named.length} feeds for ${token.symbol}: ${candidates.map((c) => `"${c.name}" ${c.proxyAddress}`).join(', ')}; none is chosen`,
    );

  const i = named[0] as number;
  const f = ctx.feeds[i] as DirectoryFeed;
  const on = ctx.onchain[i] as OnchainFeed;
  /** The other symbols of the registry a name reads as a price of. */
  const otherSymbols = (name: string) => [
    ...new Set(
      ctx.registry
        .filter((t) => t.symbol !== token.symbol && namesToken(name, t.symbol))
        .map((t) => t.symbol),
    ),
  ];
  const others = otherSymbols(f.name);
  if (others.length > 0)
    return row(
      null,
      'feed_names_two_tokens',
      `"${f.name}" also reads as a price of ${others.join(', ')}`,
    );
  if (on.description === null || on.decimals === null || on.round === null)
    return row(
      null,
      'no_answer_from_the_feed',
      `${f.proxyAddress} gave no ${on.description === null ? 'description()' : on.decimals === null ? 'decimals()' : 'latestRoundData()'}`,
    );
  if (!namesToken(on.description, token.symbol))
    return row(
      null,
      'description_does_not_name_the_token',
      `the directory calls ${f.proxyAddress} "${f.name}", the contract calls itself "${on.description}", which is not a US dollar price of ${token.symbol}`,
    );
  const alsoNamed = otherSymbols(on.description);
  if (alsoNamed.length > 0)
    return row(
      null,
      'feed_names_two_tokens',
      `the contract calls itself "${on.description}", which also reads as a price of ${alsoNamed.join(', ')}`,
    );
  if (f.decimals !== on.decimals)
    return row(
      null,
      'decimals_differ_from_directory',
      `the directory says ${f.decimals === null ? 'nothing of the' : f.decimals} decimals, the contract ${on.decimals}`,
    );
  if (BigInt(on.round.answer) <= 0n)
    return row(null, 'answer_not_positive', `latestRoundData() answered ${on.round.answer}`);
  if (on.round.updatedAt === 0 || on.round.updatedAt > ctx.blockTime)
    return row(
      null,
      'round_time_not_in_the_past',
      `updatedAt is ${on.round.updatedAt}, the block's time ${ctx.blockTime}`,
    );

  const session = regimeAt(new Date(ctx.blockTime * 1000), ctx.regime);
  const { proxyAddress, secondaryProxyAddress, decimals: _listed, ...directory } = f;
  return row(
    {
      address: proxyAddress,
      description: on.description,
      decimals: on.decimals,
      aggregator: on.aggregator,
      aggregatorIsTheListedOne:
        on.aggregator === null || f.contractAddress === null
          ? null
          : same(on.aggregator, f.contractAddress),
      aggregatorAnswersDirectly: on.aggregatorAnswersDirectly,
      secondaryProxyAddress,
      directory,
      round: {
        roundId: on.round.roundId,
        answer: on.round.answer,
        price: unitsToDecimal(on.round.answer, on.decimals),
        startedAt: iso(on.round.startedAt),
        updatedAt: iso(on.round.updatedAt),
        answeredInRound: on.round.answeredInRound,
      },
      ageSeconds: ctx.blockTime - on.round.updatedAt,
      session,
      inSession: session === 'us_market_hours',
    },
    null,
    null,
  );
}

/** What a fund's or the treasury token's feed prices, as far as the directory says it. */
export type FundRow = Wanted & {
  tracked: boolean;
  hasFeed: boolean;
  /**
   * `token_with_multiplier`: the directory's product is the tokenized price, which Chainlink documents
   * as the share's price times the issuer's multiplier. `token_from_pools`: the directory's attribute is
   * a price taken from the state of exchanges on chain, so it is a price of the token itself.
   * Null when there is no feed or the directory does not say.
   */
  prices: 'token_with_multiplier' | 'token_from_pools' | null;
  pricesReason: 'no_confirmed_feed' | 'not_stated_in_directory' | null;
  /** The directory's own words, as given. */
  productTypeCode: string | null;
  attributeType: string | null;
  marketHours: string | null;
  assetName: string | null;
  /** Shares per token as the issuer's registry states it; null when the registry gives none. Not applied to anything. */
  registryMultiplier: string | null;
};

/** The directory's product code of Chainlink's tokenized-equity feeds, and its attribute for a price from pools. */
const TOKENIZED_PRICE = 'primaryTokenizedPrice';
const DEX_STATE_PRICE = 'dex_state_price';

export function fundRow(row: OracleRow, registryMultiplier: string | null): FundRow {
  const d = row.feed?.directory ?? null;
  const prices =
    d === null
      ? null
      : d.attributeType === DEX_STATE_PRICE
        ? 'token_from_pools'
        : d.productTypeCode === TOKENIZED_PRICE
          ? 'token_with_multiplier'
          : null;
  return {
    address: row.address,
    symbol: row.symbol,
    tracked: row.tracked,
    hasFeed: row.feed !== null,
    prices,
    pricesReason:
      prices !== null ? null : d === null ? 'no_confirmed_feed' : 'not_stated_in_directory',
    productTypeCode: d?.productTypeCode ?? null,
    attributeType: d?.attributeType ?? null,
    marketHours: d?.marketHours ?? null,
    assetName: d?.assetName ?? null,
    registryMultiplier,
  };
}

/** The vault's limit on the age of a stock price inside a session (docs/vault/DESIGN-VAULT.md). Counted, never applied. */
export const VAULT_STOCK_MAX_AGE_SECONDS = 26 * 3600;

export type OraclesFile = {
  chain: string;
  chainId: number;
  provenance: 'live';
  source: string;
  method: string;
  /** Time of the block the feeds were read at. */
  fetchedAt: string;
  block: number;
  directory: { url: string; fetchedAt: string; feeds: number; skipped: Skipped[] };
  inputs: { cut: string; universe: string; collected: string };
  /** What this file does and does not decide, in words. */
  stated: Record<string, string>;
  session: { atBlock: Regime; inSession: boolean; calendar: string };
  counts: {
    tracked: number;
    trackedWithFeed: number;
    trackedWithoutFeed: number;
    trackedWithoutFeedByReason: Record<string, number>;
    collectedNotTracked: number;
    collectedNotTrackedWithFeed: number;
    feedsOlderThanTheVaultLimit: number;
    feedsOlderThanTheirHeartbeat: number;
    aggregatorsNotAnsweringDirectly: number;
  };
  /** The tracked stocks with no confirmed feed, by name. */
  trackedWithoutFeed: Array<{ symbol: string; address: string; reason: NoFeedReason }>;
  rpc: { rpcCalls: number; httpRequests: number; contractReads: number; seconds: number };
  tracked: OracleRow[];
  collectedNotTracked: OracleRow[];
  funds: FundRow[];
  /** Feeds of the directory that name a registry token outside both lists, by symbol: for a later cut. */
  feedsOfOtherTokens: Array<{
    symbol: string;
    address: string;
    name: string;
    proxyAddress: string;
  }>;
};

export const STATED = {
  matching:
    "A feed is tied to a token by the directory's `name` and the token's symbol: the name must read as the symbol, RH and the symbol, or Robinhood and the symbol, then '/ USD' or '-USD'. The directory names no token address. Rows are keyed on the token address. Two tokens of the registry sharing a symbol get no feed (symbol_shared_by_tokens); two feeds naming one token are both listed and neither is chosen (two_feeds_name_the_token); one feed naming two tokens, by the directory's name or by its own description, is refused (feed_names_two_tokens).",
  confirmation:
    'A matched feed is confirmed by its own contract at one block: description() must name the token by the same rule, decimals() must equal the decimals the directory gives, latestRoundData() must give a positive answer with a time not after the block. Otherwise the row has no feed and says why.',
  storedAddress:
    "The address stored is the directory's proxyAddress, the one the vault would read: the aggregator behind a proxy is replaced when a feed is upgraded and the proxy stays. aggregator() of the proxy and whether the listed aggregator answers a direct call are recorded beside it. The second proxy the directory lists (Shared SVR) is recorded and not read.",
  price:
    'The answer is recorded as read, with its decimal point placed. It is not compared with, corrected by or blended into a pool price (gate ORACLE-VS-DEX). No multiplier is applied to anything.',
  age: 'ageSeconds is the block time less updatedAt. An old answer is still a confirmed feed: nothing is refused for age. The session is the US session at the block time by the calendar named in `session`.',
  funds:
    "For each fund and the treasury token: whether a feed exists and what the directory says it prices. token_with_multiplier is the directory's product primaryTokenizedPrice (Chainlink: the share's price times the issuer's multiplier, https://docs.chain.link/data-feeds/tokenized-equity-feeds); token_from_pools is its attribute dex_state_price. Where the directory says neither, the answer is null. The registry's multiplier is printed beside and applied to nothing.",
} as const;

/** DU7: the funds and the treasury token in the issuer's registry. */
export const FUNDS = ['SPY', 'QQQ', 'GLD', 'SLV', 'USO', 'SGOV'];

export type OraclesInput = {
  directoryUrl: string;
  /** The stocks of the cut, keyed on the token address. */
  tracked: Wanted[];
  /** The tokens the collector reads (config.ts); those not tracked are printed apart. */
  collected: Wanted[];
  /** Every token of the registry, with its multiplier where the registry gives one. */
  registry: Array<Wanted & { multiplier?: string | null }>;
  regime: RegimeParams;
  rpcLabel: string;
  inputs: OraclesFile['inputs'] & { calendar: string };
};
export type OraclesDeps = {
  rpc: Rpc;
  fetchJson: (url: string) => Promise<unknown>;
  now: () => number;
};

/** One pass: the directory by one GET, then every feed it lists read at one block through Multicall3. */
export async function runOracles(
  chain: ChainConfig,
  deps: OraclesDeps,
  input: OraclesInput,
): Promise<OraclesFile> {
  const startedAt = deps.now();
  const before = deps.rpc.stats();
  const { feeds, skipped } = parseDirectory(await deps.fetchJson(input.directoryUrl));
  const directoryFetchedAt = new Date(deps.now()).toISOString();
  // a directory that lists nothing, or names no token of the registry, is a failed read, not thirty
  // stocks without a feed
  if (!feeds.some((f) => input.registry.some((t) => namesToken(f.name, t.symbol))))
    throw new Error(
      `the directory lists ${feeds.length} feeds and none names a token of the registry: nothing is written`,
    );
  const head = await deps.rpc.call<{ number: string; timestamp: string }>('eth_getBlockByNumber', [
    'latest',
    false,
  ]);
  const calls = feedCalls(feeds);
  const onchain = readFeeds(feeds, await multicall(deps.rpc, chain.multicall3, calls, head.number));
  const block = Number(head.number);
  const blockTime = Number(head.timestamp);
  const source = `${input.directoryUrl}, then description(), decimals(), latestRoundData() and aggregator() of each proxy by eth_call at block ${block} on ${chain.name} (chain ${chain.chainId}) through ${input.rpcLabel}`;
  const ctx: MatchContext = {
    registry: input.registry,
    feeds,
    onchain,
    blockTime,
    regime: input.regime,
    source,
  };

  const isTracked = (t: Wanted) => input.tracked.some((x) => same(x.address, t.address));
  const tracked = input.tracked.map((t) => matchToken(t, true, ctx));
  const collectedNotTracked = input.collected
    .filter((t) => !isTracked(t))
    .map((t) => matchToken(t, false, ctx));
  const listed = [...tracked, ...collectedNotTracked];
  const funds = FUNDS.flatMap((symbol) =>
    input.registry
      .filter((t) => t.symbol === symbol)
      .map((t) =>
        fundRow(
          listed.find((r) => same(r.address, t.address)) ?? matchToken(t, false, ctx),
          t.multiplier ?? null,
        ),
      ),
  );
  const feedsOfOtherTokens = feeds.flatMap((f) =>
    input.registry
      .filter(
        (t) => namesToken(f.name, t.symbol) && !listed.some((r) => same(r.address, t.address)),
      )
      .map((t) => ({
        symbol: t.symbol,
        address: t.address,
        name: f.name,
        proxyAddress: f.proxyAddress,
      })),
  );

  const without = tracked.filter((r) => r.feed === null);
  const byReason: Record<string, number> = {};
  for (const r of without) byReason[r.reason as string] = (byReason[r.reason as string] ?? 0) + 1;
  const confirmed = listed.flatMap((r) => (r.feed ? [r.feed] : []));
  const session = regimeAt(new Date(blockTime * 1000), input.regime);
  const after = deps.rpc.stats();
  const { calendar, ...inputs } = input.inputs;
  return {
    chain: chain.id,
    chainId: chain.chainId,
    provenance: 'live',
    source,
    method: ORACLES_METHOD,
    fetchedAt: iso(blockTime),
    block,
    directory: {
      url: input.directoryUrl,
      fetchedAt: directoryFetchedAt,
      feeds: feeds.length,
      skipped,
    },
    inputs,
    stated: STATED,
    session: { atBlock: session, inSession: session === 'us_market_hours', calendar },
    counts: {
      tracked: tracked.length,
      trackedWithFeed: tracked.length - without.length,
      trackedWithoutFeed: without.length,
      trackedWithoutFeedByReason: byReason,
      collectedNotTracked: collectedNotTracked.length,
      collectedNotTrackedWithFeed: collectedNotTracked.filter((r) => r.feed !== null).length,
      feedsOlderThanTheVaultLimit: confirmed.filter(
        (f) => f.ageSeconds > VAULT_STOCK_MAX_AGE_SECONDS,
      ).length,
      feedsOlderThanTheirHeartbeat: confirmed.filter(
        (f) => f.directory.heartbeatSeconds !== null && f.ageSeconds > f.directory.heartbeatSeconds,
      ).length,
      aggregatorsNotAnsweringDirectly: confirmed.filter(
        (f) => f.aggregatorAnswersDirectly === false,
      ).length,
    },
    trackedWithoutFeed: without.map((r) => ({
      symbol: r.symbol,
      address: r.address,
      reason: r.reason as NoFeedReason,
    })),
    rpc: {
      rpcCalls: after.rpcCalls - before.rpcCalls,
      httpRequests: after.httpRequests - before.httpRequests,
      contractReads: calls.length,
      seconds: (deps.now() - startedAt) / 1000,
    },
    tracked,
    collectedNotTracked,
    funds,
    feedsOfOtherTokens,
  };
}

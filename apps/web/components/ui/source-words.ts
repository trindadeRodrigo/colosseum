import type { Age } from './format';

// The words a person meets first when they open a figure's source (gate TOOLTIP-WORDS). The API
// writes `source` and `method` as free text for the record: an account, a table, a call. This module
// names that source in plain words, by a table of patterns, and says how long ago it was read. It
// invents nothing: a source no row knows gets no name, and the popover then says the details are
// below, where the API's own words always are. A plain module, so a server component may ask too.

/**
 * The source as a noun phrase that follows "from": "the Kamino Scope price feed". Null when unknown.
 * It does not say what kind of number the figure is: a vault's value stands on a price feed and is
 * not a price. The screen that draws the figure says that (`what` on the pin).
 */
export type SourceWords = { from: string | null };

type Context = {
  /** The figure was read on a test network or a local copy of mainnet (`provenance: "sandbox"`). */
  test: boolean;
};

type Rule = {
  test: RegExp;
  from: string | ((match: RegExpExecArray, context: Context) => string);
};

const network = (name: string | undefined) => (name ?? '').trim();

/**
 * One row per source the API, the chain packages and the fixtures write. The first row that matches
 * names it. `source-words.test.ts` holds every raw string found in them and fails on one left unnamed
 * that is not in its own list of the unnamed.
 */
const RULES: readonly Rule[] = [
  // Prices read on the chain. Mainnet's price account is Kamino's Scope; a test network's is the
  // test exchange's, written in the same layout (packages/chain-solana/src/vault/reader.ts).
  {
    test: /^(?:the )?price account \S+/i,
    from: (_, c) => (c.test ? 'the test network’s price feed' : 'the Kamino Scope price feed'),
  },
  { test: /^a price account$/i, from: 'an on-chain price feed' },
  {
    test: /^Chainlink feed \S+ on ([^,]+)/i,
    from: (m) => `the Chainlink price feed on ${network(m[1])}`,
  },
  { test: /^Pyth Hermes \+ Jupiter$/i, from: 'Pyth and Jupiter prices' },
  { test: /^Pyth Hermes \+ Scope$/i, from: 'Pyth and Kamino Scope prices' },
  { test: /^Pyth Hermes$/i, from: 'the Pyth price feed' },
  { test: /^Scope$/i, from: 'the Kamino Scope price feed' },
  { test: /^(?:feed of \S+:\S+|\S+:\S+ feed)$/i, from: 'the asset’s price feed' },

  // Quotes and dry runs.
  { test: /^https:\/\/api\.jup\.ag\/swap\//i, from: 'a Jupiter quote' },
  { test: /^Jupiter$/i, from: 'Jupiter' },
  { test: /^(?:https:\/\/)?lite-api\.jup\.ag\/price\//i, from: 'Jupiter’s price' },
  { test: /^stable_par$/i, from: 'a dollar stablecoin, counted at one dollar' },
  {
    test: /^Uniswap v4 Quoter \S+ on (.+)$/i,
    from: (m) => `a Uniswap quote on ${network(m[1])}`,
  },
  { test: /^test exchange\b/i, from: 'the test network’s exchange' },
  {
    test: /^simulation of the (?:call|transaction) on ([^,]+)/i,
    from: (m) => `a dry run of the transaction on ${network(m[1])}`,
  },

  // The vault itself, read from the chain.
  {
    test: /^(.+?), read over (?:JSON-)?RPC by the (?:EVM )?vault (?:reader|adapter)$/i,
    from: (m) => `the vault’s own balances on ${network(m[1])}`,
  },
  { test: /^getTokenAccountsByOwner$/, from: 'the wallet’s own balances, read on chain' },
  { test: /^klend-sdk\b/i, from: 'the Kamino lending position, read on chain' },
  {
    test: /^the person's confirmed deposits in this app's order record on (.+)$/i,
    from: (m) => `confirmed deposits recorded here on ${network(m[1])}`,
  },
  {
    test: /^(?:devnet RPC|devnet|solana devnet node)$/i,
    from: 'Solana devnet, read directly',
  },
  {
    test: /^(?:a node of the test network|a test network node)$/i,
    from: 'the test network, read directly',
  },
  { test: /^a mainnet node$/i, from: 'the chain, read directly' },
  // A chain's own name: a read of the chain with nothing between (a vault with no priced holding).
  {
    test: /^(?:Solana|Robinhood Chain|Base)(?: (?:devnet|testnet|mainnet))?$/i,
    from: (m) => `${m[0]}, read directly`,
  },

  // Bearing: the risk layer's measurements, by the table they are kept in.
  {
    test: /hours priced at the pool mid/i,
    from: 'the pool’s own mid price, as Bearing recorded it',
  },
  { test: /^risk_reference_prices\b/i, from: 'Bearing’s reference prices' },
  {
    test: /^risk_asset_snapshots\.ref_mid_usd$/i,
    from: 'Bearing’s reference prices',
  },
  { test: /^risk_depth_curves\b/i, from: 'Bearing’s measured exit' },
  { test: /^risk_asset_snapshots\b/i, from: 'Bearing’s hourly measurements of the asset' },
  { test: /^risk_pool_snapshots\b/i, from: 'Bearing’s hourly measurements of the pool' },
  { test: /^risk_pool_flow\b/i, from: 'Bearing’s record of trading in the pool' },
  { test: /^risk_pools\.tvl_usd\b/i, from: 'the pool’s size when Bearing first recorded it' },
  {
    test: /^risk_lending_(?:positions|snapshots)\b/i,
    from: 'Bearing’s hourly record of the lending markets',
  },
  { test: /^risk_events\b/i, from: 'Bearing’s record of withdrawals from the pool' },
  { test: /^risk_lp_concentration\b/i, from: 'Bearing’s record of who supplies the pool' },
  {
    test: /^AssetFacts of (\d+) legs?\b/i,
    from: (m) => `Bearing’s measurements of ${m[1]} ${m[1] === '1' ? 'holding' : 'holdings'}`,
  },
  { test: /split snapshot/i, from: 'Bearing’s hourly record of each pool’s two sides' },
  {
    test: /^tier \S+ of (\S+) on mainnet\b/i,
    from: (m) => `a liquidity tier standing in for a measurement, taken from ${m[1]} on mainnet`,
  },
  { test: /^tier source$/i, from: 'a liquidity tier standing in for a measurement' },
  { test: /^Bearing test curves$/i, from: 'Bearing’s test curves' },
  {
    test: /^Bearing, from the pools its collectors read each hour$/i,
    from: 'Bearing’s measured exit, from the pools it reads each hour',
  },
  { test: /^bearing$/i, from: 'Bearing’s measurements' },
  // No snapshot behind an answer: the API says so in the source itself.
  {
    test: /^vault_snapshots: no snapshot\b/i,
    from: 'this app’s kept readings of your vaults, which hold none yet',
  },

  // Named outside sources and this app's own settings.
  { test: /^the pool’s own rate$/i, from: 'the pool itself' },
  { test: /^Ondo$/i, from: 'Ondo' },
  { test: /^Kamino API$/i, from: 'Kamino' },
  {
    test: /^https:\/\/api\.kamino\.finance\//i,
    from: 'Kamino’s own figures for its lending market',
  },
  {
    test: /^https:\/\/yields\.llama\.fi\//i,
    from: 'DefiLlama’s list of pool rates',
  },
  { test: /^https:\/\/coins\.llama\.fi\//i, from: 'DefiLlama’s price history' },
  { test: /^issuer page$/i, from: 'the issuer’s own page' },
  { test: /^tenonfi API \/stats$/i, from: 'this app’s own counts' },
  { test: /^server registry$/i, from: 'this app’s list of assets' },
  { test: /^policy input platformFeeBps$/i, from: 'this app’s fee setting' },

  // Sample data: named as sample, never as a feed.
  { test: /^chain-mock$/i, from: 'the sample chain' },
  { test: /^fixtures\/risk\/curves-synthetic\.json$/i, from: 'sample exit curves' },
  { test: /^fixtures\/risk\/vault-price-limits\.json\b/i, from: 'sample price limits' },
  { test: /^fixtures\/testnet\b/i, from: 'a test-network stand-in for the asset' },
  { test: /mock-yields\.json$/i, from: 'sample rates' },
  { test: /^offline historical yields$/i, from: 'sample past rates' },
  { test: /^offline (?:catalog|catalog fixture)$/i, from: 'the sample catalog' },
  { test: /^offline fact sheet$/i, from: 'a sample fact sheet' },
  {
    test: /^offline (?:measured|reference|analytics) (?:fixture|input)$/i,
    from: 'sample measurements',
  },
  { test: /^sample feed$/i, from: 'a sample feed' },
  { test: /^fixture (?:exit read|exit table)$/i, from: 'a sample exit measurement' },
  { test: /^fixture price$/i, from: 'a sample price' },
  { test: /^MOCK price$/, from: 'a sample price' },
  { test: /^offline (?:adapter|exit fixture)$/i, from: 'sample data' },
  { test: /^sample measurements on a test network$/i, from: 'sample measurements' },
  { test: /^the e2e stub$/i, from: 'sample data' },
  {
    test: /^(?:sample(?: ·.*)?|fixture|fixture file|fixture rows|fixture flow rows|a fixture|a table|test fixture(?: \(MOCK\))?)$/i,
    from: 'sample data',
  },
];

const APPLIED = /^(.*) \((\S+)'s reading, applied to (\S+) on a test network\)$/;

function nameOne(source: string, context: Context): SourceWords | null {
  const text = source.trim();
  // A test token priced by its mainnet twin's reading: the reading's own name, and whose it is.
  const applied = APPLIED.exec(text);
  if (applied) {
    const inner = nameOne(applied[1] ?? '', context);
    return inner?.from
      ? { from: `${inner.from}, using ${applied[2]}’s price for the test token ${applied[3]}` }
      : null;
  }
  // The same reader through its second node is the same source.
  const second = /^(.*), on its second node$/.exec(text);
  if (second) return nameOne(second[1] ?? '', context);
  for (const rule of RULES) {
    const match = rule.test.exec(text);
    if (!match) continue;
    return { from: typeof rule.from === 'function' ? rule.from(match, context) : rule.from };
  }
  return null;
}

/**
 * A figure's source in plain words. A figure made of several (a sum, a value from several prices)
 * carries its parts joined by "; " or " + ": each is named, and the names are joined. One part with
 * no name leaves the whole unnamed, rather than naming half of what a figure stands on.
 */
export function sourceWords(source: string, provenance: string = 'live'): SourceWords {
  const context = { test: provenance === 'sandbox' };
  const parts = split(source);
  if (parts.length < 2 || JOINED.test(source.trim())) return nameOne(source, context) ?? NONE;
  const names: string[] = [];
  for (const part of parts) {
    const from = nameOne(part, context)?.from;
    if (!from) return NONE;
    if (!names.includes(from)) names.push(from);
  }
  return { from: listed(names) };
}

const NONE: SourceWords = { from: null };
/** One source whose own name holds a plus: the two feeds a price was checked against. */
const JOINED = /^Pyth Hermes \+ \w+$/i;

/** The parts of a source, cut at "; " and " + " outside any bracket. */
function split(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ';' || source.startsWith(' + ', i))) {
      parts.push(source.slice(from, i));
      from = i + (c === ';' ? 1 : 3);
    }
  }
  parts.push(source.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const listed = (names: readonly string[]) =>
  names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// How long ago. The stale tag's ages (format.ts) start at a minute and say "old"; these are for a
// sentence: "2 minutes ago", "less than a minute ago".

export type AgoWords = {
  /** Under a minute. */
  now: string;
  /** `{n}` the count, `{unit}` its word. */
  ago: string;
  minute: readonly string[];
  hour: readonly string[];
  day: readonly string[];
};

export const AGO_WORDS: AgoWords = {
  now: 'less than a minute ago',
  ago: '{n} {unit} ago',
  minute: ['minute', 'minutes'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
};

const span = (seconds: number): { count: number; unit: Age['unit'] } =>
  seconds < 3600
    ? { count: Math.max(1, Math.round(seconds / 60)), unit: 'minute' }
    : seconds < 172_800
      ? { count: Math.round(seconds / 3600), unit: 'hour' }
      : { count: Math.round(seconds / 86_400), unit: 'day' };

/** "2 minutes ago". Null when what was handed is not an age. A time ahead of the clock is "now". */
export function agoWords(seconds: number, words: AgoWords = AGO_WORDS): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  if (seconds < 45) return words.now;
  const { count, unit } = span(seconds);
  return words.ago
    .replace('{n}', String(count))
    .replace('{unit}', words[unit][count === 1 ? 0 : 1] ?? unit);
}

/** A limit as an adjective: "2 minute", "1 hour". Null when it is not a span of time. */
export function limitWords(seconds: number, words: AgoWords = AGO_WORDS): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.round(seconds)} second`;
  const { count, unit } = span(seconds);
  return `${count} ${words[unit][0] ?? unit}`;
}

const EXACT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** The exact time as a person reads it, in UTC: "9 Oct 2026, 18:26:20 UTC". The input as it came when it is no time. */
export function exactTime(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : `${EXACT.format(time)} UTC`;
}

// Addresses inside the API's words: the only part of a source set in the mono face, shortened in the
// middle, each with its own copy button.

/** `at` is where the piece starts in the text. */
export type Piece = { text: string; address: boolean; at: number };

// A Solana address (base58, 32 to 44 characters) or an EVM one (0x and 40 hex digits; 64 for a hash).
const ADDRESS = /\b(?:0x[0-9a-fA-F]{64}|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

/** The words of a source or a method, cut where an address stands. */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const at = match.index ?? 0;
    // A long run of letters with no digit is a word, not a key.
    if (!/\d/.test(match[0])) continue;
    if (at > from) out.push({ text: text.slice(from, at), address: false, at: from });
    out.push({ text: match[0], address: true, at });
    from = at + match[0].length;
  }
  if (from < text.length) out.push({ text: text.slice(from), address: false, at: from });
  return out;
}

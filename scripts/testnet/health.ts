// How old the test networks' prices are, read from the chains, in two lines a person reads at a glance.
//
//   pnpm exec tsx scripts/testnet/health.ts            both networks
//   pnpm exec tsx scripts/testnet/health.ts solana     or robinhood
//
// Per network: the oldest price and the oldest average against the age the vault takes. It exits 1
// when any is past 75% of its limit (--warn-at 0.75), which the price copiers never let happen while
// they run with --hold-last, and 2 when a network cannot be read. It reads only, holds no key, and
// refuses a node that is a mainnet. SOLANA_RPC_URL and RH_TESTNET_RPC_URL replace the public nodes;
// neither is printed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestnetChainId } from './robinhood/node';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
/** The program's limit for the one-hour average (programs/basket/src/price.rs, MAX_TWAP_AGE_S). */
const SOLANA_AVERAGE_MAX_AGE_S = 3_600;

export type Aged = { symbol: string; what: 'price' | 'average'; ageS: number; limitS: number };

/** The network's lines and whether any value is past `warnAt` of its limit. */
export function verdict(
  network: string,
  values: Aged[],
  warnAt: number,
): { lines: string[]; old: boolean } {
  const lines: string[] = [];
  let old = false;
  for (const what of ['price', 'average'] as const) {
    const of = values.filter((v) => v.what === what);
    if (of.length === 0) continue;
    const worst = of.reduce((a, b) => (b.ageS / b.limitS > a.ageS / a.limitS ? b : a));
    const past = of.filter((v) => v.ageS >= v.limitS * warnAt);
    old ||= past.length > 0;
    const share = Math.round((worst.ageS / worst.limitS) * 100);
    lines.push(
      `${network}: oldest ${what} ${worst.symbol}, ${span(worst.ageS)} of ${span(worst.limitS)} (${share}%)${
        past.length ? `  OLD: ${past.map((v) => v.symbol).join(', ')}` : '  ok'
      }`,
    );
  }
  return { lines, old };
}

function span(seconds: number): string {
  if (seconds < 600) return `${seconds} s`;
  if (seconds < 7_200) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3_600).toFixed(1)} h`;
}

/** One JSON-RPC call. An error never quotes the URL. */
async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let body: { result?: T; error?: { message?: string } };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    body = (await response.json()) as typeof body;
  } catch {
    throw new Error(`the node did not answer ${method}`);
  }
  if (body.result === undefined || body.result === null)
    throw new Error(`the node gave nothing for ${method}`);
  return body.result;
}

async function solana(): Promise<Aged[]> {
  const url = process.env.SOLANA_RPC_URL?.split(',')[0]?.trim() || 'https://api.devnet.solana.com';
  const record = JSON.parse(readFileSync(join(ROOT, 'deployments/solana-devnet.json'), 'utf8')) as {
    genesisHash: string;
    params: { maxPriceAgeS: number };
    accounts: { priceAccount: string };
    assets: { symbol: string; priceIndex: number; twapIndex: number }[];
  };
  const genesis = await rpc<string>(url, 'getGenesisHash', []);
  if (genesis === SOLANA_MAINNET_GENESIS) throw new Error('the node is mainnet: test network only');
  if (genesis !== record.genesisHash) throw new Error('the node is not the cluster of the record');
  const bytes = async (account: string) => {
    const found = await rpc<{ value: { data: [string, string] } | null }>(url, 'getAccountInfo', [
      account,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    if (!found.value) throw new Error(`the account ${account} is not there`);
    return Buffer.from(found.value.data[0], 'base64');
  };
  const [prices, clock] = [await bytes(record.accounts.priceAccount), await bytes(CLOCK)];
  const now = Number(clock.readBigInt64LE(32));
  // Scope's layout: 56 bytes an entry after a 40-byte header, the unix time at +24.
  const age = (index: number) => now - Number(prices.readBigUInt64LE(40 + 56 * index + 24));
  return record.assets.flatMap((a) => [
    {
      symbol: a.symbol,
      what: 'price' as const,
      ageS: age(a.priceIndex),
      limitS: record.params.maxPriceAgeS,
    },
    {
      symbol: a.symbol,
      what: 'average' as const,
      ageS: age(a.twapIndex),
      limitS: SOLANA_AVERAGE_MAX_AGE_S,
    },
  ]);
}

async function robinhood(): Promise<Aged[]> {
  const url = process.env.RH_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
  const record = JSON.parse(
    readFileSync(join(ROOT, 'deployments/robinhood-testnet.json'), 'utf8'),
  ) as { assets: { symbol: string; feed?: string; averageFeed?: string; maxAge?: number }[] };
  assertTestnetChainId(Number(BigInt(await rpc<string>(url, 'eth_chainId', []))));
  const block = await rpc<{ timestamp: string }>(url, 'eth_getBlockByNumber', ['latest', false]);
  const now = Number(BigInt(block.timestamp));
  // latestRoundData(): roundId, answer, startedAt, updatedAt, answeredInRound.
  const updatedAt = async (feed: string) => {
    const out = await rpc<string>(url, 'eth_call', [{ to: feed, data: '0xfeaf968c' }, 'latest']);
    if (out.length < 2 + 64 * 5) throw new Error(`the feed ${feed} has no round`);
    return Number(BigInt(`0x${out.slice(2 + 64 * 3, 2 + 64 * 4)}`));
  };
  const values: Aged[] = [];
  for (const a of record.assets) {
    if (!a.feed || !a.averageFeed || !a.maxAge) continue;
    values.push({
      symbol: a.symbol,
      what: 'price',
      ageS: now - (await updatedAt(a.feed)),
      limitS: a.maxAge,
    });
    values.push({
      symbol: a.symbol,
      what: 'average',
      ageS: now - (await updatedAt(a.averageFeed)),
      limitS: a.maxAge,
    });
  }
  if (values.length === 0) throw new Error('the record names no price contract');
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--warn-at');
  const warnAt = at === -1 ? 0.75 : Number(args[at + 1]);
  if (!(warnAt > 0 && warnAt <= 1)) throw new Error('--warn-at takes a share of the limit, 0 to 1');
  const networks = { solana, robinhood };
  const asked = (Object.keys(networks) as (keyof typeof networks)[]).filter(
    (name) => args.includes(name) || !args.some((a) => a in networks),
  );
  let code = 0;
  for (const name of asked) {
    try {
      const { lines, old } = verdict(name, await networks[name](), warnAt);
      for (const line of lines) console.log(line);
      if (old) code = Math.max(code, 1);
    } catch (error) {
      console.log(`${name}: NOT READ: ${(error as Error).message}`);
      code = 2;
    }
  }
  process.exitCode = code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
}

// Fills the vault's config for the Robinhood Chain test network (contracts/script/config/46630.json)
// from the kit's own record (contracts/script/testnet/deployed/46630.json): the test cash as the cash token, each test
// stock token priced by its test price contract and its average, its issuer's pause and its multiplier's
// schedule read on the token, the keeper's switch on, and Universal Router 2.1.2 pulling through Permit2.
// Each token's range is set around the price its test price contract holds now, from 0.775 to 1.25
// times it, as Solana devnet's ranges are (TNET-4). Reads the test network, sends nothing.
//
//   pnpm exec tsx scripts/testnet/robinhood/vault-config.ts
//
// VAULT_CONFIG_OUT writes the filled file elsewhere, as a rehearsal on a local copy does.
//
// Then contracts/script/Deploy.s.sol deploys the vault with the file (contracts/README.md, "The Robinhood
// Chain test network").
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECORD =
  process.env.TESTNET_RECORD ??
  join(ROOT, 'contracts', 'script', 'testnet', 'deployed', '46630.json');
const CONFIG = join(ROOT, 'contracts', 'script', 'config', '46630.json');
/** Where the filled file goes: the file itself, unless a rehearsal names another place. */
const OUT = process.env.VAULT_CONFIG_OUT ?? CONFIG;
const TESTNET_RPC = process.env.RH_TESTNET_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';

const PAUSED = '0x5c975abb';
const EFFECTIVE_AT = '0x97a4064f';
const LATEST_ROUND_DATA = '0xfeaf968c';
const NONE = '0x0000000000000000000000000000000000000000';

export type Record = {
  chainId: number;
  cash: string;
  cashDecimals: number;
  router: string;
  routerPull: number;
  tokens: {
    symbol: string;
    address: string;
    decimals: number;
    feed: string;
    average: string;
    feedDecimals: number;
  }[];
};

export type VaultAsset = {
  token: string;
  feed: string;
  tokenDecimals: number;
  feedDecimals: number;
  maxAge: number;
  session: number;
  source: number;
  maxWeightBps: number;
  pauseProbe: string;
  pauseSelector: string;
  scheduleSelector: string;
  flags: number;
  averageFeed: string;
  minPrice: number;
  maxPrice: number;
};

/** The range a keeper trade holds a price to: 0.775 to 1.25 times it, in the feed's units. */
export function rangeAround(price: bigint): { minPrice: number; maxPrice: number } {
  const min = (price * 775n) / 1000n;
  const max = (price * 125n) / 100n;
  if (max > 2n * min) throw new Error('the range would be wider than a factor two');
  if (max > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`a price of ${price} does not fit the file`);
  return { minPrice: Number(min), maxPrice: Number(max) };
}

/** The vault's asset entries: the cash first, unpriced and never a target, then each stock token. */
export function vaultAssets(record: Record, prices: Map<string, bigint>): VaultAsset[] {
  const cash: VaultAsset = {
    token: record.cash,
    feed: NONE,
    tokenDecimals: record.cashDecimals,
    feedDecimals: 0,
    maxAge: 0,
    session: 0,
    source: 0,
    maxWeightBps: 0,
    pauseProbe: NONE,
    pauseSelector: '0x00000000',
    scheduleSelector: '0x00000000',
    flags: 0,
    averageFeed: NONE,
    minPrice: 0,
    maxPrice: 0,
  };
  return [
    cash,
    ...record.tokens.map((t) => {
      const price = prices.get(t.feed);
      if (!price) throw new Error(`${t.symbol}'s price contract holds no price`);
      return {
        token: t.address,
        feed: t.feed,
        tokenDecimals: t.decimals,
        feedDecimals: t.feedDecimals,
        maxAge: 93600,
        session: 1,
        source: 1,
        maxWeightBps: 5000,
        pauseProbe: t.address,
        pauseSelector: PAUSED,
        scheduleSelector: EFFECTIVE_AT,
        flags: 1,
        averageFeed: t.average,
        ...rangeAround(price),
      };
    }),
  ];
}

async function latestAnswer(feed: string): Promise<bigint> {
  const response = await fetch(TESTNET_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: feed, data: LATEST_ROUND_DATA }, 'latest'],
    }),
  });
  const body = (await response.json()) as { result?: string; error?: { message?: string } };
  if (!body.result || body.result.length < 2 + 64 * 5)
    throw new Error(`${feed} gave no round: ${body.error?.message ?? 'empty answer'}`);
  return BigInt(`0x${body.result.slice(2 + 64, 2 + 128)}`);
}

async function main() {
  const record = JSON.parse(readFileSync(RECORD, 'utf8')) as Record;
  if (record.chainId !== 46630) throw new Error(`the record is for chain ${record.chainId}`);
  const prices = new Map<string, bigint>();
  for (const t of record.tokens) prices.set(t.feed, await latestAnswer(t.feed));
  const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as Record & {
    cashToken: string;
    assets: VaultAsset[];
    routers: { router: string; pull: number }[];
  };
  config.cashToken = record.cash;
  config.assets = vaultAssets(record, prices);
  config.routers = [{ router: record.router, pull: record.routerPull }];
  writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);
  console.log(
    `${OUT}: cash ${record.cash}, ${record.tokens.length} stock tokens, router ${record.router} (pull ${record.routerPull})`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

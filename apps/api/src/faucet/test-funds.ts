import type { ChainId, EnvLike, FundingResponse, TestFundsResponse } from '@colosseum/schemas';
import type { ChainEntry, ChainRegistry } from '../orders/chains';
import { Refusal } from '../orders/errors';
import { createCounter } from '../plugins/limits';

// The test faucet behind POST /v1/testnet/fund: it sends a wallet the test tokens and the gas a buy is
// missing, on a test network only. Key-free: what holds a key is a sender (faucet/signer.ts), handed
// in. Here are the rules a send is held to, whichever sender does it:
// - the chain runs on its real adapter on network `testnet`, never the mock and never mainnet;
// - what is sent is what the server read as missing for this buy, with a small margin, and never more
//   than a fixed ceiling;
// - a person may ask a few times a day, and the faucet as a whole a few more.
// The counts are kept in memory, per process, as the other rate limits are (plugins/limits.ts).

export const TEST_FUNDS = {
  /** Sends per person per day. */
  perPerson: 3,
  /** Sends per day for everybody together. */
  perDay: 100,
  /** How long a count is kept, in seconds: a day. */
  windowSeconds: 86_400,
  /** Over what is missing of the test dollar, in basis points: a rounding margin. */
  cashMarginBps: 100,
  /** Over what is missing of gas, in basis points: fees move between the read and the buy. */
  gasMarginBps: 2_500,
  /** The most test dollars one send mints, in whole dollars. */
  maxCashUsd: 5_000,
  /** The most gas one send transfers, in raw units of the native token, by chain. */
  maxGasRaw: { solana: 100_000_000n, robinhood: 10_000_000_000_000_000n } as Partial<
    Record<ChainId, bigint>
  >,
} as const;

export type TestFundsLimits = {
  perPerson: number;
  perDay: number;
  windowSeconds: number;
  cashMarginBps: number;
  gasMarginBps: number;
  maxCashUsd: number;
  maxGasRaw: Partial<Record<ChainId, bigint>>;
};

/** What a sender is asked to do: amounts already held to the rules, in raw units. */
export type TestFundsSend = {
  /** The wallet to fund. */
  to: string;
  /** The test dollar's token: its mint or contract address on the chain. */
  cashAddress: string;
  cashRaw: bigint;
  gasRaw: bigint;
};

/** Sends test tokens and gas on one chain's test network, as the key it holds. */
export type TestFundsSender = {
  chain: ChainId;
  /** Answers the transaction ids, in the order sent. Throws when the network refused one. */
  send(order: TestFundsSend): Promise<string[]>;
};

/** The environment variables that hold each chain's faucet key. Their values are never logged. */
export const FAUCET_KEY_ENV: Partial<Record<ChainId, string>> = {
  solana: 'TESTNET_FAUCET_SOLANA_KEY',
  robinhood: 'TESTNET_FAUCET_ROBINHOOD_KEY',
};

/** True for a chain the faucet may send on: its real adapter on a test network, nothing else. */
export const onTestNetwork = (entry: Pick<ChainEntry, 'config' | 'mode' | 'provenance' | 'mock'>) =>
  entry.config.network === 'testnet' &&
  entry.mode !== 'mock' &&
  entry.mock === undefined &&
  entry.provenance === 'sandbox';

/**
 * The faucet keys this server has, for the chains it may send on: a chain on a test network with its
 * variable set. Null when there is none, so nothing that holds a key is loaded.
 */
export function faucetKeysFrom(
  env: EnvLike,
  chains: ChainRegistry,
): Partial<Record<ChainId, string>> | null {
  const keys: Partial<Record<ChainId, string>> = {};
  for (const entry of chains.active()) {
    const name = FAUCET_KEY_ENV[entry.chain];
    // As written: a key is case-sensitive.
    const key = name ? env[name]?.trim() : undefined;
    if (key && onTestNetwork(entry)) keys[entry.chain] = key;
  }
  return Object.keys(keys).length ? keys : null;
}

const withMargin = (raw: bigint, bps: number) =>
  raw === 0n ? 0n : raw + (raw * BigInt(bps) + 9_999n) / 10_000n;

export type TestFunds = {
  /** True when a send can be asked for on this chain. */
  offered(entry: ChainEntry): boolean;
  /** Sends what `read` says is missing to its wallet, held to the rules above. */
  send(who: string, entry: ChainEntry, read: FundingResponse): Promise<TestFundsResponse>;
};

export function createTestFunds(options: {
  senders: TestFundsSender[];
  limits?: TestFundsLimits;
  now?: () => Date;
  /** Where a sender's failure is written. It is never sent to the caller: it may name a node. */
  log?: (err: unknown) => void;
}): TestFunds {
  const limits = options.limits ?? TEST_FUNDS;
  const now = options.now ?? (() => new Date());
  const counter = createCounter(limits.windowSeconds * 1000);
  const senders = new Map(options.senders.map((s) => [s.chain, s]));

  return {
    offered: (entry) => onTestNetwork(entry) && senders.has(entry.chain),
    async send(who, entry, read) {
      // Refused in code before anything else: a test faucet never sends on mainnet or a copy of it.
      if (!onTestNetwork(entry) || read.provenance !== 'sandbox' || read.chain !== entry.chain)
        throw new Refusal(
          403,
          `test funds are sent on a test network only, and ${entry.config.name} is not one here`,
        );
      const sender = senders.get(entry.chain);
      if (!sender)
        throw new Refusal(404, `this server sends no test funds on ${entry.config.name}`);

      const cashRaw = withMargin(BigInt(read.cash.missingRaw), limits.cashMarginBps);
      const gasRaw = withMargin(BigInt(read.gas.missingRaw), limits.gasMarginBps);
      if (cashRaw === 0n && gasRaw === 0n)
        throw new Refusal(409, 'the wallet already has what this buy needs');
      const maxCash = BigInt(limits.maxCashUsd) * 10n ** BigInt(read.cash.decimals);
      const maxGas = limits.maxGasRaw[entry.chain] ?? 0n;
      if (cashRaw > maxCash || gasRaw > maxGas)
        throw new Refusal(
          422,
          `this buy needs more than the test faucet sends at once ($${limits.maxCashUsd.toLocaleString('en-US')} in test dollars)`,
          { fix: 'Choose a smaller amount, then ask again.', details: { retryable: false } },
        );

      const at = now().getTime();
      const mine = counter.take(`person:${who}`, limits.perPerson, at);
      if (!mine.ok)
        throw tooMany(mine.resetAt - at, 'you have had test funds as often as a day allows');
      const all = counter.take('everybody', limits.perDay, at);
      if (!all.ok) throw tooMany(all.resetAt - at, 'the test faucet has sent all it may today');

      const assets = await entry.adapter.listAssets();
      const cash = assets.find((a) => a.id === read.cash.asset);
      if (!cash) throw new Error(`${entry.chain} lists no ${read.cash.asset}`);
      let txIds: string[];
      try {
        txIds = await sender.send({ to: read.wallet, cashAddress: cash.address, cashRaw, gasRaw });
      } catch (err) {
        options.log?.(err);
        throw new Refusal(502, 'the test network did not take the transfer', {
          fix: 'Read your wallet again: part of it may have arrived. Then ask again.',
          details: { retryable: true },
        });
      }
      return {
        chain: entry.chain,
        provenance: 'sandbox',
        wallet: read.wallet,
        cash: { symbol: read.cash.symbol, decimals: read.cash.decimals, raw: cashRaw.toString() },
        gas: { symbol: read.gas.symbol, decimals: read.gas.decimals, raw: gasRaw.toString() },
        txIds,
        left: mine.remaining,
      };
    },
  };
}

function tooMany(ms: number, why: string): Refusal {
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return new Refusal(429, why, {
    code: 'RATE_LIMITED',
    fix: `Try again in ${hours} hour${hours === 1 ? '' : 's'}.`,
    details: { retryable: true },
  });
}

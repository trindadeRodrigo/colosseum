import {
  type ChainId,
  type EnvLike,
  type FundingResponse,
  TEST_FUNDS_LOW,
  type TestFundsResponse,
} from '@colosseum/schemas';
import type { ChainEntry, ChainRegistry } from '../orders/chains';
import { Refusal } from '../orders/errors';
import { createCounter } from '../plugins/limits';

// The test faucet behind POST /v1/testnet/fund: it sends a wallet the test tokens and the gas a buy is
// missing, on a test network only. The faucet is a wallet of its own holding a float of test tokens,
// and it transfers from that float: it mints nothing and holds no authority or role, so the most a
// compromised server loses is the float. Key-free here: what holds the key is a sender
// (faucet/signer.ts), handed in. The rules a send is held to, whichever sender does it:
// - the chain runs on its real adapter on network `testnet`, never the mock and never mainnet;
// - what is sent is what the server read as missing for this buy, with a small margin, and never more
//   than a fixed ceiling, tight for gas, which is scarce on Robinhood Chain's test network;
// - the float covers it, with gas left for the faucet's own fee, or nothing is sent and the answer
//   says the faucet is low;
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
  /** The most test dollars one send transfers, in whole dollars. */
  maxCashUsd: 5_000,
  /**
   * The most gas one send transfers, in raw units of the native token: 0.05 SOL; 0.0005 ETH, about
   * twenty times what a buy's steps cost there.
   */
  maxGasRaw: { solana: 50_000_000n, robinhood: 500_000_000_000_000n } as Partial<
    Record<ChainId, bigint>
  >,
  /** Gas the float keeps for the faucet's own fees: 0.005 SOL; 0.0001 ETH. */
  gasReserveRaw: { solana: 5_000_000n, robinhood: 100_000_000_000_000n } as Partial<
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
  gasReserveRaw: Partial<Record<ChainId, bigint>>;
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

/** Sends test tokens and gas on one chain's test network, from the float of the key it holds. */
export type TestFundsSender = {
  chain: ChainId;
  /** What the faucet's wallet holds now, in raw units: the test dollar, and the native token. */
  float(cashAddress: string): Promise<{ cashRaw: bigint; gasRaw: bigint }>;
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
  /**
   * Where a sender's failure is written: the chain and the error's name only (`failureFields`). The
   * error itself never is, here or to the caller: a node library's message can carry the RPC URL.
   */
  log?: (fields: { chain: ChainId; error: string }) => void;
}): TestFunds {
  const limits = options.limits ?? TEST_FUNDS;
  const now = options.now ?? (() => new Date());
  const counter = createCounter(limits.windowSeconds * 1000);
  const senders = new Map(options.senders.map((s) => [s.chain, s]));
  // One send at a time per chain, from the float check to the last transaction: two people at once
  // never both pass a check that covers one, and an EVM faucet never reads one nonce twice.
  const queues = new Map<ChainId, Promise<unknown>>();
  const inTurn = <T>(chain: ChainId, run: () => Promise<T>): Promise<T> => {
    const turn = (queues.get(chain) ?? Promise.resolve()).then(run, run);
    queues.set(
      chain,
      turn.catch(() => undefined),
    );
    return turn;
  };
  const failed = (chain: ChainId, err: unknown) => options.log?.(failureFields(chain, err));

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

      const assets = await entry.adapter.listAssets();
      const cash = assets.find((a) => a.id === read.cash.asset);
      if (!cash) throw new Error(`${entry.chain} lists no ${read.cash.asset}`);
      return inTurn(entry.chain, async () => {
        // The float first: a send it cannot cover is refused before it counts against anybody.
        let held: { cashRaw: bigint; gasRaw: bigint };
        try {
          held = await sender.float(cash.address);
        } catch (err) {
          failed(entry.chain, err);
          throw new Refusal(502, 'the test network did not answer', {
            details: { retryable: true },
          });
        }
        const reserve = limits.gasReserveRaw[entry.chain] ?? 0n;
        if (held.gasRaw < gasRaw + reserve) throw low(TEST_FUNDS_LOW.gas);
        if (held.cashRaw < cashRaw) throw low(TEST_FUNDS_LOW.cash);

        const at = now().getTime();
        const mine = counter.take(`person:${who}`, limits.perPerson, at);
        if (!mine.ok)
          throw tooMany(mine.resetAt - at, 'you have had test funds as often as a day allows');
        const all = counter.take('everybody', limits.perDay, at);
        if (!all.ok) throw tooMany(all.resetAt - at, 'the test faucet has sent all it may today');
        let txIds: string[];
        try {
          txIds = await sender.send({
            to: read.wallet,
            cashAddress: cash.address,
            cashRaw,
            gasRaw,
          });
        } catch (err) {
          failed(entry.chain, err);
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
        } satisfies TestFundsResponse;
      });
    },
  };
}

/** What is written of a failed send: the chain and the kind of error, never its message. */
export const failureFields = (chain: ChainId, err: unknown) => ({
  chain,
  error: err instanceof Error ? err.name : typeof err,
});

/** The float cannot cover the send: a person tops it up from the deployer. */
const low = (why: string) =>
  new Refusal(409, why, {
    fix: 'The test faucet needs topping up. Ask the team, or fund the wallet yourself.',
    details: { retryable: false },
  });

function tooMany(ms: number, why: string): Refusal {
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return new Refusal(429, why, {
    code: 'RATE_LIMITED',
    fix: `Try again in ${hours} hour${hours === 1 ? '' : 's'}.`,
    details: { retryable: true },
  });
}

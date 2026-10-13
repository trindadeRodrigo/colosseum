import { createHash } from 'node:crypto';
import {
  BasketInputError,
  batchTrades,
  formatDecimal,
  parseDecimal,
  planRebalance,
} from '@colosseum/basket';
import { type MockAdapter, mockAddress } from '@colosseum/chain-mock';
import type { AssetId, BasketAsset, BuiltTx, ChainId, Target } from '@colosseum/schemas';
import type { KnownVault } from './source';

// The sample world of a chain on the mock. packages/chain-mock is a chain in memory, one per process, so
// the worker's mock is not the one the API's mock holds: a vault a person opened through the API does
// not exist here until this file makes it again. Before each pass it brings its chain up to date:
//
//   1. the clock goes to `now`, and each price to where it stands in this ten minutes;
//   2. every vault the database names that this chain does not hold yet is made, with the same owner and
//      plan number (the mock derives a vault's address from the two, so the address is the row's), a
//      deposit of what the row was last worth, and purchases at the row's targets;
//   3. with nothing named at all, one sample vault is made and its address answered, for a pass to
//      read with no API running.
//
// Everything here is the mock: sample owners, sample deposits, sample prices, labelled `mock` on every
// row. This is the only file of the worker that builds or lands a transaction, and only on
// packages/chain-mock, which no key signs for and no network sees.

/** A step of the price walk is ten minutes, the worker's own interval. */
export const BUCKET_MS = 600_000;
/** How many steps a price is the sum of: a day of them. */
export const WINDOW = 144;
/** The most one step moves a price, in bps of where it started. */
export const STEP_BPS = 20;
/** No price ever stands further from where it started than this, in bps: 2,880, so never near zero. */
export const MAX_LEVEL_BPS = WINDOW * STEP_BPS;
/** The most a price moves from one ten minutes to the next, in bps of where it started. */
export const MAX_MOVE_BPS = 2 * STEP_BPS;

/** What a vault is made with when the row has no value, or a value of zero, in dollars. */
const FLOOR_DEPOSIT_USD = '100';
const SAMPLE_DEPOSIT_USD = '1000';
/** The sample vault's plan number, and its targets by the shelf's slugs. A tenth stays in cash. */
const SAMPLE_PLAN = '1';
const SAMPLE_TARGETS: readonly (readonly [slug: string, weightBps: number])[] = [
  ['spy', 4_000],
  ['yield', 3_000],
  ['gold', 2_000],
];
/** Native units for the network fees of making one vault: far more than the mock charges. */
const GAS_RAW = { solana: '1000000000', evm: '1000000000000000000' } as const;
/** The slippage an owner's transaction is built with. Nothing moves between the build and the send. */
const SLIPPAGE_BPS = 50;
/** No purchase under a dollar, as the keeper plans. */
const MIN_TRADE_USD = 1;

/** The owner of the sample vault on a chain: an address that belongs to nobody. */
export function sampleOwner(chain: ChainId): string {
  return mockAddress(chain, 'snapshot:sample-owner');
}

/** Where the mock puts the vault of an owner and a plan number, on any process. */
export function mockVaultAddress(chain: ChainId, owner: string, basketId: string): string {
  return mockAddress(chain, `vault:${owner}:${basketId}`);
}

/** The sample vault's address on a chain. */
export function sampleVault(chain: ChainId): string {
  return mockVaultAddress(chain, sampleOwner(chain), SAMPLE_PLAN);
}

/** One step: whole bps from -STEP_BPS to STEP_BPS, the same for an asset and a bucket in every process. */
function stepBps(asset: AssetId, bucket: number): number {
  const hash = createHash('sha256').update(`${asset}:${bucket}`).digest();
  return (hash.readUInt32BE(0) % (2 * STEP_BPS + 1)) - STEP_BPS;
}

/**
 * Where an asset's price stands in a ten-minute bucket, in bps of where it started: the sum of the last
 * day's steps. A sum over a window, not a running walk, so the price depends on the time alone. A worker
 * started again, or run once an hour with --once, goes on with the same history instead of starting
 * over. One bucket on, a step joins the sum and a step leaves it: the move is at most MAX_MOVE_BPS.
 */
export function levelBps(asset: AssetId, bucket: number): number {
  let level = 0;
  for (let b = bucket - WINDOW + 1; b <= bucket; b++) level += stepBps(asset, b);
  return level;
}

/** A dollar figure as raw units of a token with `decimals`, cut to whole units. */
function rawOf(usd: string, decimals: number): bigint {
  return (parseDecimal(usd) * 10n ** BigInt(decimals)) / 10n ** 18n;
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : 'it failed');

export type MockWorld = {
  /**
   * Brings the chain up to `now`: the clock, the prices, and the vaults the database names. Answers the
   * addresses of the vaults it holds that the database does not name: the sample vault's when nothing
   * is named, none otherwise.
   */
  prepare(known: readonly KnownVault[], now: Date): Promise<string[]>;
};

export function createMockWorld(
  adapter: MockAdapter,
  options: { warn?: (line: string) => void } = {},
): MockWorld {
  const { chain, mock, capabilities } = adapter;
  const warn = options.warn ?? (() => {});
  /** The shelf, and each price as the chain started with it. Read on the first pass. */
  let shelf: { assets: BasketAsset[]; cashDecimals: number; start: Map<AssetId, string> } | null =
    null;
  let walkedTo: number | null = null;
  /** Rows this chain could not make. Each is said once and not tried again: the mock does not change its mind. */
  const givenUp = new Set<string>();

  async function shelfOf() {
    if (shelf) return shelf;
    const assets = await adapter.listAssets();
    const cash = assets.find((a) => a.id === mock.cash);
    if (!cash) throw new Error(`the mock of ${chain} lists no cash`);
    const others = assets.filter((a) => a.id !== mock.cash).map((a) => a.id);
    const start = new Map(
      (await adapter.getPrices(others)).map((p) => [p.asset, p.usdPerToken] as const),
    );
    shelf = { assets, cashDecimals: cash.decimals, start };
    return shelf;
  }

  /** Lands what was built and holds it to having gone through: the mock records a revert, it does not throw one. */
  async function land(tx: BuiltTx): Promise<void> {
    const { txId } = await mock.send(tx);
    const { status, error } = await adapter.track(txId);
    if (status !== 'confirmed')
      throw new Error(error?.message ?? `a ${tx.legKind} transaction was left ${status}`);
  }

  /** A vault that is not there yet: funded, approved where the chain asks, opened, and bought at its targets. */
  async function make(row: {
    address: string;
    owner: string;
    basketId: string;
    targets: readonly Target[];
    /** Dollars, or null for the floor. */
    valueUsd: string | null;
  }): Promise<void> {
    const { assets, cashDecimals } = await shelfOf();
    if (mockVaultAddress(chain, row.owner, row.basketId) !== row.address)
      throw new Error('the mock would put this owner and plan number at another address');
    const listed = new Set(assets.map((a) => a.id));
    // A target the mock's shelf does not list is dropped, and its share stays in cash.
    const targets = row.targets.filter((t) => t.asset !== mock.cash && listed.has(t.asset));
    const depositRaw = depositOf(row.valueUsd, cashDecimals).toString();
    mock.fund(row.owner, {
      gasRaw: capabilities.needsApprove ? GAS_RAW.evm : GAS_RAW.solana,
      assets: { [mock.cash]: depositRaw },
    });
    const plan = { owner: row.owner, basketId: row.basketId };
    // One at a time: on EVM each build states the owner's next nonce, which the send before it moves.
    if (capabilities.needsApprove)
      await land(await adapter.buildApprove({ ...plan, amountRaw: depositRaw }));
    await land(
      await adapter.buildCreateVault({
        ...plan,
        targets: [...targets],
        autoFollow: false,
        depositRaw,
        slippageBps: SLIPPAGE_BPS,
      }),
    );
    const vault = await adapter.getVault(row.address);
    if (!vault) throw new Error('the mock opened the vault at another address');
    const prices = await adapter.getPrices(targets.map((t) => t.asset));
    // A band of nothing: every target is bought now, as a person's first purchase does.
    const trades = planRebalance(
      vault,
      [...targets],
      prices,
      { bandBps: 0, minTradeUsd: MIN_TRADE_USD },
      assets,
    );
    for (const batch of batchTrades(trades, capabilities.maxTradesPerTx))
      await land(
        await adapter.buildOwnerSwap({
          vault: row.address,
          trades: batch,
          slippageBps: SLIPPAGE_BPS,
        }),
      );
  }

  /**
   * What a row's vault is opened with, in raw cash: what the cache last valued it at, or the floor when
   * it never valued it, valued it at nothing, or holds a figure that is not a plain decimal.
   */
  function depositOf(valueUsd: string | null, cashDecimals: number): bigint {
    const floor = rawOf(FLOOR_DEPOSIT_USD, cashDecimals);
    if (valueUsd === null) return floor;
    try {
      const raw = rawOf(valueUsd, cashDecimals);
      return raw > 0n ? raw : floor;
    } catch (e) {
      if (e instanceof BasketInputError) return floor;
      throw e;
    }
  }

  /** Each price to where it stands in the bucket of `now`. Twice in one bucket moves nothing. */
  async function walk(now: Date): Promise<void> {
    const bucket = Math.floor(now.getTime() / BUCKET_MS);
    if (bucket === walkedTo) return;
    const { start } = await shelfOf();
    for (const [asset, usdPerToken] of start) {
      const level = BigInt(10_000 + levelBps(asset, bucket));
      mock.setPrice(asset, formatDecimal((parseDecimal(usdPerToken) * level) / 10_000n));
    }
    walkedTo = bucket;
  }

  return {
    async prepare(known, now) {
      // The mock's clock moves only when told. It stamps every read, so it follows the worker's.
      const behind = Math.floor(now.getTime() / 1000) - mock.now();
      if (behind > 0) mock.advance(behind);
      await walk(now);

      for (const row of known) {
        if (givenUp.has(row.address)) continue;
        try {
          if (await adapter.getVault(row.address)) continue;
          await make({
            address: row.address,
            owner: row.owner,
            basketId: row.onchainBasketId,
            targets: row.targets,
            valueUsd: row.valueUsd,
          });
        } catch (e) {
          // One row the mock cannot make does not stop the pass: the rest are made, and this one is
          // read as a vault that is not there.
          givenUp.add(row.address);
          warn(`the mock of ${chain} could not make the vault ${row.address}: ${reasonOf(e)}`);
        }
      }
      if (known.length > 0) return [];

      // Nothing is known: one sample vault, made once.
      const address = sampleVault(chain);
      if (await adapter.getVault(address)) return [address];
      try {
        await make({
          address,
          owner: sampleOwner(chain),
          basketId: SAMPLE_PLAN,
          targets: SAMPLE_TARGETS.map(([slug, weightBps]) => ({
            asset: `${chain}:${slug}`,
            weightBps,
          })),
          valueUsd: SAMPLE_DEPOSIT_USD,
        });
      } catch (e) {
        throw new Error(
          `the mock of ${chain} could not make its sample vault ${address}: ${reasonOf(e)}`,
        );
      }
      return [address];
    },
  };
}

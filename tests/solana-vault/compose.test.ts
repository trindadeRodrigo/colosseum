import { compose, type VaultWriteRpc } from '@colosseum/chain-solana/vault';
import { ChainError } from '@colosseum/schemas';
import {
  getAddressDecoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

// One transaction from a builder's instructions: what `compose` refuses before it asks the node anything
// costly.

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

describe('compose', () => {
  it('refuses a transaction over 1,232 bytes as NotSupported before simulating it', async () => {
    const asked: string[] = [];
    const answer = <T>(method: string, value: T) => ({
      send: async () => {
        asked.push(method);
        return value;
      },
    });
    const rpc = {
      getLatestBlockhash: () =>
        answer('getLatestBlockhash', {
          context: { slot: 1n },
          value: {
            blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)),
            lastValidBlockHeight: 10n,
          },
        }),
      getRecentPrioritizationFees: () => answer('getRecentPrioritizationFees', []),
      simulateTransaction: () => answer('simulateTransaction', { value: { err: null } }),
    } as unknown as VaultWriteRpc;
    const outcome = await compose({
      rpc,
      program: key(1),
      feePayer: key(2),
      instructions: [{ programAddress: key(1), data: new Uint8Array(1_300) }],
      watch: [],
    }).then(
      () => 'built',
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(ChainError);
    expect((outcome as ChainError).code).toBe('NotSupported');
    expect((outcome as ChainError).message).toMatch(/over the 1232/);
    expect(asked).not.toContain('simulateTransaction');
  });

  // The price of a compute unit (compose's `priceAt`): at least 1 micro-lamport, so a wallet adds no
  // price of its own (what made devnet land), unless the cap allows none; the cap always wins.
  describe('the priority price', () => {
    const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
    const rpc = (unitsConsumed: bigint) =>
      ({
        getLatestBlockhash: () => ({
          send: async () => ({
            context: { slot: 1n },
            value: {
              blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)),
              lastValidBlockHeight: 10n,
            },
          }),
        }),
        getRecentPrioritizationFees: () => ({ send: async () => [] }),
        simulateTransaction: () => ({
          send: async () => ({ value: { err: null, unitsConsumed } }),
        }),
      }) as unknown as VaultWriteRpc;
    /** The prices the transaction sets: the data of each SetComputeUnitPrice instruction. */
    const pricesIn = (payload: string) => {
      const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(payload));
      const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
      return message.instructions
        .filter(
          (ix) =>
            message.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET && ix.data?.[0] === 3,
        )
        .map((ix) => new DataView((ix.data as Uint8Array).slice(1).buffer).getBigUint64(0, true));
    };
    const run = (priority: { microLamports?: bigint; maxLamports?: bigint }, units = 100_000n) =>
      compose({
        rpc: rpc(units),
        program: key(1),
        feePayer: key(2),
        instructions: [{ programAddress: key(1), data: new Uint8Array(8) }],
        watch: [],
        priority,
      });

    it('sets a floor of 1 micro-lamport when the recent fees are 0', async () => {
      const built = await run({ microLamports: 0n, maxLamports: 1_000n });
      expect(built.microLamportsPerUnit).toBe(1n);
      expect(pricesIn(built.payload)).toEqual([1n]);
      expect(built.feeLamports).toBe(5_000n + 1n);
    });

    it('sets the price asked for when it is under the cap', async () => {
      const built = await run({ microLamports: 50n, maxLamports: 1_000_000n });
      expect(pricesIn(built.payload)).toEqual([50n]);
    });

    it('sets no price at all when the cap is 0', async () => {
      const built = await run({ microLamports: 0n, maxLamports: 0n });
      expect(built.microLamportsPerUnit).toBe(0n);
      expect(pricesIn(built.payload)).toEqual([]);
      expect(built.feeLamports).toBe(5_000n);
    });

    it('sets no floor when even 1 micro-lamport would pass the cap at the limit', async () => {
      // 1,200,000 units at 1 micro-lamport is 2 lamports, over a cap of 1.
      const built = await run({ microLamports: 0n, maxLamports: 1n }, 1_000_000n);
      expect(built.computeUnitLimit).toBe(1_200_000);
      expect(pricesIn(built.payload)).toEqual([]);
      expect(built.feeLamports - 5_000n).toBeLessThanOrEqual(1n);
    });

    it('caps a price that would pass `maxLamports`', async () => {
      const built = await run({ microLamports: 1_000_000_000n, maxLamports: 1_000n });
      expect(built.feeLamports - 5_000n).toBeLessThanOrEqual(1_000n);
      expect(pricesIn(built.payload)).toEqual([built.microLamportsPerUnit]);
      expect(built.microLamportsPerUnit).toBeLessThan(1_000_000_000n);
    });
  });
});

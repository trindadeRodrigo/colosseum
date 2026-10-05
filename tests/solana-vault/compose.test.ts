import { compose, type VaultWriteRpc } from '@colosseum/chain-solana/vault';
import { ChainError } from '@colosseum/schemas';
import { getAddressDecoder, getBase58Decoder } from '@solana/kit';
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
});

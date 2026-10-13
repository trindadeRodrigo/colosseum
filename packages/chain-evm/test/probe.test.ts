import { parseChainConfigs } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { callHash } from '../src/vault/compose';
import type { EvmRpc } from '../src/vault/rpc';
import { createEvmProbe } from '../src/vault/send';

// `fate` on a node made by hand: where the signer's nonce was taken, and by what. The real node runs
// in testnet.test.ts; these are the answers a real node can give that a copy will not.

const SIGNER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';
const VAULT = '0x8ac7985210004386ebc00745262aea4b9207af30';
const DATA = '0x0a2d66f60000000000000000000000000000000000000000000000000000000000000001';
const CHAIN_ID = 46_630;
const hashOf = (data: string) =>
  callHash({ chainId: CHAIN_ID, signer: SIGNER, to: VAULT, value: '0', data });

/**
 * A node whose head is `head`, where the signer's transaction on `nonce` landed in block `landedAt`
 * with `data`. `latestCount` is what `latest` answers, which a node behind a pool may answer from
 * another node; `forgetsBelow` is the oldest height whose state it still holds.
 */
function node(o: {
  head: bigint;
  headTime?: bigint;
  nonce: number;
  landedAt: bigint | null;
  data?: string;
  latestCount?: number;
  forgetsBelow?: bigint;
}) {
  const counts: bigint[] = [];
  const countAt = (n: bigint) => (o.landedAt !== null && n >= o.landedAt ? o.nonce + 1 : o.nonce);
  const rpc = {
    async getBlock(a: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) {
      const number = a.blockNumber ?? o.head;
      const ours =
        o.landedAt !== null && number === o.landedAt
          ? [
              {
                hash: `0x${'ab'.repeat(32)}`,
                from: SIGNER,
                to: VAULT,
                value: 0n,
                input: o.data ?? DATA,
                chainId: CHAIN_ID,
                nonce: o.nonce,
              },
            ]
          : [];
      return { number, timestamp: o.headTime ?? 1_000n, transactions: ours };
    },
    async getTransactionCount(a: { blockTag?: string; blockNumber?: bigint }) {
      if (a.blockNumber === undefined) return o.latestCount ?? countAt(o.head);
      if (o.forgetsBelow !== undefined && a.blockNumber < o.forgetsBelow)
        throw new Error('historical state is not available');
      counts.push(a.blockNumber);
      return countAt(a.blockNumber);
    },
  };
  return { rpc: rpc as unknown as EvmRpc, counts };
}

const probeOn = (rpc: EvmRpc) => createEvmProbe({ config: parseChainConfigs({}).robinhood, rpc });
const attempt = (o: { nonce: number; validUntil?: string; data?: string }) => ({
  messageHash: hashOf(o.data ?? DATA),
  signer: SIGNER,
  validUntil: o.validUntil ?? null,
  nonce: o.nonce,
});

describe('fate on EVM', () => {
  it('reads the nonce at the head it read, never at a `latest` another node answers', async () => {
    // A pool of nodes: `latest` comes from one that has not seen the trade, the head from one that
    // has, past the trade's deadline. Read at that head, the nonce is taken, by this call.
    const { rpc } = node({
      head: 100n,
      headTime: 5_000n,
      nonce: 7,
      landedAt: 90n,
      latestCount: 7,
    });
    expect(await probeOn(rpc).fate(attempt({ nonce: 7, validUntil: '4000' }))).toEqual({
      state: 'landed',
      txId: `0x${'ab'.repeat(32)}`,
    });
  });

  it('finds the block that took the nonce far back in a few reads, and tells this call from another', async () => {
    const { rpc, counts } = node({ head: 1_000_000n, nonce: 3, landedAt: 37n });
    expect(await probeOn(rpc).fate(attempt({ nonce: 3 }))).toMatchObject({ state: 'landed' });
    expect(counts.length).toBeLessThan(50);
    const other = node({ head: 5_000n, nonce: 3, landedAt: 4_321n, data: `${DATA.slice(0, -1)}0` });
    expect(await probeOn(other.rpc).fate(attempt({ nonce: 3 }))).toEqual({ state: 'gone' });
  });

  it('says open where the node no longer holds the height that took the nonce', async () => {
    const { rpc } = node({ head: 100_000n, nonce: 3, landedAt: 10n, forgetsBelow: 90_000n });
    expect(await probeOn(rpc).fate(attempt({ nonce: 3 }))).toEqual({ state: 'open' });
  });

  it('says gone for a free nonce only once the head is past the deadline', async () => {
    const early = node({ head: 100n, headTime: 1_000n, nonce: 7, landedAt: null });
    expect(await probeOn(early.rpc).fate(attempt({ nonce: 7, validUntil: '2000' }))).toEqual({
      state: 'open',
    });
    const late = node({ head: 100n, headTime: 3_000n, nonce: 7, landedAt: null });
    expect(await probeOn(late.rpc).fate(attempt({ nonce: 7, validUntil: '2000' }))).toEqual({
      state: 'gone',
    });
    expect(await probeOn(late.rpc).fate(attempt({ nonce: 7 }))).toEqual({ state: 'open' });
  });
});

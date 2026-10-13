import { BYREAL_CLMM_PROGRAM, CLMM_POOL_SIZE, CLMM_TICK_ARRAY_POOL_OFFSET } from '@colosseum/risk';
import { sleep } from '../../lib';
import { rpc } from '../lib-pools';
import { BYREAL_CHILD_SLICE, type ByrealChild } from './lib';

// PLAN-UNIVERSE RU.15 — the chain reads Byreal needs beside the batch reads the other scripts already have. All
// read-only, all through `rpc` of lib-pools (its back-off on 429, its counters). getProgramAccounts is the method the
// provider throttles: calls are 150 ms apart, as in the registry run.
const GPA_GAP_MS = 150;

/** The registry's way: the program's accounts of a pool's size with the mint at byte 73 or 105, addresses only. */
export async function findByrealPools(mints: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const mint of mints)
    for (const offset of [73, 105]) {
      const r = await rpc<Array<{ pubkey: string }>>('getProgramAccounts', [
        BYREAL_CLMM_PROGRAM,
        {
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
          filters: [{ dataSize: CLMM_POOL_SIZE }, { memcmp: { offset, bytes: mint } }],
        },
      ]);
      for (const a of r) found.add(a.pubkey);
      await sleep(GPA_GAP_MS);
    }
  return [...found].sort();
}

type Listed = {
  context: { slot: number };
  value: Array<{ pubkey: string; account: { space?: number; data: [string, string] } }>;
};
const listing = (pool: string, length: number) =>
  rpc<Listed>('getProgramAccounts', [
    BYREAL_CLMM_PROGRAM,
    {
      encoding: 'base64',
      withContext: true,
      dataSlice: { offset: 0, length },
      filters: [{ memcmp: { offset: CLMM_TICK_ARRAY_POOL_OFFSET, bytes: pool } }],
    },
  ]);

/** Every account that names the pool at byte 8, with its size and its first 112 bytes: what kind each is. */
export async function listByrealChildren(
  pool: string,
): Promise<{ slot: number; children: ByrealChild[] }> {
  const r = await listing(pool, BYREAL_CHILD_SLICE);
  await sleep(GPA_GAP_MS);
  return {
    slot: r.context.slot,
    children: r.value.map((a) => {
      if (a.account.space === undefined) throw new Error(`${a.pubkey}: the RPC gave no size`);
      return {
        address: a.pubkey,
        space: a.account.space,
        head: new Uint8Array(Buffer.from(a.account.data[0], 'base64')),
      };
    }),
  };
}

/** The same accounts, addresses only: what a capture then reads whole in its own batches. */
export async function listByrealChildAddresses(pool: string): Promise<string[]> {
  const r = await listing(pool, 0);
  await sleep(GPA_GAP_MS);
  return r.value.map((a) => a.pubkey);
}

/** The same accounts, whole, at one slot: what the validation reads, at the commitment it names. */
export async function readByrealChildren(
  pool: string,
  commitment: 'finalized' | 'confirmed' = 'finalized',
): Promise<{ slot: number; accounts: Array<{ address: string; data: Uint8Array }> }> {
  const r = await rpc<Listed>('getProgramAccounts', [
    BYREAL_CLMM_PROGRAM,
    {
      encoding: 'base64',
      withContext: true,
      commitment,
      filters: [{ memcmp: { offset: CLMM_TICK_ARRAY_POOL_OFFSET, bytes: pool } }],
    },
  ]);
  await sleep(GPA_GAP_MS);
  return {
    slot: r.context.slot,
    accounts: r.value
      .map((a) => ({
        address: a.pubkey,
        data: new Uint8Array(Buffer.from(a.account.data[0], 'base64')),
      }))
      .sort((x, y) => x.address.localeCompare(y.address)),
  };
}

/**
 * Transfer fee of each mint in basis points, read as the registry run reads it (the parsed mint's
 * `transferFeeConfig`, its newer fee); 0 for a mint with no such extension. A mint the RPC did not return has no entry.
 */
export async function mintTransferFeeBps(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const r = await rpc<{
      value: Array<{
        data: {
          parsed?: {
            info?: {
              extensions?: Array<{
                extension: string;
                state: { newerTransferFee?: { transferFeeBasisPoints: number } };
              }>;
            };
          };
        };
      } | null>;
    }>('getMultipleAccounts', [batch, { encoding: 'jsonParsed' }]);
    r.value.forEach((v, k) => {
      const info = v?.data.parsed?.info;
      if (!info) return;
      const fee = info.extensions?.find((e) => e.extension === 'transferFeeConfig');
      out.set(batch[k] as string, fee?.state.newerTransferFee?.transferFeeBasisPoints ?? 0);
    });
  }
  return out;
}

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BYREAL_CLMM_PROGRAM, CLMM_TICK_ARRAY_POOL_OFFSET, decodeClmmPool } from '@colosseum/risk';
import { nowIso } from '../../lib';
import { rpc, rpcStats } from '../lib-pools';
import { BYREAL_PROBE_METHOD, type ByrealProbeFile, clmmArrayStart } from './lib';

// PLAN-UNIVERSE RU.13 — `pnpm risk:venues-freeze-byreal [pool] [out.json]`: the one read-only probe of Byreal. It
// reads one pool account, the list of the accounts the program holds for that pool (address, size and the four bytes
// where Raydium keeps a tick array's first tick: nothing else of them), and, in full, the one array that holds the
// pool's current tick. Three RPC calls, no transaction, no key. It writes the one file named (default:
// fixtures/risk/venues/byreal-<pool>-<stamp>.json); what the Raydium decoders make of those bytes is said by
// `byrealProbe` in lib.ts and pinned by the tests. No decoder is added to `packages/risk`.
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// COINx/USDC on Byreal: the Byreal pool on the most stored Jupiter routes (2,992 legs, Oct 1 to Oct 7)
const pool = args[0] ?? '5pobXosbeGSCRG3HdaRiw2TaihDDQMXkHFVbUTF24weM';
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');
const out =
  args[1] ?? join('fixtures', 'risk', 'venues', `byreal-${pool.slice(0, 6)}-${stamp}.json`);

type Info = { owner: string; space?: number; data: [string, string] };
const started = Date.now();
const fetchedAt = nowIso();
const head = await rpc<{ context: { slot: number }; value: Info | null }>('getAccountInfo', [
  pool,
  { encoding: 'base64' },
]);
if (!head.value) throw new Error(`${pool}: no such account`);
if (head.value.owner !== BYREAL_CLMM_PROGRAM)
  throw new Error(`${pool}: owned by ${head.value.owner}, not by Byreal`);
const poolData = new Uint8Array(Buffer.from(head.value.data[0], 'base64'));
const header = decodeClmmPool(poolData);

// every account of the program that names the pool where a Raydium tick array does: address, size, first tick
const listed = await rpc<Array<{ pubkey: string; account: Info }>>('getProgramAccounts', [
  BYREAL_CLMM_PROGRAM,
  {
    encoding: 'base64',
    dataSlice: { offset: 40, length: 4 },
    filters: [{ memcmp: { offset: CLMM_TICK_ARRAY_POOL_OFFSET, bytes: pool } }],
  },
]);
const children = listed
  .map((a) => {
    const b = Buffer.from(a.account.data[0], 'base64');
    return {
      address: a.pubkey,
      space: a.account.space ?? null,
      startTickIndex: b.length === 4 ? b.readInt32LE(0) : null,
    };
  })
  .sort((x, y) => (x.startTickIndex ?? 0) - (y.startTickIndex ?? 0));

// the array that holds the current tick, by Raydium's rule (60 ticks an array)
const start = clmmArrayStart(header.tickCurrent, header.tickSpacing);
const holder = children.find((c) => c.startTickIndex === start && (c.space ?? 0) > 44) ?? null;
let tickArray: ByrealProbeFile['tickArray'] = null;
let arraySlot: number | null = null;
if (holder) {
  const arr = await rpc<{ context: { slot: number }; value: Info | null }>('getAccountInfo', [
    holder.address,
    { encoding: 'base64' },
  ]);
  arraySlot = arr.context.slot;
  if (arr.value) tickArray = { address: holder.address, data: arr.value.data[0] };
}

const file: ByrealProbeFile = {
  method: BYREAL_PROBE_METHOD,
  source: `Solana RPC: getAccountInfo of the pool, getProgramAccounts of ${BYREAL_CLMM_PROGRAM} filtered on the pool at offset ${CLMM_TICK_ARRAY_POOL_OFFSET} with a 4-byte slice at offset 40, getAccountInfo of the one array holding the current tick`,
  fetchedAt,
  provenance: 'live',
  program: BYREAL_CLMM_PROGRAM,
  pool: { address: pool, slot: head.context.slot, data: head.value.data[0] },
  children,
  tickArray,
  tickArraySlot: arraySlot,
  rpc: {
    calls: rpcStats.calls,
    retries: rpcStats.retries429,
    seconds: (Date.now() - started) / 1000,
  },
};
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      out,
      pool,
      mints: [header.mint0, header.mint1],
      tickCurrent: header.tickCurrent,
      tickSpacing: header.tickSpacing,
      children: children.length,
      childSizes: [...new Set(children.map((c) => c.space))],
      arrayHoldingTheCurrentTick: holder?.address ?? null,
      rpc: file.rpc,
    },
    null,
    1,
  ),
);

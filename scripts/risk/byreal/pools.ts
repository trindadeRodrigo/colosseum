import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BYREAL_CLMM_PROGRAM,
  CLMM_POOL_SIZE,
  CLMM_TICK_ARRAY_POOL_OFFSET,
  decodeClmmPool,
} from '@colosseum/risk';
import { nowIso, RPC_URL } from '../../lib';
import { multipleAccounts } from '../lib-lending';
import { rpcStats } from '../lib-pools';
import solanaList from '../universe/solana.json';
import {
  BYREAL_CHILD_SLICE,
  BYREAL_POOLS_METHOD,
  type ByrealPoolRow,
  type ByrealPoolsFile,
  byrealPoolRow,
  byrealPoolsTable,
} from './lib';
import { findByrealPools, listByrealChildren } from './read';

// PLAN-UNIVERSE RU.15 — `pnpm risk:byreal-pools [out.json] [--md]`: every Byreal pool that holds a tracked stock.
// Read-only: no transaction, no key, no database, nothing under ~/.colosseum. The search is the registry run's
// (scripts/risk/build-registry.ts, not edited): getProgramAccounts of the program for accounts of 1,544 bytes with the
// mint at byte 73 or 105, one call a mint and a side, 150 ms apart, through the back-off of lib-pools. Then one batch
// read of the pools, one of their fee configs and vaults, and for each pool one getProgramAccounts of the accounts
// that name it at byte 8, cut to their first 112 bytes (what kind each is, and a dynamic array's own count of ticks).
// No oracle account is read: a pool's two feed ids are looked at only to say whether they are set.
// Writes the one file named (default data/risk/byreal/pools-<stamp>.json, which git ignores).
const UNQUOTED = ['AAPLx', 'AMZNx', 'GMEx', 'GOOGLx', 'MCDx', 'METAx', 'MSFTx', 'STRCx'];
const args = process.argv.slice(2);
const md = args.includes('--md');
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');
const out =
  args.find((a) => !a.startsWith('--')) ?? join('data', 'risk', 'byreal', `pools-${stamp}.json`);
// a worktree's .env has no SOLANA_RPC_URL, and the public endpoint refuses this search: say so before starting
if (RPC_URL === 'https://api.mainnet-beta.solana.com')
  throw new Error(
    'SOLANA_RPC_URL is not set: point DOTENV_CONFIG_PATH at the .env that has it (the public RPC is not used here)',
  );

const started = Date.now();
const fetchedAt = nowIso();
const tracked = solanaList.assets.map((a) => ({ symbol: a.symbol, mint: a.address }));
const stocks = new Map(tracked.map((t) => [t.mint, t.symbol]));

const pools = await findByrealPools(tracked.map((t) => t.mint));
const searchCalls = rpcStats.calls;

const heads = await multipleAccounts(pools);
const headers = new Map<string, ReturnType<typeof decodeClmmPool>>();
for (const p of pools) {
  const a = heads.accounts.get(p);
  if (!a) throw new Error(`${p}: found by the search and not returned by the read`);
  if (a.owner !== BYREAL_CLMM_PROGRAM) throw new Error(`${p}: owned by ${a.owner}`);
  headers.set(p, decodeClmmPool(a.data));
}
const side = await multipleAccounts([
  ...new Set([...headers.values()].flatMap((h) => [h.ammConfig, h.vault0, h.vault1])),
]);

const rows: ByrealPoolRow[] = [];
for (const p of pools) {
  const h = headers.get(p) as ReturnType<typeof decodeClmmPool>;
  const listed = await listByrealChildren(p);
  rows.push(
    byrealPoolRow(
      p,
      (heads.accounts.get(p) as { data: Uint8Array }).data,
      {
        config: side.accounts.get(h.ammConfig)?.data ?? null,
        vault0: side.accounts.get(h.vault0)?.data ?? null,
        vault1: side.accounts.get(h.vault1)?.data ?? null,
        children: listed.children,
        slots: { pool: heads.slot, arrays: listed.slot },
      },
      stocks,
    ),
  );
}

const file: ByrealPoolsFile = {
  method: BYREAL_POOLS_METHOD,
  source: `Solana RPC: getProgramAccounts of ${BYREAL_CLMM_PROGRAM} (accounts of ${CLMM_POOL_SIZE} bytes with a tracked stock's mint at byte 73 or 105), getMultipleAccounts of the pools, their fee configs and their vaults, getProgramAccounts of the accounts that name each pool at byte ${CLMM_TICK_ARRAY_POOL_OFFSET} (first ${BYREAL_CHILD_SLICE} bytes)`,
  fetchedAt,
  provenance: 'live',
  program: BYREAL_CLMM_PROGRAM,
  tracked,
  trackedSource: 'scripts/risk/universe/solana.json',
  rows,
  rpc: {
    calls: rpcStats.calls,
    searchCalls,
    retries429: rpcStats.retries429,
    errors: rpcStats.errors,
    seconds: (Date.now() - started) / 1000,
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
if (md) console.log(byrealPoolsTable(file, UNQUOTED));
else
  console.log(
    JSON.stringify({
      out,
      pools: rows.length,
      stocks: [...new Set(rows.flatMap((r) => r.stocks))].sort(),
      dynamicFeeOn: rows.filter((r) => r.fee.dynamic.on).map((r) => r.pool),
      decayingFeeOn: rows.filter((r) => r.fee.decay.on).map((r) => r.pool),
      ownRate: rows.filter((r) => r.fee.poolRate !== 0).length,
      rpc: file.rpc,
    }),
  );

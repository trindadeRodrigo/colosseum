import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLMM_POOL_SIZE, decodeClmmPool } from '@colosseum/risk';
import { nowIso, sleep } from '../../lib';
import { RISK_HOME } from '../lib-lending';
import { rpc, rpcStats } from '../lib-pools';
import { parseQuotes } from '../lib-routing-gap';
import solanaList from '../universe/solana.json';
import {
  DECODED_PROGRAMS,
  poolMints,
  ROUTE_POOLS_METHOD,
  type RoutePoolRow,
  type RoutePoolsFile,
  type VaultRow,
} from './lib';

// PLAN-UNIVERSE RU.13 — `pnpm risk:venues-freeze-pools [out.json]`: who owns every pool on a stored Jupiter route.
// The collector's quote rows name each leg's pool and Jupiter's label for it, and no program. This reads, once:
// - the owner program and the size of each of those accounts;
// - the whole account where the owner is a program `packages/risk` decodes, or the account has the size of a Raydium
//   concentrated-liquidity pool (Byreal's and PancakeSwap's do), so the pool's two mints can be read;
// - the two vaults of each pool of that size under another program that pairs a tracked stock: what it held;
// - Jupiter's own table of program to label, and its symbols for the mints read.
// Read-only: getMultipleAccounts and two public GETs. It writes the one file named (default:
// fixtures/risk/venues/route-pools-<stamp>.json) and nothing else; the report and the tests read that file, so the
// table can be made again without the network.
const out =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  join(
    'fixtures',
    'risk',
    'venues',
    `route-pools-${nowIso().slice(0, 16).replace(/[-:]/g, '')}.json`,
  );
const LABEL_URL = 'https://lite-api.jup.ag/swap/v1/program-id-to-label';
const TOKEN_URL = 'https://lite-api.jup.ag/tokens/v2/search';
const tracked = new Set(solanaList.assets.map((a) => a.address));

const dir = join(RISK_HOME, 'quotes');
if (!existsSync(dir)) throw new Error(`no stored quotes under ${dir}`);
const labels = new Map<string, Set<string>>();
let rows = 0;
let first: string | null = null;
let last: string | null = null;
for (const n of readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .sort()) {
  for (const q of parseQuotes(readFileSync(join(dir, n), 'utf8'))) {
    if (!q.route?.length) continue;
    rows++;
    if (!first || q.fetchedAt < first) first = q.fetchedAt;
    if (!last || q.fetchedAt > last) last = q.fetchedAt;
    for (const h of q.route) {
      const set = labels.get(h.pool) ?? new Set<string>();
      set.add(h.label ?? 'unknown');
      labels.set(h.pool, set);
    }
  }
}
const addresses = [...labels.keys()].sort();

type Info = { owner: string; space?: number; data: [string, string] } | null;
const started = Date.now();
const fetchedAt = nowIso();
const sized = new Map<string, { owner: string; space: number } | null>();
let slot = 0;
for (let i = 0; i < addresses.length; i += 100) {
  const batch = addresses.slice(i, i + 100);
  // owner and size only: an account of a program nobody here decodes is not downloaded
  const r = await rpc<{ context: { slot: number }; value: Info[] }>('getMultipleAccounts', [
    batch,
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 } },
  ]);
  slot = r.context.slot;
  r.value.forEach((v, k) => {
    const space = v?.space;
    if (v && typeof space !== 'number')
      throw new Error('the RPC returned no account size (`space`): use an endpoint that does');
    sized.set(batch[k] as string, v ? { owner: v.owner, space: space as number } : null);
  });
}
const whole = addresses.filter((a) => {
  const s = sized.get(a);
  return s && (s.owner in DECODED_PROGRAMS || s.space === CLMM_POOL_SIZE);
});
const data = new Map<string, string>();
let slotAccounts: number | null = null;
let slotVaults: number | null = null;
for (let i = 0; i < whole.length; i += 100) {
  const batch = whole.slice(i, i + 100);
  const r = await rpc<{ context: { slot: number }; value: Info[] }>('getMultipleAccounts', [
    batch,
    { encoding: 'base64' },
  ]);
  slotAccounts = r.context.slot;
  r.value.forEach((v, k) => {
    if (v) data.set(batch[k] as string, v.data[0]);
  });
}
const pools: RoutePoolRow[] = addresses.map((address) => {
  const s = sized.get(address) ?? null;
  return {
    address,
    labels: [...(labels.get(address) ?? [])].sort(),
    owner: s?.owner ?? null,
    space: s?.space ?? null,
    ...(data.has(address) ? { data: data.get(address) as string } : {}),
  };
});

// the vaults of the pools that have Raydium's pool size under another program and pair a tracked stock
const vaultKeys: string[] = [];
for (const p of pools) {
  if (!p.data || !p.owner || p.owner in DECODED_PROGRAMS || p.space !== CLMM_POOL_SIZE) continue;
  const h = decodeClmmPool(new Uint8Array(Buffer.from(p.data, 'base64')));
  if (tracked.has(h.mint0) || tracked.has(h.mint1)) vaultKeys.push(h.vault0, h.vault1);
}
const vaults: Record<string, VaultRow> = {};
type Parsed = {
  data?: {
    parsed?: { info?: { mint?: string; tokenAmount?: { amount: string; decimals: number } } };
  };
} | null;
for (let i = 0; i < vaultKeys.length; i += 100) {
  const batch = vaultKeys.slice(i, i + 100);
  const r = await rpc<{ context: { slot: number }; value: Parsed[] }>('getMultipleAccounts', [
    batch,
    { encoding: 'jsonParsed' },
  ]);
  slotVaults = r.context.slot;
  r.value.forEach((v, k) => {
    const info = v?.data?.parsed?.info;
    if (info?.mint && info.tokenAmount)
      vaults[batch[k] as string] = {
        mint: info.mint,
        amount: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals,
      };
  });
}

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`${url.split('?')[0]}: ${res.status}`);
  return (await res.json()) as T;
};
const programLabels = await getJson<Record<string, string>>(LABEL_URL);
const mints = [...new Set(pools.flatMap((p) => poolMints(p) ?? []))].sort();
const symbols: Record<string, string> = {};
for (let i = 0; i < mints.length; i += 50) {
  const found = await getJson<Array<{ id: string; symbol: string }>>(
    `${TOKEN_URL}?query=${mints.slice(i, i + 50).join(',')}`,
  );
  for (const t of found) if (mints.includes(t.id)) symbols[t.id] = t.symbol;
  await sleep(1100);
}

const file: RoutePoolsFile = {
  method: ROUTE_POOLS_METHOD,
  source: `Solana RPC getMultipleAccounts (owner program and size of every pool on a stored Jupiter route; the whole account where the owner is a program packages/risk decodes or the account has the size of a Raydium concentrated-liquidity pool; the two vaults of such a pool under another program when it pairs a tracked stock), ${LABEL_URL} and ${TOKEN_URL}`,
  fetchedAt,
  slot,
  provenance: 'live',
  quotes: { folder: 'RISK_HOME/quotes', withARoute: rows, first, last },
  rpc: {
    calls: rpcStats.calls,
    retries: rpcStats.retries429,
    seconds: (Date.now() - started) / 1000,
  },
  programLabels: { source: LABEL_URL, fetchedAt, labels: programLabels },
  tokens: { source: TOKEN_URL, fetchedAt, symbols },
  vaults,
  slots: { accounts: slotAccounts, vaults: slotVaults },
  pools,
};
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
const byOwner: Record<string, number> = {};
for (const p of pools) {
  const k = p.owner ?? 'no_such_account';
  byOwner[k] = (byOwner[k] ?? 0) + 1;
}
console.log(
  JSON.stringify(
    {
      out,
      pools: pools.length,
      whole: data.size,
      vaults: Object.keys(vaults).length,
      symbols: `${Object.keys(symbols).length} of ${mints.length} mints`,
      slot,
      rpc: file.rpc,
      byOwner,
    },
    null,
    1,
  ),
);

import 'dotenv/config';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { decoders, type RpcTx, tokenBalances } from '@colosseum/risk';
import { HISTORY_DIR, latestRegistryFile, type RegistryPool } from '../lib-history';
import { rpc, rpcStats } from '../lib-pools';

// Step 5b.4 — repair stored history rows found wrong by the completeness checks, without touching history-full.ts.
//   truncated   rows fetched with a truncated log (`tr`): refetched and re-decoded (the RPC now serves the whole log
//               for them; a row whose log is still truncated is left as it is and counted)
//   unknown     rows holding a payload the current decoders now read (`ux` with a discriminator in KNOWN_NOW):
//               refetched and re-decoded
//   added       transactions the address index never returned, found by block scan (`--add <pool>:<signature>`):
//               fetched, decoded and inserted into their day file, flagged `found: 'block-scan'`
// A replaced row keeps its signature, walk sequence and day. Every change is logged with the old and the new row in
// repairs/<stamp>.jsonl, so it can be undone. Day files are rewritten through a temporary file. Read-only on chain.
// Usage: tsx repair.ts [parallel=32] [--add <pool>:<signature> …] [--dry]
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const adds = args.flatMap((a, i) => (args[i - 1] === '--add' ? [a] : []));
const PARALLEL = Number(
  args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--add') ?? 32,
);
// Payload discriminators the decoders did not read when the history was fetched, and read now.
const KNOWN_NOW = new Set(['5f82b584fb32c326']); // Orca LiquidityRepositioned
const METHOD = 'history-repair-0.1';
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const OUT = join(HISTORY_DIR, 'repairs');
mkdirSync(OUT, { recursive: true });
const logFile = join(OUT, `${stamp}.jsonl`);

type Row = {
  s: string;
  q: number;
  sl: number;
  t: number;
  ev: unknown[] | null;
  vp: (string | null)[];
  vb: (string | null)[];
  ix?: string[];
  ux?: string[];
  tr?: number;
  found?: string;
  repaired?: { method: string; reason: string; at: string };
};
const reg = new Map(
  (JSON.parse(readFileSync(latestRegistryFile(), 'utf8')).pools as RegistryPool[]).map((p) => [
    p.address,
    p,
  ]),
);
const evRoot = join(HISTORY_DIR, 'events');
const fetchTx = (sig: string) =>
  rpc<RpcTx | null>('getTransaction', [
    sig,
    { encoding: 'json', maxSupportedTransactionVersion: 1 },
  ]);
function decodeRow(
  p: RegistryPool,
  tx: RpcTx,
  base: { s: string; q: number },
  reason: string,
): Row {
  const d = decoders[p.venue]?.(tx, p.address, { mint0: p.mint0 });
  const bal = tokenBalances(tx, [p.vault0, p.vault1]);
  return {
    s: base.s,
    q: base.q,
    sl: tx.slot,
    t: tx.blockTime ?? 0,
    ev: d?.events ?? null,
    vp: bal.pre,
    vb: bal.post,
    ix: d?.ix,
    ...(d?.unknown.length ? { ux: d.unknown } : {}),
    ...(d?.truncated ? { tr: 1 } : {}),
    repaired: { method: METHOD, reason, at: new Date().toISOString() },
  };
}
async function pool<T>(items: T[], f: (x: T) => Promise<void>) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let n = it.next(); !n.done; n = it.next()) await f(n.value);
    }),
  );
}

const stats = { candidates: 0, replaced: 0, unchanged: 0, stillTruncated: 0, added: 0, failed: 0 };
const t0 = Date.now();
for (const addr of readdirSync(evRoot)) {
  const p = reg.get(addr);
  if (!p) continue;
  for (const f of readdirSync(join(evRoot, addr)).filter((x) => x.endsWith('.jsonl'))) {
    const file = join(evRoot, addr, f);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const todo: Array<{ i: number; row: Row; reason: string }> = [];
    lines.forEach((l, i) => {
      if (!l.includes('"tr":1') && !l.includes('"ux"')) return;
      const row = JSON.parse(l) as Row;
      const reason = row.tr
        ? 'truncated_log'
        : row.ux?.some((u) => KNOWN_NOW.has(u.split('/')[0] as string))
          ? 'payload_now_decoded'
          : null;
      if (reason) todo.push({ i, row, reason });
    });
    if (!todo.length) continue;
    stats.candidates += todo.length;
    let changed = false;
    await pool(todo, async ({ i, row, reason }) => {
      try {
        const tx = await fetchTx(row.s);
        if (!tx?.meta) throw new Error('transaction not served');
        const next = decodeRow(p, tx, row, reason);
        if (next.tr) stats.stillTruncated++;
        const same =
          JSON.stringify([next.ev, next.ux ?? null, next.tr ?? null]) ===
          JSON.stringify([row.ev, row.ux ?? null, row.tr ?? null]);
        if (
          same ||
          (next.tr && reason === 'truncated_log' && (next.ev?.length ?? 0) <= (row.ev?.length ?? 0))
        ) {
          stats.unchanged++;
          return;
        }
        lines[i] = JSON.stringify(next);
        changed = true;
        stats.replaced++;
        if (!DRY)
          appendFileSync(
            logFile,
            `${JSON.stringify({ pool: addr, day: f, sig: row.s, reason, old: row, new: next })}\n`,
          );
      } catch (e) {
        stats.failed++;
        if (!DRY)
          appendFileSync(
            logFile,
            `${JSON.stringify({ pool: addr, day: f, sig: row.s, reason, error: String(e).slice(0, 300) })}\n`,
          );
      }
    });
    if (changed && !DRY) {
      writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`);
      renameSync(`${file}.tmp`, file);
    }
  }
  console.log(JSON.stringify({ pool: addr, ...stats, secs: Math.round((Date.now() - t0) / 1000) }));
}

// transactions missing from the address index, found by block scan
for (const a of adds) {
  const [addr, sig] = a.split(':') as [string, string];
  const p = reg.get(addr);
  if (!p) throw new Error(`unknown pool ${addr}`);
  const tx = await fetchTx(sig);
  if (!tx?.meta || tx.meta.err) throw new Error(`${sig}: not served or failed`);
  const day = `${new Date((tx.blockTime as number) * 1000).toISOString().slice(0, 10)}.jsonl`;
  const file = join(evRoot, addr, day);
  if (!existsSync(file)) throw new Error(`${file} missing`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.some((l) => l.startsWith(`{"s":"${sig}"`))) continue;
  const rows = lines.map((l) => JSON.parse(l) as Row);
  // walk sequence: between the neighbours by slot (sequence falls as time goes on, as in the walk)
  const before = rows.filter((r) => r.sl < tx.slot).sort((x, y) => y.sl - x.sl)[0];
  const after = rows.filter((r) => r.sl > tx.slot).sort((x, y) => x.sl - y.sl)[0];
  const q = before && after ? (before.q + after.q) / 2 : (before?.q ?? after?.q ?? 0);
  const row = {
    ...decodeRow(p, tx, { s: sig, q }, 'missing_from_address_index'),
    found: 'block-scan',
  };
  stats.added++;
  if (!DRY) {
    appendFileSync(
      logFile,
      `${JSON.stringify({ pool: addr, day, sig, reason: row.repaired?.reason, old: null, new: row })}\n`,
    );
    writeFileSync(`${file}.tmp`, `${[...lines, JSON.stringify(row)].join('\n')}\n`);
    renameSync(`${file}.tmp`, file);
  }
}
const summary = {
  at: new Date().toISOString(),
  method: METHOD,
  dry: DRY,
  parallel: PARALLEL,
  ...stats,
  rpc: rpcStats,
  log: logFile,
};
if (!DRY) appendFileSync(join(OUT, 'runs.jsonl'), `${JSON.stringify(summary)}\n`);
console.log(JSON.stringify(summary));

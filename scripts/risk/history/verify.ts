import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  chronological,
  compareTickMaps,
  decodeClmmPool,
  decodeClmmTickArray,
  decodeWhirlpool,
  decodeWpTickArray,
  type PoolEvent,
  postState,
  rewind,
  type TickMap,
  tickMapOf,
} from '@colosseum/risk';
import { HISTORY_DIR, type RegistryPool, valuePools } from '../lib-history';

// Step 5b.4 — completeness checks over the fetched history (they decide whether it can be trusted).
//  coverage   every walked successful signature is stored or listed in errors.jsonl
//  vaults     each row's vault pre-balances equal the previous row's post-balances (any missing tx,
//             wrong order, or direct transfer into a vault breaks the chain)
//  chain      CL pools with pool liquidity in events (Raydium CLMM): each liquidity event's "before"
//             equals the previous event's post-state liquidity
//  replay     CL pools: undo events from the newest raw snapshot (~/.colosseum/risk/raw) back to every
//             earlier snapshot; the rebuilt layout must equal it exactly (every tick's net and gross)
// Usage: tsx verify.ts [poolPrefix]  → prints one JSON line per pool, writes verify-<ts>.json
type Row = {
  s: string;
  q: number;
  sl: number;
  t: number;
  ev: PoolEvent[] | null;
  vp: (string | null)[];
  vb: (string | null)[];
  tr?: 1;
  ux?: string[];
};
const RAW = join(homedir(), '.colosseum', 'risk', 'raw');
const FILTER = process.argv[2];

function snapshots(
  p: RegistryPool,
): Array<{ slot: number; at: string; ticks: TickMap; tick: number }> {
  if (!existsSync(RAW)) return [];
  const out: Array<{ slot: number; at: string; ticks: TickMap; tick: number }> = [];
  for (const d of readdirSync(RAW))
    for (const h of readdirSync(join(RAW, d))) {
      const f = join(RAW, d, h, `${p.address}.json.gz`);
      if (!existsSync(f)) continue;
      const j = JSON.parse(gunzipSync(readFileSync(f)).toString()) as {
        slot: number;
        fetchedAt: string;
        head: string;
        children: Record<string, string>;
      };
      const head = new Uint8Array(Buffer.from(j.head, 'base64'));
      const kids = Object.values(j.children).map((b) => new Uint8Array(Buffer.from(b, 'base64')));
      if (p.venue === 'raydium_clmm') {
        const h0 = decodeClmmPool(head);
        const arrays = kids.map(decodeClmmTickArray).filter((a) => a?.pool === p.address);
        out.push({
          slot: j.slot,
          at: j.fetchedAt,
          tick: h0.tickCurrent,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        });
      } else if (p.venue === 'orca_whirlpool') {
        const h0 = decodeWhirlpool(head);
        const arrays = kids
          .map((k) => decodeWpTickArray(k, h0.tickSpacing))
          .filter((a) => a?.pool === p.address);
        out.push({
          slot: j.slot,
          at: j.fetchedAt,
          tick: h0.tickCurrent,
          ticks: tickMapOf(arrays.flatMap((a) => a?.ticks ?? [])),
        });
      }
    }
  return out.sort((a, b) => a.slot - b.slot);
}

const results: Record<string, unknown>[] = [];
for (const p of valuePools().filter((x) => !FILTER || x.address.startsWith(FILTER))) {
  const bydir = join(HISTORY_DIR, 'byday', p.address);
  const evdir = join(HISTORY_DIR, 'events', p.address);
  if (!existsSync(evdir)) {
    results.push({ pool: p.address, status: 'not fetched' });
    console.log(JSON.stringify({ pool: p.address, status: 'not fetched' }));
    continue;
  }
  const days = readdirSync(evdir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, 10))
    .sort();
  const done = days.filter((d) => existsSync(join(evdir, `${d}.done`)));
  let walked = 0;
  for (const d of days)
    walked += readFileSync(join(bydir, `${d}.tsv`), 'utf8')
      .split('\n')
      .filter(Boolean).length;
  let stored = 0;
  let truncated = 0;
  let unknown = 0;
  let vaultBreaks = 0;
  let vaultChecked = 0;
  let chainBreaks = 0;
  let chainChecked = 0;
  const firstBreaks: unknown[] = [];
  const liqRows: Array<{ slot: number; seq: number; events: PoolEvent[] }> = [];
  let prevVb: (string | null)[] | undefined;
  let prevL: bigint | undefined;
  let first: number | undefined;
  let last: number | undefined;
  for (const d of days) {
    const rows = readFileSync(join(evdir, `${d}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row)
      .map((r) => ({ ...r, slot: r.sl, seq: r.q }))
      .sort(chronological);
    stored += rows.length;
    for (const r of rows) {
      first ??= r.t;
      last = r.t;
      if (r.tr) truncated++;
      if (r.ux) unknown++;
      if (prevVb)
        for (const i of [0, 1]) {
          const a = prevVb[i];
          const b = r.vp[i];
          if (a == null || b == null) continue;
          vaultChecked++;
          if (a !== b) {
            vaultBreaks++;
            if (firstBreaks.length < 5)
              firstBreaks.push({
                kind: 'vault',
                vault: i,
                slot: r.sl,
                sig: r.s,
                expected: a,
                got: b,
              });
          }
        }
      if (r.vb.some((x) => x != null)) prevVb = r.vb.map((x, i) => x ?? prevVb?.[i] ?? null);
      for (const e of r.ev ?? []) {
        if (e.kind === 'liquidity' && e.poolLiquidityBefore !== undefined && prevL !== undefined) {
          chainChecked++;
          if (BigInt(e.poolLiquidityBefore) !== prevL) {
            chainBreaks++;
            if (firstBreaks.length < 5)
              firstBreaks.push({
                kind: 'chain',
                slot: r.sl,
                sig: r.s,
                expected: prevL.toString(),
                got: e.poolLiquidityBefore,
              });
          }
        }
        const st = postState(e);
        if (st) prevL = st.liquidity;
      }
      if (r.ev?.some((e) => e.kind === 'liquidity'))
        liqRows.push({ slot: r.sl, seq: r.q, events: r.ev });
    }
  }
  // backward replay between raw snapshots inside the fetched window
  // only snapshots inside the walked window: one taken after the pool's newest walked signature would
  // include changes the history does not have
  const newestSlot = Number(
    readFileSync(join(HISTORY_DIR, 'sigs', p.address, '0000.tsv'), 'utf8').split('\t', 2)[1],
  );
  const snaps = snapshots(p).filter((s) => s.slot <= newestSlot);
  const replay: unknown[] = [];
  const minSlot = Math.min(...liqRows.map((r) => r.slot), Number.POSITIVE_INFINITY);
  if (snaps.length >= 2) {
    const anchor = snaps.at(-1) as (typeof snaps)[number];
    for (const s of snaps.slice(0, -1)) {
      const rebuilt = rewind(anchor.ticks, anchor.slot, liqRows, s.slot);
      const mism = compareTickMaps(s.ticks, rebuilt);
      const between = liqRows.filter((r) => r.slot > s.slot && r.slot <= anchor.slot).length;
      replay.push({
        from: anchor.at,
        to: s.at,
        ticks: s.ticks.size,
        liquidityTxs: between,
        mismatches: mism.length,
        ...(mism.length
          ? {
              firstMismatch: {
                tick: mism[0]?.tick,
                expected: String(mism[0]?.expected?.net),
                got: String(mism[0]?.got?.net),
              },
            }
          : {}),
        coveredByHistory: s.slot >= minSlot || between > 0,
      });
    }
  }
  const row = {
    pool: p.address,
    venue: p.venue,
    asset: p.assetSymbol,
    days: days.length,
    daysDone: done.length,
    walked,
    stored,
    missing: walked - stored,
    window: first
      ? [new Date(first * 1000).toISOString(), new Date((last ?? first) * 1000).toISOString()]
      : null,
    truncated,
    unknownPayloadRows: unknown,
    vaultChecked,
    vaultBreaks,
    chainChecked,
    chainBreaks,
    liquidityTxs: liqRows.length,
    snapshots: snaps.length,
    replay,
    firstBreaks,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(
  join(HISTORY_DIR, `verify-${new Date().toISOString().slice(0, 16).replace(/[:-]/g, '')}.json`),
  JSON.stringify(results, null, 1),
);

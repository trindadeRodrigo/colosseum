// PLAN-ASSETS AS.8, series 3 and 4 on Solana: every swap and liquidity event of the pools of the tracked stocks
// and of every listed or candidate token in the registry, the last 90 days in full and a sampled walk beyond;
// and the mints of those tokens for their whole life (not USDC or USDT: DA15). Through the existing rpc()
// client of scripts/risk/lib-pools.ts; read-only.
//
//   count   an address's transactions over time from anchored pages: getSignaturesForAddress(address,
//           { before: <a signature at time T>, limit }) returns the newest signatures before T, so a page at each
//           of a fixed set of times gives the rate there, and a page shorter than the limit reaches the address's
//           first transaction (`estimateSignatures`). The anchors are signatures of other walks already on disk
//           (the lending history's day files, Step 5b's), chosen by date, never fetched; `before` is honoured
//           by its slot (checked 2026-10-11 on the NVDAx USDC pool: a 2025-09-01 anchor returned its 8
//           signatures of 2025-07-02)
//   fetch   one pool or mint and one window of time: its signatures walked back from the window's end, every
//           successful one fetched with getTransaction and decoded as history-full.ts does (pools), or kept
//           as its token balances and instructions (mints), gzip per UTC day under
//           <out>/solana/<swaps|mints>/<address>/<day>.jsonl.gz with a manifest
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  type AnchoredPage,
  addToManifest,
  BACKFILL_METHOD_VERSION,
  decoders,
  type Manifest,
  type RpcTx,
  tokenBalances,
} from '@colosseum/risk';
import type { RegistryPool } from '../lib-history';
import { gzLines } from './gz-lines';

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
type Sig = { signature: string; slot: number; blockTime: number | null; err: unknown };

/** One anchor: a signature of another walk on disk at a known time. `null` signature: now (no `before`). */
export type Anchor = { at: string; t: number; signature: string | null; from: string };

const tsvLine = (file: string, pick: 'middle' | 'first') => {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const l = pick === 'first' ? lines[0] : lines[Math.floor(lines.length / 2)];
  if (!l) return null;
  const [signature, slot, blockTime] = l.split('\t');
  return { signature: signature as string, slot: Number(slot), t: Number(blockTime) };
};

/**
 * The anchors: now, then every `stepDays` back to `windowDays`, then monthly to `oldest` (ISO date). Each is
 * the middle signature of the lending history's day file of that date (data/risk/lending-history/byday), or of
 * a Step 5b pool's walk for a date after that history ends.
 */
export function anchors(
  dataDir: string,
  nowT: number,
  opts: { windowDays: number; stepDays: number; oldest: string },
): Anchor[] {
  const byday = join(dataDir, 'lending-history', 'byday');
  const days = existsSync(byday)
    ? readdirSync(byday)
        .filter((f) => f.endsWith('.tsv'))
        .sort()
    : [];
  const out: Anchor[] = [
    { at: new Date(nowT * 1000).toISOString(), t: nowT, signature: null, from: 'now' },
  ];
  const want: number[] = [];
  for (let d = opts.stepDays; d <= opts.windowDays; d += opts.stepDays)
    want.push(nowT - d * 86_400);
  const oldest = Date.parse(opts.oldest) / 1000;
  for (let m = 1; ; m++) {
    const dt = new Date((nowT - opts.windowDays * 86_400) * 1000);
    dt.setUTCMonth(dt.getUTCMonth() - m);
    if (dt.getTime() / 1000 < oldest) break;
    want.push(Math.floor(dt.getTime() / 1000));
  }
  want.push(oldest);
  // Step 5b's walk of one pool: its signatures to Oct 6, for a date the lending history does not reach
  const fiveB = join(
    dataDir,
    'history-full',
    'sigs',
    '6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE',
  );
  for (const t of want) {
    const date = new Date(t * 1000).toISOString().slice(0, 10);
    const file = days.find((f) => f >= `${date}.tsv`);
    if (file && file.slice(0, 10) === date) {
      const l = tsvLine(join(byday, file), 'middle');
      if (l)
        out.push({
          at: new Date(l.t * 1000).toISOString(),
          t: l.t,
          signature: l.signature,
          from: `lending-history/byday/${file}`,
        });
      continue;
    }
    if (existsSync(join(fiveB, '0000.tsv'))) {
      // the walk is newest first: the chunk whose lines straddle the date
      for (const f of readdirSync(fiveB)
        .filter((x) => x.endsWith('.tsv'))
        .sort()) {
        const l = tsvLine(join(fiveB, f), 'first');
        if (l && l.t <= t) {
          out.push({
            at: new Date(l.t * 1000).toISOString(),
            t: l.t,
            signature: l.signature,
            from: `history-full/sigs/6truu3rZ…/${f}`,
          });
          break;
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = a.signature ?? 'now';
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Anchors older than the walks on disk: the first signature of the block at the slot a date maps to, from a
 * known slot and time at 0.4 s a slot (a skipped slot tries the next ones). One getBlock a date, signatures
 * only; the anchor's time is the block's own.
 */
export async function blockAnchors(
  rpc: Rpc,
  ref: { slot: number; t: number },
  dates: number[],
): Promise<Anchor[]> {
  const out: Anchor[] = [];
  for (const t of dates) {
    const guess = Math.max(1, Math.round(ref.slot - (ref.t - t) / 0.4));
    for (let k = 0; k < 8; k++) {
      try {
        const b = await rpc<{ blockTime: number | null; signatures?: string[] }>('getBlock', [
          guess + k,
          { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 1 },
        ]);
        const sig = b.signatures?.[0];
        if (!sig || !b.blockTime) continue;
        out.push({
          at: new Date(b.blockTime * 1000).toISOString(),
          t: b.blockTime,
          signature: sig,
          from: `getBlock ${guess + k}`,
        });
        break;
      } catch {
        // a skipped or pruned slot: the next one
      }
    }
  }
  return out;
}

/** One anchored page of an address. */
export async function anchoredPage(rpc: Rpc, address: string, a: Anchor, limit: number) {
  const page = await rpc<Sig[]>('getSignaturesForAddress', [
    address,
    { limit, ...(a.signature ? { before: a.signature } : {}) },
  ]);
  const times = page.map((s) => s.blockTime ?? 0).filter((t) => t > 0);
  const p: AnchoredPage = {
    t: a.t,
    n: page.length,
    newest: times.length ? Math.max(...times) : null,
    oldest: times.length ? Math.min(...times) : null,
    failed: page.filter((s) => s.err).length,
    exhausted: page.length < limit,
  };
  return { page: p, bytes: JSON.stringify(page).length };
}

/** Runs `f` over `items`, `parallel` at a time, in order of results. */
export async function pool<T, R>(items: T[], parallel: number, f: (x: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i] as T, i);
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// fetch

export type FetchSolana = {
  rpc: Rpc;
  out: string;
  kind: 'swaps' | 'mints';
  address: string;
  /** The pool's registry row, for a pool: its venue's decoder and its vaults. */
  pool?: RegistryPool;
  from: number;
  to: number;
  parallel: number;
  source: string;
  now: () => Date;
  /** Continue the walk below this signature (the last one a previous window walked), not from the newest. */
  startBefore?: string;
  /** The sampled walk beyond day 90: keep at most this many successful signatures an hour, the oldest of each. */
  perHour?: number;
};

/** One address over [from, to]: signatures walked back from `to`, each successful one fetched and kept. */
export async function fetchWindow(inp: FetchSolana) {
  const t0 = inp.now().getTime();
  // the walk: newest first, from the first page whose signatures are at or before `to`
  const sigs: Sig[] = [];
  let before: string | undefined = inp.startBefore;
  // the next, older window starts below the oldest signature at or after this window's start: one it kept,
  // or one newer than the window it passed (a window with no signature of its own)
  let cursor: string | undefined;
  let pages = 0;
  let walked = 0;
  /** The walk reached the address's first transaction (a page shorter than its limit). */
  let exhausted = false;
  let emptyBelowCursor = false;
  for (;;) {
    const page = await inp.rpc<Sig[]>('getSignaturesForAddress', [
      inp.address,
      { limit: 1000, ...(before ? { before } : {}) },
    ]);
    pages++;
    walked += page.length;
    if (!page.length) {
      exhausted = true;
      // an empty page below a cursor: the address's first transaction was the last page's, or the endpoint does
      // not hold the cursor; either way the window is not taken as whole (it is asked again)
      if (pages > 1 || inp.startBefore) emptyBelowCursor = true;
      break;
    }
    for (const s of page) {
      const t = s.blockTime ?? 0;
      if (t < inp.from) break;
      cursor = s.signature;
      if (t > inp.to) continue;
      sigs.push(s);
    }
    const last = page.at(-1) as Sig;
    before = last.signature;
    if (page.length < 1000) exhausted = true;
    if ((last.blockTime ?? 0) < inp.from || page.length < 1000) break;
  }
  const walkS = (inp.now().getTime() - t0) / 1000;
  let ok = sigs.filter((s) => !s.err);
  if (inp.perHour) {
    // the walk is newest first: what is left of each hour after the walk passes it is its oldest run
    const byHour = new Map<number, Sig[]>();
    for (const s of ok) {
      const h = Math.floor((s.blockTime ?? 0) / 3600);
      const l = byHour.get(h) ?? [];
      l.push(s);
      if (l.length > inp.perHour) l.shift();
      byHour.set(h, l);
    }
    ok = [...byHour.values()].flat();
  }
  const t1 = inp.now().getTime();
  const decode = inp.pool ? decoders[inp.pool.venue] : undefined;
  let errors = 0;
  let bodyBytes = 0;
  const rows = await pool(ok, inp.parallel, async (s, i) => {
    try {
      const tx = await inp.rpc<RpcTx | null>('getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 1 },
      ]);
      if (!tx?.meta) throw new Error('transaction not served');
      bodyBytes += JSON.stringify(tx).length;
      const t = tx.blockTime ?? s.blockTime ?? 0;
      if (inp.pool && decode) {
        const d = decode(tx, inp.pool.address, { mint0: inp.pool.mint0 });
        const bal = tokenBalances(tx, [inp.pool.vault0, inp.pool.vault1]);
        return {
          s: s.signature,
          q: i,
          sl: tx.slot,
          t,
          ev: d?.events ?? null,
          vp: bal.pre,
          vb: bal.post,
          ix: d?.ix,
          ...(d?.unknown.length ? { ux: d.unknown } : {}),
          ...(d?.truncated ? { tr: 1 } : {}),
        };
      }
      // a mint: the token balances of every account of the mint, before and after, and the logs' instructions
      const meta = tx.meta as unknown as {
        preTokenBalances?: Array<{
          mint: string;
          accountIndex: number;
          uiTokenAmount: { amount: string };
        }>;
        postTokenBalances?: Array<{
          mint: string;
          accountIndex: number;
          uiTokenAmount: { amount: string };
        }>;
        logMessages?: string[];
      };
      const mine = (
        b?: Array<{ mint: string; accountIndex: number; uiTokenAmount: { amount: string } }>,
      ) =>
        (b ?? [])
          .filter((x) => x.mint === inp.address)
          .map((x) => [x.accountIndex, x.uiTokenAmount.amount]);
      return {
        s: s.signature,
        q: i,
        sl: tx.slot,
        t,
        pre: mine(meta.preTokenBalances),
        post: mine(meta.postTokenBalances),
        ix: (meta.logMessages ?? [])
          .map((l) => /^Program log: Instruction: (\w+)/.exec(l)?.[1])
          .filter(Boolean),
      };
    } catch {
      errors++;
      return null;
    }
  });
  const fetchS = (inp.now().getTime() - t1) / 1000;
  const kept = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  const dir = join(inp.out, inp.kind, inp.address);
  mkdirSync(dir, { recursive: true });
  const byDay = new Map<string, typeof kept>();
  for (const r of kept) {
    const d = new Date(r.t * 1000).toISOString().slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const days: Record<string, { rows: number; bytes: number }> = {};
  let rowBytes = 0;
  let gzBytes = 0;
  let duplicates = 0;
  for (const [d, rs] of byDay) {
    const file = join(dir, `${d}.jsonl.gz`);
    // a day file another window already extended: its signatures are not written twice, and the day's
    // count is the file's, not this window's
    const have = new Set<string>();
    if (existsSync(file))
      for (const l of gzLines(readFileSync(file))) have.add((JSON.parse(l) as { s: string }).s);
    const fresh = rs.filter((r) => !have.has(r.s));
    duplicates += rs.length - fresh.length;
    for (const r of fresh) have.add(r.s);
    if (fresh.length) {
      const text = `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`;
      const gz = gzipSync(text);
      writeFileSync(file, gz, { flag: 'a' });
      rowBytes += text.length;
      gzBytes += gz.length;
    }
    days[d] = { rows: have.size, bytes: existsSync(file) ? statSync(file).size : 0 };
  }
  const mp = join(dir, 'manifest.json');
  const m0: Manifest = existsSync(mp)
    ? (JSON.parse(readFileSync(mp, 'utf8')) as Manifest)
    : {
        series: inp.kind === 'swaps' ? 'solana-swaps' : 'solana-mints',
        chain: 'solana',
        subject: inp.address,
        methodVersion: BACKFILL_METHOD_VERSION,
        source: inp.source,
        provenance: 'live',
        covered: [],
        days: {},
        rows: 0,
        bytes: 0,
        checks: [],
        updatedAt: inp.now().toISOString(),
      };
  // a window with a transaction not served is not covered: the next run asks it again (its rows are kept,
  // and not written twice)
  const m = addToManifest(
    m0,
    // a sampled window (--per-hour) or a walk that ended on an empty page below a cursor is never whole
    errors === 0 && !inp.perHour && !emptyBelowCursor
      ? { from: inp.from, to: inp.to, unit: 'second' }
      : null,
    days,
    [
      {
        name: 'every_successful_signature_fetched',
        passed: errors === 0,
        detail: `${kept.length} of ${ok.length} successful signatures fetched (${sigs.length - ok.length} failed ones walked, not fetched)`,
      },
      ...(inp.pool
        ? [
            {
              name: 'vault_balances_chain',
              passed: true,
              detail:
                'pre and post vault balances kept per row (vp, vb): the reserve trace history-full.ts checks',
            },
          ]
        : []),
    ],
    inp.now().toISOString(),
  );
  writeFileSync(mp, `${JSON.stringify(m, null, 1)}\n`);
  return {
    address: inp.address,
    lastSignature: cursor ?? inp.startBefore ?? null,
    window: {
      from: new Date(inp.from * 1000).toISOString(),
      to: new Date(inp.to * 1000).toISOString(),
    },
    pages,
    walked,
    signatures: sigs.length,
    successful: ok.length,
    fetched: kept.length,
    errors,
    covered: errors === 0 && !inp.perHour && !emptyBelowCursor,
    duplicatesDropped: duplicates,
    exhausted,
    walkSeconds: walkS,
    fetchSeconds: fetchS,
    txPerSecond: kept.length / Math.max(0.001, fetchS),
    bodyBytes,
    rowBytes,
    gzBytes,
    gzBytesPerTx: kept.length ? gzBytes / kept.length : null,
    rowBytesPerTx: kept.length ? rowBytes / kept.length : null,
  };
}

/** What the exact pass counted for one address: every signature in the window, by UTC day. */
export type ExactWalk = {
  address: string;
  signatures: number;
  failed: number;
  byDay: Record<string, [number, number]>;
  pages: number;
  seconds: number;
  /** The walk reached the address's first transaction inside the window. */
  exhausted: boolean;
};

/**
 * The exact signature pass (history-full-measure.ts's walk, counting only): every signature of each address
 * from the head back to `from`, 1,000 a page, counted by day and failed or not; nothing is fetched or kept but
 * the counts. It is the first step of the Solana fetch: its count replaces the sampled one before any
 * transaction is asked.
 */
export async function exactWalk(
  rpc: Rpc,
  addresses: string[],
  from: number,
  parallel: number,
  now: () => Date,
  onDone?: (w: ExactWalk) => void,
): Promise<ExactWalk[]> {
  return pool(addresses, parallel, async (address) => {
    const t0 = now().getTime();
    const w: ExactWalk = {
      address,
      signatures: 0,
      failed: 0,
      byDay: {},
      pages: 0,
      seconds: 0,
      exhausted: false,
    };
    let before: string | undefined;
    for (;;) {
      const page = await rpc<Sig[]>('getSignaturesForAddress', [
        address,
        { limit: 1000, ...(before ? { before } : {}) },
      ]);
      w.pages++;
      let past = false;
      for (const s of page) {
        const t = s.blockTime ?? 0;
        if (t < from) {
          past = true;
          break;
        }
        const d = new Date(t * 1000).toISOString().slice(0, 10);
        const c = w.byDay[d] ?? [0, 0];
        c[0]++;
        if (s.err) c[1]++;
        w.byDay[d] = c;
        w.signatures++;
        if (s.err) w.failed++;
      }
      if (page.length < 1000) w.exhausted = true;
      if (past || page.length < 1000) break;
      before = (page.at(-1) as Sig).signature;
    }
    w.seconds = (now().getTime() - t0) / 1000;
    onDone?.(w);
    return w;
  });
}

/** The UTC days of [from, to], newest first, each cut to the window: the pieces a long window is fetched in. */
export function dayPieces(from: number, to: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let d = Math.floor(to / 86_400) * 86_400; d + 86_400 > from; d -= 86_400)
    out.push({ from: Math.max(from, d), to: Math.min(to, d + 86_400 - 1) });
  return out;
}

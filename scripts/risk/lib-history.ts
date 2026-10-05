import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { rpc } from './lib-pools';

// Step 5b — shared pieces of the complete-history fetch for the pools holding 80% of live on-chain TVL.

export const HISTORY_DIR = join(process.env.RISK_DATA_DIR ?? 'data/risk', 'history-full');

export type RegistryPool = {
  address: string;
  venue: string;
  program: string;
  assetSymbol: string;
  quoteSymbol: string | null;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  tvlUsd: number;
  assetMint: string;
  assetIsToken0: number;
  tier: string;
  exitPath: string;
};

export function latestRegistryFile(dir = 'data/risk'): string {
  return join(
    dir,
    readdirSync(dir)
      .filter((n) => n.startsWith('registry-') && n.endsWith('.json') && !n.includes('search'))
      .sort()
      .at(-1) as string,
  );
}

/** The value pools: live (non-dust) pools by tvlUsd, taken until the cumulative share reaches `share`.
 *  Same rule as `retier.ts` (34 pools at 80% on the 2026-10-01 01:39Z registry). */
export function valuePools(share = 0.8, file = latestRegistryFile()): RegistryPool[] {
  const reg = JSON.parse(readFileSync(file, 'utf8')) as { pools: RegistryPool[] };
  const live = reg.pools.filter((p) => p.tier !== 'X').sort((a, b) => b.tvlUsd - a.tvlUsd);
  const total = live.reduce((s, p) => s + p.tvlUsd, 0);
  const out: RegistryPool[] = [];
  let s = 0;
  for (const p of live) {
    if (s >= share * total) break;
    s += p.tvlUsd;
    out.push(p);
  }
  return out;
}

export type SigRow = { signature: string; slot: number; blockTime: number; failed: boolean };
type WalkCursor = {
  before?: string;
  oldestTime?: number;
  newestTime?: number;
  walked: number;
  kept: number;
  failed: number;
  chunk: number;
  bytes: number;
  done: boolean;
  since: number;
};

const CHUNK_ROWS = 100_000;

/** Walk getSignaturesForAddress newest → oldest back to `since` (unix s) and stream every signature to
 *  `sigs/<pool>/<chunk>.tsv` (signature, slot, blockTime, failed). Resumable: the cursor records the
 *  chunk byte length after each page, and a restart truncates any partial append. */
export async function walkSignatures(
  pool: string,
  since: number,
  onPage?: (c: WalkCursor) => void,
): Promise<WalkCursor> {
  const dir = join(HISTORY_DIR, 'sigs', pool);
  mkdirSync(dir, { recursive: true });
  const curFile = join(dir, 'cursor.json');
  const c: WalkCursor = existsSync(curFile)
    ? JSON.parse(readFileSync(curFile, 'utf8'))
    : { walked: 0, kept: 0, failed: 0, chunk: 0, bytes: 0, done: false, since };
  if (c.done && c.since <= since) return c;
  if (c.since > since) c.done = false; // window extended: continue further back
  c.since = since;
  const chunkPath = () => join(dir, `${String(c.chunk).padStart(4, '0')}.tsv`);
  if (existsSync(chunkPath()) && statSync(chunkPath()).size > c.bytes)
    truncateSync(chunkPath(), c.bytes);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsv')))
    if (Number(f.slice(0, 4)) > c.chunk) rmSync(join(dir, f)); // rolled over after the last cursor write
  let rowsInChunk = c.kept % CHUNK_ROWS;
  while (!c.done) {
    const page = await rpc<
      Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>
    >('getSignaturesForAddress', [
      pool,
      { limit: 1000, ...(c.before ? { before: c.before } : {}) },
    ]);
    if (!page.length) {
      c.done = true;
      break;
    }
    let lines = '';
    for (const sg of page) {
      c.walked++;
      const t = sg.blockTime ?? 0;
      if (t && t < since) {
        c.done = true;
        break;
      }
      lines += `${sg.signature}\t${sg.slot}\t${t}\t${sg.err ? 1 : 0}\n`;
      c.kept++;
      if (sg.err) c.failed++;
      c.newestTime ??= t;
      c.oldestTime = t || c.oldestTime;
      rowsInChunk++;
      if (rowsInChunk >= CHUNK_ROWS) {
        appendFileSync(chunkPath(), lines);
        lines = '';
        c.chunk++;
        c.bytes = 0;
        rowsInChunk = 0;
      }
    }
    if (lines) appendFileSync(chunkPath(), lines);
    c.bytes = existsSync(chunkPath()) ? statSync(chunkPath()).size : 0;
    c.before = page.at(-1)?.signature;
    writeFileSync(curFile, JSON.stringify(c));
    onPage?.(c);
  }
  writeFileSync(curFile, JSON.stringify(c));
  return c;
}

/** Stream a pool's walked signatures, newest first (walk order). */
export function* readSignatures(pool: string): Generator<SigRow> {
  const dir = join(HISTORY_DIR, 'sigs', pool);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.tsv'))
    .sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      const [signature, slot, blockTime, failed] = line.split('\t');
      yield {
        signature: signature as string,
        slot: Number(slot),
        blockTime: Number(blockTime),
        failed: failed === '1',
      };
    }
  }
}

/** Append-only JSONL writer that keeps file descriptors open per path. */
export class JsonlSink {
  private fds = new Map<string, number>();
  write(path: string, row: unknown) {
    let fd = this.fds.get(path);
    if (fd === undefined) {
      mkdirSync(join(path, '..'), { recursive: true });
      fd = openSync(path, 'a');
      this.fds.set(path, fd);
    }
    appendFileSync(fd, `${JSON.stringify(row)}\n`);
  }
  close() {
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
  }
}

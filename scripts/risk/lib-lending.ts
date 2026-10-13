import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestRegistryFile, type RegistryPool } from './lib-history';
import { rpc } from './lib-pools';

// Step 10b — shared pieces of the lending-pool ingestion (measure, registry, history).
// New code beside lib-history.ts: nothing exported there changes behaviour.

export const LENDING_DATA = process.env.RISK_DATA_DIR ?? 'data/risk';
export const LENDING_MEASURE_DIR = join(LENDING_DATA, 'lending-measure');
export const LENDING_HISTORY_DIR = join(LENDING_DATA, 'lending-history');
/** PLAN-ANALYTICS item 18.1: the split snapshots (`split-0.1`), written by split-snapshot.ts, read by the cost
 * breakdown and the fixture freezer; with RISK_SPLIT_TWO_HOP=1 the `split-0.2` rows go to the two-hop folder inside
 * it, which the readers do not list. Follows RISK_DATA_DIR so the hourly job (DA8) and hand runs agree. */
export const SPLIT_DIR = join(LENDING_DATA, 'split');
export const RISK_HOME = process.env.RISK_HOME ?? join(homedir(), '.colosseum', 'risk');
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EH5LxbDByQKnNxFnEqZn';

/** Every xStock in the DEX registry: mint → symbol. */
export function registryAssets(file = latestRegistryFile()): Map<string, string> {
  const reg = JSON.parse(readFileSync(file, 'utf8')) as { pools: RegistryPool[] };
  return new Map(reg.pools.map((p) => [p.assetMint, p.assetSymbol]));
}

/** All DEX pool vault token accounts in the registry (for classifying holders). */
export function registryVaults(file = latestRegistryFile()): Map<string, string> {
  const reg = JSON.parse(readFileSync(file, 'utf8')) as { pools: RegistryPool[] };
  const out = new Map<string, string>();
  for (const p of reg.pools) {
    out.set(p.vault0, `${p.venue}:${p.address}`);
    out.set(p.vault1, `${p.venue}:${p.address}`);
  }
  return out;
}

/** Latest hourly API rows written by the pool collector's `snapshotMarkets` (the independent cross-check). */
export function latestMarketRows(): Array<
  Record<string, unknown> & { account: string; fetchedAt: string }
> {
  const dir = join(RISK_HOME, 'markets');
  const file = readdirSync(dir).sort().at(-1) as string;
  const rows = readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown> & { account: string; fetchedAt: string });
  const last = rows.filter((r) => r.account).at(-1)?.fetchedAt;
  return rows.filter((r) => r.fetchedAt === last && r.account);
}

export function measureLog(row: Record<string, unknown>) {
  mkdirSync(LENDING_DATA, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...row });
  console.log(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
  appendFileSync(join(LENDING_DATA, 'lending-measure.jsonl'), `${line}\n`);
}

export function saveMeasure(name: string, value: unknown) {
  mkdirSync(LENDING_MEASURE_DIR, { recursive: true });
  writeFileSync(
    join(LENDING_MEASURE_DIR, `${name}.json`),
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1),
  );
}

export function loadMeasure<T>(name: string): T {
  return JSON.parse(readFileSync(join(LENDING_MEASURE_DIR, `${name}.json`), 'utf8')) as T;
}

export type RpcAccount = { pubkey: string; owner: string; data: Uint8Array; lamports: number };

/** getProgramAccounts with filters and an optional data slice; backoff is in `rpc()`. */
export async function programAccounts(
  program: string,
  filters: unknown[],
  dataSlice?: { offset: number; length: number },
): Promise<RpcAccount[]> {
  const r = await rpc<
    Array<{
      pubkey: string;
      account: { owner: string; lamports: number; data: [string, string] };
    }>
  >('getProgramAccounts', [
    program,
    { encoding: 'base64', filters, ...(dataSlice ? { dataSlice } : {}) },
  ]);
  return r.map((a) => ({
    pubkey: a.pubkey,
    owner: a.account.owner,
    lamports: a.account.lamports,
    data: new Uint8Array(Buffer.from(a.account.data[0], 'base64')),
  }));
}

/** getMultipleAccounts in batches of 100, with the context slot of the last batch. */
export async function multipleAccounts(
  keys: string[],
): Promise<{ slot: number; accounts: Map<string, { owner: string; data: Uint8Array } | null> }> {
  const accounts = new Map<string, { owner: string; data: Uint8Array } | null>();
  let slot = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const r = await rpc<{
      context: { slot: number };
      value: Array<{ owner: string; data: [string, string] } | null>;
    }>('getMultipleAccounts', [batch, { encoding: 'base64' }]);
    slot = r.context.slot;
    r.value.forEach((v, k) => {
      accounts.set(
        batch[k] as string,
        v ? { owner: v.owner, data: new Uint8Array(Buffer.from(v.data[0], 'base64')) } : null,
      );
    });
  }
  return { slot, accounts };
}

/** SPL token account amount (raw) and owner from account bytes (Token and Token-2022 share the base layout). */
export const tokenAccount = (data: Uint8Array) => {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { amount: v.getBigUint64(64, true) };
};

export type WalkCursor = {
  before?: string;
  oldestTime?: number;
  newestTime?: number;
  firstSignature?: string;
  walked: number;
  kept: number;
  failed: number;
  chunk: number;
  bytes: number;
  done: boolean;
  since: number;
};
const CHUNK_ROWS = 100_000;

/**
 * Same checkpointed walk as `walkSignatures` in lib-history.ts (Step 5b), with the output directory as a
 * parameter: getSignaturesForAddress newest → oldest back to `since` (0 = the address's first transaction),
 * every signature streamed to `<dir>/sigs/<address>/<chunk>.tsv`. Resumable.
 */
export async function walkAddress(
  dir: string,
  address: string,
  since: number,
  onPage?: (c: WalkCursor) => void,
): Promise<WalkCursor> {
  const d = join(dir, 'sigs', address);
  mkdirSync(d, { recursive: true });
  const curFile = join(d, 'cursor.json');
  const c: WalkCursor = existsSync(curFile)
    ? JSON.parse(readFileSync(curFile, 'utf8'))
    : { walked: 0, kept: 0, failed: 0, chunk: 0, bytes: 0, done: false, since };
  if (c.done && c.since <= since) return c;
  if (c.since > since) c.done = false;
  c.since = since;
  const chunkPath = () => join(d, `${String(c.chunk).padStart(4, '0')}.tsv`);
  if (existsSync(chunkPath()) && statSync(chunkPath()).size > c.bytes)
    truncateSync(chunkPath(), c.bytes);
  for (const f of readdirSync(d).filter((n) => n.endsWith('.tsv')))
    if (Number(f.slice(0, 4)) > c.chunk) rmSync(join(d, f));
  let rowsInChunk = c.kept % CHUNK_ROWS;
  while (!c.done) {
    const page = await rpc<
      Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>
    >('getSignaturesForAddress', [
      address,
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
      if (since && t && t < since) {
        c.done = true;
        break;
      }
      lines += `${sg.signature}\t${sg.slot}\t${t}\t${sg.err ? 1 : 0}\n`;
      c.kept++;
      if (sg.err) c.failed++;
      c.newestTime ??= t;
      c.oldestTime = t || c.oldestTime;
      c.firstSignature = sg.signature;
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

export type SigRow = { signature: string; slot: number; blockTime: number; failed: boolean };

/** Stream an address's walked signatures, newest first. */
export function* readAddressSignatures(dir: string, address: string): Generator<SigRow> {
  const d = join(dir, 'sigs', address);
  if (!existsSync(d)) return;
  for (const f of readdirSync(d)
    .filter((n) => n.endsWith('.tsv'))
    .sort()) {
    for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
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

/** Current slot duration (ms) from the last 30 performance samples (about 30 minutes). */
export async function measuredSlotMs(): Promise<number> {
  const s = await rpc<Array<{ numSlots: number; samplePeriodSecs: number }>>(
    'getRecentPerformanceSamples',
    [30],
  );
  const slots = s.reduce((a, x) => a + x.numSlots, 0);
  const secs = s.reduce((a, x) => a + x.samplePeriodSecs, 0);
  return slots ? (1000 * secs) / slots : 400;
}

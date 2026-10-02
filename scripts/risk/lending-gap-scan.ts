import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { LENDING_HISTORY_DIR, measureLog } from './lib-lending';
import { rpc, rpcStats } from './lib-pools';

// Step 10b item 6 — locate a vault-balance chain break that the signature walks cannot explain. Reads every block
// in (fromSlot, toSlot) with getBlock (transactionDetails `accounts`: account keys, lookup-table addresses
// included, and token balances) and lists each transaction that touches one of the given accounts, with its
// pre/post token balance on them. Skipped slots are counted. Read-only; PARALLEL getBlock at a time.
// Output: `<dir>/gaps/scan-<fromSlot>-<toSlot>.json` and one line in data/risk/lending-measure.jsonl.
// --add: each successful transaction found is fetched (getTransaction, as the history fetch does) and appended to
// `<dir>/raw/<day>.jsonl.gz` with every walked address it touches (static or lookup-table keys), flagged
// `found: 'block-scan'`, and listed in `<dir>/gaps/found.jsonl`; the decode pass and the checks then include it.
// Idempotent: a signature already in found.jsonl is not added again.
// Usage: tsx lending-gap-scan.ts <fromSlot> <toSlot> <account>[,<account>…] [parallel=16] [--add]
const ADD = process.argv.includes('--add');
const [fromArg, toArg, accArg, parArg] = process.argv.slice(2).filter((a) => a !== '--add');
if (!fromArg || !toArg || !accArg)
  throw new Error('usage: lending-gap-scan.ts <fromSlot> <toSlot> <account,…> [parallel]');
const FROM = Number(fromArg);
const TO = Number(toArg);
const ACCOUNTS = new Set(accArg.split(','));
const PARALLEL = Number(parArg ?? 16);
const t0 = Date.now();

type Key = { pubkey: string; source?: string };
type TokenBal = { accountIndex: number; mint: string; uiTokenAmount: { amount: string } };
type BlockTx = {
  transaction: { signatures: string[]; accountKeys: Key[] };
  meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
};
type Block = { blockTime: number | null; transactions: BlockTx[] };

const hits: Array<Record<string, unknown>> = [];
let blocks = 0;
let skipped = 0;
let txs = 0;
const failures: Array<{ slot: number; error: string }> = [];
const slots = Array.from({ length: TO - FROM - 1 }, (_, i) => FROM + 1 + i);
let next = 0;
async function worker() {
  while (next < slots.length) {
    const slot = slots[next++] as number;
    let b: Block | null;
    try {
      b = await rpc<Block | null>('getBlock', [
        slot,
        {
          encoding: 'json',
          transactionDetails: 'accounts',
          maxSupportedTransactionVersion: 0,
          rewards: false,
        },
      ]);
    } catch (e) {
      const msg = String((e as Error).message);
      // -32007 / -32009: slot skipped or missing in long-term storage
      if (/-3200[79]|skipped|not available/i.test(msg)) skipped++;
      else failures.push({ slot, error: msg.slice(0, 300) });
      continue;
    }
    if (!b) {
      skipped++;
      continue;
    }
    blocks++;
    for (const t of b.transactions) {
      txs++;
      const keys = t.transaction.accountKeys.map((k) => k.pubkey);
      const touched = keys.flatMap((k, i) => (ACCOUNTS.has(k) ? [{ k, i }] : []));
      if (!touched.length) continue;
      const bal = (xs: TokenBal[] | undefined, i: number) =>
        xs?.find((x) => x.accountIndex === i)?.uiTokenAmount.amount ?? null;
      hits.push({
        slot,
        blockTime: b.blockTime,
        signature: t.transaction.signatures[0],
        failed: t.meta?.err != null,
        accounts: touched.map(({ k, i }) => ({
          account: k,
          source: t.transaction.accountKeys[i]?.source ?? null,
          pre: bal(t.meta?.preTokenBalances, i),
          post: bal(t.meta?.postTokenBalances, i),
        })),
      });
    }
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
hits.sort((a, b) => (a.slot as number) - (b.slot as number));

const out = {
  source: 'Solana RPC getBlock (Chainstack archive)',
  method: 'lending-gap-scan-0.1',
  fetched_at: new Date().toISOString(),
  provenance: 'live',
  fromSlot: FROM,
  toSlot: TO,
  accounts: [...ACCOUNTS],
  slotsScanned: slots.length,
  blocks,
  skipped,
  txs,
  failures,
  hits,
  rpc: { ...rpcStats },
  secs: Math.round((Date.now() - t0) / 1000),
};
const dir = join(LENDING_HISTORY_DIR, 'gaps');
mkdirSync(dir, { recursive: true });
const file = join(dir, `scan-${FROM}-${TO}.json`);
writeFileSync(file, JSON.stringify(out, null, 1));
measureLog({
  vl: 'gap-scan',
  command: `tsx scripts/risk/lending-gap-scan.ts ${process.argv.slice(2).join(' ')}`,
  value: { ...out, hits: hits.length, failures: failures.length, file },
});
for (const h of hits) console.log(JSON.stringify(h));

if (ADD) {
  const DIR = LENDING_HISTORY_DIR;
  const foundFile = join(dir, 'found.jsonl');
  const have = new Set(
    existsSync(foundFile)
      ? readFileSync(foundFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { signature: string }).signature)
      : [],
  );
  const addrs = JSON.parse(readFileSync(join(DIR, 'addresses.json'), 'utf8')) as Array<{
    i: number;
    address: string;
  }>;
  const index = new Map(addrs.map((a) => [a.address, a.i]));
  for (const h of hits) {
    const sig = h.signature as string;
    if (h.failed || have.has(sig)) continue;
    const tx = await rpc<{
      meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
      transaction: { message: { accountKeys: string[] } };
    } | null>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 1 }]);
    if (!tx?.meta) throw new Error(`transaction not served: ${sig}`);
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const a = [...new Set(keys.flatMap((k) => (index.has(k) ? [index.get(k) as number] : [])))];
    const t = h.blockTime as number;
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    const row = { s: sig, sl: h.slot, t, a, found: 'block-scan', tx };
    appendFileSync(join(DIR, 'raw', `${day}.jsonl.gz`), gzipSync(`${JSON.stringify(row)}\n`));
    const f = {
      signature: sig,
      slot: h.slot,
      blockTime: t,
      day,
      a,
      addresses: a.map((i) => addrs[i]?.address),
      foundBy: file,
      source: out.source,
      method: out.method,
      fetched_at: new Date().toISOString(),
      provenance: 'live',
    };
    appendFileSync(foundFile, `${JSON.stringify(f)}\n`);
    console.log(JSON.stringify({ added: sig, day, addresses: a.length }));
  }
}

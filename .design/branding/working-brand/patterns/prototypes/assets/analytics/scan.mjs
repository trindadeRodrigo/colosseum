#!/usr/bin/env node
// Wallet check for the snapshot (D13: no wallet reaches the page or the snapshot).
// Finds every base58 string of 32–44 characters in snapshot/*.json, standalone or inside text, and classifies it
// by the field that carries it. Anything not a pool, a lending or market account, a token mint, a program or an
// oracle feed is printed as UNKNOWN, with its file and field, and the script exits 1.
//   node scan.mjs
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshot');
const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const KIND = {
  address: 'pool', pool: 'pool', account: 'lending or market account', market: 'lending market account',
  assetMint: 'token mint', quoteMint: 'token mint', quote: 'token mint', mint: 'token mint', assetId: 'token mint',
  program: 'program', scopePriceFeed: 'oracle feed', oracle: 'oracle feed',
};
const found = new Map();
const unknown = [];
function walk(v, key, file) {
  if (typeof v === 'string') {
    for (const m of v.match(B58) || []) {
      const kind = KIND[key] || null;
      const k = found.get(m) || { kinds: new Set(), n: 0 };
      k.kinds.add(kind || `in ${key}`); k.n++; found.set(m, k);
      if (!kind) unknown.push({ value: m, file, key, text: v.slice(0, 120) });
    }
  } else if (Array.isArray(v)) v.forEach((x) => walk(x, key, file));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, file);
}
for (const f of await readdir(DIR)) walk(JSON.parse(await readFile(join(DIR, f), 'utf8')), '', f);
const byKind = {};
for (const [, k] of found) for (const kind of k.kinds) byKind[kind] = (byKind[kind] || 0) + 1;
console.log('distinct base58 strings:', found.size);
console.log('by field:', byKind);
// Strings found inside text fields: show each distinct one once, with where it sits, so a person can judge it.
const seen = new Set();
for (const u of unknown) if (!seen.has(u.value)) { seen.add(u.value); console.log('UNKNOWN', u.value, 'in', u.key, '·', u.file, '·', JSON.stringify(u.text)); }
const pools = new Set([...found].filter(([, k]) => k.kinds.has('pool')).map(([v]) => v));
const known = new Set([...found].filter(([, k]) => [...k.kinds].some((x) => !x.startsWith('in '))).map(([v]) => v));
const truly = [...seen].filter((v) => !known.has(v));
console.log(`${seen.size} found inside other fields; ${truly.length} not also seen as a pool, account, mint, program or feed`);
process.exit(truly.length ? 1 : 0);

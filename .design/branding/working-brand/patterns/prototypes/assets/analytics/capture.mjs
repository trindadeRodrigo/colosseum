#!/usr/bin/env node
// Captures the snapshot the analytics view falls back to when the risk API does not answer.
// Every route the page reads, once, as JSON under snapshot/, with manifest.json mapping the exact request
// (path + query, or "POST path body") to its file and carrying captured_at.
//   node capture.mjs [apiBase]        default http://localhost:3011
// Keys must match the request strings built in ../analytics.js (the R.* route builders).
// Wallets: none are captured. scan.mjs checks every file for base58 strings that are not a displayed pool,
// a lending or market account, a token mint or a program.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = (process.argv[2] || 'http://localhost:3011').replace(/\/$/, '');
const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, 'snapshot');
const SIZES = [10000, 50000, 100000, 250000];
const TAUS = [0.005, 0.01, 0.02];
const REGIMES = ['us_market_hours', 'us_offhours_weekday', 'weekend', 'us_holiday'];
const GAPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
/** Registry assets that are not stocks: shown with their reasons until item 17 measures them. */
const OTHER = ['usdy', 'syrupusdc', 'usdt', 'kamino-usdc'];

const fileFor = (key) =>
  key.replace(/^POST /, 'post_').replace(/^\//, '').replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 180) + '.json';

const files = {};
const failed = [];
async function take(key) {
  const post = key.startsWith('POST ');
  const path = post ? key.slice(5, key.indexOf(' {')) : key;
  const body = post ? key.slice(key.indexOf(' {') + 1) : null;
  const res = await fetch(API + path, post ? { method: 'POST', headers: { 'content-type': 'application/json' }, body } : undefined);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { failed.push([key, res.status, 'not json']); return null; }
  // Discovery figures from an off-chain aggregator are never shown (on-chain measurement only): not kept either.
  if (json && Array.isArray(json.pools)) for (const p of json.pools) { delete p.discoveryVolume24hUsd; delete p.discoveryLiquidityUsd; }
  const f = fileFor(key);
  await writeFile(join(OUT, f), JSON.stringify({ status: res.status, body: json }));
  files[key] = f;
  if (!res.ok) failed.push([key, res.status, json && json.error]);
  return res.ok ? json : null;
}
async function pool(keys, n = 6) {
  const q = keys.slice();
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await take(q.shift()); }));
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const t0 = new Date();

const assets = await take('/risk/assets?tau=0.01');
if (!assets) throw new Error(`the API at ${API} did not answer /risk/assets`);
await pool(TAUS.filter((t) => t !== 0.01).map((t) => `/risk/assets?tau=${t}`));
const stocks = assets.assets.map((a) => a.symbol);
const lending = await take('/risk/facts/lending');
const markets = await take('/risk/markets');
await pool(['/risk/facts/methodology', '/risk/pools']);

const keys = [];
const e = encodeURIComponent;
for (const s of [...stocks, ...OTHER]) for (const n of SIZES) keys.push(`/risk/facts/assets/${e(s)}?sizeUsd=${n}`);
for (const s of stocks) {
  keys.push(`/risk/pools?asset=${e(s)}`, `/risk/assets/${e(s)}/lp`);
  for (const r of REGIMES) keys.push(`/risk/assets/${e(s)}/depth?side=sell&regime=${r}`, `/risk/assets/${e(s)}/depth?side=buy&regime=${r}`);
  keys.push(`/risk/assets/${e(s)}/history?days=7&tau=0.01`, `/risk/assets/${e(s)}/prices?days=365`, `/risk/assets/${e(s)}/prices?days=31`);
  for (const n of SIZES) {
    keys.push(`/risk/assets/${e(s)}/heatmap?notional=${n}`);
    keys.push(`/risk/assets/${e(s)}/score?tau=0.01&nRef=${n}&hours=72`);
  }
}
const collateral = new Set();
for (const p of lending.pools) {
  const sheet = await take(`/risk/facts/lending/${p.account}`);
  for (const c of (sheet && sheet.collateral) || []) collateral.add(c.asset);
}
for (const a of collateral) keys.push(`/risk/lending/coverage?asset=${e(a)}`);
for (const p of lending.pools) keys.push(`/risk/facts/lending/${e(p.account)}/history?days=365`);
// the liquidity distribution of each stock's largest concentrated-liquidity pool (the page's default choice)
const allPools = await (await fetch(API + '/risk/pools')).json();
const largest = {};
for (const p of allPools.pools || []) if (/clmm|whirlpool|dlmm/.test(p.venue) && (!largest[p.assetSymbol] || (p.tvlUsd || 0) > (largest[p.assetSymbol].tvlUsd || 0))) largest[p.assetSymbol] = p;
for (const s of stocks) if (largest[s]) keys.push(`/risk/pools/${e(largest[s].address)}/liquidity?bands=60&rangePct=0.3`);
for (const m of markets.markets) for (const g of GAPS) keys.push(`POST /risk/markets/${m.account}/gap ${JSON.stringify({ gapPct: g })}`);
await pool(keys);

const manifest = {
  captured_at: t0.toISOString(),
  finished_at: new Date().toISOString(),
  api: API,
  note: 'Snapshot of the risk API for the analytics view. Measured figures, only old: the page shows them stale, never MOCK.',
  routes: Object.keys(files).length,
  failed,
  files,
};
await writeFile(join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
const n = (await readdir(OUT)).length;
console.log(`captured ${n} files at ${manifest.captured_at}; ${failed.length} answered with an error (kept: the page shows the reason)`);

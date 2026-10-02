import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  assetRowObservation,
  hourlyPoolRowObservation,
  type LoggedPriceContext,
  lendingRowObservation,
  loggedOraclePrices,
  type PriceObservation,
  type RpcTx,
} from '@colosseum/risk';
import { HISTORY_DIR, latestRegistryFile, type RegistryPool, valuePools } from '../lib-history';
import { LENDING_HISTORY_DIR, RISK_HOME, USDC } from '../lib-lending';
import {
  dayOf,
  OBS_DIR,
  PRICES_DIR,
  PRICES_METHOD_VERSION,
  readJsonl,
  type StoredObservation,
  writeObservations,
} from './lib';

// Step 11 item 1 — price observations from data already on disk. It never fetches.
//   logged  the oracle prices klend logged and the Jupiter Lend oracle returned, from the lending history's raw
//           bodies (`data/risk/lending-history/raw/<day>.jsonl.gz`); a day already written is skipped unless --force
//   pools   Step 5b's hourly mid of each asset's reference USDC pool (the first USDC value pool by TVL holding the
//           hour, the rule lending-reconstruct used)
//   live    the collectors' 5-minute rows: Scope feed and Jupiter Lend cache prices, and the reference pool mid
// Output: data/risk/prices/obs/<priceSource>/<method>/<day>.jsonl.gz and data/risk/prices/extract-summary.json.
// Usage: tsx scripts/risk/prices/extract.ts [--only=logged|pools|live] [--day=YYYY-MM-DD] [--force]
const argv = process.argv.slice(2);
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7);
const DAY = argv.find((a) => a.startsWith('--day='))?.slice(6);
const FORCE = argv.includes('--force');
const fetchedAt = new Date().toISOString();
mkdirSync(PRICES_DIR, { recursive: true });
const want = (m: string) => !ONLY || ONLY === m;
const stored = (o: PriceObservation, source: string): StoredObservation => ({
  ...o,
  source,
  fetchedAt,
  methodVersion: PRICES_METHOD_VERSION,
  provenance: 'live',
});
const summaryFile = join(PRICES_DIR, 'extract-summary.json');
const summary: Record<string, unknown> = existsSync(summaryFile)
  ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as Record<string, unknown>)
  : {};
const t0 = Date.now();

type LendingRow = {
  account: string;
  venue: string;
  market: string;
  mint: string | null;
  symbol: string | null;
};
const lreg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: LendingRow[];
};

// ------------------------------------------------------------------------------------------------- logged
if (want('logged')) {
  const SOURCE =
    'lending history raw bodies (Solana RPC getTransaction), program logs and return data';
  const ctx: LoggedPriceContext = {
    kaminoReserves: new Map(
      lreg.rows
        .filter((r) => r.venue === 'kamino' && r.symbol && r.mint)
        .map((r) => [
          r.account,
          { symbol: r.symbol as string, mint: r.mint as string, market: r.market },
        ]),
    ),
  };
  const jlVaults = new Set(
    lreg.rows.filter((r) => r.venue === 'jupiter_lend').map((r) => r.account),
  );
  const RAW = join(LENDING_HISTORY_DIR, 'raw');
  const days = readdirSync(RAW)
    .filter((f) => f.endsWith('.jsonl.gz'))
    .map((f) => f.slice(0, 10))
    .filter((d) => (DAY ? d === DAY : existsSync(join(RAW, `${d}.done`))))
    .sort();
  const s = {
    method: 'klend_refresh_log + jl_oracle_return',
    source: SOURCE,
    extractedAt: fetchedAt,
    days: 0,
    daysSkipped: 0,
    txs: 0,
    txsFailed: 0,
    txsUnaligned: 0,
    kaminoOutsideRegistry: 0,
    kaminoAmbiguous: 0,
    jlOutsideRegistry: 0,
    jlSecondRateDiffers: 0,
    failedCheckLines: 0,
    observations: { kamino_scope: 0, jupiter_lend_oracle: 0 } as Record<string, number>,
    first: {} as Record<string, string>,
  };
  type Row = { s: string; sl: number; t: number; tx: RpcTx };
  for (const day of days) {
    const outK = join(OBS_DIR, 'kamino_scope', 'klend_refresh_log', `${day}.jsonl.gz`);
    if (!FORCE && !DAY && existsSync(outK)) {
      s.daysSkipped++;
      continue;
    }
    let text: string;
    try {
      text = gunzipSync(readFileSync(join(RAW, `${day}.jsonl.gz`))).toString('utf8');
    } catch {
      s.daysSkipped++;
      continue;
    }
    const by = new Map<string, StoredObservation[]>();
    const seen = new Map<string, StoredObservation>();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line) as Row;
      s.txs++;
      if (!r.tx?.meta || r.tx.meta.err) {
        s.txsFailed++;
        continue;
      }
      const d = loggedOraclePrices(r.tx, ctx);
      if (!d.aligned) {
        s.txsUnaligned++;
        continue;
      }
      s.kaminoOutsideRegistry += d.outside;
      s.kaminoAmbiguous += d.ambiguous;
      const t = r.tx.blockTime ?? r.t;
      for (const p of d.prices) {
        if (p.priceSource === 'jupiter_lend_oracle' && !jlVaults.has(p.ref)) {
          s.jlOutsideRegistry++;
          continue;
        }
        if (p.secondPrice !== undefined) s.jlSecondRateDiffers++;
        if (p.failedChecks) s.failedCheckLines++;
        // one row per reserve or vault, slot and price; a failed check on any of them stays on the row
        const k = `${p.ref}|${r.tx.slot}|${p.price}`;
        const prev = seen.get(k);
        if (prev) {
          if (p.failedChecks)
            prev.failedChecks = [
              ...new Set([...(prev.failedChecks ?? []), ...p.failedChecks]),
            ].sort();
          continue;
        }
        const method = p.priceSource === 'kamino_scope' ? 'klend_refresh_log' : 'jl_oracle_return';
        const key = `${p.priceSource}|${method}`;
        const arr = by.get(key) ?? [];
        const row = stored(
          {
            chain: 'solana',
            mint: p.mint,
            priceSource: p.priceSource,
            t,
            slot: r.tx.slot,
            price: p.price,
            quote: p.quote,
            ref: p.ref,
            market: p.market,
            method,
            ...(p.failedChecks ? { failedChecks: p.failedChecks } : {}),
          },
          SOURCE,
        );
        seen.set(k, row);
        arr.push(row);
        by.set(key, arr);
        s.observations[p.priceSource] = (s.observations[p.priceSource] ?? 0) + 1;
        const f = s.first[p.priceSource];
        const iso = new Date(t * 1000).toISOString();
        if (!f || iso < f) s.first[p.priceSource] = iso;
      }
    }
    // a raw day file holds that day's transactions; keep the file name so a re-run replaces it
    writeObservations(
      'kamino_scope',
      'klend_refresh_log',
      day,
      by.get('kamino_scope|klend_refresh_log') ?? [],
    );
    const jl = by.get('jupiter_lend_oracle|jl_oracle_return') ?? [];
    if (jl.length) writeObservations('jupiter_lend_oracle', 'jl_oracle_return', day, jl);
    s.days++;
    if (s.days % 25 === 0)
      console.log(
        `${day}  days ${s.days}/${days.length}  txs ${s.txs}  obs ${JSON.stringify(s.observations)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
  }
  summary.logged = s;
  console.log('logged', JSON.stringify(s));
}

// ------------------------------------------------------------------------------------------------- pools
if (want('pools')) {
  const SOURCE = 'Step 5b hourly pool reconstruction (data/risk/history-full/hourly)';
  const hourlyDir = join(HISTORY_DIR, 'hourly');
  const usdcPools = valuePools(0.8, latestRegistryFile())
    .filter((p: RegistryPool) => p.mint0 === USDC || p.mint1 === USDC)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
  const taken = new Set<string>();
  const by = new Map<string, StoredObservation[]>();
  let n = 0;
  for (const p of usdcPools) {
    const f = join(hourlyDir, `${p.address}.jsonl`);
    if (!existsSync(f)) continue;
    for (const r of readJsonl<Record<string, unknown>>(f)) {
      const o = hourlyPoolRowObservation(r, p.assetMint);
      if (!o || taken.has(`${o.mint}|${o.t}`)) continue;
      taken.add(`${o.mint}|${o.t}`);
      const d = dayOf(o.t);
      const arr = by.get(d) ?? [];
      arr.push(stored(o, SOURCE));
      by.set(d, arr);
      n++;
    }
  }
  for (const [d, rows] of by) writeObservations('pool_mid', 'pool_hourly_mid', d, rows);
  summary.pools = { source: SOURCE, extractedAt: fetchedAt, observations: n, days: by.size };
  console.log('pools', JSON.stringify(summary.pools));
}

// ------------------------------------------------------------------------------------------------- live
if (want('live')) {
  const count: Record<string, number> = {};
  const put = (
    file: string,
    source: string,
    map: (r: Record<string, unknown>) => PriceObservation | null,
  ) => {
    const by = new Map<string, StoredObservation[]>();
    for (const r of readJsonl<Record<string, unknown>>(file)) {
      const o = map(r);
      if (!o) continue;
      const k = `${o.priceSource}|${o.method}`;
      const arr = by.get(k) ?? [];
      arr.push(stored(o, source));
      by.set(k, arr);
    }
    return by;
  };
  for (const [dir, source, map] of [
    [
      'lending',
      'risk-lending collector rows (Solana RPC getMultipleAccounts)',
      lendingRowObservation,
    ],
    ['assets', 'risk-pools collector asset rows (Solana RPC pool reads)', assetRowObservation],
  ] as const) {
    const d = join(RISK_HOME, dir);
    for (const f of readdirSync(d)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort()) {
      const day = f.slice(0, 10);
      if (DAY && day !== DAY) continue;
      for (const [k, rows] of put(join(d, f), source, map)) {
        const [ps, method] = k.split('|') as [PriceObservation['priceSource'], string];
        writeObservations(ps, method, day, rows);
        count[k] = (count[k] ?? 0) + rows.length;
      }
    }
  }
  summary.live = { extractedAt: fetchedAt, observations: count };
  console.log('live', JSON.stringify(summary.live));
}

writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${OBS_DIR}`);

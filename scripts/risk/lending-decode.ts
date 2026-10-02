import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  decodeLendingTx,
  kvaultReallocation,
  type LendingDecodeContext,
  type RpcTx,
  type VaultRole,
  vaultBalanceCheck,
} from '@colosseum/risk';
import { latestRegistryFile, type RegistryPool } from './lib-history';
import { LENDING_HISTORY_DIR } from './lib-lending';

// Step 10b item 5 — decode pass over the lending history's raw bodies (item 4). It never fetches: it reads
// `<dir>/raw/<day>.jsonl.gz` and writes one row per transaction to `<dir>/decoded/<day>.jsonl.gz`:
// decoded events (with flows, args, Anchor events, config values, liquidation detail), the pre and post balance of
// every protocol vault the transaction touches, the vault-balance check, refresh count, undecoded payloads and the
// truncated-log flag. Then, across all decoded days in time order:
//   decoded/config-changes.jsonl   one row per parameter change, with the previous value of the same parameter
//   decoded/liquidations.jsonl     one row per liquidation (Kamino and Jupiter Lend), with any DEX sale
//   decoded/reallocations.jsonl    one row per curated-vault transaction that invests or divests
//   decoded/summary.json           counts, check failures and unknown payloads (the item-5 evidence)
// Re-run whenever a decoder changes. Days whose fetch is not done are skipped unless --partial is given (a day
// being appended may end in an incomplete gzip member; then the day is skipped and reported).
// Usage: tsx scripts/risk/lending-decode.ts [--partial] [--day=YYYY-MM-DD] [dir=data/risk/lending-history]
const argv = process.argv.slice(2);
const PARTIAL = argv.includes('--partial');
const ONLY = argv.find((a) => a.startsWith('--day='))?.slice(6);
const DIR = argv.find((a) => !a.startsWith('--')) ?? LENDING_HISTORY_DIR;
const METHOD = 'lending-decode-0.1';
const SOURCE =
  'lending history raw bodies (Solana RPC getTransaction); decoders packages/risk/src/lending/tx.ts';
const RAW = join(DIR, 'raw');
const OUT = join(DIR, 'decoded');
mkdirSync(OUT, { recursive: true });

// context: lending registry (reserve symbols, protocol vaults), DEX registry (pools for liquidation sales)
type LendingRow = {
  account: string;
  venue: string;
  role: string;
  symbol: string | null;
  accounts: Record<string, string>;
};
const lreg = JSON.parse(
  readFileSync(join(homedir(), '.colosseum', 'risk', 'lending-registry.json'), 'utf8'),
) as { rows: LendingRow[] };
const reserveSymbols = new Map<string, string>();
const vaults = new Map<string, VaultRole>();
for (const r of lreg.rows) {
  if (r.venue === 'kamino' && r.symbol) reserveSymbols.set(r.account, r.symbol);
  const a = r.accounts;
  if (a.liquiditySupplyVault) vaults.set(a.liquiditySupplyVault, 'liquidity_supply');
  if (a.collateralSupplyVault) vaults.set(a.collateralSupplyVault, 'collateral_supply');
  if (a.liquidityFeeVault) vaults.set(a.liquidityFeeVault, 'fee_vault');
  if (r.role === 'curated_vault' && a.tokenVault) vaults.set(a.tokenVault, 'kvault_token');
}
const dreg = JSON.parse(readFileSync(latestRegistryFile(), 'utf8')) as { pools: RegistryPool[] };
const pools = new Map(
  dreg.pools.map((p) => [p.address, { venue: p.venue, mint0: p.mint0, mint1: p.mint1 }]),
);
const ctx: LendingDecodeContext = { reserveSymbols, vaults, pools };

const days = readdirSync(RAW)
  .filter((f) => f.endsWith('.jsonl.gz'))
  .map((f) => f.slice(0, 10))
  .filter((d) => (ONLY ? d === ONLY : PARTIAL || existsSync(join(RAW, `${d}.done`))))
  .sort();

type Row = { s: string; sl: number; t: number; a: number[]; found?: string; tx: RpcTx };
const summary = {
  method: METHOD,
  source: SOURCE,
  decodedAt: new Date().toISOString(),
  days: 0,
  daysSkipped: [] as string[],
  txs: 0,
  txsWithEvents: 0,
  events: {} as Record<string, number>,
  ix: {} as Record<string, number>,
  refreshes: 0,
  vaultsChecked: 0,
  checkFailures: 0,
  checkFailureExamples: [] as unknown[],
  externalFlows: 0,
  externalExamples: [] as unknown[],
  unknown: {} as Record<string, number>,
  unknownExamples: {} as Record<string, string>,
  unhandledTokenIx: 0,
  truncated: 0,
  logsMisaligned: 0,
  liquidations: 0,
  configChanges: 0,
  reallocations: 0,
};
const t0 = Date.now();
for (const day of days) {
  let text: string;
  try {
    text = gunzipSync(readFileSync(join(RAW, `${day}.jsonl.gz`))).toString('utf8');
  } catch {
    summary.daysSkipped.push(day);
    continue;
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line) as Row;
    const d = decodeLendingTx(r.tx, ctx);
    const check = vaultBalanceCheck(d);
    summary.txs++;
    if (d.events.length) summary.txsWithEvents++;
    summary.refreshes += d.refreshes;
    summary.vaultsChecked += check.rows.length;
    for (const e of d.events) {
      summary.events[e.kind] = (summary.events[e.kind] ?? 0) + 1;
      const k = `${e.program}.${e.ix}`;
      summary.ix[k] = (summary.ix[k] ?? 0) + 1;
    }
    for (const row of check.rows.filter((x) => !x.ok)) {
      summary.checkFailures++;
      if (summary.checkFailureExamples.length < 30)
        summary.checkFailureExamples.push({ s: r.s, ...row, ix: d.events.map((e) => e.ix) });
    }
    if (d.external.length) {
      summary.externalFlows += d.external.length;
      if (summary.externalExamples.length < 10)
        summary.externalExamples.push({ s: r.s, external: d.external });
    }
    for (const u of d.unknown) {
      const k = u.slice(0, u.indexOf(':', u.indexOf(':') + 1) > 0 ? u.indexOf('/') : u.length);
      summary.unknown[k] = (summary.unknown[k] ?? 0) + 1;
      summary.unknownExamples[k] ??= r.s;
    }
    summary.unhandledTokenIx += d.unhandledTokenIx;
    if (d.truncated) summary.truncated++;
    if (d.logsMisaligned) summary.logsMisaligned++;
    out.push(
      JSON.stringify({
        s: r.s,
        sl: r.sl,
        t: r.t,
        a: r.a,
        ...(r.found ? { found: r.found } : {}),
        ...(d.events.length ? { ev: d.events } : {}),
        ...(d.refreshes ? { rf: d.refreshes } : {}),
        ...(d.external.length ? { ext: d.external } : {}),
        v: d.vaults,
        ok: check.ok,
        ...(d.unknown.length ? { ux: d.unknown } : {}),
        ...(d.unhandledTokenIx ? { uth: d.unhandledTokenIx } : {}),
        ...(d.truncated ? { tr: true } : {}),
        ...(d.logsMisaligned ? { mis: true } : {}),
      }),
    );
  }
  writeFileSync(join(OUT, `${day}.jsonl.gz`), gzipSync(`${out.join('\n')}\n`));
  summary.days++;
}

// cross-day outputs, in time order (slot, then position in the transaction)
type Dec = {
  s: string;
  sl: number;
  t: number;
  ev?: ReturnType<typeof decodeLendingTx>['events'];
};
const decodedDays = readdirSync(OUT)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
  .sort();
const configs: string[] = [];
const liquidations: string[] = [];
const reallocations: string[] = [];
const last = new Map<string, string>();
const prov = (fetchedFrom: string) => ({
  source: SOURCE,
  fetched_at: fetchedFrom,
  method: METHOD,
  provenance: 'live',
});
for (const f of decodedDays) {
  const doneFile = join(RAW, f.replace('.jsonl.gz', '.done'));
  const fetchedAt = existsSync(doneFile)
    ? (JSON.parse(readFileSync(doneFile, 'utf8')) as { fetchedAt: string }).fetchedAt
    : 'partial';
  const rows = gunzipSync(readFileSync(join(OUT, f)))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Dec)
    .sort((a, b) => a.sl - b.sl);
  for (const r of rows) {
    for (const e of r.ev ?? []) {
      if (!e.ok) continue;
      const target =
        e.accounts.reserve ??
        e.accounts.vault_config ??
        e.accounts.vaultState ??
        e.accounts.lendingMarket ??
        e.accounts.token_reserve ??
        '';
      for (const c of e.config ?? []) {
        const key = `${e.program}:${target}:${c.param}`;
        const old = last.get(key) ?? null;
        last.set(key, c.value);
        configs.push(
          JSON.stringify({
            s: r.s,
            slot: r.sl,
            time: new Date(r.t * 1000).toISOString(),
            program: e.program,
            ix: e.ix,
            target,
            param: c.param,
            old,
            new: c.value,
            changed: old !== c.value,
            ...prov(fetchedAt),
          }),
        );
      }
      if (e.kind === 'vault_allocation_config' && e.args) {
        const key = `kvault:${e.accounts.vaultState}:${e.accounts.reserve}:allocation`;
        const val = `${e.args.weight}/${e.args.cap}${e.args.ctokenAllocationCap !== undefined ? `/${e.args.ctokenAllocationCap}` : ''}`;
        const old = last.get(key) ?? null;
        last.set(key, val);
        if (old !== val)
          configs.push(
            JSON.stringify({
              s: r.s,
              slot: r.sl,
              time: new Date(r.t * 1000).toISOString(),
              program: e.program,
              ix: e.ix,
              target: `${e.accounts.vaultState}:${e.accounts.reserve}`,
              param: 'allocation weight/cap',
              old,
              new: val,
              changed: true,
              ...prov(fetchedAt),
            }),
          );
      }
      if (e.liquidation)
        liquidations.push(
          JSON.stringify({
            s: r.s,
            slot: r.sl,
            time: new Date(r.t * 1000).toISOString(),
            ...e.liquidation,
            ...prov(fetchedAt),
          }),
        );
    }
    const re = r.ev?.some((e) => e.kind === 'vault_invest')
      ? kvaultReallocation({ events: r.ev } as Parameters<typeof kvaultReallocation>[0])
      : null;
    if (re)
      reallocations.push(
        JSON.stringify({
          s: r.s,
          slot: r.sl,
          time: new Date(r.t * 1000).toISOString(),
          ...re,
          ...prov(fetchedAt),
        }),
      );
  }
}
writeFileSync(join(OUT, 'config-changes.jsonl'), configs.length ? `${configs.join('\n')}\n` : '');
writeFileSync(
  join(OUT, 'liquidations.jsonl'),
  liquidations.length ? `${liquidations.join('\n')}\n` : '',
);
writeFileSync(
  join(OUT, 'reallocations.jsonl'),
  reallocations.length ? `${reallocations.join('\n')}\n` : '',
);
summary.configChanges = configs.length;
summary.liquidations = liquidations.length;
summary.reallocations = reallocations.length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(
  JSON.stringify({
    ...summary,
    checkFailureExamples: summary.checkFailureExamples.slice(0, 5),
    externalExamples: summary.externalExamples.slice(0, 2),
    secs: Math.round((Date.now() - t0) / 1000),
  }),
);

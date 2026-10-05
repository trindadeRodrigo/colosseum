import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeKaminoReserve, KAMINO_RESERVE_SIZE, type LendingEvent } from '@colosseum/risk';
import { LENDING_HISTORY_DIR, RISK_HOME } from './lib-lending';

// Step 10b item 7 — freeze real mainnet data for tests/risk-layer/lending-reconstruct.test.ts, from what is on disk
// (no RPC; `pnpm risk:lending-decode` and `pnpm risk:lending-reconstruct` must have run):
//  forward   one Kamino debt reserve, two consecutive hourly raw snapshots (raw-markets) inside the window and every
//            transaction on the reserve's own walk between them (refresh-only ones included), picked as the pair
//            with at least one borrow and one repay and the fewest transactions
//  blob      a reserve's `UpdateEntireReserveConfig` value from its history, and the reserve's raw bytes today, for a
//            reserve whose history changes the borrow-rate curve only through that blob
//  jl        one Jupiter Lend vault: every liquidity-layer operation of the vault (amount and the exchange prices it
//            logged), the layer's exchange-price observations either side of one API read, and that API row
// Usage: tsx scripts/risk/lending-freeze-reconstruct-fixtures.ts
const OUT = 'fixtures/risk/lending/reconstruct.json';
const DIR = LENDING_HISTORY_DIR;
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
type RegRow = {
  account: string;
  venue: string;
  role: string;
  symbol: string | null;
  mint?: string;
  debtMint?: string;
  accounts: Record<string, string>;
};
const reg = (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as { rows: RegRow[] }
).rows;
const reserves = reg.filter((r) => r.venue === 'kamino');
const summary = JSON.parse(readFileSync(join(DIR, 'hourly', 'summary.json'), 'utf8')) as {
  window: { cutSlot: number };
};
const cutSlot = summary.window.cutSlot;
const addrs = JSON.parse(readFileSync(join(DIR, 'addresses.json'), 'utf8')) as Array<{
  i: number;
  address: string;
}>;
const addrIndex = new Map(addrs.map((a) => [a.address, a.i]));

// ------------------------------------------------------------------------------------------------- forward
type Snap = { at: string; slot: number; accounts: Record<string, string | { b64: string }> };
const rawBase = join(RISK_HOME, 'raw-markets');
const snaps: Snap[] = [];
for (const d of readdirSync(rawBase).sort())
  for (const h of readdirSync(join(rawBase, d)).sort()) {
    const j = JSON.parse(gunzipSync(readFileSync(join(rawBase, d, h))).toString()) as Snap & {
      fetchedAt: string;
    };
    if (j.slot <= cutSlot) snaps.push({ at: j.fetchedAt, slot: j.slot, accounts: j.accounts });
  }
snaps.sort((a, b) => a.slot - b.slot);
const b64 = (v: string | { b64: string }) => (typeof v === 'string' ? v : v.b64);
type Dec = { s: string; sl: number; t: number; a: number[]; rf?: number; ev?: LendingEvent[] };
const days = [...new Set(snaps.map((s) => s.at.slice(0, 10)))];
const decoded = days.flatMap((d) => readJsonl<Dec>(join(DIR, 'decoded', `${d}.jsonl.gz`)));
let best:
  | { reserve: RegRow; a: Snap; b: Snap; sigs: Array<{ s: string; sl: number; day: string }> }
  | undefined;
for (const r of reserves.filter((x) => x.role === 'debt')) {
  const i = addrIndex.get(r.account);
  if (i === undefined) continue;
  const mine = decoded.filter((x) => x.a.includes(i));
  for (let k = 1; k < snaps.length; k++) {
    const a = snaps[k - 1] as Snap;
    const b = snaps[k] as Snap;
    if (!a.accounts[r.account] || !b.accounts[r.account]) continue;
    const between = mine.filter((x) => x.sl > a.slot && x.sl <= b.slot);
    const kinds = new Set(
      between.flatMap((x) =>
        (x.ev ?? [])
          .filter(
            (e) =>
              e.program === 'klend' &&
              (e.accounts.borrowReserve === r.account || e.accounts.repayReserve === r.account),
          )
          .map((e) => e.kind),
      ),
    );
    if (!kinds.has('borrow') || !kinds.has('repay')) continue;
    if (!best || between.length < best.sigs.length)
      best = {
        reserve: r,
        a,
        b,
        sigs: between
          .sort((x, y) => x.sl - y.sl)
          .map((x) => ({ s: x.s, sl: x.sl, day: new Date(x.t * 1000).toISOString().slice(0, 10) })),
      };
  }
}
if (!best) throw new Error('no snapshot pair with a borrow and a repay on a debt reserve');
const rawCache = new Map<string, Map<string, unknown>>();
const rawTx = (sig: string, day: string) => {
  if (!rawCache.has(day))
    rawCache.set(
      day,
      new Map(
        readJsonl<{ s: string; tx: unknown }>(join(DIR, 'raw', `${day}.jsonl.gz`)).map((r) => [
          r.s,
          r.tx,
        ]),
      ),
    );
  const tx = rawCache.get(day)?.get(sig);
  if (!tx) throw new Error(`no raw body for ${sig}`);
  return tx;
};
const fr = best.reserve;
const forward = {
  reserve: fr.account,
  symbol: fr.symbol,
  liquiditySupplyVault: fr.accounts.liquiditySupplyVault,
  collateralMint: fr.accounts.collateralMint,
  vaultRoles: {
    [fr.accounts.liquiditySupplyVault as string]: 'liquidity_supply',
    [fr.accounts.collateralSupplyVault as string]: 'collateral_supply',
    [fr.accounts.liquidityFeeVault as string]: 'fee_vault',
  },
  from: { at: best.a.at, slot: best.a.slot, b64: b64(best.a.accounts[fr.account] as string) },
  to: { at: best.b.at, slot: best.b.slot, b64: b64(best.b.accounts[fr.account] as string) },
  txs: best.sigs.map((x) => ({ s: x.s, sl: x.sl, tx: rawTx(x.s, x.day) })),
};

// ------------------------------------------------------------------------------------------------- blob
type Change = { target: string; param: string; new: string };
const changes = readJsonl<Change>(join(DIR, 'decoded', 'config-changes.jsonl'));
const curveChanged = new Set(
  changes.filter((c) => c.param === 'UpdateBorrowRateCurve').map((c) => c.target),
);
const blobChange = changes.find(
  (c) => c.param.endsWith('EntireReserveConfig') && !curveChanged.has(c.target),
);
if (!blobChange) throw new Error('no reserve configured only by a whole-config blob');
const today = [...snaps].reverse().find((s) => s.accounts[blobChange.target] !== undefined) as Snap;
const blobBytes = Buffer.from(b64(today.accounts[blobChange.target] as string), 'base64');
if (blobBytes.length !== KAMINO_RESERVE_SIZE) throw new Error('blob reserve bytes');
const blob = {
  reserve: blobChange.target,
  hex: blobChange.new,
  reserveAt: today.at,
  reserveB64: blobBytes.toString('base64'),
  name: decodeKaminoReserve(new Uint8Array(blobBytes)).config.name,
};

// ------------------------------------------------------------------------------------------------- jl
const vault = reg.find((r) => r.venue === 'jupiter_lend' && r.symbol === 'NVDAx' && r.debtMint);
if (!vault) throw new Error('no Jupiter Lend vault');
const colMint = vault.mint as string;
const debtMint = vault.debtMint as string;
type Op = {
  t: number;
  token: string;
  supplyAmount: string;
  borrowAmount: string;
  sEx: string;
  bEx: string;
};
const ops: Op[] = [];
const obs: Array<{ t: number; token: string; sEx: string; bEx: string }> = [];
const decDays = readdirSync(join(DIR, 'decoded'))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
  .sort();
for (const f of decDays)
  for (const r of readJsonl<Dec>(join(DIR, 'decoded', f))) {
    if (r.sl > cutSlot) continue;
    for (const e of r.ev ?? []) {
      if (e.program !== 'jl_liquidity' || e.ix !== 'operate') continue;
      const x = e.events?.find((y) => y.name === 'LogOperate')?.fields;
      if (!x) continue;
      const token = String(x.token);
      if (token !== colMint && token !== debtMint) continue;
      const row = {
        t: r.t,
        token,
        sEx: String(x.supplyExchangePrice),
        bEx: String(x.borrowExchangePrice),
      };
      obs.push(row);
      if (String(x.user) === vault.account)
        ops.push({
          ...row,
          supplyAmount: String(x.supplyAmount),
          borrowAmount: String(x.borrowAmount),
        });
    }
  }
ops.sort((a, b) => a.t - b.t);
obs.sort((a, b) => a.t - b.t);
const apiFile = join(RISK_HOME, 'markets', '2026-10-01.jsonl');
const apiRow = existsSync(apiFile)
  ? readJsonl<{ venue: string; account: string; fetchedAt: string; api: Record<string, unknown> }>(
      apiFile,
    )
      .filter((a) => a.venue === 'jupiter_lend' && a.account === vault.account)
      .find((a) => {
        const t = Date.parse(a.fetchedAt) / 1000;
        return ops.some((o) => o.t < t) && obs.some((o) => o.t > t && o.token === debtMint);
      })
  : undefined;
if (!apiRow) throw new Error('no API row with observations after it');
const ta = Date.parse(apiRow.fetchedAt) / 1000;
const around = (token: string) => {
  const mine = obs.filter((o) => o.token === token);
  const before = mine.filter((o) => o.t <= ta).at(-1);
  const after = mine.find((o) => o.t > ta);
  return [before, after].filter((x) => x !== undefined);
};
const jl = {
  vault: vault.account,
  symbol: vault.symbol,
  colMint,
  debtMint,
  ops: ops.filter((o) => o.t < ta),
  around: { [colMint]: around(colMint), [debtMint]: around(debtMint) },
  api: {
    fetchedAt: apiRow.fetchedAt,
    totalSupplyLiquidity: String(apiRow.api.totalSupplyLiquidity),
    totalBorrowLiquidity: String(apiRow.api.totalBorrowLiquidity),
  },
};

mkdirSync('fixtures/risk/lending', { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      source:
        'lending history (decoded + raw bodies), ~/.colosseum/risk raw-markets / markets; hourly/summary.json',
      forward,
      blob,
      jl,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify({
    out: OUT,
    forward: {
      symbol: forward.symbol,
      from: forward.from.at,
      to: forward.to.at,
      txs: forward.txs.length,
    },
    blob: { reserve: blob.reserve, name: blob.name },
    jl: { vault: jl.vault, ops: jl.ops.length, apiAt: jl.api.fetchedAt },
  }),
);

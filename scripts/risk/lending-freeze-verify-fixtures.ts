import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  decodeKaminoObligation,
  decodeKaminoReserve,
  KAMINO_OBLIGATION_SIZE,
  KAMINO_RESERVE_SIZE,
  type LendingEvent,
  reserveDeltas,
} from '@colosseum/risk';
import { LENDING_HISTORY_DIR, RISK_HOME, readAddressSignatures } from './lib-lending';

// Step 10b item 6 — freeze real mainnet data for tests/risk-layer/lending-verify.test.ts, from what is on disk (no
// RPC; `pnpm risk:lending-decode` and `pnpm risk:lending-verify` must have run):
//  replay     one Kamino reserve, two consecutive hourly raw snapshots (raw-markets) and every transaction between
//             them that changes the reserve, picked as the pair with at least one borrow and one repay and the
//             fewest such transactions
//  gap        the two transactions either side of the first vault-chain break the verify run found, or of the
//             transaction a getBlock scan found for it (gaps/found.jsonl), with that transaction
//  obligation an obligation initialised more than once inside the window and unchanged after it, its raw bytes from
//             the first hourly positions snapshot, and every transaction of it inside the window
//  api        the API row read between two 5-minute on-chain rows that differ (a transaction between the reads)
// Transactions and accounts are public chain data; fixtures label no wallet.
// Usage: tsx scripts/risk/lending-freeze-verify-fixtures.ts
const OUT = 'fixtures/risk/lending/verify.json';
const DIR = LENDING_HISTORY_DIR;
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
const verifyFile = readdirSync(DIR)
  .filter((f) => /^verify-\d{8}T\d{4}\.json$/.test(f))
  .sort()
  .at(-1);
if (!verifyFile) throw new Error('run pnpm risk:lending-verify first');
const verify = JSON.parse(readFileSync(join(DIR, verifyFile), 'utf8')) as {
  cutSlot: number;
  coverage: { window: [string, string] };
  chain: { vaults: Array<{ vault: string; firstBreaks: Array<{ sig: string; prevSig: string }> }> };
};
type RegRow = {
  account: string;
  venue: string;
  symbol: string | null;
  accounts: Record<string, string>;
};
const reserves = (
  JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as { rows: RegRow[] }
).rows.filter((r) => r.venue === 'kamino');
const vaultRoles = Object.fromEntries(
  reserves.flatMap((r) => [
    [r.accounts.liquiditySupplyVault, 'liquidity_supply'],
    [r.accounts.collateralSupplyVault, 'collateral_supply'],
    [r.accounts.liquidityFeeVault, 'fee_vault'],
  ]),
);

type Dec = { s: string; sl: number; ev?: LendingEvent[] };
const days = readdirSync(join(DIR, 'decoded'))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
  .map((f) => f.slice(0, 10))
  .filter((d) => d >= verify.coverage.window[0] && d <= verify.coverage.window[1])
  .sort();
const decoded = new Map<string, Dec[]>(
  days.map((d) => [d, readJsonl<Dec>(join(DIR, 'decoded', `${d}.jsonl.gz`))]),
);
const rawCache = new Map<string, Map<string, unknown>>();
const rawTx = (sig: string) => {
  for (const [d, rows] of decoded)
    if (rows.some((r) => r.s === sig)) {
      if (!rawCache.has(d))
        rawCache.set(
          d,
          new Map(
            readJsonl<{ s: string; tx: unknown }>(join(DIR, 'raw', `${d}.jsonl.gz`)).map((r) => [
              r.s,
              r.tx,
            ]),
          ),
        );
      return rawCache.get(d)?.get(sig);
    }
  throw new Error(`no raw body for ${sig}`);
};
const slotOf = new Map([...decoded.values()].flat().map((r) => [r.s, r.sl]));

// replay
const snaps = new Map<string, Array<{ at: string; slot: number; b64: string }>>();
const base = join(RISK_HOME, 'raw-markets');
for (const d of readdirSync(base).sort())
  for (const h of readdirSync(join(base, d)).sort()) {
    const j = JSON.parse(gunzipSync(readFileSync(join(base, d, h))).toString()) as {
      fetchedAt: string;
      slot: number;
      accounts: Record<string, string>;
    };
    if (j.slot > verify.cutSlot) continue;
    for (const [acc, b64] of Object.entries(j.accounts))
      if (Buffer.from(b64, 'base64').length === KAMINO_RESERVE_SIZE) {
        const arr = snaps.get(acc) ?? [];
        arr.push({ at: j.fetchedAt, slot: j.slot, b64 });
        snaps.set(acc, arr);
      }
  }
const lastDay = decoded.get(verify.coverage.window[1]) ?? [];
let best:
  | {
      reserve: RegRow;
      a: { at: string; slot: number; b64: string };
      b: { at: string; slot: number; b64: string };
      sigs: string[];
    }
  | undefined;
for (const r of reserves) {
  const arr = (snaps.get(r.account) ?? []).sort((x, y) => x.slot - y.slot);
  const keys = {
    reserve: r.account,
    liquiditySupplyVault: r.accounts.liquiditySupplyVault as string,
    collateralMint: r.accounts.collateralMint as string,
  };
  for (let i = 1; i < arr.length; i++) {
    const a = arr[i - 1] as { at: string; slot: number; b64: string };
    const b = arr[i] as { at: string; slot: number; b64: string };
    const rows = lastDay.filter((x) => x.sl > a.slot && x.sl <= b.slot);
    const touching = rows.filter((x) => {
      const d = reserveDeltas(x.ev ?? [], keys);
      return d.available || d.borrowed || d.ctoken;
    });
    const kinds = new Set(
      touching.flatMap((x) =>
        (x.ev ?? [])
          .filter((e) => (e.accounts.borrowReserve ?? e.accounts.repayReserve) === r.account)
          .map((e) => e.kind),
      ),
    );
    if (!kinds.has('borrow') || !kinds.has('repay') || touching.length < 3) continue;
    const ra = decodeKaminoReserve(new Uint8Array(Buffer.from(a.b64, 'base64')));
    const rb = decodeKaminoReserve(new Uint8Array(Buffer.from(b.b64, 'base64')));
    if (ra.cumulativeBorrowRateBsf === rb.cumulativeBorrowRateBsf) continue;
    if (!best || touching.length < best.sigs.length)
      best = { reserve: r, a, b, sigs: touching.sort((x, y) => x.sl - y.sl).map((x) => x.s) };
  }
}
if (!best) throw new Error('no snapshot pair with a borrow and a repay');

// gap: the transactions either side of a vault-chain break and, once a getBlock scan has found the transaction
// the address index missed (gaps/found.jsonl), that transaction too
type Found = { signature: string; slot: number; addresses: string[] };
const foundFile = join(DIR, 'gaps', 'found.jsonl');
const found = (existsSync(foundFile) ? readJsonl<Found>(foundFile) : []).find((f) =>
  f.addresses.some((a) => vaultRoles[a] === 'liquidity_supply'),
);
const broken = verify.chain.vaults.find((v) => v.firstBreaks.length);
const gapTx = (s: string) => ({ s, sl: slotOf.get(s), tx: rawTx(s) });
let gap: { vault: string; txs: unknown[]; found?: unknown } | null = null;
if (found) {
  const vault = found.addresses.find((a) => vaultRoles[a] === 'liquidity_supply') as string;
  const walk = [...readAddressSignatures(DIR, vault)].filter((x) => !x.failed);
  const prev = walk.filter((x) => x.slot < found.slot).sort((a, b) => b.slot - a.slot)[0];
  const next = walk.filter((x) => x.slot > found.slot).sort((a, b) => a.slot - b.slot)[0];
  if (!prev || !next) throw new Error('found tx has no walked neighbours');
  gap = {
    vault,
    txs: [prev.signature, next.signature].map(gapTx),
    found: gapTx(found.signature),
  };
} else if (broken?.firstBreaks[0])
  gap = {
    vault: broken.vault,
    txs: [broken.firstBreaks[0].prevSig, broken.firstBreaks[0].sig].map(gapTx),
  };

// obligation
const inits = new Map<string, number>();
const obTxs = new Map<string, Set<string>>();
for (const rows of decoded.values())
  for (const r of rows)
    for (const e of r.ev ?? []) {
      const ob = e.program === 'klend' ? e.accounts.obligation : undefined;
      if (!ob) continue;
      if (e.ix === 'initObligation') inits.set(ob, (inits.get(ob) ?? 0) + 1);
      const s = obTxs.get(ob) ?? new Set<string>();
      s.add(r.s);
      obTxs.set(ob, s);
    }
const posBase = join(RISK_HOME, 'lending-positions');
const firstHourDay = readdirSync(posBase).sort()[0] as string;
const firstHour = join(
  posBase,
  firstHourDay,
  readdirSync(join(posBase, firstHourDay)).sort()[0] as string,
);
let ob: { address: string; b64: string; sigs: string[] } | undefined;
for (const f of readdirSync(firstHour).filter(
  (x) => x.startsWith('kamino-') && x.endsWith('.raw.json.gz'),
)) {
  const j = JSON.parse(gunzipSync(readFileSync(join(firstHour, f))).toString()) as {
    accounts: Record<string, string>;
  };
  for (const [address, b64] of Object.entries(j.accounts)) {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    if (bytes.length !== KAMINO_OBLIGATION_SIZE || (inits.get(address) ?? 0) < 2) continue;
    const o = decodeKaminoObligation(bytes);
    if (
      o.lastUpdateSlot > BigInt(verify.cutSlot) ||
      !o.deposits.some((d) => d.depositedAmount > 0n)
    )
      continue;
    const sigs = [...(obTxs.get(address) ?? [])];
    if (!ob || sigs.length < ob.sigs.length) ob = { address, b64, sigs };
  }
}
if (!ob) throw new Error('no reopened obligation');

// api: Jupiter Lend vault 82 (SPYx/JupUSD), API read 2026-10-01T23:02:04Z between on-chain reads 23:01:04Z and 23:06:05Z
type OnRow = Record<string, unknown> & { kind: string; fetchedAt: string; vaultId?: number };
const onRows = readJsonl<OnRow>(join(RISK_HOME, 'lending', '2026-10-01.jsonl')).filter(
  (r) => r.kind === 'jl_vault' && r.vaultId === 82,
);
const apiRow = readJsonl<{ venue: string; fetchedAt: string; api: Record<string, unknown> }>(
  join(RISK_HOME, 'markets', '2026-10-01.jsonl'),
).find(
  (r) =>
    r.venue === 'jupiter_lend' && r.api.id === 82 && r.fetchedAt.startsWith('2026-10-01T23:02'),
);
const pick = (r: OnRow | undefined) =>
  r && {
    fetchedAt: r.fetchedAt,
    slot: r.slot,
    internalDecimals: r.internalDecimals,
    collateralInternal: r.collateralInternal,
    liquiditySupplied: r.liquiditySupplied,
  };
const api = apiRow && {
  apiAt: apiRow.fetchedAt,
  supplyDecimals: (apiRow.api.supplyToken as { decimals: number }).decimals,
  totalSupply: apiRow.api.totalSupply,
  totalSupplyLiquidity: apiRow.api.totalSupplyLiquidity,
  before: pick(onRows.filter((r) => r.fetchedAt <= apiRow.fetchedAt).at(-1)),
  after: pick(onRows.find((r) => r.fetchedAt > apiRow.fetchedAt)),
};

mkdirSync('fixtures/risk/lending', { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      source: `lending history (decoded + raw bodies), ~/.colosseum/risk raw-markets / lending-positions / lending / markets; ${verifyFile}`,
      cutSlot: verify.cutSlot,
      vaultRoles,
      replay: {
        reserve: best.reserve.account,
        symbol: best.reserve.symbol,
        liquiditySupplyVault: best.reserve.accounts.liquiditySupplyVault,
        collateralMint: best.reserve.accounts.collateralMint,
        from: best.a,
        to: best.b,
        txs: best.sigs.map((s) => ({ s, sl: slotOf.get(s), tx: rawTx(s) })),
      },
      gap,
      obligation: {
        address: ob.address,
        b64: ob.b64,
        collateralVaults: reserves.map((r) => r.accounts.collateralSupplyVault),
        txs: ob.sigs
          .map((s) => ({ s, sl: slotOf.get(s), tx: rawTx(s) }))
          .sort((a, b) => (a.sl ?? 0) - (b.sl ?? 0)),
      },
      api,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify({
    out: OUT,
    replay: { symbol: best.reserve.symbol, from: best.a.at, to: best.b.at, txs: best.sigs.length },
    gap: gap?.vault,
    obligation: { inits: inits.get(ob.address), txs: ob.sigs.length },
    api: !!api?.before && !!api.after,
  }),
);

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  apiResidual,
  type BalanceStep,
  balanceChain,
  decodeKaminoObligation,
  decodeKaminoReserve,
  defaultLendingVerifyParams,
  KAMINO_OBLIGATION_SIZE,
  KAMINO_RESERVE_SIZE,
  type LendingEvent,
  obligationCollateral,
  type ReserveSnapshot,
  type ReserveStep,
  replayReserve,
  reserveDeltas,
} from '@colosseum/risk';
import { LENDING_HISTORY_DIR, RISK_HOME, readAddressSignatures } from './lib-lending';

// Step 10b item 6 — completeness checks over the lending history (`pnpm risk:lending-verify`). Reads only what is
// on disk: the walks (`sigs/`), the per-day partition (`byday/`), the decode pass output (`decoded/`, run
// `pnpm risk:lending-decode` first), the hourly raw reserve bytes (`~/.colosseum/risk/raw-markets/`,
// `raw-lending/`), the hourly obligation bytes (`lending-positions/`), the 5-minute on-chain rows (`lending/`) and the
// hourly API rows (`markets/`). No RPC.
//  coverage   every walked successful signature of a fetched day is stored or listed in errors.jsonl
//  chain      every walked vault (Kamino liquidity, collateral and fee vaults; curated-vault token vaults), in the
//             order of its own signature walk: each tx's pre-balance = the previous tx's post-balance (exact)
//  replay     Kamino reserves: from each hourly raw snapshot inside the window, undo the decoded events back to the
//             previous one and to the first one: available and cToken supply exact, borrowed within borrowReplayTolBps
//  positions  obligations opened inside the fetched window and not changed after it: summed collateral events =
//             the obligation's deposited cTokens in the first hourly snapshot (exact)
//  api        5-minute on-chain rows against the hourly API rows within 5 minutes, after interest accrual
// Transactions the address index does not return but a getBlock scan found (`<dir>/gaps/found.jsonl`, written by
// `lending-gap-scan.ts --add`) are merged into the walks of the addresses they touch, by slot, and counted apart.
// Output: `<dir>/verify-<stamp>.json` (gitignored), one summary line per check on stdout.
// Usage: tsx scripts/risk/lending-verify.ts [dir=data/risk/lending-history]
const DIR = process.argv[2] ?? LENDING_HISTORY_DIR;
const P = defaultLendingVerifyParams();
const METHOD = 'lending-verify-0.1';
const t0 = Date.now();
const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

type Addr = { i: number; address: string; kind: string; group: string; label: string };
const addrs = JSON.parse(readFileSync(join(DIR, 'addresses.json'), 'utf8')) as Addr[];
type RegRow = {
  account: string;
  venue: string;
  role: string;
  market: string | null;
  symbol: string | null;
  decimals: number;
  accounts: Record<string, string>;
};
const reg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
  rows: RegRow[];
};
const reserves = reg.rows.filter((r) => r.venue === 'kamino');
type Found = { signature: string; slot: number; blockTime: number; addresses: string[] };
const foundFile = join(DIR, 'gaps', 'found.jsonl');
const found = existsSync(foundFile) ? readJsonl<Found>(foundFile) : [];
const foundByAddress = new Map<string, Found[]>();
for (const f of found)
  for (const a of f.addresses) foundByAddress.set(a, [...(foundByAddress.get(a) ?? []), f]);

// the window: each address was walked from the VL-4 start back to its first tx
const vl4 = readJsonl<{ at: string; vl: string; value: { seconds: number } }>(
  'data/risk/lending-measure.jsonl',
)
  .filter((r) => r.vl === 'VL-4')
  .at(-1);
if (!vl4) throw new Error('no VL-4 row in data/risk/lending-measure.jsonl');
const walkStart = Math.floor(Date.parse(vl4.at) / 1000) - vl4.value.seconds;
// the newest slot every walk is known to have reached: the latest walked head at or before the walk started
let cutSlot = 0;
for (const a of addrs) {
  const head = readAddressSignatures(DIR, a.address).next().value;
  if (head && head.blockTime <= walkStart && head.slot > cutSlot) cutSlot = head.slot;
}

// ------------------------------------------------------------------------------------------------- decoded days
const raw = join(DIR, 'raw');
const dec = join(DIR, 'decoded');
const doneDays = readdirSync(raw)
  .filter((f) => f.endsWith('.done'))
  .map((f) => f.slice(0, 10))
  .sort();
const decodedDays = new Set(
  readdirSync(dec)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
    .map((f) => f.slice(0, 10)),
);
const allDays = readdirSync(join(DIR, 'byday'))
  .filter((f) => f.endsWith('.tsv'))
  .map((f) => f.slice(0, 10))
  .sort();
// the checked window: the newest days, contiguous, fetched and decoded (the fetch runs newest first)
const window: string[] = [];
for (const d of [...allDays].reverse()) {
  if (!doneDays.includes(d) || !decodedDays.has(d)) break;
  window.unshift(d);
}
const inWindow = new Set(window);
const notDecoded = doneDays.filter((d) => !decodedDays.has(d));

type Dec = {
  s: string;
  sl: number;
  t: number;
  a: number[];
  ev?: LendingEvent[];
  v: Record<string, { pre: string | null; post: string | null }>;
};
const vaultKinds = new Set([
  'kamino_liquidity_vault',
  'kamino_collateral_vault',
  'kamino_fee_vault',
  'kvault_token_vault',
]);
const walkedVaults = addrs.filter((a) => vaultKinds.has(a.kind));
const vaultSet = new Set(walkedVaults.map((a) => a.address));
const balances = new Map<string, Map<string, [string | null, string | null]>>(
  walkedVaults.map((a) => [a.address, new Map()]),
);
const collateralVaults = new Set(reserves.map((r) => r.accounts.collateralSupplyVault as string));
const obligationSums = new Map<string, Map<string, bigint>>();
const openedInWindow = new Set<string>();
const fetchedSigs = new Set<string>();
const fetchedPerDay = new Map<string, number>();
// events by reserve (for the replay; only the slots the snapshots span are kept)
const snapshotsByReserve = new Map<string, ReserveSnapshot[]>();
const stepsByReserve = new Map<string, ReserveStep[]>();
const unsupportedByReserve = new Map<string, number>();

// hourly raw reserve bytes: pool collector's raw-markets (API-listed reserves, since 2026-10-01 01Z) and the lending
// collector's raw-lending (all registered reserves, since 21Z)
const reserveSet = new Set(reserves.map((r) => r.account));
for (const store of ['raw-markets', 'raw-lending']) {
  const base = join(RISK_HOME, store);
  if (!existsSync(base)) continue;
  for (const d of readdirSync(base).sort())
    for (const h of readdirSync(join(base, d)).sort()) {
      const j = JSON.parse(gunzipSync(readFileSync(join(base, d, h))).toString()) as {
        fetchedAt: string;
        slot: number;
        accounts: Record<string, string | { b64: string }>;
      };
      for (const [acc, v] of Object.entries(j.accounts)) {
        if (!reserveSet.has(acc)) continue;
        const bytes = Buffer.from(typeof v === 'string' ? v : v.b64, 'base64');
        if (bytes.length !== KAMINO_RESERVE_SIZE) continue;
        const arr = snapshotsByReserve.get(acc) ?? [];
        if (!arr.some((s) => s.slot === j.slot))
          arr.push({
            at: `${j.fetchedAt} (${store})`,
            slot: j.slot,
            reserve: decodeKaminoReserve(new Uint8Array(bytes)),
          });
        snapshotsByReserve.set(acc, arr);
      }
    }
}
const inWindowSnaps = new Map<string, ReserveSnapshot[]>();
const afterWindowSnaps = new Map<string, number>();
for (const [acc, arr] of snapshotsByReserve) {
  arr.sort((a, b) => a.slot - b.slot);
  inWindowSnaps.set(
    acc,
    arr.filter((s) => s.slot <= cutSlot),
  );
  afterWindowSnaps.set(acc, arr.filter((s) => s.slot > cutSlot).length);
}
const replayFromSlot = Math.min(
  ...[...inWindowSnaps.values()].flatMap((a) => (a[0] ? [a[0].slot] : [])),
  Number.POSITIVE_INFINITY,
);

for (const day of window) {
  // slot order (the decode pass keeps fetch order); obligation sums depend on it
  const rows = readJsonl<Dec>(join(dec, `${day}.jsonl.gz`)).sort((a, b) => a.sl - b.sl);
  fetchedPerDay.set(day, rows.length);
  for (const r of rows) {
    fetchedSigs.add(r.s);
    for (const [acc, b] of Object.entries(r.v))
      if (vaultSet.has(acc)) balances.get(acc)?.set(r.s, [b.pre, b.post]);
    const ev = r.ev ?? [];
    for (const e of ev)
      if (e.program === 'klend' && e.ix === 'initObligation' && e.accounts.obligation)
        openedInWindow.add(e.accounts.obligation);
    obligationCollateral(ev, collateralVaults, obligationSums);
    if (r.sl > replayFromSlot && r.sl <= cutSlot)
      for (const k of reserves) {
        const keys = {
          reserve: k.account,
          liquiditySupplyVault: k.accounts.liquiditySupplyVault as string,
          collateralMint: k.accounts.collateralMint as string,
        };
        const d = reserveDeltas(ev, keys);
        if (d.unsupported)
          unsupportedByReserve.set(
            k.account,
            (unsupportedByReserve.get(k.account) ?? 0) + d.unsupported,
          );
        if (d.available || d.borrowed || d.ctoken) {
          const arr = stepsByReserve.get(k.account) ?? [];
          arr.push({
            slot: r.sl,
            sig: r.s,
            available: d.available,
            borrowed: d.borrowed,
            ctoken: d.ctoken,
          });
          stepsByReserve.set(k.account, arr);
        }
      }
  }
}

// ------------------------------------------------------------------------------------------------- 1. coverage
const errorSigs = new Set<string>();
if (existsSync(join(DIR, 'errors.jsonl')))
  for (const e of readJsonl<{ signature: string }>(join(DIR, 'errors.jsonl')))
    errorSigs.add(e.signature);
let walkedAll = 0;
let walkedWindow = 0;
let missingWindow = 0;
const missingExamples: string[] = [];
for (const d of allDays) {
  const sigs = new Set<string>();
  for (const line of readFileSync(join(DIR, 'byday', `${d}.tsv`), 'utf8').split('\n'))
    if (line) sigs.add(line.slice(0, line.indexOf('\t')));
  walkedAll += sigs.size;
  if (!inWindow.has(d)) continue;
  walkedWindow += sigs.size;
  for (const s of sigs)
    if (!fetchedSigs.has(s) && !errorSigs.has(s)) {
      missingWindow++;
      if (missingExamples.length < 10) missingExamples.push(`${d} ${s}`);
    }
}
const coverage = {
  days: allDays.length,
  daysFetched: doneDays.length,
  daysDecodedInWindow: window.length,
  window: window.length ? [window[0], window.at(-1)] : null,
  doneButNotDecoded: notDecoded,
  walkedTxs: walkedAll,
  walkedTxsInWindow: walkedWindow,
  fetchedInWindow: fetchedSigs.size,
  errorsListed: errorSigs.size,
  // not returned by the address index; found by a getBlock scan of a chain break (gaps/found.jsonl)
  foundByBlockScan: found.filter((f) =>
    inWindow.has(new Date(f.blockTime * 1000).toISOString().slice(0, 10)),
  ).length,
  foundFetched: found.filter((f) => fetchedSigs.has(f.signature)).length,
  missingInWindow: missingWindow,
  missingExamples,
  notYetFetched: walkedAll - walkedWindow,
  ok: missingWindow === 0,
};
console.log(JSON.stringify({ check: 'coverage', ...coverage }));

// ------------------------------------------------------------------------------------------------- 2. vault chain
const windowStart = window[0]
  ? Date.parse(`${window[0]}T00:00:00Z`) / 1000
  : Number.POSITIVE_INFINITY;
const chain: Array<Record<string, unknown>> = [];
for (const a of walkedVaults) {
  const steps: BalanceStep[] = [];
  let walkedInWindow = 0;
  let notFetched = 0;
  let noBalance = 0;
  const noBalanceExamples: string[] = [];
  const walk = [...readAddressSignatures(DIR, a.address)].reverse();
  const extra = foundByAddress.get(a.address) ?? [];
  let foundSameSlot = 0;
  for (const f of extra) {
    if (walk.some((s) => s.slot === f.slot)) foundSameSlot++;
    // after every walked tx of an earlier or the same slot (order inside a slot is unknown; counted above)
    const at = walk.findIndex((s) => s.slot > f.slot);
    walk.splice(at < 0 ? walk.length : at, 0, { ...f, failed: false });
  }
  for (const s of walk) {
    if (s.failed || s.blockTime < windowStart) continue;
    walkedInWindow++;
    const b = balances.get(a.address)?.get(s.signature);
    if (b) steps.push({ sig: s.signature, slot: s.slot, pre: b[0], post: b[1] });
    else if (fetchedSigs.has(s.signature)) {
      noBalance++;
      if (noBalanceExamples.length < 3) noBalanceExamples.push(s.signature);
    } else notFetched++;
  }
  const c = balanceChain(steps);
  // a break is either a missing tx between the two, or two txs of one slot in the wrong order
  const breaks = c.breaks.map((b) => ({ ...b, sameSlot: b.slot === b.prevSlot }));
  chain.push({
    vault: a.address,
    kind: a.kind,
    group: a.group,
    label: a.label,
    walkedInWindow,
    steps: c.steps,
    checked: c.checked,
    notFetched,
    noBalance,
    noBalanceExamples,
    foundByBlockScan: extra.length,
    foundSameSlot,
    breaks: breaks.length,
    firstBreaks: breaks.slice(0, 5),
  });
}
const chainSummary = {
  vaults: chain.length,
  checked: chain.reduce((s, r) => s + (r.checked as number), 0),
  breaks: chain.reduce((s, r) => s + (r.breaks as number), 0),
  vaultsWithBreaks: chain.filter((r) => (r.breaks as number) > 0).length,
  notFetched: chain.reduce((s, r) => s + (r.notFetched as number), 0),
  noBalance: chain.reduce((s, r) => s + (r.noBalance as number), 0),
  foundByBlockScan: chain.reduce((s, r) => s + (r.foundByBlockScan as number), 0),
  foundSameSlot: chain.reduce((s, r) => s + (r.foundSameSlot as number), 0),
  notCovered:
    'Jupiter Lend liquidity-layer token vaults are shared by every vault and lender of a token and are not walked (D12: live-only); Jupiter Lend has no per-vault balance chain',
};
console.log(JSON.stringify({ check: 'chain', ...chainSummary }));

// ------------------------------------------------------------------------------------------------- 3. replay
const replay: Array<Record<string, unknown>> = [];
for (const k of reserves) {
  const snaps = inWindowSnaps.get(k.account) ?? [];
  const steps = (stepsByReserve.get(k.account) ?? []).sort((a, b) => a.slot - b.slot);
  const pairs: ReturnType<typeof replayReserve>[] = [];
  const fromAnchor: ReturnType<typeof replayReserve>[] = [];
  for (let i = 1; i < snaps.length; i++)
    pairs.push(
      replayReserve(snaps[i] as ReserveSnapshot, snaps[i - 1] as ReserveSnapshot, steps, P),
    );
  const anchor = snaps.at(-1);
  if (anchor)
    for (const s of snaps.slice(0, -1)) fromAnchor.push(replayReserve(anchor, s, steps, P));
  const fails = (xs: typeof pairs) =>
    xs.filter((x) => !x.available.ok || !x.ctoken.ok || !x.borrowed.ok);
  const errs = pairs
    .filter((x) => Number(x.borrowed.expected) > 0)
    .map((x) => Math.abs(x.borrowed.errBps));
  replay.push({
    reserve: k.account,
    market: k.market,
    symbol: k.symbol,
    snapshotsInWindow: snaps.length,
    snapshotsAfterWindow: afterWindowSnaps.get(k.account) ?? 0,
    window: snaps.length ? [snaps[0]?.at, anchor?.at] : null,
    steps: steps.filter((s) => snaps[0] && s.slot > snaps[0].slot).length,
    unsupported: unsupportedByReserve.get(k.account) ?? 0,
    pairs: pairs.length,
    pairFailures: fails(pairs).map((x) => ({
      from: x.from,
      to: x.to,
      available: x.available,
      ctoken: x.ctoken,
      borrowed: x.borrowed,
    })),
    fromAnchor: fromAnchor.length,
    fromAnchorFailures: fails(fromAnchor).length,
    borrowedErrBps: errs.length
      ? { max: Math.max(...errs), median: errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)] }
      : null,
  });
}
const replaySummary = {
  reserves: replay.filter((r) => (r.snapshotsInWindow as number) >= 2).length,
  reservesWithoutSnapshots: replay
    .filter((r) => (r.snapshotsInWindow as number) < 2)
    .map((r) => `${r.symbol} ${r.reserve}`),
  pairs: replay.reduce((s, r) => s + (r.pairs as number), 0),
  pairFailures: replay.reduce((s, r) => s + (r.pairFailures as unknown[]).length, 0),
  fromAnchor: replay.reduce((s, r) => s + (r.fromAnchor as number), 0),
  fromAnchorFailures: replay.reduce((s, r) => s + (r.fromAnchorFailures as number), 0),
  borrowedErrBpsMax: Math.max(
    0,
    ...replay.map((r) => (r.borrowedErrBps as { max: number } | null)?.max ?? 0),
  ),
  stepsReplayed: replay.reduce((s, r) => s + (r.steps as number), 0),
  notCovered:
    'Jupiter Lend vault state has no hourly raw snapshot inside the window (raw-markets keeps vault configs only; raw-lending starts 21:21Z, after it)',
};
console.log(JSON.stringify({ check: 'replay', ...replaySummary }));

// ------------------------------------------------------------------------------------------------- 4. positions
const vaultToReserve = new Map(
  reserves.map((r) => [r.accounts.collateralSupplyVault as string, r.account]),
);
const posBase = join(RISK_HOME, 'lending-positions');
const firstHour = existsSync(posBase)
  ? readdirSync(posBase)
      .sort()
      .flatMap((d) =>
        readdirSync(join(posBase, d))
          .sort()
          .map((h) => join(posBase, d, h)),
      )[0]
  : undefined;
const positions = {
  snapshot: firstHour ?? null,
  obligations: 0,
  openedInWindow: 0,
  changedAfterWindow: 0,
  checked: 0,
  depositsChecked: 0,
  mismatches: 0,
  mismatchExamples: [] as unknown[],
  ok: true,
};
if (firstHour)
  for (const f of readdirSync(firstHour).filter(
    (x) => x.startsWith('kamino-') && x.endsWith('.raw.json.gz'),
  )) {
    const j = JSON.parse(gunzipSync(readFileSync(join(firstHour, f))).toString()) as {
      slot: number;
      accounts: Record<string, string>;
    };
    for (const [ob, b64] of Object.entries(j.accounts)) {
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length !== KAMINO_OBLIGATION_SIZE) continue;
      positions.obligations++;
      if (!openedInWindow.has(ob)) continue;
      positions.openedInWindow++;
      const o = decodeKaminoObligation(new Uint8Array(bytes));
      if (o.lastUpdateSlot > BigInt(cutSlot)) {
        positions.changedAfterWindow++;
        continue;
      }
      positions.checked++;
      const sums = new Map<string, bigint>();
      for (const [vault, d] of obligationSums.get(ob) ?? []) {
        const reserve = vaultToReserve.get(vault) as string;
        sums.set(reserve, (sums.get(reserve) ?? 0n) + d);
      }
      const reservesSeen = new Set([...sums.keys(), ...o.deposits.map((d) => d.reserve)]);
      for (const reserve of reservesSeen) {
        positions.depositsChecked++;
        const want = o.deposits.find((d) => d.reserve === reserve)?.depositedAmount ?? 0n;
        const got = sums.get(reserve) ?? 0n;
        if (want !== got) {
          positions.mismatches++;
          // obligations are kept locally; the example names the account only in the local verify file
          if (positions.mismatchExamples.length < 10)
            positions.mismatchExamples.push({
              obligation: ob,
              reserve,
              deposited: want.toString(),
              events: got.toString(),
            });
        }
      }
    }
  }
positions.ok = positions.mismatches === 0;
console.log(
  JSON.stringify({
    check: 'positions',
    ...positions,
    mismatchExamples: positions.mismatchExamples.length,
  }),
);

// ------------------------------------------------------------------------------------------------- 5. api
type OnRow = Record<string, unknown> & { kind: string; account: string; fetchedAt: string };
type ApiRow = {
  venue: string;
  account: string;
  symbol: string;
  fetchedAt: string;
  api: Record<string, unknown>;
};
const days = (sub: string) =>
  existsSync(join(RISK_HOME, sub))
    ? readdirSync(join(RISK_HOME, sub)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    : [];
const onRows = days('lending').flatMap((f) => readJsonl<OnRow>(join(RISK_HOME, 'lending', f)));
const apiRows = days('markets').flatMap((f) => readJsonl<ApiRow>(join(RISK_HOME, 'markets', f)));
const onBy = new Map<string, OnRow[]>();
for (const r of onRows) {
  const key =
    r.kind === 'jl_vault' ? `jl:${r.vaultId}` : r.kind === 'kamino_reserve' ? r.account : '';
  if (!key) continue;
  const arr = onBy.get(key) ?? [];
  arr.push(r);
  onBy.set(key, arr);
}
const api: Array<Record<string, unknown>> = [];
const num = (x: unknown) => Number(x);
for (const a of apiRows) {
  const key = a.venue === 'jupiter_lend' ? `jl:${a.api.id}` : a.account;
  const cands = onBy.get(key) ?? [];
  const ta = Date.parse(a.fetchedAt);
  // the API read falls between two on-chain reads; the state it saw is the one before or the one after (a
  // transaction between the two reads changes it), so it must equal one of them after interest accrual
  const withDt = cands.map((r) => ({ r, dt: (Date.parse(r.fetchedAt) - ta) / 1000 }));
  const before = withDt.filter((x) => x.dt <= 0 && x.dt >= -300).sort((x, y) => y.dt - x.dt)[0];
  const after = withDt.filter((x) => x.dt > 0 && x.dt <= 300).sort((x, y) => x.dt - y.dt)[0];
  const sides = [before, after]
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((b) => {
      const r = b.r;
      const fields: Array<{ field: string; onchain: number; api: number; apr: number }> = [];
      if (a.venue === 'kamino') {
        const scale = 10 ** num(r.decimals);
        fields.push({
          field: 'supplied',
          onchain: num(r.supplied) / scale,
          api: num(a.api.totalSupply),
          apr: num(r.supplyApr),
        });
        fields.push({
          field: 'borrowed',
          onchain: num(r.borrowed) / scale,
          api: num(a.api.totalBorrow),
          apr: num(r.borrowApr),
        });
      } else {
        const supplyToken = a.api.supplyToken as { decimals: number };
        const borrowToken = a.api.borrowToken as { decimals: number };
        const internal = num(r.internalDecimals);
        fields.push({
          field: 'collateral',
          onchain: num(r.collateralInternal) / 10 ** (internal - supplyToken.decimals),
          api: num(a.api.totalSupply),
          apr: 0,
        });
        fields.push({
          field: 'debt',
          onchain: num(r.debtInternal) / 10 ** (internal - borrowToken.decimals),
          api: num(a.api.totalBorrow),
          apr: num(r.debtLayerBorrowApr),
        });
        fields.push({
          field: 'liquiditySupplied',
          onchain: num(r.liquiditySupplied),
          api: num(a.api.totalSupplyLiquidity),
          apr: 0,
        });
        fields.push({
          field: 'liquidityBorrowed',
          onchain: num(r.liquidityBorrowed),
          api: num(a.api.totalBorrowLiquidity),
          apr: num(r.debtLayerBorrowApr),
        });
        fields.push({
          field: 'totalPositions',
          onchain: num(r.totalPositions),
          api: num(a.api.totalPositions),
          apr: 0,
        });
      }
      const rows = fields.map((f) => {
        const res = apiResidual(f.onchain, f.api, f.apr, b.dt);
        return {
          ...f,
          onchainAt: r.fetchedAt,
          dtSec: b.dt,
          residual: res,
          ok: Math.abs(res) <= P.apiMatchTolRel,
        };
      });
      return { side: b === before ? 'before' : 'after', rows, ok: rows.every((x) => x.ok) };
    });
  if (!sides.length) continue;
  const maxRes = (x: (typeof sides)[number]) =>
    Math.max(...x.rows.map((y) => Math.abs(y.residual)));
  const chosen = sides.find((x) => x.ok) ?? [...sides].sort((x, y) => maxRes(x) - maxRes(y))[0];
  if (!chosen) continue;
  const changedBetweenReads = sides.length === 2 && sides[0]?.ok !== sides[1]?.ok;
  for (const f of chosen.rows)
    api.push({
      venue: a.venue,
      account: a.account,
      symbol: a.symbol,
      apiAt: a.fetchedAt,
      side: chosen.side,
      changedBetweenReads,
      ...f,
    });
}
const apiFails = api.filter((x) => !x.ok);
const apiSummary = {
  comparisons: api.length,
  apiRowsMatched: new Set(api.map((x) => `${x.account}@${x.apiAt}`)).size,
  failures: apiFails.length,
  matchedAfter: new Set(api.filter((x) => x.side === 'after').map((x) => `${x.account}@${x.apiAt}`))
    .size,
  changedBetweenReads: new Set(
    api.filter((x) => x.changedBetweenReads).map((x) => `${x.account}@${x.apiAt}`),
  ).size,
  maxAbsResidual: Math.max(0, ...api.map((x) => Math.abs(x.residual as number))),
  failuresByField: Object.fromEntries(
    [...new Set(apiFails.map((x) => `${x.venue}.${x.field}`))].map((k) => [
      k,
      apiFails.filter((x) => `${x.venue}.${x.field}` === k).length,
    ]),
  ),
};
console.log(JSON.stringify({ check: 'api', ...apiSummary }));

const stamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, '');
const out = join(DIR, `verify-${stamp}.json`);
writeFileSync(
  out,
  JSON.stringify(
    {
      method: METHOD,
      source:
        'lending history (sigs, byday, decoded) + hourly raw reserve/obligation bytes + 5-min and API rows',
      fetched_at: new Date().toISOString(),
      provenance: 'live',
      params: P,
      walkStart: new Date(walkStart * 1000).toISOString(),
      cutSlot,
      coverage,
      chain: { ...chainSummary, vaults: chain },
      replay: { ...replaySummary, reserves: replay },
      positions,
      api: { ...apiSummary, failures: apiFails, comparisons: api.length },
      secs: Math.round((Date.now() - t0) / 1000),
    },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    1,
  ),
);
console.log(JSON.stringify({ out, secs: Math.round((Date.now() - t0) / 1000) }));

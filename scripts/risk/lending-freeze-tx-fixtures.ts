import 'dotenv/config';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  discOf,
  EVENT_IX_TAG,
  flattenIxs,
  LENDING_PROGRAMS,
  type LendingEvent,
  type RpcTx,
  txAccountKeys,
} from '@colosseum/risk';
import { latestRegistryFile, type RegistryPool } from './lib-history';
import { LENDING_HISTORY_DIR } from './lib-lending';

// Step 10b item 5 — freeze real mainnet lending transactions for tests/risk-layer/lending-tx.test.ts, one per
// event type the decoders produce, picked from the decoded history (`pnpm risk:lending-decode` must have run).
// Each fixture keeps the raw `getTransaction` body, the decode context it needs (symbols of the reserves it touches,
// registry pools it touches) and the SDK's decode of every lending instruction in it (D11): instruction names and
// arguments by Anchor's BorshCoder over klend-sdk 12.0.1's IDLs, or lend-read 0.0.14's program coders.
// Transactions are public chain data; fixtures label no wallet.
// Usage: tsx scripts/risk/lending-freeze-tx-fixtures.ts
const OUT = 'fixtures/risk/lending/txs';
mkdirSync(OUT, { recursive: true });
const DEC = join(LENDING_HISTORY_DIR, 'decoded');
const RAW = join(LENDING_HISTORY_DIR, 'raw');

type Row = { s: string; t: number; ev?: LendingEvent[] };
const want: Array<[string, (r: Row) => boolean]> = [
  [
    'kamino-liquidation-dex-sale',
    (r) => !!r.ev?.some((e) => e.liquidation?.venue === 'kamino' && e.liquidation.sales.length > 0),
  ],
  [
    'kamino-liquidation',
    (r) =>
      !!r.ev?.some(
        (e) =>
          e.liquidation?.venue === 'kamino' &&
          e.liquidation.statedBonusBps !== undefined &&
          Number(e.liquidation.debtRepaid) > 1_000_000,
      ),
  ],
  [
    'jl-liquidation',
    (r) =>
      !!r.ev?.some(
        (e) =>
          e.liquidation?.venue === 'jupiter_lend' && Number(e.liquidation.debtRepaid) > 1_000_000,
      ),
  ],
  [
    'kamino-lender-deposit',
    (r) => !!r.ev?.some((e) => e.ix === 'depositReserveLiquidity' && !e.parentPath && !e.caller),
  ],
  [
    'kamino-lender-redeem',
    (r) => !!r.ev?.some((e) => e.ix === 'redeemReserveCollateral' && !e.parentPath && !e.caller),
  ],
  [
    'kamino-collateral-deposit',
    (r) =>
      !!r.ev?.some(
        (e) => e.ix === 'depositReserveLiquidityAndObligationCollateralV2' && !e.caller,
      ) && !r.ev?.some((e) => e.kind === 'borrow'),
  ],
  [
    'kamino-borrow',
    (r) => !!r.ev?.some((e) => e.ix === 'borrowObligationLiquidityV2' && !e.caller),
  ],
  [
    'kamino-repay-withdraw',
    (r) =>
      !!r.ev?.some((e) => e.ix === 'repayObligationLiquidityV2') &&
      !!r.ev?.some((e) => e.ix === 'withdrawObligationCollateralAndRedeemReserveCollateralV2'),
  ],
  [
    'kamino-repay-and-withdraw-combined',
    (r) => !!r.ev?.some((e) => e.ix === 'repayAndWithdrawAndRedeem'),
  ],
  [
    'kamino-flash-loan',
    (r) => !!r.ev?.some((e) => e.kind === 'flash_borrow' && e.program === 'klend'),
  ],
  [
    'kamino-via-router',
    (r) =>
      !!r.ev?.some(
        (e) => e.program === 'klend' && !!e.caller && !e.parentPath && e.kind !== 'admin',
      ),
  ],
  [
    'kamino-config-interest-basis',
    (r) => !!r.ev?.some((e) => e.config?.some((c) => c.param === 'UpdateInterestRateBasis')),
  ],
  [
    'kamino-config-ltv',
    (r) => !!r.ev?.some((e) => e.config?.some((c) => c.param === 'UpdateLoanToValuePct')),
  ],
  [
    'kvault-reallocation',
    (r) => {
      const inv = r.ev?.filter((e) => e.kind === 'vault_invest') ?? [];
      const kids = r.ev?.filter((e) => inv.some((i) => e.parentPath === i.path)) ?? [];
      return (
        kids.some((k) => k.kind === 'lender_redeem') &&
        kids.some((k) => k.kind === 'lender_deposit')
      );
    },
  ],
  ['kvault-deposit', (r) => !!r.ev?.some((e) => e.ix === 'deposit' && e.program === 'kvault')],
  [
    'kvault-withdraw-disinvest',
    (r) =>
      !!r.ev?.some(
        (e) =>
          e.ix === 'withdraw' &&
          e.program === 'kvault' &&
          r.ev?.some((k) => k.parentPath === e.path && k.kind === 'lender_redeem'),
      ),
  ],
  ['kvault-allocation-config', (r) => !!r.ev?.some((e) => e.kind === 'vault_allocation_config')],
  [
    'jl-operate-deposit-borrow',
    (r) =>
      !!r.ev?.some(
        (e) =>
          e.ix === 'operate' &&
          e.program === 'jl_vaults' &&
          BigInt(String(e.args?.newCol ?? 0)) > 0n &&
          BigInt(String(e.args?.newDebt ?? 0)) > 0n,
      ),
  ],
  [
    'jl-operate-payback-withdraw',
    (r) =>
      !!r.ev?.some(
        (e) =>
          e.ix === 'operate' &&
          e.program === 'jl_vaults' &&
          BigInt(String(e.args?.newCol ?? 0)) < 0n &&
          BigInt(String(e.args?.newDebt ?? 0)) < 0n,
      ),
  ],
  ['jl-flashloan', (r) => !!r.ev?.some((e) => e.program === 'jl_flashloan')],
  ['jl-config', (r) => !!r.ev?.some((e) => e.program === 'jl_vaults' && e.kind === 'config')],
];

const found = new Map<string, Row>();
const days = readdirSync(DEC)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(f))
  .sort()
  .reverse();
for (const f of days) {
  if (found.size === want.length) break;
  for (const l of gunzipSync(readFileSync(join(DEC, f)))
    .toString('utf8')
    .split('\n')) {
    if (!l) continue;
    const r = JSON.parse(l) as Row;
    for (const [name, test] of want)
      if (!found.has(name) && test(r)) found.set(name, { ...r, t: Number(f.slice(0, 4)) && r.t });
  }
}

// SDK coders (D11)
const kRequire = createRequire(
  join(realpathSync('node_modules/@kamino-finance/klend-sdk'), 'package.json'),
);
type Coder = { instruction: { decode(b: Buffer): { name: string; data: unknown } | null } };
const anchor = kRequire('@coral-xyz/anchor') as { BorshCoder: new (idl: unknown) => Coder };
const idlDir = join(realpathSync('node_modules/@kamino-finance/klend-sdk'), 'dist', 'idl');
const { Client } = await import('@jup-ag/lend-read');
const client = new Client(
  process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899',
) as unknown as Record<'vault' | 'liquidity' | 'lending', { program: { coder: Coder } }>;
const coders: Record<string, Coder> = {
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: new anchor.BorshCoder(
    JSON.parse(readFileSync(join(idlDir, 'klend.json'), 'utf8')),
  ),
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: new anchor.BorshCoder(
    JSON.parse(readFileSync(join(idlDir, 'kvault.json'), 'utf8')),
  ),
  jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi: client.vault.program.coder,
  jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC: client.liquidity.program.coder,
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: client.lending.program.coder,
};
/** SDK values to plain JSON: BN and bigint as decimal strings, PublicKey as base58, bytes as hex. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'object') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  const o = v as Record<string, unknown> & { toBase58?: () => string };
  if (typeof o.toBase58 === 'function') return o.toBase58();
  if (o.constructor?.name === 'BN') return String(o);
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
}

// decode context
const lreg = JSON.parse(
  readFileSync(join(homedir(), '.colosseum', 'risk', 'lending-registry.json'), 'utf8'),
) as {
  rows: Array<{ account: string; venue: string; symbol: string | null }>;
};
const dreg = JSON.parse(readFileSync(latestRegistryFile(), 'utf8')) as { pools: RegistryPool[] };

const rawCache = new Map<string, Map<string, { sl: number; t: number; tx: RpcTx }>>();
function rawTx(sig: string, day: string) {
  let m = rawCache.get(day);
  if (!m) {
    m = new Map();
    for (const l of gunzipSync(readFileSync(join(RAW, `${day}.jsonl.gz`)))
      .toString('utf8')
      .split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l) as { s: string; sl: number; t: number; tx: RpcTx };
      m.set(r.s, r);
    }
    rawCache.set(day, m);
  }
  return m.get(sig);
}

const missing: string[] = [];
for (const [name] of want) {
  const r = found.get(name);
  if (!r) {
    missing.push(name);
    continue;
  }
  const day = new Date(r.t * 1000).toISOString().slice(0, 10);
  const raw = rawTx(r.s, day);
  if (!raw) {
    missing.push(`${name} (raw body not found)`);
    continue;
  }
  const keys = new Set(txAccountKeys(raw.tx));
  const sdk = flattenIxs(raw.tx)
    .filter((ix) => LENDING_PROGRAMS.has(ix.program) && discOf(ix.data) !== EVENT_IX_TAG)
    .map((ix) => {
      const c = coders[ix.program];
      const d = c?.instruction.decode(Buffer.from(ix.data)) ?? null;
      return {
        path: ix.path,
        program: ix.program,
        name: d?.name ?? null,
        args: d ? plain(d.data) : null,
      };
    });
  const fx = {
    name,
    signature: r.s,
    slot: raw.sl,
    blockTime: raw.t,
    frozenAt: new Date().toISOString(),
    ctx: {
      reserveSymbols: Object.fromEntries(
        lreg.rows
          .filter((x) => x.venue === 'kamino' && x.symbol && keys.has(x.account))
          .map((x) => [x.account, x.symbol]),
      ),
      pools: Object.fromEntries(
        dreg.pools
          .filter((p) => keys.has(p.address))
          .map((p) => [p.address, { venue: p.venue, mint0: p.mint0, mint1: p.mint1 }]),
      ),
    },
    sdk,
    tx: raw.tx,
  };
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(fx));
  console.log(name, r.s.slice(0, 16), day, `${sdk.length} lending ix`);
}
console.log(JSON.stringify({ frozen: want.length - missing.length, missing }));

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BYREAL_CLMM_PROGRAM, byrealFee, decodeClmmPool } from '@colosseum/risk';
import { JUPITER_API_BASE, jupHeaders, nowIso, RPC_URL, sleep } from '../../lib';
import { rpc, rpcStats } from '../lib-pools';
import {
  BYREAL_QUOTE_TOLERANCE,
  BYREAL_VALIDATE_METHOD,
  type ByrealInvariantRow,
  type ByrealPoolsFile,
  type ByrealQuoteRow,
  type ByrealValidatedPool,
  type ByrealValidationFile,
  byrealInvariantRow,
  byrealSimulate,
  byrealVerdict,
  DOLLARS,
} from './lib';
import { readByrealChildren } from './read';

// PLAN-UNIVERSE RU.15 — `pnpm risk:byreal-validate <table.json> [out.json] [--quote POOL,…] [--no-quotes]
// [--max-quotes N]`: the validation decision D4 of PLAN-RISK asks of a new decoder, as Step 2 did it for the four we
// have (scripts/risk/validate-clmm.ts). Read-only: no transaction, no key of ours, no database,
// nothing under ~/.colosseum. No oracle account is read and no pool price is set against an oracle.
//
// (a) The liquidity check, on every pool of the table: the pool account, then every account that names it in one
//     getProgramAccounts (one slot for all its arrays), each read as the kind its own first 8 bytes say. The ticks at
//     or below the price must add up to the pool's stored liquidity and all the ticks to nothing, exactly. A pool whose
//     check does not hold is read once more (a deposit between the two reads would fail it); both reads are kept.
// (b) Jupiter's own quote through the same pool (`onlyDirectRoutes`, `dexes=Byreal`), for the pools named by
//     `--quote` (addresses; default: none), a sale and a purchase at $1,000, $10,000 and $100,000. The pool account is
//     read just before each quote and again after it, until the read's slot has reached the slot Jupiter gives for
//     its quote; our simulation runs on the read before. Every read is at the `confirmed` commitment: a finalized
//     read is about 32 slots behind the state Jupiter quotes on. A pair is a comparison of one state only when the
//     pool's price, tick and liquidity are the same in both reads and Jupiter's slot lies between them. One that is
//     not is asked once more; the first try is kept under `retaken` with its numbers, and a second that is still
//     not one state is kept, marked, and not counted.
//     Jupiter's key is the collector's: calls are 1.4 s apart, none is made in minutes 4, 19, 34 and 49 or in the 40 s
//     after them, when the collector's quote job runs, and a run makes at most `--max-quotes` (default 24).
// The file written keeps every quoted pool whole (its config, every account it owns, each quote with the pool account
// it was set against), so the comparison can be run again from the file alone: `pnpm risk:byreal-report` prints it,
// and `pnpm risk:byreal-freeze-fixture` cuts one pool out of it for the tests.
const args = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const v = args[at + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} takes a value`);
  return v;
};
const quotePools = [...new Set((flagValue('--quote') ?? '').split(',').filter(Boolean))];
const maxQuotes = Number(flagValue('--max-quotes') ?? 24);
if (!Number.isSafeInteger(maxQuotes) || maxQuotes < 1)
  throw new Error('--max-quotes takes an integer of 1 or more');
const noQuotes = args.includes('--no-quotes');
const taken = new Set<number>();
for (const f of ['--quote', '--max-quotes']) {
  const at = args.indexOf(f);
  if (at >= 0) taken.add(at + 1);
}
const positional = args.filter((a, i) => !a.startsWith('--') && !taken.has(i));
const tableFile = positional[0];
if (!tableFile) throw new Error('usage: validate.ts <table.json> [out.json] [--quote POOL,…]');
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');
const out = positional[1] ?? join('data', 'risk', 'byreal', `validate-${stamp}.json`);
if (RPC_URL === 'https://api.mainnet-beta.solana.com')
  throw new Error(
    'SOLANA_RPC_URL is not set: point DOTENV_CONFIG_PATH at the .env that has it (the public RPC is not used here)',
  );
const table = JSON.parse(readFileSync(tableFile, 'utf8')) as ByrealPoolsFile;
const SIZES = [1_000, 10_000, 100_000];
const JUPITER_GAP_MS = 1_400;

type Info = { context: { slot: number }; value: { owner: string; data: [string, string] } | null };
const COMMITMENT = 'confirmed';
const readPool = async (pool: string): Promise<{ slot: number; data: Uint8Array }> => {
  const r = await rpc<Info>('getAccountInfo', [
    pool,
    { encoding: 'base64', commitment: COMMITMENT },
  ]);
  if (!r.value || r.value.owner !== BYREAL_CLMM_PROGRAM)
    throw new Error(`${pool}: not an account of Byreal`);
  return { slot: r.context.slot, data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')) };
};
const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

const started = Date.now();
const fetchedAt = nowIso();

// (a) the liquidity check on every pool of the table
const invariant: ByrealInvariantRow[] = [];
const invariantFirstReads: ByrealInvariantRow[] = [];
const checkOnce = async (pool: string, stocks: string[]) => {
  const head = await readPool(pool);
  const kids = await readByrealChildren(pool, COMMITMENT);
  return byrealInvariantRow(
    pool,
    stocks,
    head.data,
    kids.accounts.map((a) => a.data),
    { pool: head.slot, arrays: kids.slot },
  );
};
for (const r of [...table.rows].sort((a, b) => a.pool.localeCompare(b.pool))) {
  let row = await checkOnce(r.pool, r.stocks);
  if (!row.holds) {
    invariantFirstReads.push(row);
    row = await checkOnce(r.pool, r.stocks);
  }
  invariant.push(row);
}

// (b) Jupiter's quote through the same pool
let jupiterQuotes = 0;
let lastQuoteAt = 0;
const outOfTheCollectorsWay = async () => {
  for (;;) {
    const now = new Date();
    const m = now.getUTCMinutes() % 15;
    const s = now.getUTCSeconds();
    // minutes 4, 19, 34, 49 and the 40 s after them; the 20 s before them too, so that a call never runs into one
    const busy = m === 4 || (m === 5 && s < 40) || (m === 3 && s >= 40);
    if (!busy) return;
    await sleep(5_000);
  }
};
type JupiterAnswer = {
  outAmount?: string;
  contextSlot?: number;
  error?: string;
  errorCode?: string;
  routePlan?: Array<{
    percent?: number;
    swapInfo: {
      ammKey: string;
      label?: string;
      feeAmount?: string;
      feeMint?: string;
    };
  }>;
};
const quote = async (inputMint: string, outputMint: string, amount: number) => {
  if (jupiterQuotes >= maxQuotes)
    throw new Error(`more than ${maxQuotes} Jupiter quotes asked for`);
  await outOfTheCollectorsWay();
  const wait = lastQuoteAt + JUPITER_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  jupiterQuotes++;
  const url = `${JUPITER_API_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50&swapMode=ExactIn&onlyDirectRoutes=true&dexes=Byreal`;
  try {
    const res = await fetch(url, { headers: jupHeaders(), signal: AbortSignal.timeout(20_000) });
    lastQuoteAt = Date.now();
    return { status: res.status, body: (await res.json()) as JupiterAnswer };
  } catch (e) {
    lastQuoteAt = Date.now();
    return { status: 0, body: { error: String(e).slice(0, 120) } as JupiterAnswer };
  }
};

const quoted: ByrealValidatedPool[] = [];
for (const pool of noQuotes ? [] : quotePools) {
  if (jupiterQuotes >= maxQuotes) break;
  const row = table.rows.find((r) => r.pool === pool);
  if (!row) throw new Error(`${pool}: not a pool of the table`);
  const first = await readPool(pool);
  const h = decodeClmmPool(first.data);
  const stockIsToken0 = !DOLLARS[h.mint0];
  const stockMint = stockIsToken0 ? h.mint0 : h.mint1;
  const quoteMint = stockIsToken0 ? h.mint1 : h.mint0;
  if (!DOLLARS[quoteMint] || row.stocks.length !== 1)
    throw new Error(`${pool}: not a pool of one tracked stock against a dollar token`);
  const decStock = stockIsToken0 ? h.decimals0 : h.decimals1;
  const decQuote = stockIsToken0 ? h.decimals1 : h.decimals0;
  const cfg = await rpc<Info>('getAccountInfo', [
    h.ammConfig,
    { encoding: 'base64', commitment: COMMITMENT },
  ]);
  if (!cfg.value) throw new Error(`${pool}: its fee config was not returned`);
  const config = new Uint8Array(Buffer.from(cfg.value.data[0], 'base64'));
  const fee = byrealFee(first.data, config);
  if (!fee.priced) throw new Error(`${pool}: ${fee.reason}: not priced from its own accounts`);
  let kids = await readByrealChildren(pool, COMMITMENT);
  const one = async (side: 'sell' | 'buy', usd: number): Promise<ByrealQuoteRow> => {
    const before = await readPool(pool);
    const hb = decodeClmmPool(before.data);
    const p01 = (Number(hb.sqrtPriceX64) / 2 ** 64) ** 2;
    // dollars per stock token, in the tokens' own units
    const price = (stockIsToken0 ? p01 : 1 / p01) * 10 ** (decStock - decQuote);
    const amountIn =
      side === 'sell' ? Math.floor((usd / price) * 10 ** decStock) : usd * 10 ** decQuote;
    const at = nowIso();
    const answer = await quote(
      side === 'sell' ? stockMint : quoteMint,
      side === 'sell' ? quoteMint : stockMint,
      amountIn,
    );
    // read again until our RPC has reached the slot Jupiter quoted at (a few tries, 400 ms apart)
    let after = await readPool(pool);
    for (let i = 0; i < 12 && after.slot < (answer.body.contextSlot ?? 0); i++) {
      await sleep(400);
      after = await readPool(pool);
    }
    const ha = decodeClmmPool(after.data);
    const sameState =
      hb.sqrtPriceX64 === ha.sqrtPriceX64 &&
      hb.liquidity === ha.liquidity &&
      hb.tickCurrent === ha.tickCurrent;
    const run = () =>
      byrealSimulate(
        pool,
        before.data,
        config,
        kids.accounts.map((a) => a.data),
        stockIsToken0,
        side,
        amountIn,
      );
    let sim: ReturnType<typeof byrealSimulate>;
    try {
      sim = run();
    } catch (e) {
      if (!/byreal (liquidity|arrays) check/.test(String(e))) throw e;
      // the arrays read at the start no longer add up to this pool account: read them again, once
      kids = await readByrealChildren(pool, COMMITMENT);
      sim = run();
    }
    const leg = answer.body.routePlan?.[0];
    const samePool =
      !!answer.body.outAmount &&
      answer.body.routePlan?.length === 1 &&
      leg?.swapInfo.ammKey === pool;
    const jupiter = samePool
      ? {
          outAmount: answer.body.outAmount as string,
          contextSlot: answer.body.contextSlot ?? null,
          ammKey: (leg as NonNullable<typeof leg>).swapInfo.ammKey,
          label: leg?.swapInfo.label ?? null,
          feeAmount: leg?.swapInfo.feeAmount ?? null,
          feeMint: leg?.swapInfo.feeMint ?? null,
        }
      : null;
    const slot = jupiter?.contextSlot ?? null;
    return {
      side,
      usd,
      amountIn: String(amountIn),
      head: b64(before.data),
      slotBefore: before.slot,
      slotAfter: after.slot,
      sameState,
      bracketed: slot !== null && before.slot <= slot && slot <= after.slot,
      fetchedAt: at,
      jupiter,
      jupiterError: jupiter
        ? null
        : answer.body.outAmount
          ? `Jupiter's route is not this pool alone (${(answer.body.routePlan ?? []).map((l) => l.swapInfo.ammKey.slice(0, 6)).join(', ')})`
          : `HTTP ${answer.status}: ${answer.body.errorCode ?? answer.body.error ?? 'no quote'}`,
      simOut: sim.out,
      unfilledShare: sim.unfilledShare,
      ticksCrossed: sim.ticksCrossed,
      relDiff: jupiter ? (sim.out - Number(jupiter.outAmount)) / Number(jupiter.outAmount) : null,
    };
  };
  const quotes: ByrealQuoteRow[] = [];
  const retaken: ByrealQuoteRow[] = [];
  for (const side of ['sell', 'buy'] as const)
    for (const usd of SIZES) {
      // at the cap the run stops asking and writes what it has: a pool with fewer than six trades says so by itself
      if (jupiterQuotes >= maxQuotes) continue;
      let q = await one(side, usd);
      // a quote that came back and is not of one state is asked once more, while the run's quotes last
      if (q.jupiter && !(q.sameState && q.bracketed) && jupiterQuotes < maxQuotes) {
        retaken.push(q);
        q = await one(side, usd);
      }
      quotes.push(q);
    }
  const counts = byrealInvariantRow(
    pool,
    row.stocks,
    first.data,
    kids.accounts.map((a) => a.data),
    { pool: first.slot, arrays: kids.slot },
  ).accounts;
  quoted.push({
    pool,
    stock: row.stocks[0] as string,
    stockMint,
    quoteMint,
    stockIsToken0,
    tradeFeeRate: fee.tradeFeeRate,
    feeFrom: fee.from,
    config: { address: h.ammConfig, data: b64(config) },
    children: Object.fromEntries(kids.accounts.map((a) => [a.address, b64(a.data)])),
    childrenSlot: kids.slot,
    accounts: counts,
    quotes,
    retaken,
  });
}

const file: ByrealValidationFile = {
  method: BYREAL_VALIDATE_METHOD,
  source: `Solana RPC (getAccountInfo of each pool and fee config, getProgramAccounts of ${BYREAL_CLMM_PROGRAM} for the accounts that name each pool at byte 8); Jupiter ${JUPITER_API_BASE}/quote with onlyDirectRoutes=true and dexes=Byreal`,
  fetchedAt,
  provenance: 'live',
  program: BYREAL_CLMM_PROGRAM,
  table: { file: tableFile, fetchedAt: table.fetchedAt },
  tolerance: BYREAL_QUOTE_TOLERANCE,
  invariant,
  invariantFirstReads,
  quoted,
  jupiterQuotes,
  rpc: {
    calls: rpcStats.calls,
    retries429: rpcStats.retries429,
    errors: rpcStats.errors,
    seconds: (Date.now() - started) / 1000,
  },
};
mkdirSync(dirname(out), { recursive: true });
// the pools quoted are kept whole in the file: without their accounts the comparison could not be run again
writeFileSync(out, `${JSON.stringify(file)}\n`);
const verdict = byrealVerdict(file);
console.log(
  JSON.stringify(
    {
      out,
      fetchedAt,
      invariant: {
        ...verdict.invariant,
        accounts: invariant.reduce(
          (s, r) => ({
            fixed: s.fixed + r.accounts.fixed,
            dynamic: s.dynamic + r.accounts.dynamic,
            neither: s.neither + r.accounts.neither,
          }),
          { fixed: 0, dynamic: 0, neither: 0 },
        ),
        ticks: invariant.reduce(
          (s, r) => ({ fixed: s.fixed + r.ticks.fixed, dynamic: s.dynamic + r.ticks.dynamic }),
          { fixed: 0, dynamic: 0 },
        ),
        slotsApart: {
          max: Math.max(...invariant.map((r) => Math.abs(r.slots.arrays - r.slots.pool))),
          median: [...invariant.map((r) => Math.abs(r.slots.arrays - r.slots.pool))].sort(
            (a, b) => a - b,
          )[Math.floor(invariant.length / 2)],
        },
        readAgain: invariantFirstReads.map((r) => r.pool),
      },
      quotes: quoted.map((p) => ({
        pool: p.pool,
        stock: p.stock,
        feeMillionths: p.tradeFeeRate,
        feeFrom: p.feeFrom,
        accounts: p.accounts,
        rows: p.quotes.map((q) => ({
          side: q.side,
          usd: q.usd,
          relDiff: q.relDiff === null ? null : Number(q.relDiff.toExponential(3)),
          sameState: q.sameState,
          bracketed: q.bracketed,
          ticksCrossed: q.ticksCrossed,
          unfilledShare: Number(q.unfilledShare.toFixed(4)),
          slotsBeforeToJupiter:
            q.jupiter?.contextSlot == null ? null : q.jupiter.contextSlot - q.slotBefore,
          slotsBeforeToAfter: q.slotAfter - q.slotBefore,
          jupiterError: q.jupiterError,
        })),
      })),
      retaken: quoted.flatMap((p) =>
        p.retaken.map((q) => ({
          pool: p.pool,
          side: q.side,
          usd: q.usd,
          relDiff: q.relDiff === null ? null : Number(q.relDiff.toExponential(3)),
          sameState: q.sameState,
          bracketed: q.bracketed,
        })),
      ),
      verdict: verdict.quotes,
      everyComparisonWithin: verdict.everyComparisonWithin,
      threePoolsWithAllSix: verdict.threePoolsWithAllSix,
      jupiterQuotes,
      rpc: file.rpc,
    },
    null,
    1,
  ),
);

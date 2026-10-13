import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assets, createDb, yieldObservations } from '@colosseum/db';
import { applyHaircut, fetchRealised30d } from '@colosseum/engine';
import type { YieldObservation } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import { MODEL_ASSETS } from '../seed-models';
import { DAY_S, LOOKBACK, type Round, realisedFromRounds, WINDOW_DAYS } from './model-rounds';

// Yield readings of the mainnet tokens a test network's dollar-yield stand-ins model and the registry
// does not hold (gate ENG-DEVNET-EXIT-TWIN): jlUSDC on Solana (tjlUSDC) and SGOV on Robinhood Chain
// (tSGOV). `pnpm feeds:refresh` covers the registry; a stand-in whose model has no reading is left out
// of a plan (NO_YIELD), which left a devnet income plan with one dollar-yield token and three quarters
// in cash. Run: pnpm feeds:refresh-models. Read-only on both chains; it writes yield_observations only.
// The models' `assets` rows are the seed's (scripts/seed-models.ts and seed-evm.ts, `pnpm db:seed`).
//
//   jlUSDC  realised over 30 days from its price path (it accrues by price), as the registry's tokens
//           are read (`fetchRealised30d`, DefiLlama coins)
//   SGOV    realised over 30 days from its Chainlink feed on Robinhood Chain, which carries the
//           multiplier the token pays its yield through; the rounds are read with eth_call, and the
//           reading is refused where the feed is old, short or in a distribution fall (model-rounds.ts)

const { db, client } = createDb();
const written: Array<Record<string, unknown>> = [];
const unchanged: Array<Record<string, unknown>> = [];
const errors: Array<{ model: string; error: string }> = [];

async function store(o: YieldObservation) {
  // A reading stamped with its source's own time (SGOV's newest round) is the same reading until the
  // source moves: it is stored once.
  const [same] = await db
    .select({ id: yieldObservations.assetId })
    .from(yieldObservations)
    .where(
      and(
        eq(yieldObservations.assetId, o.assetId),
        eq(yieldObservations.method, o.method),
        eq(yieldObservations.fetchedAt, new Date(o.fetchedAt)),
      ),
    )
    .limit(1);
  if (same) {
    unchanged.push({ assetId: o.assetId, fetchedAt: o.fetchedAt });
    return;
  }
  await db.insert(yieldObservations).values({
    assetId: o.assetId,
    quotedYield: String(o.quotedYield),
    haircutYield: String(o.haircutYield),
    haircutRule: o.haircutRule,
    source: o.source,
    method: o.method,
    fetchedAt: new Date(o.fetchedAt),
    provenance: o.provenance,
  });
  written.push({
    assetId: o.assetId,
    method: o.method,
    quoted: o.quotedYield,
    haircut: o.haircutYield,
    rule: o.haircutRule,
    fetchedAt: o.fetchedAt,
  });
}

// ---------------------------------------------------------------------------------------- jlUSDC
const JLUSDC = MODEL_ASSETS.find((a) => a.id === 'jlusdc');
try {
  const [seeded] = JLUSDC
    ? await db.select({ id: assets.id }).from(assets).where(eq(assets.id, JLUSDC.id)).limit(1)
    : [];
  if (!JLUSDC || !seeded)
    errors.push({ model: 'jlUSDC', error: 'no assets row jlusdc: seed it first (pnpm db:seed)' });
  else {
    // read as a token that accrues by price is read; the haircut is the realised one
    const r = await fetchRealised30d(JLUSDC);
    if (r.observation) await store(r.observation);
    else errors.push({ model: 'jlUSDC', error: r.error ?? 'unknown' });
  }
} catch (e) {
  errors.push({ model: 'jlUSDC', error: String(e).slice(0, 200) });
}

// ------------------------------------------------------------------------------------------ SGOV
const RPC = process.env.RISK_EVM_RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const LIST = join(process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe', 'robinhood.json');
/** Rounds read back at most: a feed with a daily heartbeat writes about thirty in the window. */
const MAX_ROUNDS = 400;
const TRIES = 3;

const word = (hex: string, i: number) => BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
const roundOf = (hex: string): Round | null =>
  hex.length >= 2 + 64 * 5
    ? { id: word(hex, 0), answer: word(hex, 1), updatedAt: Number(word(hex, 3)) }
    : null;
/**
 * One eth_call (public endpoints refuse batches), tried again before it fails: a round that cannot be
 * read stops the run, it never shortens the window.
 */
async function call(to: string, data: string): Promise<string> {
  let last = '';
  for (let t = 0; t < TRIES; t++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = (await res.json()) as { result?: string; error?: { message?: string } };
      if (j.result) return j.result;
      last = j.error?.message ?? `HTTP ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 1000 * (t + 1)));
  }
  throw new Error(`the feed read failed after ${TRIES} tries: ${last.slice(0, 120)}`);
}
const LATEST_ROUND_DATA = '0xfeaf968c';
const getRoundData = (id: bigint) => `0x9a6fc8f5${id.toString(16).padStart(64, '0')}`;

try {
  const list = JSON.parse(readFileSync(LIST, 'utf8')) as {
    assets: Array<{ id: string; symbol: string; oracle?: { kind?: string; ref?: string } }>;
  };
  const sgov = list.assets.find((a) => a.symbol === 'SGOV');
  const feed = sgov?.oracle?.kind === 'chainlink' ? sgov.oracle.ref : undefined;
  const [row] = sgov ? await db.select().from(assets).where(eq(assets.id, sgov.id)).limit(1) : [];
  if (!sgov || !feed)
    errors.push({ model: 'SGOV', error: `no Chainlink feed for SGOV in ${LIST}` });
  else if (!row)
    errors.push({
      model: 'SGOV',
      error: `no assets row ${sgov.id}: the Robinhood Chain stocks are seeded first (pnpm db:seed)`,
    });
  else {
    const latest = roundOf(await call(feed, LATEST_ROUND_DATA));
    if (!latest || latest.answer <= 0n) throw new Error('the feed gave no latest round');
    // Back from the latest round, one by one, past the start of the window by the rounds the fall
    // check looks at. The round id keeps its phase in its high bits: a phase's first round ends it.
    const from = latest.updatedAt - WINDOW_DAYS * DAY_S;
    const rounds: Round[] = [latest];
    let past = 0;
    for (let k = 1n; k <= BigInt(MAX_ROUNDS) && past <= LOOKBACK; k++) {
      const id = latest.id - k;
      if ((id & 0xffff_ffff_ffff_ffffn) < 1n) break;
      const r = roundOf(await call(feed, getRoundData(id)));
      if (!r || r.updatedAt === 0) break;
      rounds.unshift(r);
      if (r.updatedAt <= from) past++;
    }
    const got = realisedFromRounds(rounds, Math.floor(Date.now() / 1000));
    if (!got.ok) errors.push({ model: 'SGOV', error: got.error });
    else {
      // a rate token read by its realised price path, as USDY is: the realised haircut
      const { haircutYield, rule } = applyHaircut(
        { kind: 'usd_yield', mintPath: 'dex_swap' },
        'realised_30d',
        got.quoted,
      );
      await store({
        assetId: sgov.id,
        quotedYield: got.quoted,
        haircutYield,
        haircutRule: rule.id,
        source: `Chainlink SGOV-USD feed ${feed} on Robinhood Chain (chain 4663), rounds ${got.first.id} to ${got.latest.id} by eth_call getRoundData: ${got.days.toFixed(1)} days, ${got.rounds} rounds`,
        method: 'realised_30d',
        // the time of the feed's newest round, not of this run: an old feed shows as old
        fetchedAt: new Date(got.latest.updatedAt * 1000).toISOString(),
        provenance: 'live',
      });
    }
  }
} catch (e) {
  errors.push({ model: 'SGOV', error: String(e).slice(0, 200).replace(RPC, '<rpc>') });
}

console.log(JSON.stringify({ written, unchanged, errors }, null, 1));
await client.end();

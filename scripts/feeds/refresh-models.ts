import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assets, createDb, yieldObservations } from '@colosseum/db';
import { applyHaircut, fetchRealised30d } from '@colosseum/engine';
import { Asset, type YieldObservation } from '@colosseum/schemas';
import { eq } from 'drizzle-orm';

// Yield readings of the mainnet tokens a test network's dollar-yield stand-ins model and the registry
// does not hold (gate ENG-DEVNET-EXIT-TWIN): jlUSDC on Solana (tjlUSDC) and SGOV on Robinhood Chain
// (tSGOV). `pnpm feeds:refresh` covers the registry; a stand-in whose model has no reading is left out
// of a plan (NO_YIELD), which left a devnet income plan with one dollar-yield token and three quarters
// in cash. Run: pnpm feeds:refresh-models. Read-only on both chains; it writes yield_observations, and
// the `assets` row of jlUSDC if it is not there (offered to no plan: no profile, cap 0).
//
//   jlUSDC  realised over 30 days from its price path (it accrues by price), as the registry's tokens
//           are read (`fetchRealised30d`, DefiLlama coins)
//   SGOV    realised over 30 days from its Chainlink feed on Robinhood Chain, which carries the
//           multiplier the token pays its yield through; the rounds are read with eth_call

const { db, client } = createDb();
const written: Array<Record<string, unknown>> = [];
const errors: Array<{ model: string; error: string }> = [];

async function store(o: YieldObservation) {
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
const JLUSDC = Asset.parse({
  id: 'jlusdc',
  symbol: 'jlUSDC',
  name: 'Jupiter Lend USDC (the model of the test-network tjlUSDC; offered to no plan here)',
  kind: 'usd_yield',
  chain: 'solana',
  mint: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D',
  tokenProgram: 'token',
  decimals: 6,
  eligibleProfiles: [],
  capWeight: 0,
  mintPath: 'unavailable',
  metadata: {
    issuer: 'Jupiter Lend',
    creditExposure: 'a deposit in the Jupiter Lend liquidity layer, lent to its borrowers',
    oracle: 'the token accrues by its exchange price',
    redemptionPath: 'withdraw from Jupiter Lend while the layer has liquidity',
    redemptionTime: 'instant while the layer has liquidity; utilisation-gated',
    gates: [],
    docsUrl: 'https://jup.ag/lend',
  },
  provenance: 'live',
});
try {
  await db
    .insert(assets)
    .values({
      id: JLUSDC.id,
      symbol: JLUSDC.symbol,
      name: JLUSDC.name,
      kind: JLUSDC.kind,
      chain: JLUSDC.chain,
      mint: JLUSDC.mint ?? null,
      tokenProgram: JLUSDC.tokenProgram ?? null,
      decimals: JLUSDC.decimals ?? null,
      eligibleProfiles: JLUSDC.eligibleProfiles,
      capWeight: String(JLUSDC.capWeight),
      mintPath: JLUSDC.mintPath,
      metadata: JLUSDC.metadata,
      provenance: JLUSDC.provenance,
    })
    .onConflictDoNothing();
  // read as a token that accrues by price is read; the haircut is the realised one
  const r = await fetchRealised30d({ ...JLUSDC, mintPath: 'dex_swap' });
  if (r.observation) await store(r.observation);
  else errors.push({ model: 'jlUSDC', error: r.error ?? 'unknown' });
} catch (e) {
  errors.push({ model: 'jlUSDC', error: String(e).slice(0, 200) });
}

// ------------------------------------------------------------------------------------------ SGOV
const RPC = process.env.RISK_EVM_RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const LIST = join(process.env.RISK_UNIVERSE_DIR ?? 'scripts/risk/universe', 'robinhood.json');
const DAY = 86_400;
const WINDOW_DAYS = 30;
/** Rounds read back at most: a feed with a daily heartbeat writes about thirty in the window. */
const MAX_ROUNDS = 400;

type Round = { id: bigint; answer: bigint; updatedAt: number };
const word = (hex: string, i: number) => BigInt(`0x${hex.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
const roundOf = (hex: string): Round | null =>
  hex.length >= 2 + 64 * 5
    ? { id: word(hex, 0), answer: word(hex, 1), updatedAt: Number(word(hex, 3)) }
    : null;
/** One eth_call: public endpoints refuse batches, and a feed with a daily heartbeat needs about thirty. */
async function call(to: string, data: string): Promise<string | null> {
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
  return ((await res.json()) as { result?: string }).result ?? null;
}
const LATEST_ROUND_DATA = '0xfeaf968c';
const getRoundData = (id: bigint) => `0x9a6fc8f5${id.toString(16).padStart(64, '0')}`;

try {
  const list = JSON.parse(readFileSync(LIST, 'utf8')) as {
    assets: Array<{
      id: string;
      symbol: string;
      oracle?: { kind?: string; ref?: string; decimals?: number };
    }>;
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
    const head = await call(feed, LATEST_ROUND_DATA);
    const latest = head ? roundOf(head) : null;
    if (!latest || latest.answer <= 0n) throw new Error('the feed gave no latest round');
    // Back from the latest round, one by one, to the first at or before the start of the window. The
    // round id keeps its phase in its high bits: a phase's first round ends the walk.
    const from = latest.updatedAt - WINDOW_DAYS * DAY;
    let first: Round = latest;
    let read = 1;
    for (let k = 1n; k <= BigInt(MAX_ROUNDS); k++) {
      const id = latest.id - k;
      if ((id & 0xffff_ffff_ffff_ffffn) < 1n) break;
      const hex = await call(feed, getRoundData(id));
      const r = hex ? roundOf(hex) : null;
      if (!r || r.answer <= 0n || r.updatedAt === 0) break;
      read++;
      first = r;
      if (r.updatedAt <= from) break;
    }
    const days = (latest.updatedAt - first.updatedAt) / DAY;
    if (days < 20)
      errors.push({
        model: 'SGOV',
        error: `window too short (${days.toFixed(1)} days over ${read} rounds of the feed)`,
      });
    else {
      const quoted = (Number(latest.answer) / Number(first.answer)) ** (365 / days) - 1;
      // a rate token read by its realised price path, as USDY is: the realised haircut
      const { haircutYield, rule } = applyHaircut(
        { kind: 'usd_yield', mintPath: 'dex_swap' },
        'realised_30d',
        quoted,
      );
      await store({
        assetId: sgov.id,
        quotedYield: quoted,
        haircutYield,
        haircutRule: rule.id,
        source: `Chainlink SGOV-USD feed ${feed} on Robinhood Chain (chain 4663), rounds ${first.id} to ${latest.id} by eth_call getRoundData: ${days.toFixed(1)} days, ${read} rounds`,
        method: 'realised_30d',
        fetchedAt: new Date().toISOString(),
        provenance: 'live',
      });
    }
  }
} catch (e) {
  errors.push({ model: 'SGOV', error: String(e).slice(0, 200).replace(RPC, '<rpc>') });
}

console.log(JSON.stringify({ written, errors }, null, 1));
await client.end();

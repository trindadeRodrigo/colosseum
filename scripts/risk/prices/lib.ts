import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildPriceIndex,
  buildSessionClock,
  defaultLivenessParams,
  defaultPriceParams,
  defaultRegimeParams,
  markLiveness,
  type PriceContext,
  type PriceIndex,
  type PriceObservation,
  type PriceSourceId,
  sourceKind,
} from '@colosseum/risk';
import { LENDING_DATA, RISK_HOME, USDC } from '../lib-lending';

// Step 11 — shared pieces of the price scripts. Observations live in
// `data/risk/prices/obs/<priceSource>/<method>/<day>.jsonl.gz` (gitignored), one row per observation with its
// provenance; `<day>` is the UTC day of the observation.
export const PRICES_DIR = join(LENDING_DATA, 'prices');
export const OBS_DIR = join(PRICES_DIR, 'obs');
export const PRICES_METHOD_VERSION = 'prices-0.1';

export type StoredObservation = PriceObservation & {
  source: string;
  fetchedAt: string;
  methodVersion: string;
  provenance: 'live';
};

export const readJsonl = <T>(f: string): T[] =>
  (f.endsWith('.gz') ? gunzipSync(readFileSync(f)).toString('utf8') : readFileSync(f, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

export const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export function writeObservations(
  priceSource: PriceSourceId,
  method: string,
  day: string,
  rows: StoredObservation[],
) {
  const dir = join(OBS_DIR, priceSource.replace(':', '_'), method);
  mkdirSync(dir, { recursive: true });
  rows.sort((a, b) => a.t - b.t || (a.slot ?? 0) - (b.slot ?? 0) || a.ref.localeCompare(b.ref));
  writeFileSync(
    join(dir, `${day}.jsonl.gz`),
    gzipSync(rows.map((r) => `${JSON.stringify(r)}\n`).join('')),
  );
}

/** Every stored observation, optionally of some sources only, in no particular order. */
export function* readObservations(only?: readonly string[]): Generator<StoredObservation> {
  if (!existsSync(OBS_DIR)) return;
  for (const s of readdirSync(OBS_DIR).sort()) {
    if (only && !only.includes(s)) continue;
    for (const m of readdirSync(join(OBS_DIR, s)).sort())
      for (const f of readdirSync(join(OBS_DIR, s, m)).sort())
        if (f.endsWith('.jsonl.gz')) yield* readJsonl<StoredObservation>(join(OBS_DIR, s, m, f));
  }
}

/** JupUSD, valued at par like USDC (PLAN-RISK D20): Jupiter Lend prices a stock the same in both vaults. */
export const JUPUSD = 'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD';
/** USD stablecoins that are debt reserves and refreshed rarely: a day-old logged price is accepted (policy input). */
const USD_STABLE_SYMBOLS = ['USDG', 'PYUSD'];

export type PriceInputs = {
  /** Every observation given, with `live: false` set where a stock oracle was not pricing the stock. */
  observations: StoredObservation[];
  index: PriceIndex;
  ctx: PriceContext;
  /** Observations per `priceSource|method`. */
  counts: Record<string, number>;
  /** Observations flagged not live per `priceSource|mint|quote` (stock oracles only). */
  notLive: Record<string, number>;
};

/**
 * Everything the resolver needs, from a set of observations and the lending registry: the index (with the
 * liveness flags set on stock oracle observations), the parameters, the calendar and the session clocks. It reads
 * only `~/.colosseum/risk` and the calendar (`RISK_HOLIDAYS`, else the fixture), so the hourly job can use it.
 */
export function buildPriceInputs(all: StoredObservation[]): PriceInputs {
  const calendar = JSON.parse(
    readFileSync(process.env.RISK_HOLIDAYS ?? 'fixtures/risk/us-market-holidays.json', 'utf8'),
  ) as { closed: string[]; earlyClose13ET: string[] };
  const regime = defaultRegimeParams(calendar);
  const lreg = JSON.parse(readFileSync(join(RISK_HOME, 'lending-registry.json'), 'utf8')) as {
    rows: Array<{
      venue: string;
      mint: string | null;
      symbol: string | null;
      dexAssetMint: string | null;
    }>;
  };
  // a Kamino reserve token that is not an xStock is priced around the clock
  const reserves = lreg.rows.filter((r) => r.venue === 'kamino' && r.mint);
  const continuousMints = [
    ...new Set(reserves.filter((r) => !r.dexAssetMint).map((r) => r.mint as string)),
  ];
  const usdStableMints = [
    ...new Set(
      reserves
        .filter((r) => USD_STABLE_SYMBOLS.includes(r.symbol ?? ''))
        .map((r) => r.mint as string),
    ),
  ];
  const params = defaultPriceParams({
    parMints: [USDC, JUPUSD],
    continuousMints,
    usdStableMints,
  });

  const counts: Record<string, number> = {};
  const series = new Map<string, StoredObservation[]>();
  let minT = Math.floor(Date.now() / 1000);
  for (const o of all) {
    counts[`${o.priceSource}|${o.method}`] = (counts[`${o.priceSource}|${o.method}`] ?? 0) + 1;
    if (o.t < minT) minT = o.t;
    if (sourceKind(o.priceSource) !== 'lending_oracle' || continuousMints.includes(o.mint))
      continue;
    const k = `${o.priceSource}|${o.mint}|${o.quote}`;
    const a = series.get(k);
    if (a) a.push(o);
    else series.set(k, [o]);
  }
  const notLive: Record<string, number> = {};
  const LP = defaultLivenessParams();
  for (const [k, a] of series) {
    a.sort((x, y) => x.t - y.t || (x.slot ?? 0) - (y.slot ?? 0));
    const L = markLiveness(a, regime, LP);
    let n = 0;
    L.live.forEach((v, i) => {
      const o = a[i] as StoredObservation;
      if (v) delete o.live;
      else {
        o.live = false;
        n++;
      }
    });
    if (n) notLive[k] = n;
  }
  const from = minT - 86400;
  const to = Math.floor(Date.now() / 1000) + 86400;
  const clocks = {
    us_market_hours: buildSessionClock(from, to, regime, 'us_market_hours'),
    us_weekdays: buildSessionClock(from, to, regime, 'us_weekdays'),
  };
  return {
    observations: all,
    index: buildPriceIndex(all),
    ctx: { params, regime, clocks },
    counts,
    notLive,
  };
}

/** The inputs from every observation file on disk (`data/risk/prices/obs`). */
export const loadPriceInputs = (): PriceInputs => buildPriceInputs([...readObservations()]);

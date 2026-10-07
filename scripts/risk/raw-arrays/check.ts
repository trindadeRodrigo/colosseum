import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildPoolSim, decodeClmmPool } from '@colosseum/risk';
import { readRecorded } from '../../../apps/api/src/pool-recorded';
import { captureBytes, loadCapture } from '../lib-split';
import {
  hourFolder,
  MAX_SLOT_GAP,
  poolOutcomes,
  RAW_ARRAYS_METHOD,
  RAW_ARRAYS_METHOD_VERSION,
  RAW_ARRAYS_SOURCE,
} from './lib';

// PLAN-UNIVERSE RU.12 — `pnpm risk:raw-arrays-check <folder> <capture.json.gz>`: one run of the raw-arrays job read
// back and set against the capture the same run saved (RISK_RAW_ARRAYS_CAPTURE). No network.
// For every pool of the capture there is a file in the run's hour folder exactly when the pool's bytes decode. Each
// file is then checked twice:
//  - as bytes, before anything is decoded: the pool account, every listed address in the cache's order with the bytes
//    the chain returned ("" for one it did not), the fee config and the job's own keys are those of the capture, and
//    the first seven keys are the collector's, in the collector's order;
//  - as the reader sees it: read with the API's own reader (apps/api/src/pool-recorded.ts), a simulator is built
//    from it with packages/risk/src/pools, another from the capture's bytes, and the two must be the same: the same
//    mid, fee rate and liquidity check, and the same answer to every sale and purchase of a grid of sizes.
// The two are needed: the decoders sort ticks and skip what is no array, so a file with its arrays in another order
// builds the same simulator and is still not what the chain returned. Exit code 1 on any difference.
const [dir, captureFile] = process.argv.slice(2);
if (!dir || !captureFile) throw new Error('usage: check.ts <folder of the run> <capture.json.gz>');

const KEYS = [
  'pool',
  'venue',
  'slot',
  'fetchedAt',
  'head',
  'children',
  'config',
  'slotHead',
  'childrenListedAt',
  'invariantRelErr',
  'source',
  'method',
  'methodVersion',
  'provenance',
];
// raw units of the side that is paid in, from a dust trade to one no pool can fill
const SIZES = [1, 1e3, 1e5, 1e7, 1e9, 1e11, 1e13];

const c = loadCapture(captureFile);
const { day, hour } = hourFolder(c.fetchedAt);
const hourDir = join(dir, day, hour);
const onDisk = new Set(
  existsSync(hourDir)
    ? readdirSync(hourDir)
        .filter((f) => f.endsWith('.json.gz'))
        .map((f) => f.slice(0, -'.json.gz'.length))
    : [],
);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// an account the chain returned with no data is written as one it did not return
const stored = (k: string) => c.accounts[k] || '';
const different: Array<{ pool: string; what: string }> = [];
let compared = 0;
let swaps = 0;
const outcomes = poolOutcomes(c, c.direct);
for (const o of outcomes) {
  const p = o.pool;
  const file = join(hourDir, `${p.address}.json.gz`);
  const say = (what: string) => different.push({ pool: p.address, what });
  if (!o.written) {
    if (onDisk.has(p.address)) say(`a file exists, but the capture gives ${o.reason}`);
    continue;
  }
  if (!onDisk.has(p.address)) {
    say('no file, but the capture decodes');
    continue;
  }
  const raw = JSON.parse(gunzipSync(readFileSync(file)).toString()) as Record<string, unknown>;
  const head = captureBytes(c, p.address) as Uint8Array;
  const cfgKey = p.venue === 'raydium_clmm' ? decodeClmmPool(head).ammConfig : null;

  // --- the bytes
  if (!same(Object.keys(raw), KEYS)) say(`keys: ${Object.keys(raw).join(',')}`);
  if (raw.pool !== p.address || raw.venue !== p.venue || raw.fetchedAt !== c.fetchedAt)
    say('pool, venue or fetchedAt');
  if (raw.head !== c.accounts[p.address]) say('the pool account’s bytes');
  if (
    !same(
      Object.entries(raw.children as Record<string, string>),
      (c.children[p.address] ?? []).map((k) => [k, stored(k)]),
    )
  )
    say('children: the addresses, their order or their bytes');
  if (raw.config !== (cfgKey ? stored(cfgKey) || null : null)) say('the fee config’s bytes');
  if (
    raw.source !== RAW_ARRAYS_SOURCE ||
    raw.method !== RAW_ARRAYS_METHOD ||
    raw.methodVersion !== RAW_ARRAYS_METHOD_VERSION ||
    raw.provenance !== 'live'
  )
    say('source, method, methodVersion or provenance');
  // each pool's two slots are its own batches': whole numbers of this run, no further apart than a run allows
  const slot = raw.slot as number;
  const slotHead = raw.slotHead as number;
  if (
    !Number.isInteger(slot) ||
    !Number.isInteger(slotHead) ||
    slot <= 0 ||
    slotHead <= 0 ||
    Math.abs(slot - slotHead) > MAX_SLOT_GAP
  )
    say(`slots: ${slotHead} and ${slot}`);

  // --- what the reader sees
  const rec = readRecorded(file);
  if (!rec) {
    say('the reader does not read the file');
    continue;
  }
  if (rec.pool !== p.address || rec.venue !== p.venue || rec.fetchedAt !== c.fetchedAt)
    say('the reader’s pool, venue or fetchedAt');
  const fromFile = buildPoolSim(
    p,
    rec.head,
    rec.kids,
    typeof raw.config === 'string' ? new Uint8Array(Buffer.from(raw.config, 'base64')) : undefined,
  );
  const fromCapture = buildPoolSim(
    p,
    head,
    (c.children[p.address] ?? [])
      .map((k) => captureBytes(c, k))
      .filter((d): d is Uint8Array => !!d?.length),
    cfgKey ? captureBytes(c, cfgKey) : undefined,
  );
  compared++;
  if (!Object.is(fromFile.sim.midRaw, fromCapture.sim.midRaw)) say('mid');
  if (!Object.is(fromFile.feeRate, fromCapture.feeRate)) say('fee rate');
  if (!Object.is(fromFile.invariantRelErr, fromCapture.invariantRelErr)) say('liquidity check');
  if (!Object.is(raw.invariantRelErr, fromCapture.invariantRelErr)) say('invariantRelErr in file');
  if (!same(fromFile.sim.depthWithin(0.02), fromCapture.sim.depthWithin(0.02))) say('depth at 2%');
  for (const x of SIZES) {
    swaps += 2;
    if (!same(fromFile.sim.sellAsset(x), fromCapture.sim.sellAsset(x))) say(`sale of ${x}`);
    if (!same(fromFile.sim.buyAsset(x), fromCapture.sim.buyAsset(x))) say(`purchase with ${x}`);
  }
}
const expected = new Set(outcomes.filter((o) => o.written).map((o) => o.pool.address));
const unexpectedFiles = [...onDisk].filter((a) => !expected.has(a));
console.log(
  JSON.stringify({
    hourFolder: hourDir,
    capture: captureFile,
    fetchedAt: c.fetchedAt,
    pools: c.direct.length,
    files: onDisk.size,
    compared,
    swapsCompared: swaps,
    notWritten: outcomes
      .filter((o) => !o.written)
      .map((o) => ({ pool: o.pool.address, reason: o.written ? null : o.reason })),
    unexpectedFiles,
    different,
    same: !different.length && !unexpectedFiles.length,
  }),
);
if (different.length || unexpectedFiles.length) process.exitCode = 1;

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defaultRegimeParams } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import {
  CURVE_METHOD_VERSION,
  type CurveRow,
  curveRows,
  curveVersionOf,
  previousKey,
  type SnapshotForCurve,
} from '../../scripts/risk/curve-rows';

// PLAN-UNIVERSE RU.8 (RISK-1): `pnpm risk:compute` fits every row of risk_asset_snapshots. A row of the
// EVM collector keeps its own symbol and its evmq- method version; a Solana row is what it was.
// The fixture is real rows of the local database for SPYx and QQQx (every 12th snapshot), with the curves
// compute wrote from them BEFORE this change (scripts/risk/freeze-compute-fixture.ts). No network, no
// database.
type Frozen = {
  params: { quantile: number; minSamples: number; now: string };
  poolSymbols: Array<[string, string]>;
  snapshots: Array<Omit<SnapshotForCurve, 'fetchedAt'> & { fetchedAt: string }>;
  expected: unknown[];
};
const frozen: Frozen = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk/compute/solana-snapshots.json.gz')).toString(),
);
const regimeParams = defaultRegimeParams(
  JSON.parse(readFileSync('fixtures/risk/us-market-holidays.json', 'utf8')),
);
const solana: SnapshotForCurve[] = frozen.snapshots.map((s) => ({
  ...s,
  fetchedAt: new Date(s.fetchedAt),
}));
const run = (snapshots: SnapshotForCurve[], previous = new Map()) =>
  curveRows({
    snapshots,
    poolSymbols: new Map(frozen.poolSymbols),
    previous,
    now: new Date(frozen.params.now),
    quantile: frozen.params.quantile,
    minSamples: frozen.params.minSamples,
    regimeParams,
  }).rows;
// as the file holds them: dates as text
const asStored = (rows: CurveRow[]) => JSON.parse(JSON.stringify(rows));

// A token address in the issuer registry's mixed case, as the collector writes it (NVDA in config.ts).
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const [SPYX] = frozen.poolSymbols.find(([, s]) => s === 'SPYx') as [string, string];
// the same measurements under an EVM row's labels: only the labels differ, so the fit can be compared
const evm: SnapshotForCurve[] = solana
  .filter((s) => s.assetMint === SPYX)
  .map((s) => ({ ...s, assetMint: NVDA, asset: 'NVDA', methodVersion: 'evmq-0.1' }));

describe('a Solana row through compute is unchanged', () => {
  it('writes, byte for byte, the rows compute wrote before the change', () => {
    expect(frozen.expected.length).toBeGreaterThan(0);
    expect(JSON.stringify(run(solana))).toBe(JSON.stringify(frozen.expected));
  });

  it('stays risk-0.3 with the pool registry symbol, whatever version its snapshot carries', () => {
    const rows = run(solana);
    expect(new Set(solana.map((s) => s.methodVersion))).toEqual(new Set(['pools-0.1']));
    expect(new Set(rows.map((r) => r.methodVersion))).toEqual(new Set([CURVE_METHOD_VERSION]));
    expect(new Set(rows.map((r) => r.assetSymbol))).toEqual(new Set(['SPYx', 'QQQx']));
    expect(rows.every((r) => r.source.includes('routed'))).toBe(true);
  });

  it('is the same with EVM rows beside it', () => {
    const both = run([...evm, ...solana]).filter((r) => r.assetMint !== NVDA);
    expect(asStored(both)).toEqual(frozen.expected);
  });
});

describe('an EVM row through compute keeps its symbol and its method version', () => {
  const rows = run([...solana, ...evm]).filter((r) => r.assetMint === NVDA);

  it('is stored as NVDA under evmq-0.1, not as 0xd060 under risk-0.3', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.assetSymbol))).toEqual(new Set(['NVDA']));
    expect(new Set(rows.map((r) => r.methodVersion))).toEqual(new Set(['evmq-0.1']));
    expect(rows.every((r) => r.assetMint === NVDA)).toBe(true);
  });

  it('says what it is fitted from: the best single pool, not a routed split', () => {
    for (const r of rows) {
      expect(r.source).toContain('best single pool');
      expect(r.source).not.toContain('routed');
      expect(r.provenance).toBe('live');
    }
  });

  it('is fitted as any row is: the same samples give the same curve', () => {
    const spyx = run(solana).filter((r) => r.assetMint === SPYX);
    const fit = (r: CurveRow) => [r.side, r.regime, r.points, r.samples, r.insufficientFrom];
    expect(rows.map(fit)).toEqual(spyx.map(fit));
  });

  it('keeps a later evmq version, and the version of the newest snapshot', () => {
    expect(curveVersionOf('evmq-0.2')).toBe('evmq-0.2');
    expect(curveVersionOf('pools-0.1')).toBe(CURVE_METHOD_VERSION);
    const newest = evm.reduce((a, b) => (a.fetchedAt > b.fetchedAt ? a : b));
    const mixed = evm.map((s) => (s === newest ? { ...s, methodVersion: 'evmq-0.2' } : s));
    expect(new Set(run(mixed.reverse()).map((r) => r.methodVersion))).toEqual(
      new Set(['evmq-0.2']),
    );
  });

  it('takes nothing from a curve stored for the address under the Solana name', () => {
    const [first] = rows as [CurveRow, ...CurveRow[]];
    const stray = first.points.map((p) => ({ ...p, split: { poolFee: 1 } }));
    const previous = new Map([
      [previousKey(NVDA, first.side, first.regime, CURVE_METHOD_VERSION), stray],
    ]);
    const again = run(evm, previous).find(
      (r) => r.side === first.side && r.regime === first.regime,
    ) as CurveRow;
    expect(asStored([again])[0].points).toEqual(asStored([first])[0].points);
  });
});

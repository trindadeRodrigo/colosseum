import {
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  type PersonWithdrawal,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import type { HistoryAnswer, PlansAnswer } from './api';
import {
  chainsOf,
  DEFAULT_PERIOD,
  flowsOf,
  PERIODS,
  periodPnl,
  periodQuery,
  provenanceOf,
  signRuns,
  stacks,
  totalLine,
} from './overview-series';

// The overview's figures over time: a deposit is never a gain, the line changes colour where the
// value crosses what was put in, and the sums never add figures of two provenances.

const A = 'So11111111111111111111111111111111111111112';
const B = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();

const point = (day: number, value: number, assets: Record<string, number> = {}) => ({
  observedAt: at(day),
  valueUsd: String(value),
  cashUsd: String(value - Object.values(assets).reduce((s, v) => s + v, 0)),
  positions: Object.entries(assets).map(([asset, usd]) => ({
    asset,
    valueUsd: String(usd),
    weightBps: 0,
    targetBps: 0,
    driftBps: 0,
  })),
  lossUsedBps: 0,
});

function history(
  vaults: { address: string; points: ReturnType<typeof point>[] }[],
  provenance: 'live' | 'sandbox' | 'mock' = 'sandbox',
): HistoryAnswer {
  return {
    from: at(1),
    to: at(9),
    step: '1d',
    chains: [
      {
        chain: 'solana',
        name: 'Solana',
        provenance,
        vaults: vaults.map((v) => ({ ...v, name: null, source: 's', method: 'm' })),
      },
    ],
    unavailable: [],
    disclaimer: 'd',
  } as unknown as HistoryAnswer;
}

function plans(
  deposits: Record<string, { day: number; usd: number }[]>,
  provenance: 'live' | 'sandbox' | 'mock' = 'sandbox',
): PlansAnswer {
  return {
    chains: [
      {
        chain: 'solana',
        provenance,
        plans: Object.entries(deposits).map(([address, list]) => ({
          address,
          putIn: list.length
            ? {
                usd: String(list.reduce((s, d) => s + d.usd, 0)),
                deposits: list.map((d, i) => ({
                  orderId: `o${i}`,
                  at: at(d.day),
                  usd: String(d.usd),
                })),
              }
            : null,
        })),
      },
    ],
    unavailable: [],
  } as unknown as PlansAnswer;
}

const SOLANA = new Set(['solana']);

describe('the periods of the chart', () => {
  it('are 1D, 7D, 30D, 1Y, YTD and All, and the page opens on 30D', () => {
    expect(PERIODS.map((p) => p.id)).toEqual(['1d', '7d', '30d', '1y', 'ytd', 'all']);
    expect(DEFAULT_PERIOD).toBe('30d');
  });

  it('are each a window the history route serves, line and bars', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    for (const p of PERIODS)
      for (const kind of ['line', 'bars'] as const) {
        const q = periodQuery(p.id, kind, now, Date.parse('2020-01-01T00:00:00Z'));
        expect(q).not.toBeNull();
        const steps =
          (Date.parse(q?.to ?? '') - Date.parse(q?.from ?? '')) /
          1000 /
          HISTORY_STEP_SECONDS[q?.step ?? '1d'];
        expect(steps).toBeLessThanOrEqual(HISTORY_MAX_POINTS);
      }
  });

  it('starts YTD on the first of January, and All on the day of the first deposit', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(periodQuery('ytd', 'line', now, null)?.from).toBe('2026-01-01T00:00:00.000Z');
    expect(periodQuery('all', 'bars', now, Date.parse('2026-09-03T15:00:00Z'))?.from).toBe(
      '2026-09-03T00:00:00.000Z',
    );
    // daily bars for the long periods, hourly for a day
    expect(periodQuery('1d', 'bars', now, null)?.step).toBe('1h');
    expect(periodQuery('30d', 'bars', now, null)?.step).toBe('1d');
  });
});

describe('the value over time', () => {
  it('does not count a deposit as a gain', () => {
    const answer = history([{ address: A, points: [point(1, 100), point(3, 300), point(5, 290)] }]);
    const { flows } = flowsOf(
      plans({
        [A]: [
          { day: 1, usd: 100 },
          { day: 2, usd: 200 },
        ],
      }),
      [],
    );
    const line = totalLine(answer, flows, SOLANA);
    expect(line.map((p) => [p.valueUsd, p.netUsd, p.pnlUsd])).toEqual([
      [100, 100, 0],
      [300, 300, 0],
      [290, 300, -10],
    ]);
  });

  it('takes a valued, confirmed withdrawal off what was put in, and counts one it cannot value', () => {
    const withdrawal = {
      orderId: 'w',
      createdAt: at(4),
      chain: 'solana',
      vault: A,
      status: 'done',
      steps: [
        {
          legId: 'l1',
          status: 'confirmed',
          txId: null,
          explorerUrl: null,
          at: at(4),
          provenance: 'sandbox',
          withdrawals: [
            {
              asset: 'x',
              amountRaw: '1',
              heldRaw: '1',
              valued: {
                usd: '50',
                source: 's',
                fetchedAt: at(4),
                method: 'm',
                provenance: 'sandbox',
              },
            },
            { asset: 'y', amountRaw: '1', heldRaw: '1' },
          ],
        },
        {
          legId: 'l2',
          status: 'sent',
          txId: null,
          explorerUrl: null,
          at: at(4),
          provenance: 'sandbox',
          withdrawals: [
            {
              asset: 'x',
              amountRaw: '1',
              heldRaw: '1',
              valued: {
                usd: '9',
                source: 's',
                fetchedAt: at(4),
                method: 'm',
                provenance: 'sandbox',
              },
            },
          ],
        },
      ],
    } as unknown as PersonWithdrawal;
    const { flows, unvalued } = flowsOf(plans({ [A]: [{ day: 1, usd: 100 }] }), [withdrawal]);
    expect(unvalued).toBe(1);
    const line = totalLine(
      history([{ address: A, points: [point(1, 100), point(5, 55)] }]),
      flows,
      SOLANA,
    );
    expect(line.map((p) => [p.netUsd, p.pnlUsd])).toEqual([
      [100, 0],
      [50, 5],
    ]);
  });

  it('adds a vault in only from its first reading, with what went into it', () => {
    const answer = history([
      { address: A, points: [point(1, 100), point(3, 110)] },
      { address: B, points: [point(3, 50)] },
    ]);
    const { flows } = flowsOf(
      plans({ [A]: [{ day: 1, usd: 100 }], [B]: [{ day: 2, usd: 60 }] }),
      [],
    );
    expect(totalLine(answer, flows, SOLANA).map((p) => [p.valueUsd, p.pnlUsd])).toEqual([
      [100, 0],
      [160, 0],
    ]);
  });

  it('says what the window made or lost, and of what', () => {
    const answer = history([{ address: A, points: [point(1, 100), point(3, 300), point(5, 330)] }]);
    const { flows } = flowsOf(
      plans({
        [A]: [
          { day: 1, usd: 100 },
          { day: 2, usd: 200 },
        ],
      }),
      [],
    );
    expect(periodPnl(answer, flows, SOLANA)).toEqual({ pnlUsd: 30, share: 0.1 });
    expect(periodPnl(history([]), flows, SOLANA)).toBeNull();
  });

  it('is cut where it crosses what was put in, so green and red meet', () => {
    const runs = signRuns([
      { at: 0, valueUsd: 110, netUsd: 100, pnlUsd: 10 },
      { at: 10, valueUsd: 90, netUsd: 100, pnlUsd: -10 },
      { at: 20, valueUsd: 80, netUsd: 100, pnlUsd: -20 },
    ]);
    expect(runs).toEqual([
      {
        up: true,
        points: [
          { at: 0, valueUsd: 110 },
          { at: 5, valueUsd: 100 },
        ],
      },
      {
        up: false,
        points: [
          { at: 5, valueUsd: 100 },
          { at: 10, valueUsd: 90 },
          { at: 20, valueUsd: 80 },
        ],
      },
    ]);
  });
});

describe('the stacks', () => {
  const answer = history([
    { address: A, points: [point(1, 100, { usdy: 60 }), point(2, 120, { usdy: 80 })] },
    { address: B, points: [point(2, 30, { usdy: 10, paxg: 20 })] },
  ]);

  it('cut the value by vault, largest first, the same parts at every step', () => {
    expect(stacks(answer, 'vault', SOLANA)).toEqual([
      {
        at: Date.parse(at(1)),
        parts: [
          { key: `solana:${A}`, usd: 100 },
          { key: `solana:${B}`, usd: 0 },
        ],
      },
      {
        at: Date.parse(at(2)),
        parts: [
          { key: `solana:${A}`, usd: 120 },
          { key: `solana:${B}`, usd: 30 },
        ],
      },
    ]);
  });

  it('cut the value by asset, cash included', () => {
    const second = stacks(answer, 'asset', SOLANA)[1];
    expect(second?.parts).toEqual([
      { key: 'usdy', usd: 90 },
      { key: 'cash', usd: 40 },
      { key: 'paxg', usd: 20 },
    ]);
  });
});

describe('the provenance of the sums', () => {
  it('is the most live chain that holds a plan, and only its chains are added', () => {
    const mixed = {
      chains: [
        { chain: 'solana', provenance: 'sandbox', plans: [{}] },
        { chain: 'robinhood', provenance: 'live', plans: [{}] },
        { chain: 'base', provenance: 'live', plans: [] },
      ],
      unavailable: [],
    } as unknown as PlansAnswer;
    expect(provenanceOf(mixed)).toBe('live');
    expect([...chainsOf(mixed, 'live')]).toEqual(['robinhood']);
  });
});

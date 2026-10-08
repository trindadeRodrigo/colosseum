import type { MixReview } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { retargetShapeOk } from '../order/order-check';
import { planTermsOf } from '../order/run-order';
import { readTerms } from '../shared/terms';
import {
  acceptedOf,
  bpsOf,
  cashLeft,
  confirmable,
  editorIssues,
  mixOf,
  sameMix,
  textOf,
  unticked,
} from './mix';

const cash = 'solana:usdc';
const line = (assetId: string, weightBps: number) => ({ assetId, weightBps });

describe('the weight editor', () => {
  it('reads whole percents with up to two decimals, and whole basis points', () => {
    expect(bpsOf('12.5', 'percent')).toBe(1250);
    expect(bpsOf('12,25', 'percent')).toBe(1225);
    expect(bpsOf('', 'percent')).toBe(0);
    expect(bpsOf('100', 'percent')).toBe(10000);
    expect(bpsOf('1250', 'bps')).toBe(1250);
    for (const bad of ['12.555', '-1', '101', 'ten', '1e2'])
      expect(bpsOf(bad, 'percent')).toBeNull();
    for (const bad of ['12.5', '10001', '-5']) expect(bpsOf(bad, 'bps')).toBeNull();
    expect(textOf(1250, 'percent')).toBe('12.5');
    expect(textOf(1250, 'bps')).toBe('1250');
  });

  it('leaves the rest in cash and sends it as the cash line, summing to 10,000', () => {
    const lines = [line('solana:spy', 4000), line('solana:nvda', 2500), line('solana:gold', 0)];
    expect(cashLeft(lines)).toBe(3500);
    expect(mixOf(lines, cash)).toEqual([
      line('solana:spy', 4000),
      line('solana:nvda', 2500),
      line(cash, 3500),
    ]);
    // A full mix sends no cash line.
    expect(mixOf([line('solana:spy', 7000), line('solana:nvda', 3000)], cash)).toEqual([
      line('solana:spy', 7000),
      line('solana:nvda', 3000),
    ]);
    // The same mix whatever the order; a line at zero is not held, and a changed weight is another mix.
    const seed = [line('solana:spy', 7000), line('solana:nvda', 3000)];
    expect(sameMix([line('solana:nvda', 3000), line('solana:spy', 7000)], seed)).toBe(true);
    expect(sameMix([...seed, line('solana:tsla', 0)], seed)).toBe(true);
    expect(sameMix([line('solana:spy', 7001), line('solana:nvda', 2999)], seed)).toBe(false);
    expect(sameMix([line('solana:spy', 7000)], seed)).toBe(false);
  });

  it('says what to change: too many, a repeat, cash as a line, over the whole, nothing held', () => {
    expect(editorIssues([line('solana:spy', 7000), line('solana:nvda', 3000)], cash)).toEqual([]);
    const seventeen = Array.from({ length: 17 }, (_, i) => line(`solana:a${i}`, 100));
    expect(editorIssues(seventeen, cash)).toContain('too-many');
    // Sixteen held plus one at zero is fine: a zero line is not held.
    expect(editorIssues([...seventeen.slice(0, 16), line('solana:z', 0)], cash)).toEqual([]);
    expect(editorIssues([line('solana:spy', 10), line('solana:spy', 10)], cash)).toContain(
      'duplicate',
    );
    expect(editorIssues([line(cash, 1000), line('solana:spy', 10)], cash)).toContain('cash-line');
    expect(editorIssues([line('solana:spy', 6000), line('solana:nvda', 5000)], cash)).toEqual([
      'over-whole',
    ]);
    expect(editorIssues([line('solana:spy', 0)], cash)).toEqual(['all-cash']);
    expect(editorIssues([line('solana:spy', 12.5)], cash)).toContain('not-whole');
  });
});

describe('the warnings a confirm sends', () => {
  const review = {
    warnings: [
      { id: 'EXIT_OVER_CAPACITY:solana:spy', code: 'EXIT_OVER_CAPACITY', text: 'a', figures: [] },
      { id: 'NOT_FOR_GOAL:solana:nvda', code: 'NOT_FOR_GOAL', text: 'b', figures: [] },
    ],
    reviewHash: 'a'.repeat(64),
  } as unknown as MixReview;

  it('needs every warning ticked, and sends only this review’s ticks', () => {
    const one = new Set(['EXIT_OVER_CAPACITY:solana:spy', 'STOPS_FOLLOWING']);
    expect(unticked(review, one)).toEqual(['NOT_FOR_GOAL:solana:nvda']);
    expect(confirmable(review, one)).toBe(false);
    const both = new Set([...one, 'NOT_FOR_GOAL:solana:nvda']);
    expect(confirmable(review, both)).toBe(true);
    // A tick from an earlier review whose warning is gone is not sent.
    expect(acceptedOf(review, both)).toEqual([
      'EXIT_OVER_CAPACITY:solana:spy',
      'NOT_FOR_GOAL:solana:nvda',
    ]);
    expect(confirmable({ ...review, warnings: [] } as MixReview, new Set())).toBe(true);
    expect(confirmable({ ...review, reviewHash: 'nope' } as MixReview, both)).toBe(false);
  });
});

describe('an order that sets a vault’s targets', () => {
  const targets = [
    { asset: 'solana:spy', weightBps: 6000 },
    { asset: 'solana:nvda', weightBps: 2000 },
  ];
  const terms = {
    kind: 'retarget' as const,
    vault: 'Vault1111',
    basketId: '42',
    targets,
    origin: 'person' as const,
  };
  const leg = (seq: number, kind: string, trades: { sell: string; buy: string }[] = []) => ({
    seq,
    kind,
    trades: trades.map((t) => ({ ...t, amountInRaw: '1', minOutRaw: '1' })),
  });
  const order = (legs: ReturnType<typeof leg>[], depositRaw?: string) =>
    ({ legs, ...(depositRaw ? { depositRaw } : {}) }) as unknown as Parameters<
      typeof retargetShapeOk
    >[0];
  const units = { cash };

  it('keeps the reviewed targets in the browser and hands them to the guard', () => {
    expect(readTerms(terms)).toEqual(terms);
    expect(readTerms({ ...terms, targets: [] })).toBeNull();
    expect(readTerms({ ...terms, origin: 'agent' })).toBeNull();
    expect(readTerms({ ...terms, targets: [...targets, targets[0]] })).toBeNull();
    expect(planTermsOf(terms)).toEqual({ basketId: '42', targets });
  });

  it('is signed only as: the targets first, then swaps into the targets or cash, and no deposit', () => {
    const good = [
      leg(0, 'set_targets'),
      leg(1, 'swap', [{ sell: 'solana:tsla', buy: cash }]),
      leg(2, 'swap', [{ sell: cash, buy: 'solana:spy' }]),
    ];
    expect(retargetShapeOk(order(good), terms, units)).toBe(true);
    expect(retargetShapeOk(order(good), terms, null)).toBe(false);
    expect(retargetShapeOk(order(good, '100'), terms, units)).toBe(false);
    expect(retargetShapeOk(order([good[1] as never, good[0] as never]), terms, units)).toBe(true);
    // A swap that buys something else than the targets or cash.
    expect(
      retargetShapeOk(
        order([leg(0, 'set_targets'), leg(1, 'swap', [{ sell: cash, buy: 'solana:tsla' }])]),
        terms,
        units,
      ),
    ).toBe(false);
    // No targets step first, or another kind of step.
    expect(
      retargetShapeOk(order([leg(0, 'swap', [{ sell: cash, buy: 'solana:spy' }])]), terms, units),
    ).toBe(false);
    expect(retargetShapeOk(order([leg(0, 'set_targets'), leg(1, 'withdraw')]), terms, units)).toBe(
      false,
    );
  });
});

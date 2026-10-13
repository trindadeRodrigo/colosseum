import {
  PortfolioExposureResponse,
  PortfolioHistoryResponse,
  PortfolioPlansResponse,
  PortfolioRebalancesResponse,
  TRACK_RULE,
  TrackLine,
  TrackStatus,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { addDecimals } from './pins';
import {
  EXPOSURE,
  EXPOSURE_OF_INCOME,
  EXPOSURE_OF_NOTHING,
  exposure,
  HISTORY,
  history,
  PLANS,
  planAt,
  plans,
  REBALANCES,
  RH_SILENT,
  rebalances,
  SOL_INCOME,
  SOL_NEVER,
  SOL_STALE,
  SOL_UNPRICED,
  STATUS_BY_LINE,
} from './test/fixtures';

// The sample answers the section's pages are tested on (fixtures/answers.ts): each is an answer of its
// route in the frozen shape, between them they hold every case a page has to draw, and their figures
// agree with each other, so a page that adds or compares them is tested on sums that are right.

describe('the sample answers of the four routes', () => {
  it('each parse with their contract’s schema, as written and narrowed', () => {
    expect(PortfolioPlansResponse.parse(PLANS)).toEqual(PLANS);
    expect(PortfolioExposureResponse.parse(EXPOSURE)).toEqual(EXPOSURE);
    expect(PortfolioRebalancesResponse.parse(REBALANCES)).toEqual(REBALANCES);
    expect(PortfolioHistoryResponse.parse(HISTORY)).toEqual(HISTORY);
    expect(PortfolioExposureResponse.parse(EXPOSURE_OF_INCOME)).toEqual(EXPOSURE_OF_INCOME);
    expect(PortfolioExposureResponse.parse(EXPOSURE_OF_NOTHING)).toEqual(EXPOSURE_OF_NOTHING);
    for (const q of [{ chain: 'solana' }, { address: SOL_INCOME }, { address: RH_SILENT }, {}]) {
      expect(() => [plans(q), exposure(q), rebalances(q), history(q)]).not.toThrow();
    }
  });

  it('have one answer for each line of the rule, in the frozen shape', () => {
    expect(Object.keys(STATUS_BY_LINE).sort()).toEqual([...TrackLine.options].sort());
    for (const line of TrackLine.options) {
      const answers = STATUS_BY_LINE[line];
      expect(answers.length, line).toBeGreaterThan(0);
      for (const status of answers) {
        expect(TrackStatus.parse(status)).toEqual(status);
        expect(status.line).toBe(line);
        // a verdict names the rule that spoke; every other line names this one
        if (line !== 'verdict') expect(status.rule).toBe(TRACK_RULE);
      }
    }
    expect(STATUS_BY_LINE.verdict.map((s) => s.rule)).not.toContain(TRACK_RULE);
  });

  it('hold every case a page has to draw', () => {
    const answer = plans();
    const all = answer.chains.flatMap((chain) => chain.plans);
    // two chains, one on a test network and one on the mock, and one switched off
    expect(answer.chains.map((c) => [c.chain, c.provenance])).toEqual([
      ['solana', 'sandbox'],
      ['robinhood', 'mock'],
    ]);
    expect(answer.unavailable.map((u) => [u.chain, u.retryable])).toEqual([['base', false]]);
    // a plan made to measure with its sheet, for each kind of goal
    expect(all.flatMap((p) => (p.plan?.sheet ? [p.plan.sheet.goal] : [])).sort()).toEqual([
      'grow',
      'income',
      'protect',
    ]);
    // a vault opened to follow a shared portfolio and following it; one on the mock, which names none
    const following = planAt(SOL_STALE).plan;
    expect(following.openedFor?.name).toBe('Steady dollars');
    expect(following.follows?.name).toBe('Steady dollars');
    expect(planAt(RH_SILENT).plan).toMatchObject({
      follows: null,
      openedFor: { name: 'US stocks' },
    });
    // a vault never read
    expect(planAt(SOL_NEVER).plan).toMatchObject({ newest: null, putIn: null, plan: null });
    // each status word, and no status for two reasons
    expect(new Set(all.map((p) => p.status.status))).toEqual(
      new Set(['on_track', 'watch', 'off_track', null]),
    );
    expect(
      all
        .filter((p) => p.status.status === null)
        .map((p) => p.status.line)
        .sort(),
    ).toEqual(['empty', 'never_read']);
    // a stale snapshot under each label, and an unpriced position
    expect(
      all
        .filter((p) => p.newest?.stale)
        .map((p) => p.newest?.provenance)
        .sort(),
    ).toEqual(['mock', 'mock', 'sandbox']);
    expect(
      planAt(SOL_UNPRICED).plan.newest?.positions.filter((p) => p.valueUsd === null),
    ).toHaveLength(1);
    // deposits: one order, and two
    expect(all.flatMap((p) => (p.putIn ? [p.putIn.deposits.length] : [])).sort()).toEqual([
      1, 1, 1, 1, 2,
    ]);

    const steps = rebalances().chains.flatMap((chain) => chain.entries);
    // a step of the owner's with its quote, its reference price and the drift on each side
    expect(
      steps.some(
        (s) =>
          s.by === 'owner' &&
          s.trades.some((t) => t.expected && t.reference && t.before && t.after),
      ),
    ).toBe(true);
    // a trade of the keeper's, worked out from snapshots: no transaction, no quote, no reason
    const derived = steps.filter((s) => s.derived);
    expect(derived.length).toBeGreaterThan(0);
    for (const s of derived) {
      expect([s.by, s.txId, s.orderId, s.why, s.explorerUrl]).toEqual([
        'keeper',
        null,
        null,
        null,
        null,
      ]);
      expect(s.trades.every((t) => t.expected === undefined && t.rawAfter !== undefined)).toBe(
        true,
      );
    }
    // a revert, a version adopted with no trade, and a quote whose cost reads zero
    expect(steps.some((s) => s.outcome === 'failed')).toBe(true);
    expect(steps.some((s) => s.kind === 'accept_version' && s.trades.length === 0)).toBe(true);
    expect(steps.some((s) => s.trades.some((t) => t.expected?.costBps === 0))).toBe(true);

    const exits = exposure().chains.flatMap((chain) => chain.exit);
    // a measured exit with its whole stamp, and a tier named as the fallback with no cost
    expect(
      exits.some((e) => e.measured && e.costBps !== null && e.fetchedAt && e.source && e.method),
    ).toBe(true);
    expect(exits.filter((e) => !e.measured).map((e) => [e.fallbackTier, e.costBps])).toEqual([
      ['B', null],
      ['A', null],
    ]);
    // measured with the size beyond what was measured, and measured with no time
    expect(exits.some((e) => e.measured && e.costBps === null)).toBe(true);
    expect(exits.some((e) => e.measured && e.fetchedAt === undefined)).toBe(true);
    // a holding that is in no sum
    expect(exposure().chains.flatMap((chain) => chain.unvalued)).toEqual([
      { asset: 'solana:paxg', vault: SOL_UNPRICED, display: '0.06' },
    ]);
    expect(exposure().unavailable.map((u) => u.chain)).toEqual(['base']);
    expect(exposure().total?.provenance).toBe('mock');
  });
});

describe('the figures of the sample answers', () => {
  const cents = (decimal: string) => Math.round(Number(decimal) * 100);

  it('add up: a vault’s value is its cash and its priced positions', () => {
    for (const { newest } of plans().chains.flatMap((chain) => chain.plans)) {
      if (!newest) continue;
      const parts = [
        newest.cash.display,
        ...newest.positions.flatMap((p) => (p.valueUsd === null ? [] : [p.valueUsd])),
      ];
      expect(cents(addDecimals(parts))).toBe(cents(newest.valueUsd));
      for (const p of newest.positions) expect(p.driftBps).toBe(p.weightBps - p.targetBps);
    }
  });

  it('add up: what was put in is its deposits, oldest first', () => {
    for (const { putIn } of plans().chains.flatMap((chain) => chain.plans)) {
      if (!putIn) continue;
      expect(addDecimals(putIn.deposits.map((d) => d.usd))).toBe(putIn.usd);
      expect(putIn.orders).toBe(putIn.deposits.length);
      const times = putIn.deposits.map((d) => d.at);
      expect(times).toEqual([...times].sort());
    }
  });

  it('agree across routes: the exposure’s sums are the vaults’ newest snapshots', () => {
    const answer = exposure();
    for (const chain of answer.chains) {
      const read = plans({ chain: chain.chain }).chains.flatMap((c) =>
        c.plans.flatMap((p) => (p.newest ? [p.newest] : [])),
      );
      expect(chain.vaults).toBe(read.length);
      expect(cents(chain.valueUsd)).toBe(cents(addDecimals(read.map((n) => n.valueUsd))));
      expect(chain.observedAt).toBe(read.map((n) => n.observedAt).sort()[0]);
      for (const shares of [chain.byUnderlying, chain.byIssuer]) {
        expect(shares.reduce((sum, s) => sum + s.bps, 0)).toBe(10_000);
        expect(cents(addDecimals(shares.map((s) => s.usd)))).toBe(cents(chain.valueUsd));
      }
    }
    const total = answer.total;
    expect(total).not.toBeNull();
    if (!total) return;
    expect(cents(total.valueUsd)).toBe(
      cents(addDecimals(answer.chains.map((chain) => chain.valueUsd))),
    );
    for (const shares of [total.byUnderlying, total.byIssuer])
      expect(shares.reduce((sum, s) => sum + s.bps, 0)).toBe(10_000);
  });

  it('agree across routes: a history ends at the newest snapshot, and lists no vault never read', () => {
    const series = history().chains.flatMap((chain) => chain.vaults);
    expect(series.map((s) => s.address)).not.toContain(SOL_NEVER);
    for (const s of series) {
      const { newest } = planAt(s.address).plan;
      const last = s.points.at(-1);
      expect(last?.observedAt).toBe(newest?.observedAt);
      expect(last?.valueUsd).toBe(newest?.valueUsd);
      const times = s.points.map((p) => p.observedAt);
      expect(times).toEqual([...times].sort());
    }
    // newest first, as the route lists them
    for (const chain of rebalances().chains) {
      const times = chain.entries.map((e) => e.at);
      expect(times).toEqual([...times].sort().reverse());
    }
  });

  it('narrow as the routes do: one chain, one vault, nothing for an address of nobody’s', () => {
    expect(plans({ chain: 'robinhood' }).chains.map((c) => c.chain)).toEqual(['robinhood']);
    expect(plans({ chain: 'robinhood' }).unavailable).toEqual([]);
    const one = plans({ address: SOL_INCOME });
    expect(one.chains.map((c) => c.plans.map((p) => p.address))).toEqual([[SOL_INCOME], []]);
    expect(history({ address: SOL_INCOME }).chains[0]?.vaults).toHaveLength(1);
    expect(
      rebalances({ address: SOL_INCOME }).chains.flatMap((c) => c.entries.map((e) => e.vault)),
    ).toEqual([SOL_INCOME, SOL_INCOME]);
    expect(rebalances({ limit: 1 }).chains.map((c) => c.entries.length)).toEqual([1, 1]);
    // the exposure of one vault is that vault's alone
    const own = exposure({ address: SOL_INCOME });
    expect(own.total?.valueUsd).toBe(planAt(SOL_INCOME).plan.newest?.valueUsd);
    expect(own.chains.map((c) => c.vaults)).toEqual([1, 0]);
    const nobody = 'So11111111111111111111111111111111111111112';
    expect(exposure({ address: nobody }).total).toBeNull();
    expect(plans({ address: nobody }).chains.flatMap((c) => c.plans)).toEqual([]);
  });
});

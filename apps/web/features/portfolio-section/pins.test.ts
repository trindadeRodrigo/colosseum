import type { PlanNewest } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { pinState } from '../../components/ui/provenance';
import {
  entryPin,
  exitPin,
  exposurePin,
  leastLive,
  pointPin,
  pricePin,
  putInPin,
  snapshotPin,
  sourcedPin,
  sumPin,
} from './pins';
import {
  exposure,
  history,
  planAt,
  RH_SILENT,
  rebalances,
  SOL_GROW,
  SOL_INCOME,
  SOL_STALE,
} from './test/fixtures';

// What each figure of the section hands its pin: the stamp its answer carries, as it came. A figure
// is live only when everything it stands on is, a snapshot is stale only when the answer says so, and
// a stamp that lacks a part gives no pin at all.

const newestOf = (address: string): PlanNewest => {
  const { newest } = planAt(address).plan;
  if (!newest) throw new Error('never read');
  return newest;
};
const live = (newest: PlanNewest): PlanNewest => ({
  ...newest,
  provenance: 'live',
  prices: newest.prices.map((price) => ({ ...price, provenance: 'live' })),
});

describe('the pin of a vault’s value', () => {
  it('is the snapshot’s own stamp: its source, the time it was taken, its method', () => {
    const newest = newestOf(SOL_GROW);
    expect(snapshotPin(newest, 'sandbox', 'sandbox')).toEqual({
      source: newest.source,
      fetchedAt: newest.observedAt,
      method: newest.method,
      provenance: 'sandbox',
      staleAgeSec: null,
    });
  });

  it('is stale when the answer says the snapshot is, with the age the answer gives', () => {
    const stale = newestOf(SOL_STALE);
    expect(stale.stale).toBe(true);
    expect(snapshotPin(stale).staleAgeSec).toBe(stale.ageSeconds);
    // nothing is worked out from the time: an old time the answer does not call stale is not stale
    const old = { ...newestOf(SOL_GROW), observedAt: '2020-01-01T00:00:00.000Z' };
    expect(snapshotPin(old).staleAgeSec).toBeNull();
    // the pin draws it stale only for a live figure; one that is not live keeps its hatched pin
    expect(pinState(snapshotPin(live(stale)))).toBe('stale');
    expect(pinState(snapshotPin(stale))).toBe('mock');
  });

  it('is live only when the snapshot, what it sits under and every price it stood on are', () => {
    const newest = live(newestOf(SOL_GROW));
    expect(snapshotPin(newest, 'live', 'live').provenance).toBe('live');
    expect(snapshotPin(newest, 'live', 'sandbox').provenance).toBe('sandbox');
    expect(snapshotPin(newest, 'mock', 'live').provenance).toBe('mock');
    const [first, ...rest] = newest.prices;
    if (!first) throw new Error('no price');
    const onePriceOff = {
      ...newest,
      prices: [{ ...first, provenance: 'sandbox' as const }, ...rest],
    };
    expect(snapshotPin(onePriceOff, 'live', 'live').provenance).toBe('sandbox');
    // a price of a position that has no value adds no label: the value does not stand on it
    const unused = {
      ...newest,
      prices: [...newest.prices, { ...first, asset: 'solana:other', provenance: 'mock' as const }],
    };
    expect(snapshotPin(unused, 'live', 'live').provenance).toBe('live');
    expect(leastLive('live')).toBe('live');
    expect(leastLive('live', 'sandbox', 'mock')).toBe('mock');
  });
});

describe('the pins of the other stamps', () => {
  it('hands what was put in its own stamp, under the labels of its chain and its vault', () => {
    const { chain, plan } = planAt(SOL_INCOME);
    if (!plan.putIn) throw new Error('nothing put in');
    expect(putInPin(plan.putIn, chain.provenance, plan.provenance)).toEqual({
      source: plan.putIn.source,
      fetchedAt: plan.putIn.fetchedAt,
      method: plan.putIn.method,
      provenance: 'sandbox',
    });
    expect(sourcedPin({ ...plan.putIn, provenance: 'live' }, 'mock').provenance).toBe('mock');
  });

  it('hands a sum the sources of its parts, the oldest of their times and its own method', () => {
    const parts = [snapshotPin(newestOf(SOL_GROW)), snapshotPin(newestOf(SOL_STALE))];
    const sum = sumPin(parts, 'two vaults, added up');
    expect(sum.method).toBe('two vaults, added up');
    expect(sum.fetchedAt).toBe(newestOf(SOL_STALE).observedAt);
    expect(sum.source).toBe(newestOf(SOL_GROW).source);
    expect(sum.provenance).toBe('sandbox');
    // stale as its stalest part
    expect(sum.staleAgeSec).toBe(newestOf(SOL_STALE).ageSeconds);
    // a sum across labels is the least live of them
    expect(sumPin([...parts, snapshotPin(newestOf(RH_SILENT))], 'm').provenance).toBe('mock');
  });

  it('hands a price its own stamp, stale when the price says it is, never more live than its chain', () => {
    const [price] = newestOf(SOL_GROW).prices;
    if (!price) throw new Error('no price');
    expect(pricePin(price)).toMatchObject({
      source: price.source,
      fetchedAt: price.fetchedAt,
      method: price.method,
      provenance: 'sandbox',
      staleAgeSec: null,
    });
    expect(pricePin({ ...price, ageSeconds: 600 }).staleAgeSec).toBe(600);
    expect(pricePin({ ...price, provenance: 'live' }, 'mock').provenance).toBe('mock');
  });

  it('hands a point of a history the series’ stamp, and its own where it differs', () => {
    const chain = history().chains[0];
    const series = chain?.vaults.find((s) => s.address === SOL_GROW);
    if (!chain || !series) throw new Error('no series');
    const [plain, other] = series.points;
    if (!plain || !other) throw new Error('no points');
    expect(pointPin(series, plain, chain.provenance)).toEqual({
      source: series.source,
      fetchedAt: plain.observedAt,
      method: series.method,
      provenance: 'sandbox',
    });
    expect(other.source).toBeDefined();
    expect(pointPin(series, other, chain.provenance).source).toBe(other.source);
  });

  it('hands a rebalance entry its own stamp', () => {
    const chain = rebalances().chains[0];
    const [entry] = chain?.entries ?? [];
    if (!chain || !entry) throw new Error('no entry');
    expect(entryPin(entry, chain.provenance)).toEqual({
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      method: entry.method,
      provenance: 'sandbox',
    });
  });

  it('hands a chain’s sums of holdings their stamp, and none where no snapshot stands behind them', () => {
    const [solana] = exposure().chains;
    if (!solana) throw new Error('no chain');
    expect(exposurePin(solana)).toEqual({
      source: solana.source,
      fetchedAt: solana.observedAt,
      method: solana.method,
      provenance: 'sandbox',
    });
    expect(exposurePin({ ...solana, observedAt: null })).toBeNull();
  });

  it('pins an exit cost only when the measurement has its source, time, method and label', () => {
    const [solana] = exposure().chains;
    const [whole, , noTime, tier] = solana?.exit ?? [];
    if (!solana || !whole || !noTime || !tier) throw new Error('no exits');
    // Bearing's own label is live; the holding is on a test network, and so is the figure
    expect(whole.provenance).toBe('live');
    expect(exitPin(whole, solana.provenance)).toEqual({
      source: whole.source,
      fetchedAt: whole.fetchedAt,
      method: whole.method,
      provenance: 'sandbox',
    });
    expect(exitPin(whole, 'live')?.provenance).toBe('live');
    // the time left out is never made up, and a tier is no measurement at all: no pin for either
    expect(exitPin(noTime, solana.provenance)).toBeNull();
    expect(exitPin(tier, solana.provenance)).toBeNull();
  });
});

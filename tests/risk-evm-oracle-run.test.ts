import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createDb, riskPriceObservations } from '@colosseum/db';
import type { AssetList } from '@colosseum/schemas';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { encodeAggregate3, word } from '../scripts/risk-evm/abi';
import { CHAINS, type ChainConfig } from '../scripts/risk-evm/config';
import type { AssetSnapshotRow } from '../scripts/risk-evm/curve';
import { type CutForCollector, listRun } from '../scripts/risk-evm/listed';
import {
  ORACLE_METHOD_VERSION,
  type OracleRow,
  oracleCalls,
  oracleRows,
  parseOracleRow,
  toObservation,
} from '../scripts/risk-evm/oracle';
import { insertOracleRows } from '../scripts/risk-evm/oracle-import';
import { replayRpc } from '../scripts/risk-evm/replay';
import type { RpcReply, RpcRequest } from '../scripts/risk-evm/rpc';
import { collectOnce } from '../scripts/risk-evm/run';

// PLAN-UNIVERSE RU.7: the oracle recorded beside the pool price. The fixture is the recorded list run
// for NVDA and GME (scripts/risk-evm/record-list-fixture.ts), whose first call after the block is the
// feeds' latestRoundData() at that block. No test calls the network.
type Fixture = {
  fetchedAt: string;
  block: number;
  names: { list: string; cut: string };
  list: Pick<AssetList, 'chain' | 'inputs' | 'assets'>;
  cut: CutForCollector;
  threePools: { discoveredAt: string };
  answers: Record<string, RpcReply>;
};
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-list-run.json.gz')).toString(),
) as Fixture;
const robinhood = CHAINS.find((c) => c.id === 'robinhood') as ChainConfig;
const { tokens, listed } = listRun(robinhood, fx.list, fx.cut, fx.names);
const jsonl = <T>(path: string): T[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];
const feedsCall = encodeAggregate3(
  oracleCalls(tokens.flatMap((t) => listed.feeds[t.symbol] ?? [])),
);
const isFeedsCall = (r: RpcRequest) =>
  r.method === 'eth_call' && (r.params[0] as { data?: string }).data === feedsCall;

async function replay(override?: (r: RpcRequest) => RpcReply | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-evm-oracle-'));
  const rpc = replayRpc(fx.answers, override);
  const events: Record<string, unknown>[] = [];
  const summary = await collectOnce(
    { ...robinhood, tokens },
    {
      dir,
      maxPools: Number.MAX_SAFE_INTEGER,
      minLiquidityUsd: 10_000,
      poolsMaxAgeHours: 24,
      rediscover: false,
      listed,
      rpc,
      now: () => Date.parse(fx.threePools.discoveredAt) + 1_000,
      sleep: async () => {},
      log: (e) => events.push(e),
    },
  );
  const day = fx.fetchedAt.slice(0, 10);
  return {
    summary,
    events,
    asked: rpc.asked,
    oracle: jsonl<OracleRow>(join(dir, 'oracle', `${day}.jsonl`)),
    assets: jsonl<AssetSnapshotRow>(join(dir, 'assets', `${day}.jsonl`)),
  };
}

describe('the oracle of a list run, replayed', async () => {
  const run = await replay();

  it('reads every tracked feed in one call at the block of the pool prices', () => {
    const calls = run.asked.filter(isFeedsCall);
    expect(calls).toHaveLength(1);
    expect((calls[0] as RpcRequest).params[1]).toBe(`0x${fx.block.toString(16)}`);
    expect(run.oracle.map((r) => r.asset).sort()).toEqual(['GME', 'NVDA']);
    expect(run.summary.list).toMatchObject({ oracleRows: 2, oracleRowsRead: 2 });
    expect(run.summary.list?.oracleError).toBeUndefined();
    for (const r of run.oracle) {
      const asset = run.assets.find((a) => a.asset === r.asset) as AssetSnapshotRow;
      // the same block and the same time as the stock's pool prices, in a file of its own
      expect(r.slot).toBe(asset.slot);
      expect(r.fetchedAt).toBe(asset.fetchedAt);
      expect(r.assetMint).toBe(asset.assetMint);
      expect(r.feed).toBe(fx.list.assets.find((a) => a.symbol === r.asset)?.oracle?.ref);
      expect(r.methodVersion).toBe(ORACLE_METHOD_VERSION);
      expect(r.provenance).toBe('live');
      expect(r.source).toContain(`at block ${fx.block}`);
      expect(r.reason).toBeNull();
    }
  });

  it('each row`s age is the block time less the feed`s updatedAt, and the price is the answer with its point', () => {
    for (const r of run.oracle) {
      const age = (Date.parse(r.fetchedAt) - Date.parse(r.updatedAt as string)) / 1000;
      expect(r.ageSeconds).toBe(age);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(r.decimals).toBe(8);
      expect(r.price).toMatch(/^\d+\.\d{8}$/);
      expect((r.price as string).replace('.', '').replace(/^0+/, '')).toBe(r.answer);
    }
  });

  it('a second replay gives the same rows', async () => {
    expect((await replay()).oracle).toEqual(run.oracle);
  });

  it('keeps the oracle out of the asset row: the pool rows are the same with the read refused', async () => {
    const refused = await replay((r) =>
      isFeedsCall(r) ? { error: { message: 'rate limit exceeded' } } : undefined,
    );
    expect(refused.oracle).toEqual([]);
    expect(refused.summary.list).toMatchObject({
      oracleRows: 0,
      oracleRowsRead: 0,
      oracleError: 'rate limit exceeded',
    });
    expect(refused.events.some((e) => e.event === 'oracle_read_failed')).toBe(true);
    // ORACLE-VS-DEX: nothing of the pool price depends on the feed
    expect(refused.assets).toEqual(run.assets);
    expect(JSON.stringify(run.assets)).not.toContain('chainlink');
  });

  it('asks nothing of a stock with no oracle', () => {
    const none = JSON.parse(JSON.stringify(fx.list)) as Fixture['list'];
    const gme = none.assets.find((a) => a.symbol === 'GME');
    if (!gme) throw new Error('fixture');
    Object.assign(gme, { oracle: null, oracleReason: 'no_feed', autoRebalance: false });
    const plan = listRun(robinhood, none, fx.cut, fx.names);
    expect(Object.keys(plan.listed.feeds)).toEqual(['NVDA']);
    expect(plan.tokens.map((t) => t.symbol).sort()).toEqual(['GME', 'NVDA']);
  });
});

describe('oracle rows, by hand', () => {
  const round = (answer: bigint, updatedAt: number) => ({
    success: true,
    data: `0x${word(7n)}${word(answer)}${word(BigInt(updatedAt - 5))}${word(BigInt(updatedAt))}${word(7n)}`,
  });
  const token = (symbol: string, n: string) => ({
    token: { symbol, address: `0x${n.repeat(20)}`, decimals: 18 },
    feed: { address: `0x${n.repeat(19)}ff`, decimals: 8 },
  });
  const blockTime = new Date('2026-10-06T00:10:00.000Z');
  const at = blockTime.getTime() / 1000;
  const rows = oracleRows({
    chain: 'robinhood',
    tokens: [token('AAA', 'a1'), token('BBB', 'b2'), token('CCC', 'c3')],
    replies: [round(24028000000n, at - 600), { success: false, data: '0x' }, round(0n, at - 30)],
    blockTime,
    blockNumber: 9,
    source: 'by hand',
  });

  it('places the point, and counts the age from the block', () => {
    expect(rows[0]).toMatchObject({
      asset: 'AAA',
      answer: '24028000000',
      price: '240.28000000',
      updatedAt: '2026-10-06T00:00:00.000Z',
      ageSeconds: 600,
      slot: 9,
      reason: null,
    });
  });

  it('a feed that does not answer, or answers zero, is a row with null and the reason', () => {
    expect(rows[1]).toMatchObject({
      price: null,
      answer: null,
      updatedAt: null,
      ageSeconds: null,
      reason: 'no_answer_from_the_feed',
    });
    expect(rows[2]).toMatchObject({ price: null, answer: null, reason: 'answer_not_positive' });
    expect(rows[2]?.ageSeconds).toBe(30);
    expect(() =>
      oracleRows({
        chain: 'robinhood',
        tokens: [token('AAA', 'a1')],
        replies: [],
        blockTime,
        blockNumber: 9,
        source: 'by hand',
      }),
    ).toThrow(/1 feeds, 0 answers/);
  });

  it('parses its own rows and refuses a line that is not one', () => {
    for (const r of rows) expect(parseOracleRow(JSON.parse(JSON.stringify(r)))).toEqual(r);
    const good = rows[0] as OracleRow;
    expect(parseOracleRow({ ...good, methodVersion: 'evmq-0.1' })).toBeNull();
    expect(parseOracleRow({ ...good, price: '0' })).toBeNull();
    expect(parseOracleRow({ ...good, price: null })).toBeNull();
    expect(parseOracleRow({ ...good, updatedAt: null })).toBeNull();
    const { source: _source, ...bare } = good;
    expect(parseOracleRow(bare)).toBeNull();
    expect(parseOracleRow('x')).toBeNull();
  });

  it('becomes a price observation with the feed`s own time; a row with no price becomes none', () => {
    expect(toObservation(rows[0] as OracleRow)).toMatchObject({
      chain: 'robinhood',
      mint: `0x${'a1'.repeat(20)}`,
      priceSource: 'chainlink',
      ref: `0x${'a1'.repeat(19)}ff`,
      observedAt: blockTime,
      slot: 9,
      price: 240.28,
      quote: 'usd',
      sourceTs: new Date('2026-10-06T00:00:00.000Z'),
      methodVersion: 'evmo-0.1',
      provenance: 'live',
    });
    expect(toObservation(rows[1] as OracleRow)).toBeNull();
  });

  it('a second import inserts nothing (in a transaction that is rolled back)', async () => {
    const { db, client } = createDb();
    const outcome = { first: -1, second: -1, noPrice: -1, stored: 0 };
    class Undo extends Error {}
    try {
      await db.transaction(async (tx) => {
        const first = await insertOracleRows(tx, rows);
        const second = await insertOracleRows(tx, rows);
        outcome.first = first.inserted;
        outcome.second = second.inserted;
        outcome.noPrice = first.noPrice;
        const stored = await tx
          .select()
          .from(riskPriceObservations)
          .where(
            and(
              eq(riskPriceObservations.priceSource, 'chainlink'),
              eq(riskPriceObservations.mint, `0x${'a1'.repeat(20)}`),
            ),
          );
        outcome.stored = stored.length;
        expect(stored[0]).toMatchObject({ chain: 'robinhood', price: 240.28, live: true });
        expect(stored[0]?.sourceTs?.toISOString()).toBe('2026-10-06T00:00:00.000Z');
        throw new Undo();
      });
    } catch (e) {
      if (!(e instanceof Undo)) throw e;
    } finally {
      await client.end();
    }
    expect(outcome).toEqual({ first: 1, second: 0, noPrice: 2, stored: 1 });
  });
});

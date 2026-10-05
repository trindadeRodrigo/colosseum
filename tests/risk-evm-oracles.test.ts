import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { defaultRegimeParams } from '@colosseum/risk';
import { describe, expect, it } from 'vitest';
import { decodeAggregate3, words } from '../scripts/risk-evm/abi';
import { CHAINS } from '../scripts/risk-evm/config';
import {
  CALLS_PER_FEED,
  decodeRound,
  feedCalls,
  type MatchContext,
  matchToken,
  namesToken,
  ORACLES_METHOD,
  type OraclesFile,
  parseDirectory,
  readFeeds,
  runOracles,
  unitsToDecimal,
  VAULT_STOCK_MAX_AGE_SECONDS,
  type Wanted,
} from '../scripts/risk-evm/feeds';
import type { Reply } from '../scripts/risk-evm/multicall';
import { replayRpc } from '../scripts/risk-evm/replay';
import type { RpcReply } from '../scripts/risk-evm/rpc';

// PLAN-UNIVERSE RU.5: the oracle map of Robinhood Chain. The fixture is one real pass of
// `pnpm risk-evm:oracles` (scripts/risk-evm/record-oracles-fixture.ts): Chainlink's directory and the
// chain's answers as they came. No test calls the network.
type DirectoryEntry = Record<string, unknown> & { name: string; proxyAddress: string };
const fx = JSON.parse(
  gunzipSync(readFileSync('fixtures/risk-evm/robinhood-oracles.json.gz')).toString(),
) as {
  now: number;
  block: number;
  inputs: OraclesFile['inputs'] & { calendar: string };
  directoryUrl: string;
  directory: DirectoryEntry[];
  tracked: Wanted[];
  collected: Wanted[];
  rpcLabel: string;
  registry: Array<Wanted & { multiplier: string | null }>;
  answers: Record<string, RpcReply>;
  file: OraclesFile;
};
const robinhood = CHAINS.find((c) => c.id === 'robinhood');
if (!robinhood) throw new Error('no robinhood chain in config.ts');
const chain = robinhood;
const regime = defaultRegimeParams(JSON.parse(readFileSync(fx.inputs.calendar, 'utf8')));

type Change = {
  directory?: DirectoryEntry[];
  registry?: typeof fx.registry;
  tracked?: Wanted[];
  /** Seconds added to the time of the block the endpoint reports. */
  later?: number;
};
/** The recorded pass again, with the directory, the lists or the block's time changed. */
async function replay(change: Change = {}) {
  const rpc = replayRpc(fx.answers, (r) => {
    if (r.method !== 'eth_getBlockByNumber' || !change.later) return undefined;
    const head = Object.values(fx.answers).find((a) => typeof a.result === 'object')?.result as {
      number: string;
      timestamp: string;
    };
    return {
      result: { ...head, timestamp: `0x${(Number(head.timestamp) + change.later).toString(16)}` },
    };
  });
  const file = await runOracles(
    chain,
    { rpc, fetchJson: async () => change.directory ?? fx.directory, now: () => fx.now },
    {
      directoryUrl: fx.directoryUrl,
      tracked: change.tracked ?? fx.tracked,
      collected: fx.collected,
      registry: change.registry ?? fx.registry,
      regime,
      rpcLabel: fx.rpcLabel,
      inputs: fx.inputs,
    },
  );
  return { file, rpc };
}
/** The directory with some feeds renamed: the addresses, and so the calls, stay as recorded. */
const renamed = (names: Record<string, string>) =>
  fx.directory.map((f) => ({ ...f, name: names[f.name] ?? f.name }));
const rowOf = (file: OraclesFile, symbol: string) => {
  const row = [...file.tracked, ...file.collectedNotTracked].find((r) => r.symbol === symbol);
  if (!row) throw new Error(`no row for ${symbol}`);
  return row;
};
const NO_FEED = ['AMC', 'COST', 'DJT', 'HIMS', 'LLY', 'RDDT'];

describe('the oracle map on the recorded pass', () => {
  it('replays to the file it was recorded as, in two requests', async () => {
    const { file, rpc } = await replay();
    expect(file).toEqual(fx.file);
    expect(rpc.asked.map((r) => r.method)).toEqual(['eth_getBlockByNumber', 'eth_call']);
    expect(file.rpc).toMatchObject({
      rpcCalls: 2,
      contractReads: fx.directory.length * CALLS_PER_FEED,
      seconds: 0,
    });
    // every contract read is at the one block the endpoint named
    expect(rpc.asked[1]?.params[1]).toBe(`0x${fx.block.toString(16)}`);
    expect(file.block).toBe(fx.block);
  });

  it('the check: every tracked stock has a confirmed feed or no_feed, and those without are named', async () => {
    const { file } = await replay();
    expect(file.tracked).toHaveLength(30);
    expect(file.tracked.map((r) => r.address)).toEqual(fx.tracked.map((t) => t.address));
    expect(new Set(file.tracked.map((r) => r.address.toLowerCase())).size).toBe(30);
    for (const r of file.tracked) {
      expect(r.tracked).toBe(true);
      if (r.feed === null) expect(r.reason).toBe('no_feed');
      else expect(r.reason).toBeNull();
    }
    expect(file.counts).toMatchObject({
      tracked: 30,
      trackedWithFeed: 24,
      trackedWithoutFeed: 6,
      trackedWithoutFeedByReason: { no_feed: 6 },
    });
    expect(file.trackedWithoutFeed.map((t) => t.symbol).sort()).toEqual(NO_FEED);
    for (const t of file.trackedWithoutFeed)
      expect(fx.tracked.find((x) => x.symbol === t.symbol)?.address).toBe(t.address);
  });

  it('every row carries its source, time, method and provenance', async () => {
    const { file } = await replay();
    for (const r of [...file.tracked, ...file.collectedNotTracked]) {
      expect(r.source).toContain(fx.directoryUrl);
      expect(r.source).toContain(`block ${fx.block}`);
      expect(r.fetchedAt).toBe(file.fetchedAt);
      expect(r.method).toBe(ORACLES_METHOD);
      expect(r.provenance).toBe('live');
    }
    expect(Date.parse(file.fetchedAt)).not.toBeNaN();
    expect(file.method).toBe('evm-oracles-0.1');
  });

  it('a confirmed feed is the proxy of the directory, named by its own contract, with the answer as read', async () => {
    const { file } = await replay();
    const replies = decodeAggregate3(
      Object.values(fx.answers).find((a) => typeof a.result === 'string')?.result as string,
    );
    const { feeds } = parseDirectory(fx.directory);
    for (const r of file.tracked) {
      if (!r.feed) continue;
      const i = feeds.findIndex((f) => f.proxyAddress === r.feed?.address);
      const listed = feeds[i];
      expect(listed && namesToken(listed.name, r.symbol)).toBe(true);
      expect(namesToken(r.feed.description, r.symbol)).toBe(true);
      expect(r.feed.decimals).toBe(listed?.decimals);
      // the proxy points at the aggregator the directory lists
      expect(r.feed.aggregator?.toLowerCase()).toBe(listed?.contractAddress?.toLowerCase());
      expect(r.feed.aggregatorIsTheListedOne).toBe(true);
      // the answer is the second word of latestRoundData(), digit for digit
      const round = words((replies[i * CALLS_PER_FEED + 2] as Reply).data);
      expect(r.feed.round.answer).toBe((round[1] as bigint).toString());
      expect(r.feed.round.price.replace('.', '').replace(/^0+/, '')).toBe(r.feed.round.answer);
      expect(Date.parse(r.feed.round.updatedAt) / 1000).toBe(Number(round[3]));
      expect(r.feed.ageSeconds).toBe(Date.parse(file.fetchedAt) / 1000 - Number(round[3]));
      expect(r.feed.ageSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('the contracts name a stock in four ways, and all four are read', async () => {
    const { file } = await replay();
    expect(rowOf(file, 'SPY').feed?.description).toBe('RHSPY / USD');
    expect(rowOf(file, 'QQQ').feed?.description).toBe('Robinhood QQQ / USD');
    expect(rowOf(file, 'DELL').feed?.description).toBe('Robinhood DELL-USD');
    expect(rowOf(file, 'GLD').feed?.description).toBe('GLD / USD');
  });

  it('the collected token that is not tracked is printed apart', async () => {
    const { file } = await replay();
    expect(file.collectedNotTracked.map((r) => r.symbol)).toEqual(['TSM']);
    const tsm = rowOf(file, 'TSM');
    expect(tsm.tracked).toBe(false);
    expect(tsm.feed?.description).toBe('Robinhood TSM / USD');
    expect(file.tracked.some((r) => r.symbol === 'TSM')).toBe(false);
    expect(file.counts.collectedNotTrackedWithFeed).toBe(1);
  });

  it('the funds and the treasury token: a feed for each, and what the directory says it prices', async () => {
    const { file } = await replay();
    expect(file.funds.map((f) => f.symbol)).toEqual(['SPY', 'QQQ', 'GLD', 'SLV', 'USO', 'SGOV']);
    for (const f of file.funds) {
      expect(f.hasFeed).toBe(true);
      // the registry's multiplier is printed beside, as the registry wrote it
      expect(f.registryMultiplier).toBe(fx.registry.find((t) => t.symbol === f.symbol)?.multiplier);
    }
    const by = (s: string) => file.funds.find((f) => f.symbol === s);
    for (const s of ['SPY', 'QQQ', 'SLV', 'USO'])
      expect(by(s)).toMatchObject({ prices: 'token_with_multiplier', pricesReason: null });
    // gold's feed is of another kind: a price from the pools, around the clock
    expect(by('GLD')).toMatchObject({
      prices: 'token_from_pools',
      attributeType: 'dex_state_price',
      marketHours: 'Crypto',
    });
    // the directory says nothing of the treasury token's product: unknown, not guessed
    expect(by('SGOV')).toMatchObject({
      prices: null,
      pricesReason: 'not_stated_in_directory',
      productTypeCode: null,
    });
  });

  it('the proxy is stored because an aggregator may refuse a direct call', async () => {
    const { file } = await replay();
    expect(rowOf(file, 'GLD').feed?.aggregatorAnswersDirectly).toBe(false);
    expect(rowOf(file, 'SPY').feed?.aggregatorAnswersDirectly).toBe(true);
    expect(file.counts.aggregatorsNotAnsweringDirectly).toBe(1);
  });
});

describe('what is refused, and what is not', () => {
  it('a feed whose description does not name the token is refused, with the reason', async () => {
    // the directory now calls QQQ's feed SPY's; the contract still says what it is
    const { file } = await replay({
      directory: renamed({
        'Robinhood SPY / USD': 'Robinhood XYZ / USD',
        'Robinhood QQQ / USD': 'Robinhood SPY / USD',
      }),
    });
    const spy = rowOf(file, 'SPY');
    expect(spy.feed).toBeNull();
    expect(spy.reason).toBe('description_does_not_name_the_token');
    expect(spy.detail).toContain('"Robinhood QQQ / USD"');
    expect(spy.candidates).toHaveLength(1);
    expect(spy.candidates[0]?.description).toBe('Robinhood QQQ / USD');
    expect(rowOf(file, 'QQQ')).toMatchObject({ feed: null, reason: 'no_feed', candidates: [] });
    expect(file.counts.trackedWithoutFeedByReason).toEqual({
      no_feed: 7,
      description_does_not_name_the_token: 1,
    });
    expect(file.trackedWithoutFeed).toContainEqual({
      symbol: 'SPY',
      address: spy.address,
      reason: 'description_does_not_name_the_token',
    });
  });

  it('a stock with no feed in the directory is null with no_feed, never a zero', async () => {
    const { file } = await replay();
    for (const s of NO_FEED)
      expect(rowOf(file, s)).toMatchObject({
        feed: null,
        reason: 'no_feed',
        detail: null,
        candidates: [],
      });
  });

  it('two feeds naming one stock: both are listed and neither is chosen', async () => {
    const { file } = await replay({
      directory: renamed({ 'Robinhood EWY / USD': 'Robinhood SPY / USD' }),
    });
    const spy = rowOf(file, 'SPY');
    expect(spy).toMatchObject({ feed: null, reason: 'two_feeds_name_the_token' });
    expect(spy.candidates.map((c) => c.description)).toEqual([
      'Robinhood EWY / USD',
      'RHSPY / USD',
    ]);
    expect(file.counts.trackedWithFeed).toBe(23);
  });

  it('two tokens sharing a symbol: no feed is tied to either, tracked or not', async () => {
    const twin = { address: '0x00000000000000000000000000000000000000aa', symbol: 'SPY' };
    const { file } = await replay({
      registry: [...fx.registry, { ...twin, multiplier: null }],
      tracked: [...fx.tracked, twin],
    });
    const rows = file.tracked.filter((r) => r.symbol === 'SPY');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ feed: null, reason: 'symbol_shared_by_tokens' });
      expect(r.detail).toContain('2 tokens');
    }
    expect(rows[0]?.detail).toContain(twin.address);
    // the twin need not be tracked to be seen: the registry is what is searched
    const { file: untracked } = await replay({
      registry: [...fx.registry, { ...twin, multiplier: null }],
    });
    expect(rowOf(untracked, 'SPY').reason).toBe('symbol_shared_by_tokens');
    expect(untracked.funds.filter((f) => f.symbol === 'SPY')).toHaveLength(2);
  });

  it('one feed that reads as two tokens is refused', async () => {
    const { file } = await replay({
      directory: renamed({ 'Robinhood MU / USD': 'RHMU / USD' }),
      registry: [
        ...fx.registry,
        { address: '0x00000000000000000000000000000000000000bb', symbol: 'RHMU', multiplier: null },
      ],
    });
    expect(rowOf(file, 'MU')).toMatchObject({ feed: null, reason: 'feed_names_two_tokens' });
    expect(rowOf(file, 'MU').detail).toContain('RHMU');
  });

  it('an old answer is still a confirmed feed: its age is printed, off session, and nothing is refused', async () => {
    const { file: asRead } = await replay();
    const later = 3 * 86_400;
    const { file } = await replay({ later });
    expect(file.counts.trackedWithFeed).toBe(24);
    expect(file.counts.feedsOlderThanTheVaultLimit).toBe(25);
    expect(file.counts.feedsOlderThanTheirHeartbeat).toBe(25);
    for (const r of file.tracked) {
      if (!r.feed) continue;
      expect(r.reason).toBeNull();
      expect(r.feed.ageSeconds).toBe((rowOf(asRead, r.symbol).feed?.ageSeconds as number) + later);
      expect(r.feed.ageSeconds).toBeGreaterThan(VAULT_STOCK_MAX_AGE_SECONDS);
      expect(r.feed.round).toEqual(rowOf(asRead, r.symbol).feed?.round);
      expect(r.feed.session).toBe(file.session.atBlock);
    }
  });

  it('the session is the US session at the time of the block', async () => {
    // recorded on Monday 2026-10-05 after 19:00 in New York
    const { file } = await replay();
    expect(file.session).toMatchObject({ atBlock: 'us_offhours_weekday', inSession: false });
    // the same hour of the day five days on is inside the weekend
    const { file: saturday } = await replay({ later: 5 * 86_400 });
    expect(saturday.session.atBlock).toBe('weekend');
    expect(rowOf(saturday, 'SPY').feed).toMatchObject({ session: 'weekend', inSession: false });
  });
});

describe('the pieces', () => {
  const { feeds } = parseDirectory(fx.directory);
  const replies = decodeAggregate3(
    Object.values(fx.answers).find((a) => typeof a.result === 'string')?.result as string,
  );
  const blockTime = Date.parse(fx.file.fetchedAt) / 1000;
  const ctxWith = (changed: Reply[]): MatchContext => ({
    registry: fx.registry,
    feeds,
    onchain: readFeeds(feeds, changed),
    blockTime,
    regime,
    source: 'test',
  });
  const spy = fx.tracked.find((t) => t.symbol === 'SPY') as Wanted;
  const at = feeds.findIndex((f) => f.name === 'Robinhood SPY / USD') * CALLS_PER_FEED;
  const withReply = (offset: number, reply: Reply) =>
    replies.map((r, i) => (i === at + offset ? reply : r));
  const word = (v: bigint) => v.toString(16).padStart(64, '0');

  it('namesToken reads the forms in use and nothing wider', () => {
    for (const t of [
      'SPY / USD',
      'RHSPY / USD',
      'Robinhood SPY / USD',
      'Robinhood SPY-USD',
      ' RHSPY/USD ',
    ])
      expect(namesToken(t, 'SPY')).toBe(true);
    for (const t of [
      'Robinhood SPYX / USD',
      'XSPY / USD',
      'SPY / USDC',
      'SPY / USD Exchange Rate',
      'SYRUPUSDC / USDC Exchange Rate',
      'Robinhood spy / USD',
      'SPY',
      'USD',
      '',
    ])
      expect(namesToken(t, 'SPY')).toBe(false);
    expect(namesToken('RHSPY / USD', 'RHSPY')).toBe(true);
    expect(namesToken('BTC.B / USD', 'BTC.B')).toBe(true);
    expect(namesToken(' / USD', '')).toBe(false);
  });

  it('the directory: every listed feed is kept, and an entry that cannot be read is left out with a reason', () => {
    expect(feeds).toHaveLength(fx.directory.length);
    expect(feedCalls(feeds)).toHaveLength(feeds.length * CALLS_PER_FEED);
    const first = fx.directory[0] as DirectoryEntry;
    const { feeds: kept, skipped } = parseDirectory([
      first,
      { ...first, name: 'again' },
      { ...first, proxyAddress: null, name: 'no proxy' },
      { proxyAddress: '0x00000000000000000000000000000000000000cc' },
      null,
    ]);
    expect(kept).toHaveLength(1);
    expect(skipped).toEqual([
      { name: 'again', reason: 'proxy_listed_twice' },
      { name: 'no proxy', reason: 'no_proxy_address' },
      { name: '?', reason: 'no_name' },
      { name: '?', reason: 'no_name' },
    ]);
    expect(() => parseDirectory({ feeds: [] })).toThrow(/not a list/);
  });

  it('a feed that does not answer is not a feed', () => {
    const silent = { success: false, data: '0x' };
    for (const offset of [0, 1, 2]) {
      const row = matchToken(spy, true, ctxWith(withReply(offset, silent)));
      expect(row).toMatchObject({ feed: null, reason: 'no_answer_from_the_feed' });
    }
    expect(matchToken(spy, true, ctxWith(withReply(0, silent))).detail).toContain('description()');
    expect(matchToken(spy, true, ctxWith(withReply(2, silent))).detail).toContain(
      'latestRoundData()',
    );
    // without aggregator() the feed still stands: the proxy is what is read
    const noAggregator = matchToken(spy, true, ctxWith(withReply(3, silent)));
    expect(noAggregator.reason).toBeNull();
    expect(noAggregator.feed).toMatchObject({ aggregator: null, aggregatorIsTheListedOne: null });
  });

  it('an answer of zero or less, a time after the block, or other decimals are refused', () => {
    const round = words((replies[at + 2] as Reply).data) as bigint[];
    const roundWith = (i: number, v: bigint) => ({
      success: true,
      data: `0x${round.map((w, k) => word(k === i ? v : w)).join('')}`,
    });
    expect(matchToken(spy, true, ctxWith(withReply(2, roundWith(1, 0n))))).toMatchObject({
      feed: null,
      reason: 'answer_not_positive',
    });
    expect(
      matchToken(spy, true, ctxWith(withReply(2, roundWith(1, (1n << 256n) - 5n)))),
    ).toMatchObject({ reason: 'answer_not_positive', detail: 'latestRoundData() answered -5' });
    expect(
      matchToken(spy, true, ctxWith(withReply(2, roundWith(3, BigInt(blockTime + 1))))),
    ).toMatchObject({ feed: null, reason: 'round_time_not_in_the_past' });
    expect(matchToken(spy, true, ctxWith(withReply(2, roundWith(3, 0n)))).reason).toBe(
      'round_time_not_in_the_past',
    );
    expect(
      matchToken(spy, true, ctxWith(withReply(1, { success: true, data: `0x${word(18n)}` }))),
    ).toMatchObject({ feed: null, reason: 'decimals_differ_from_directory' });
    // and the answers as recorded confirm it
    expect(matchToken(spy, true, ctxWith(replies)).reason).toBeNull();
  });

  it('decodeRound wants the five words and nothing else', () => {
    expect(decodeRound(replies[at + 2] as Reply)?.updatedAt).toBeGreaterThan(0);
    expect(decodeRound({ success: true, data: `0x${word(1n).repeat(4)}` })).toBeNull();
    expect(decodeRound({ success: false, data: (replies[at + 2] as Reply).data })).toBeNull();
    expect(readFeeds(feeds, replies)).toHaveLength(feeds.length);
    expect(() => readFeeds(feeds, replies.slice(1))).toThrow(/answers/);
  });

  it('unitsToDecimal places the point and changes no digit', () => {
    expect(unitsToDecimal('12345678901', 8)).toBe('123.45678901');
    expect(unitsToDecimal('5', 8)).toBe('0.00000005');
    expect(unitsToDecimal('100000000', 8)).toBe('1.00000000');
    expect(unitsToDecimal('42', 0)).toBe('42');
    expect(unitsToDecimal('-5', 2)).toBe('-0.05');
    expect(unitsToDecimal('1000000000000000000', 18)).toBe('1.000000000000000000');
  });
});

describe('from the review', () => {
  it('a contract whose own description reads as two tokens is refused too', async () => {
    // the directory's name is plain; MU's contract calls itself "RHMU / USD"
    const { file } = await replay({
      registry: [
        ...fx.registry,
        { address: '0x00000000000000000000000000000000000000bb', symbol: 'RHMU', multiplier: null },
      ],
    });
    expect(rowOf(file, 'MU')).toMatchObject({ feed: null, reason: 'feed_names_two_tokens' });
    expect(rowOf(file, 'MU').detail).toContain('the contract calls itself "RHMU / USD"');
  });

  it('a directory that lists nothing, or names no token, writes nothing', async () => {
    await expect(replay({ directory: [] })).rejects.toThrow(/none names a token/);
    await expect(
      replay({
        directory: fx.directory.filter(
          (f) => !fx.registry.some((t) => namesToken(f.name, t.symbol)),
        ),
      }),
    ).rejects.toThrow(/none names a token/);
  });

  it('a feed whose decimals the directory does not give is not confirmed', async () => {
    const { file } = await replay({
      directory: fx.directory.map((f) =>
        f.name === 'Robinhood SPY / USD' ? { ...f, decimals: null } : f,
      ),
    });
    expect(rowOf(file, 'SPY')).toMatchObject({
      feed: null,
      reason: 'decimals_differ_from_directory',
    });
    expect(file.counts.trackedWithFeed).toBe(23);
  });

  it('the replay does not read the collected list of config.ts', () => {
    expect(fx.collected).toHaveLength(21);
    expect(fx.file.source).toContain(fx.rpcLabel);
  });
});

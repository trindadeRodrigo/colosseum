import type Anthropic from '@anthropic-ai/sdk';
import type { BasketAsset } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { fixtureLookups, OFFLINE_DB } from '../testing/lookups';
import {
  emptyLooked,
  LOOKUP_FINAL_MS,
  LOOKUP_MAX_ROUNDS,
  LOOKUP_TOOLS,
  LOOKUP_WAIT_MS,
  type LookupCall,
  type LookupResponse,
  type LookupScope,
  mergeLooked,
  runLookupLoop,
} from './lookup-loop';
import type { AssetLookups, LookupAnswer } from './lookups';
import { figureResolver } from './vault-figures';

// The lookup loop of both conversations (FIGURES-BY-REFERENCE as amended 2026-10-14, ledger
// API-AGENT-LOOKUPS-2), with the model and the reader stubbed: what goes to the model, what comes back
// into the request's evidence, and where the loop stops.

const catalog = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const NVDA = 'solana:nvdax';
const TSLA = 'solana:tslax';
const scope = (service: AssetLookups = fixtureLookups()): LookupScope => ({
  service,
  db: OFFLINE_DB,
  chain: 'solana',
  catalog,
});
const use = (id: string, name: string, input: unknown): Anthropic.ToolUseBlock =>
  ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }) as Anthropic.ToolUseBlock;
const thinking = { type: 'thinking', thinking: 'which asset', signature: 'opaque-sig' } as const;
const asks = (...uses: Anthropic.ToolUseBlock[]): LookupResponse => ({
  stop_reason: 'tool_use',
  content: [thinking, ...uses] as unknown as Anthropic.ContentBlock[],
});
const answer: LookupResponse = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"say":"done"}', citations: null }],
};
type Sent = Parameters<LookupCall>[0];
/** A model that answers in turn from `responses`, the last again, and keeps every request. */
function model(...responses: LookupResponse[]) {
  const sent: Sent[] = [];
  const call: LookupCall = async (request) => {
    sent.push(request);
    return responses[Math.min(sent.length - 1, responses.length - 1)] as LookupResponse;
  };
  return { call, sent };
}
const base: Anthropic.MessageParam[] = [{ role: 'user', content: 'how did NVDAx move this week?' }];
const resultsOf = (message: Anthropic.MessageParam | undefined) =>
  ((message?.content ?? []) as Anthropic.ToolResultBlockParam[]).map((block) => ({
    ...block,
    json: JSON.parse(block.content as string),
  }));

describe('the lookup loop', () => {
  it('offers four read-only tools, sorted, the same bytes each time, with strict inputs', () => {
    expect(LOOKUP_TOOLS.map((tool) => tool.name)).toEqual([
      'asset_lending',
      'asset_pools',
      'asset_price_history',
      'asset_profile',
    ]);
    for (const tool of LOOKUP_TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema).toMatchObject({ additionalProperties: false });
      expect(tool.input_schema.required).toContain('assetId');
      expect(tool.description).toMatch(/Read-only/u);
    }
    expect(LOOKUP_TOOLS.find((t) => t.name === 'asset_price_history')?.input_schema).toMatchObject({
      required: ['assetId', 'window'],
      properties: { window: { enum: ['24h', '7d', '30d'] } },
    });
    expect(LOOKUP_MAX_ROUNDS).toBe(3);
    expect(LOOKUP_WAIT_MS).toBe(2_500);
  });

  it('runs every call of a turn at once, and sends all results back in one user message after the turn as it came', async () => {
    const turn = asks(
      use('a', 'asset_price_history', { assetId: NVDA, window: '7d' }),
      use('b', 'asset_profile', { assetId: NVDA }),
    );
    const { call, sent } = model(turn, answer);
    const run = await runLookupLoop({ call, messages: base, reserve: () => null, scope: scope() });
    expect(run.kind).toBe('answered');
    expect(sent).toHaveLength(2);
    const second = sent[1]?.messages ?? [];
    expect(second).toHaveLength(3);
    // the assistant's content unchanged, thinking block and signature included
    expect(second[1]).toEqual({ role: 'assistant', content: turn.content });
    expect(second[2]?.role).toBe('user');
    const results = resultsOf(second[2]);
    expect(results.map((r) => [r.type, r.tool_use_id])).toEqual([
      ['tool_result', 'a'],
      ['tool_result', 'b'],
    ]);
    // the first call's messages are as they were sent
    expect(sent[0]?.messages).toEqual(base);
    if (run.kind !== 'answered') throw new Error('no answer');
    expect(run.transcript.at(-1)).toEqual({ role: 'assistant', content: answer.content });
    expect(run.looked.counts).toEqual({
      rounds: 1,
      calls: 2,
      facts: expect.any(Number),
      errors: 0,
    });
    expect(run.looked.sources.get(`bars:${NVDA}:7d:close`)).toMatchObject({
      assetId: NVDA,
      unit: 'USD',
      provenance: 'live',
      source: expect.any(String),
      method: expect.any(String),
      fetchedAt: expect.any(String),
    });
    expect(run.looked.missing[`profile:${NVDA}:holders_top20_share`]).toEqual({
      assetId: NVDA,
      label: "Share of the token's supply held by its twenty largest token accounts",
      reason: 'not_collected',
    });
    expect(run.looked.staleAgeSec[`profile:${NVDA}:pool_tvl_usd`]).toBe(449_495);
  });

  it('hands the model each fact without its source or method, and a missing one with why', async () => {
    const { call, sent } = model(asks(use('a', 'asset_profile', { assetId: NVDA })), answer);
    await runLookupLoop({ call, messages: base, reserve: () => null, scope: scope() });
    const [result] = resultsOf(sent[1]?.messages[2]);
    expect(result?.is_error).toBeUndefined();
    expect(result?.json).toMatchObject({ assetId: NVDA, part: 'profile' });
    expect(result?.json.facts).toContainEqual({
      id: `profile:${NVDA}:pool_tvl_usd`,
      measures: "Dollars held in the token's DEX pools (pool TVL)",
      value: expect.any(Number),
      unit: 'USD',
      asOf: expect.any(String),
      provenance: 'live',
      ageSeconds: 449_495,
    });
    expect(result?.json.notMeasured).toContainEqual({
      id: `profile:${NVDA}:holders_top20_share`,
      measures: "Share of the token's supply held by its twenty largest token accounts",
      notMeasured: 'not collected yet',
    });
    const text = String(result?.content);
    expect(text).not.toMatch(/"source"|"method"|api\.dexscreener\.com|dexscreener_token_pairs/u);
  });

  it('stops looking up after three rounds: the next call may not (tool_choice none)', async () => {
    const again = asks(use('x', 'asset_profile', { assetId: NVDA }));
    const sent: Sent[] = [];
    const call: LookupCall = async (request) => {
      sent.push(request);
      return request.tool_choice?.type === 'none' ? answer : again;
    };
    const reserve = vi.fn(() => null);
    const run = await runLookupLoop({ call, messages: base, reserve, scope: scope() });
    expect(sent.map((r) => r.tool_choice ?? null)).toEqual([null, null, null, { type: 'none' }]);
    expect(sent.every((r) => r.tools === LOOKUP_TOOLS)).toBe(true);
    // one reservation before every paid call
    expect(reserve).toHaveBeenCalledTimes(4);
    expect(run.kind === 'answered' && run.looked.counts.rounds).toBe(3);
    expect(run.kind === 'answered' && run.response).toBe(answer);
  });

  it('answers a tool call it will not run, so a repair never sends a call left without its result', async () => {
    // asked for past the last round (the model went on after tool_choice none), or cut off mid-call
    const ignored = asks(use('late', 'asset_profile', { assetId: NVDA }));
    const { call } = model(ignored);
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: scope(),
      maxRounds: 0,
    });
    expect(run.kind).toBe('answered');
    if (run.kind !== 'answered') return;
    expect(run.transcript.at(-2)).toEqual({ role: 'assistant', content: ignored.content });
    const results = resultsOf(run.transcript.at(-1));
    expect(run.transcript.at(-1)?.role).toBe('user');
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([['late', true]]);
    // nothing was read for it
    expect(run.looked.counts).toMatchObject({ rounds: 0, calls: 0 });
  });

  it("keeps a reply's calls to its deadline: each given what is left, and none looking up when little is", async () => {
    let clock = 0;
    const again = asks(use('x', 'asset_profile', { assetId: NVDA }));
    const sent: Sent[] = [];
    const call: LookupCall = async (request) => {
      sent.push(request);
      clock += 8_000; // each call takes eight seconds
      return request.tool_choice?.type === 'none' ? answer : again;
    };
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: scope(),
      deadline: 30_000,
      now: () => clock,
    });
    expect(run.kind).toBe('answered');
    // 30 s, then 22 s and 14 s left; at 6 s left the last call may not look up and has the floor
    expect(sent.map((r) => r.timeoutMs)).toEqual([30_000, 22_000, 14_000, LOOKUP_FINAL_MS]);
    expect(sent.map((r) => r.tool_choice ?? null)).toEqual([null, null, null, { type: 'none' }]);
    // a deadline already near: the first call answers and looks nothing up
    const near = model(answer);
    await runLookupLoop({
      call: near.call,
      messages: base,
      reserve: () => null,
      scope: scope(),
      deadline: 5_000,
      now: () => 0,
    });
    expect(near.sent[0]).toMatchObject({
      tool_choice: { type: 'none' },
      timeoutMs: LOOKUP_FINAL_MS,
    });
    // no deadline: no time given, as before
    const free = model(answer);
    await runLookupLoop({ call: free.call, messages: base, reserve: () => null, scope: scope() });
    expect(free.sent[0]).not.toHaveProperty('timeoutMs');
  });

  it('ends at a denied reservation: no further paid call', async () => {
    const { call, sent } = model(asks(use('a', 'asset_profile', { assetId: NVDA })), answer);
    let n = 0;
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => (n++ === 0 ? null : 'model_person_budget_spent'),
      scope: scope(),
    });
    expect(run).toMatchObject({ kind: 'denied', detail: 'model_person_budget_spent' });
    expect(sent).toHaveLength(1);
    // denied before the first call: nothing is sent
    const none = model(answer);
    expect(
      await runLookupLoop({
        call: none.call,
        messages: base,
        reserve: () => 'model_budget_spent',
        scope: scope(),
      }),
    ).toMatchObject({ kind: 'denied', detail: 'model_budget_spent' });
    expect(none.sent).toHaveLength(0);
  });

  it('sends no tools when the lookups are off, as before', async () => {
    const { call, sent } = model(answer);
    await runLookupLoop({ call, messages: base, reserve: () => null });
    expect(sent).toEqual([{ messages: base }]);
  });

  it('answers a late read "reading", and an unknown asset, the cash token, a bad input or a failed read an error, never throwing', async () => {
    const reading: LookupAnswer = { facts: [], missing: [], modelledOn: null, unread: 'reading' };
    const failed: LookupAnswer = { facts: [], missing: [], modelledOn: null, unread: 'failed' };
    const service: AssetLookups = {
      profile: vi.fn(async () => reading),
      priceHistory: vi.fn(async () => failed),
      pools: vi.fn(async () => {
        throw new Error('the reader broke');
      }),
      lending: vi.fn(async () => reading),
      bearing: vi.fn(async () => reading),
    };
    const turn = asks(
      use('late', 'asset_profile', { assetId: NVDA }),
      use('unlisted', 'asset_profile', { assetId: 'solana:jitosolx' }),
      use('other-chain', 'asset_profile', { assetId: 'robinhood:nvda' }),
      use('cash', 'asset_pools', { assetId: 'solana:usdc' }),
      use('cash-lending', 'asset_lending', { assetId: 'solana:usdc' }),
      use('window', 'asset_price_history', { assetId: NVDA, window: '1y' }),
      use('no-id', 'asset_pools', {}),
      use('failed', 'asset_price_history', { assetId: NVDA, window: '24h' }),
      use('threw', 'asset_pools', { assetId: TSLA }),
      use('unknown-tool', 'asset_screener', { assetId: NVDA }),
    );
    const { call, sent } = model(turn, answer);
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: scope(service),
    });
    const results = resultsOf(sent[1]?.messages[2]);
    const by = Object.fromEntries(results.map((r) => [r.tool_use_id, r]));
    expect(by.late?.is_error).toBeUndefined();
    expect(by.late?.json.reading).toMatch(/still being read/u);
    for (const id of [
      'unlisted',
      'other-chain',
      'cash',
      'window',
      'no-id',
      'failed',
      'threw',
      'unknown-tool',
    ])
      expect([id, by[id]?.is_error, typeof by[id]?.json.error]).toEqual([id, true, 'string']);
    expect(by.unlisted?.json.error).toMatch(/not on the catalog of this chain/u);
    expect(by.cash?.json.error).toMatch(/cash token/u);
    expect(by.window?.json.error).toMatch(/24h, 7d or 30d/u);
    // an unknown asset is never read, and the cash token only for its lending markets
    expect(by['cash-lending']?.is_error).toBeUndefined();
    expect(service.lending).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ asset: expect.objectContaining({ id: 'solana:usdc' }) }),
    );
    expect(service.pools).toHaveBeenCalledTimes(1);
    expect(service.profile).toHaveBeenCalledTimes(1);
    expect(run.kind === 'answered' && run.looked.counts).toEqual({
      rounds: 1,
      calls: 10,
      facts: 0,
      errors: 8,
    });
  });

  it('reads each call within the wait, against the chain and the label it runs on', async () => {
    const profile = vi.fn(async () => ({ facts: [], missing: [], modelledOn: null }));
    const service = { ...fixtureLookups(), profile } as AssetLookups;
    const { call } = model(asks(use('a', 'asset_profile', { assetId: 'solana:NVDAX' })), answer);
    const db = { handed: 'in' } as unknown as LookupScope['db'];
    await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: { ...scope(service), db, provenance: 'sandbox' },
      waitMs: 1_234,
    });
    expect(profile).toHaveBeenCalledWith({
      db,
      chain: 'solana',
      asset: catalog.find((a) => a.id === NVDA) as BasketAsset,
      waitMs: 1_234,
      provenance: 'sandbox',
    });
  });

  it('says a test-network figure is its mainnet model, and keeps its sandbox plate', async () => {
    const sandboxed = fixtureLookups(
      {},
      {
        twins: async (_db, assets) =>
          assets.map((asset) => ({
            id: asset.id,
            symbol: `t${asset.symbol}`,
            twinSymbol: asset.symbol,
            twinMint: asset.address,
          })) as never,
      },
    );
    const { call, sent } = model(
      asks(use('a', 'asset_price_history', { assetId: NVDA, window: '7d' })),
      answer,
    );
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: { ...scope(sandboxed), provenance: 'sandbox' },
    });
    const [result] = resultsOf(sent[1]?.messages[2]);
    expect(result?.json.modelledOn).toMatch(/^NVDAx: /u);
    expect(result?.json.facts[0]).toMatchObject({ provenance: 'sandbox', modelledOn: 'NVDAx' });
    const close = run.kind === 'answered' ? run.looked.sources.get(`bars:${NVDA}:7d:close`) : null;
    expect(close?.provenance).toBe('sandbox');
    expect(close?.source).toMatch(/test-network token tNVDAx/u);
  });

  it('never holds an id twice: a looked-up id the request was handed keeps the handed one', async () => {
    const { call, sent } = model(
      asks(
        use('a', 'asset_profile', { assetId: NVDA }),
        use('b', 'asset_profile', { assetId: NVDA }),
      ),
      answer,
    );
    const handedId = `profile:${NVDA}:supply_total`;
    const run = await runLookupLoop({
      call,
      messages: base,
      reserve: () => null,
      scope: scope(),
      handed: (id) => id === handedId,
    });
    if (run.kind !== 'answered') throw new Error('no answer');
    expect(run.looked.sources.has(handedId)).toBe(false);
    const [a, b] = resultsOf(sent[1]?.messages[2]);
    expect(a?.json.alreadyHanded).toContain(handedId);
    // the second identical call adds nothing new: every id is held already
    expect(b?.json.facts).toEqual([]);
    const handed = {
      id: handedId,
      assetId: NVDA,
      value: 1,
      unit: 'tokens',
      source: 'handed',
      method: 'handed',
      fetchedAt: '2026-10-06T00:00:00.000Z',
      provenance: 'live' as const,
    };
    const into = {
      sources: new Map([[handedId, handed]]),
      references: { missing: {}, staleAgeSec: {} },
      lowerBound: new Set<string>(),
    };
    run.looked.sources.set(handedId, { ...handed, value: 2, source: 'looked' });
    mergeLooked(into, run.looked);
    expect(into.sources.get(handedId)).toBe(handed);
    expect(into.sources.get(`profile:${NVDA}:pool_tvl_usd`)).toBeDefined();
    expect(into.references.staleAgeSec).toEqual({ [`profile:${NVDA}:pool_tvl_usd`]: 449_495 });
    expect(Object.keys(into.references.missing)).toContain(`profile:${NVDA}:holders_top20_share`);
  });

  it("keeps the hours a looked-up window misses, and the resolver says them beside the figure in the reply's language", () => {
    const id = `bars:${NVDA}:30d:close`;
    const looked = emptyLooked();
    looked.sources.set(id, {
      id,
      assetId: NVDA,
      label: 'Latest closing price over the last month',
      value: 240.51,
      unit: 'USD',
      source: 'market_bars',
      method: 'hourly bars',
      fetchedAt: '2026-10-22T20:00:00.000Z',
      provenance: 'live',
    });
    looked.windowGaps[id] = { missingHours: 11, windowHours: 720 };
    const into = {
      sources: new Map(),
      references: { missing: {}, staleAgeSec: {} },
      lowerBound: new Set<string>(),
    };
    mergeLooked(into, looked);
    expect(into.references).toMatchObject({
      windowGaps: { [id]: { missingHours: 11, windowHours: 720 } },
    });
    for (const [language, said] of [
      ['en', '$240.51 (11 of 720 hours missing)'],
      ['pt', 'US$ 240,51 (faltam 11 de 720 horas)'],
    ] as const) {
      const resolver = figureResolver({
        enabled: true,
        sources: into.sources,
        references: into.references,
        lowerBound: into.lowerBound,
        language,
      });
      const figure = resolver.figure(id);
      expect(figure).toMatchObject({ missingHours: 11, windowHours: 720 });
      expect(figure && resolver.plain(figure)).toBe(said);
    }
    // a figure with no hours missing reads as its text alone
    const whole = figureResolver({
      enabled: true,
      sources: into.sources,
      references: { missing: {}, staleAgeSec: {} },
      lowerBound: new Set(),
      language: 'en',
    });
    const plain = whole.figure(id);
    expect(plain).not.toHaveProperty('missingHours');
    expect(plain && whole.plain(plain)).toBe('$240.51');
  });
});

import type { BasketAsset, VaultAgentResult, VaultAgentSource } from '@colosseum/schemas';
import { VaultAgentReply } from '@colosseum/schemas';
import { describe, expect, it, vi } from 'vitest';
import { launchShelf } from '../../../../packages/engine/src/personal/testing';
import { type ModelScript, scriptedModel, toolResults } from '../testing/lookup-script';
import { fixtureLookups, LOOKUP_CHAIN_HOURS, LOOKUP_ROWS, OFFLINE_DB } from '../testing/lookups';
import { LOOKUP_TOOLS, type LookupBase } from './lookup-loop';
import { createRelaxedGoalAgent } from './relaxed-goal-agent';
import { FIGURE_CUT, type GoalAgentContext } from './vault-agent';

// The lookups on /goal (FIGURES-BY-REFERENCE and RELAXED-INTAKE as amended 2026-10-14, ledger
// API-AGENT-LOOKUPS-2): the relaxed intake with its model scripted (MOCK, testing/lookup-script.ts) and
// the reader of slice 1 over its fixtures. What is checked is what the server does with what the model
// looked up: each figure served by reference with its pin, under the unchanged rules.

const assets = launchShelf().assets.filter((asset) => asset.chain === 'solana');
const NVDA = 'solana:nvdax';
const TSLA = 'solana:tslax';
const CUT = FIGURE_CUT.en;
const ref = (id: string) => `{{fact:${id}}}`;
const at = '2026-10-06T06:00:00.000Z';
const source = (id: string, extra: Partial<VaultAgentSource> = {}): VaultAgentSource => ({
  id,
  source: 'server registry',
  method: 'listed asset catalog',
  fetchedAt: at,
  provenance: 'live',
  ...extra,
});
const context = (): GoalAgentContext =>
  ({
    person: 'person-1',
    kind: 'new_goal',
    chain: 'solana',
    state: null,
    assets,
    evidence: assets.map((a: BasketAsset) => source(`catalog:${a.id}`, { assetId: a.id })),
    currentGoals: [],
    stockAttributes: null,
    liquidity: [],
    unknowns: [],
    caps: {},
  }) as unknown as GoalAgentContext;
const NOTHING = {
  amount: null,
  currency: null,
  when: null,
  need_by: null,
  monthly: null,
  withdraw_months: null,
  withdraw_start: null,
  weights: null,
  risk: null,
};
const sheet = (say: string, lines: { id: string; why: string; share: number | null }[] = []) => ({
  say,
  shape: 'pick',
  lines,
  buckets: null,
  stated: NOTHING,
  not_available: [],
  open: [],
});
const week = { name: 'asset_price_history', input: { assetId: NVDA, window: '7d' } };
const lookups = (over: Partial<LookupBase> = {}): LookupBase => ({
  service: fixtureLookups(),
  db: OFFLINE_DB,
  ...over,
});

async function ask(
  script: ModelScript,
  words: string | { who: 'person' | 'app'; text: string }[] = 'how did NVDAx move this week?',
  options: { base?: LookupBase | null; reserve?: () => string | null } = {},
) {
  const model = scriptedModel(script);
  const reserve = vi.fn(options.reserve ?? (() => null));
  const agent = createRelaxedGoalAgent({
    apiKey: 'offline-placeholder',
    log: () => {},
    quota: { reserve } as never,
    create: model.create,
  });
  const messages = typeof words === 'string' ? [{ who: 'person' as const, text: words }] : words;
  const base = options.base === undefined ? lookups() : options.base;
  const result = await (base
    ? agent.reply({ version: 1, language: 'en', messageId: 'm1', messages }, context(), base)
    : agent.reply({ version: 1, language: 'en', messageId: 'm1', messages }, context()));
  return { result, calls: model.calls, reserve, options: model.options };
}
const served = (result: VaultAgentResult) => {
  if (result.kind !== 'reply') throw new Error(`no reply: ${JSON.stringify(result)}`);
  expect(VaultAgentReply.safeParse(result.reply).success).toBe(true);
  return result.reply;
};
const factsOf = (result: VaultAgentResult) =>
  new Map((served(result).figures?.facts ?? []).map((fact) => [fact.id, fact]));

const systemOf = (call: unknown) =>
  ((call as { system?: unknown } | undefined)?.system ?? []) as {
    text: string;
    cache_control?: unknown;
  }[];
const MOVED = `NVDAx's price changed by ${ref(`bars:${NVDA}:7d:change`)} over the last week. Its latest closing price was ${ref(`bars:${NVDA}:7d:close`)}.`;

describe('the relaxed intake looks up the data we hold', () => {
  it('serves a looked-up figure by reference, with its source, time, method and provenance', async () => {
    const { result, calls } = await ask({ lookups: [[week]], final: sheet(MOVED) });
    const reply = served(result);
    expect(reply.message).toBe(
      "NVDAx's price changed by 4.32% over the last week. Its latest closing price was $240.51.",
    );
    expect(reply.figures?.prose.message).toBe(MOVED);
    expect(factsOf(result).get(`bars:${NVDA}:7d:close`)).toMatchObject({
      assetId: NVDA,
      text: '$240.51',
      unit: 'USD',
      source: expect.stringMatching(/\S/u),
      method: expect.stringMatching(/\S/u),
      fetchedAt: expect.stringMatching(/^2026-10-/u),
      provenance: 'live',
      staleAgeSec: null,
    });
    expect(result.kind === 'reply' && result.lookups).toEqual({
      rounds: 1,
      calls: 1,
      facts: 9,
      errors: 0,
    });
    // tools on every call, the same list
    expect(calls.every((call) => call.tools === LOOKUP_TOOLS)).toBe(true);
    // the model saw the value and no source
    const [looked] = toolResults(calls[1]);
    expect(looked?.json.facts).toContainEqual(
      expect.objectContaining({ id: `bars:${NVDA}:7d:close`, value: expect.any(Number) }),
    );
    expect(JSON.stringify(looked)).not.toMatch(/"source"|"method"/u);
  });

  it('says how many hours a window misses beside each of its figures, and never hands the model the count', async () => {
    // the chain's collector down five hours on Oct 2: the week is shown (at most 8 of 168 may miss)
    const down = new Set(
      LOOKUP_CHAIN_HOURS.filter((h) => h >= '2026-10-02T10:00' && h < '2026-10-02T15:00'),
    );
    const service = fixtureLookups({
      bars: async () => ({
        rows: LOOKUP_ROWS.bars.filter((bar) => !down.has(bar.hour)),
        before: null,
        chainHours: LOOKUP_CHAIN_HOURS.filter((h) => !down.has(h)),
      }),
    });
    const { result, calls } = await ask({ lookups: [[week]], final: sheet(MOVED) }, undefined, {
      base: lookups({ service }),
    });
    const reply = served(result);
    expect(reply.message).toBe(
      "NVDAx's price changed by 4.32% (5 of 168 hours missing) over the last week. Its latest closing price was $240.51 (5 of 168 hours missing).",
    );
    // the drawn figure keeps its value as its text, and carries the count for the client
    expect(reply.figures?.prose.message).toBe(MOVED);
    expect(factsOf(result).get(`bars:${NVDA}:7d:close`)).toMatchObject({
      text: '$240.51',
      missingHours: 5,
      windowHours: 168,
    });
    const [looked] = toolResults(calls[1]);
    const close = ((looked?.json.facts ?? []) as { id: string; window?: string }[]).find(
      (fact) => fact.id === `bars:${NVDA}:7d:close`,
    );
    expect(close?.window).toMatch(/not collected; the server writes how many/u);
    expect(JSON.stringify(looked)).not.toMatch(/missingHours|windowHours|168/u);
  });

  it("gives each call what is left of the reply's time, and never sends that time to the model", async () => {
    const { result, calls, options } = await ask({ lookups: [[week]], final: sheet(MOVED) });
    served(result);
    // one call's time for the answer and its lookups, each call given what is left of it
    const given = options.map((option) => option?.timeout);
    expect(given).toHaveLength(2);
    for (const ms of given) expect(ms).toBeGreaterThan(0);
    expect(given[0]).toBeLessThanOrEqual(60_000);
    expect(given[1]).toBeLessThanOrEqual(given[0] as number);
    // the time is the client's, never a parameter of the request
    for (const call of calls) expect(call).not.toHaveProperty('timeoutMs');
    // with the lookups off, no time is given: the client's own limit, as before
    const off = await ask({ lookups: [], final: sheet('Nothing to look up.') }, 'hello', {
      base: null,
    });
    expect(off.options).toEqual([undefined]);
  });

  it('serves the volume on the entry side and the exit side, in the product\'s words (never "bought")', async () => {
    const said = `Over the last week ${ref(`bars:${NVDA}:7d:buyvol`)} of NVDAx traded on the entry side. Over the last week ${ref(`bars:${NVDA}:7d:sellvol`)} of NVDAx traded on the exit side.`;
    const { result, calls } = await ask({ lookups: [[week]], final: sheet(said) });
    expect(served(result).message).toBe(
      'Over the last week $51,163,435.96 of NVDAx traded on the entry side. Over the last week $49,941,620.05 of NVDAx traded on the exit side.',
    );
    // what each figure measures, as the model reads it (the ids keep their names)
    const labels = ((toolResults(calls[1])[0]?.json.facts ?? []) as { measures: string }[])
      .map((fact) => fact.measures)
      .join('\n');
    expect(labels).toContain('entry side (swaps into the asset)');
    expect(labels).toContain('exit side (swaps out of the asset)');
    expect(labels).not.toMatch(/\b(?:buy|bought|purchase)/iu);
  });

  it('still cuts a looked-up figure said as a return, compared, scaled or forecast', async () => {
    for (const say of [
      `NVDAx returned ${ref(`bars:${NVDA}:7d:change`)} over the last week.`,
      `NVDAx's price changed by ${ref(`bars:${NVDA}:7d:change`)} over the last week, more than TSLAx.`,
      `NVDAx's latest closing price was ${ref(`bars:${NVDA}:7d:close`)} times two.`,
      `NVDAx's price will change by ${ref(`bars:${NVDA}:7d:change`)} again next week.`,
    ]) {
      const { result, calls } = await ask({ lookups: [[week]], final: sheet(say) });
      const reply = served(result);
      expect([say, reply.message]).toEqual([say, CUT]);
      expect(reply.figures).toBeUndefined();
      expect(result.kind === 'reply' && result.repair).toMatchObject({
        failed: 'figure_reference',
        outcome: 'prose_figure_trimmed',
      });
      // the repair call: tools sent, no further lookup
      expect(calls.at(-1)?.tool_choice).toEqual({ type: 'none' });
    }
  });

  it('refuses a typed copy of a looked-up value', async () => {
    const { result } = await ask({
      lookups: [[week]],
      final: sheet("NVDAx's latest closing price was $240.51. It trades on several pools."),
    });
    expect(served(result).message).toBe(`It trades on several pools.\n${CUT}`);
  });

  it('cuts a reference to an id it did not look up', async () => {
    const { result } = await ask({
      lookups: [[week]],
      final: sheet(
        `NVDAx's latest closing price was ${ref(`bars:${NVDA}:30d:close`)}. It trades on several pools.`,
      ),
    });
    expect(served(result).message).toBe(`It trades on several pools.\n${CUT}`);
  });

  it('repairs with the attempt as it was: the lookups, their results and its answer, and no tools to call', async () => {
    const bad = sheet("NVDAx's latest closing price was $240.51.");
    const { result, calls } = await ask({ lookups: [[week]], final: bad, repair: sheet(MOVED) });
    expect(served(result).message).toContain('$240.51');
    expect(calls).toHaveLength(3);
    const repair = calls[2];
    expect(repair?.tool_choice).toEqual({ type: 'none' });
    expect(repair?.tools).toBe(LOOKUP_TOOLS);
    const roles = repair?.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    // the lookup turn and the answer exactly as they came
    expect(repair?.messages.slice(0, 3)).toEqual(calls[1]?.messages);
    expect(JSON.stringify(repair?.messages[3]?.content)).toContain('$240.51');
    expect(String(repair?.messages[4]?.content)).toMatch(/no digit/u);
  });

  it('reserves the quota before each paid call, and a denial ends the reply as a budget failure', async () => {
    const two = await ask({ lookups: [[week], [week]], final: sheet(MOVED) });
    expect(two.calls).toHaveLength(3);
    expect(two.reserve).toHaveBeenCalledTimes(3);
    let n = 0;
    const denied = await ask({ lookups: [[week]], final: sheet(MOVED) }, undefined, {
      reserve: () => (n++ === 0 ? null : 'model_person_budget_spent'),
    });
    expect(denied.result).toEqual({
      kind: 'failure',
      reason: 'budget',
      detail: 'model_person_budget_spent',
    });
    expect(denied.calls).toHaveLength(1);
  });

  it('answers a late read as being read, and serves none of its figures', async () => {
    // the reader past its wait answers `reading` (asset-lookups.test.ts); its answer fills the cache later
    const never = {
      ...fixtureLookups(),
      profile: async () => ({
        facts: [],
        missing: [],
        modelledOn: null,
        unread: 'reading' as const,
      }),
    };
    const { result, calls } = await ask(
      {
        lookups: [[{ name: 'asset_profile', input: { assetId: NVDA } }]],
        final: sheet(
          `The supply of NVDAx is ${ref(`profile:${NVDA}:supply_total`)}. Its figures are still being read.`,
        ),
      },
      'what is the supply of NVDAx?',
      { base: lookups({ service: never }) },
    );
    expect(toolResults(calls[1])[0]?.json.reading).toMatch(/still being read/u);
    expect(served(result).message).toBe(`Its figures are still being read.\n${CUT}`);
  });

  it('answers an asset not on the chain and the cash token with an error, and the reply stands', async () => {
    const { result, calls } = await ask(
      {
        lookups: [
          [
            { name: 'asset_profile', input: { assetId: 'solana:bonk' } },
            { name: 'asset_profile', input: { assetId: 'solana:usdc' } },
          ],
        ],
        final: sheet('BONK is not listed on this chain, and USDC is the cash line.'),
      },
      'who holds BONK, and who holds USDC?',
    );
    expect(toolResults(calls[1]).map((r) => r.error)).toEqual([true, true]);
    expect(served(result).message).toBe(
      'BONK is not listed on this chain, and USDC is the cash line.',
    );
    expect(result.kind === 'reply' && result.lookups?.errors).toBe(2);
  });

  it("serves the cash token's lending markets on /goal, though no draft names the cash token", async () => {
    const vault = 'Dnrc3CxMiDbcLPNaDVFZKf8SapkbQE6Az2obcKfWwBke';
    const { result } = await ask(
      {
        lookups: [[{ name: 'asset_lending', input: { assetId: 'solana:usdc' } }]],
        final: sheet(
          `The supply rate of USDC in the Jupiter Lend vault that takes NVDAx as collateral is ${ref(`lend:solana:usdc:${vault}:supply`)} a year.`,
        ),
      },
      'can I lend USDC and at what rate?',
    );
    expect(served(result).message).toBe(
      'The supply rate of USDC in the Jupiter Lend vault that takes NVDAx as collateral is 8.8% a year.',
    );
    expect(factsOf(result).get(`lend:solana:usdc:${vault}:supply`)).toMatchObject({
      assetId: 'solana:usdc',
      provenance: 'live',
    });
  });

  it('keeps the sandbox plate of a test-network figure', async () => {
    const sandboxed = fixtureLookups(
      {},
      {
        twins: async (_db, list) =>
          list.map((a) => ({
            id: a.id,
            symbol: `t${a.symbol}`,
            twinSymbol: a.symbol,
            twinMint: a.address,
          })),
      },
    );
    const { result } = await ask({ lookups: [[week]], final: sheet(MOVED) }, undefined, {
      base: lookups({ service: sandboxed, provenance: 'sandbox' }),
    });
    const close = factsOf(result).get(`bars:${NVDA}:7d:close`);
    expect(close).toMatchObject({ provenance: 'sandbox' });
    expect(close && 'source' in close ? close.source : '').toMatch(/test-network token tNVDAx/u);
  });

  it('never reads a looked-up figure back as a share: weights come from the person alone', async () => {
    const pools = { name: 'asset_pools', input: { assetId: NVDA } };
    const { result } = await ask(
      {
        lookups: [[pools]],
        final: sheet(
          `NVDAx's largest pool holds ${ref(`pool:${NVDA}:1:tvl`)}.`,
          // the model reports a share it saw in a figure: never applied
          [
            { id: NVDA, why: 'The stock you named.', share: 0.65 },
            { id: TSLA, why: 'The other stock you named.', share: null },
          ],
        ),
      },
      [
        { who: 'person', text: 'NVDAx and TSLAx please' },
        {
          who: 'app',
          text: "NVDAx's largest pool holds 65% of the dollars in its pools, about $3,627,618.88.",
        },
        { who: 'person', text: 'ok, how deep are the NVDAx pools?' },
      ],
    );
    const reply = served(result);
    expect(reply.proposal?.allocations.map((l) => [l.assetId, l.weightBps])).toEqual([
      [NVDA, 5000],
      [TSLA, 5000],
    ]);
    expect(reply.message).toBe("NVDAx's largest pool holds $3,627,618.88.");
  });

  it('sends no tools when the server has no lookups, as before', async () => {
    const { calls } = await ask({ final: sheet('Noted.') }, 'hello', { base: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('tools');
    expect(calls[0]).not.toHaveProperty('tool_choice');
    const rules = systemOf(calls[0])[0]?.text ?? '';
    expect(rules).not.toContain('LOOKUPS');
  });

  it('tells the model when to look up, in the cached rules, the same for everyone', async () => {
    const one = await ask({ final: sheet('Noted.') }, 'hello');
    const two = await ask({ final: sheet('Noted.') }, 'what about TSLAx?');
    const rules = systemOf(one.calls[0])[0];
    expect(rules?.cache_control).toEqual({ type: 'ephemeral' });
    expect(rules?.text).toBe(systemOf(two.calls[0])[0]?.text);
    expect(rules?.text).toContain('LOOKUPS');
    expect(rules?.text).toMatch(/come first/u);
    expect(rules?.text).toMatch(/At most three rounds/u);
    expect(rules?.text).toMatch(/never a return/u);
    expect(rules?.text).toMatch(/no verdict/u);
  });
});

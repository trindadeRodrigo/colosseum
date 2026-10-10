import { readFileSync } from 'node:fs';
import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags, type VaultAgentStatedShare } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelQuota } from '../../model-quota';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import {
  createRelaxedGoalAgent,
  type RelaxedGoalAgent,
  relaxedGoalAgentFromEnv,
} from '../../orders/relaxed-goal-agent';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import type { VaultAgentModel } from '../../vault-agent-model';
import { registerGoalConversationReplyRoute } from './goal-conversation-reply';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(
  available = true,
  analytics?: AgentAnalytics,
  relaxed: RelaxedGoalAgent | null = null,
) {
  const issuer = await testIssuer('goal-reply');
  const owner = await person(issuer, 'solana');
  const other = await person(issuer, 'solana');
  const evm = await person(issuer, 'robinhood');
  const chains = createChainRegistry(parseFlags({}), parseChainConfigs({}), { seed: 'goal-reply' });
  const entry = chains.get('solana');
  const listed = await entry.adapter.listAssets();
  const cash = listed.find((asset) => asset.cls === 'cash');
  const asset = listed.find((asset) => asset.cls !== 'cash' && asset.maxWeightBps >= 2000);
  if (!cash || !asset) throw new Error('Incomplete offline catalog');
  const assets = vi.spyOn(entry.adapter, 'listAssets');
  const vaults = vi.spyOn(entry.adapter, 'getVault');
  const liquidityEntry = vi.fn(() => {
    throw new Error('No confirmed planning size');
  });
  // Size-free: what sells at the cost tolerance, which a new goal can read with no amount.
  const exitCapacity = vi.fn((id: string) =>
    id === asset.id
      ? {
          capacityUsd: 42_000,
          lowerBound: false,
          regime: 'us_offhours_weekday',
          samples: 30,
          dataFrom: '2026-10-06T00:00:00.000Z',
          dataTo: '2026-10-07T20:00:00.000Z',
        }
      : null,
  );
  const inputs = vi.fn(async () => ({
    liquidity: {
      provider: {
        entry: liquidityEntry,
        exitCapacity,
        methodVersion: 'offline-exit-fixture',
        provenance: 'mock',
      },
      source: 'offline measured input',
    },
  }));
  const model: VaultAgentModel = {
    read: vi.fn(async () => ({
      reply: {
        message: 'We can explore that direction.',
        question: 'Which business matters most to you?',
        proposal: null,
      },
    })),
  };
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('Private DB access forbidden');
      },
    },
  ) as Db;
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line) => logs.push(line) } } });
  cleanup.push(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app, issuer.issuer);
  app.setErrorHandler((error, _req, reply) =>
    error instanceof Refusal
      ? reply.code(error.status).send(error.body())
      : reply.code(400).send({ error: 'invalid request' }),
  );
  registerGoalConversationReplyRoute(
    app,
    { db, chains, now: () => new Date('2026-10-08T01:00:00.000Z') },
    available ? model : null,
    inputs as unknown as Parameters<typeof registerGoalConversationReplyRoute>[3],
    analytics,
    relaxed,
  );
  const body = {
    version: 1,
    language: 'en',
    messageId: 'goal-person',
    messages: [
      { who: 'app', text: 'Earlier draft: stocks and cash.' },
      { who: 'person', text: 'I want to explore the named business.' },
    ],
  };
  const path = '/v1/conversations/solana/goal/reply';
  const post = (who = owner, payload: object = body, url = path) =>
    app.inject({ method: 'POST', url, headers: who.headers, payload });
  // Picks only: the server sets the weights. `cashOnly` leaves the listed asset out.
  const proposal = (cashOnly = false) => ({
    message: 'Here is a draft direction.',
    question: null,
    proposal: {
      objective: 'Explore the named business',
      summary: 'Retain a liquid cushion.',
      allocations: [
        ...(cashOnly
          ? []
          : [
              {
                assetId: asset.id,
                why: 'Express the stated preference.',
                evidenceIds: [`catalog:${asset.id}`],
              },
            ]),
        {
          assetId: cash.id,
          why: 'Keep a cushion.',
          evidenceIds: [`catalog:${cash.id}`],
        },
      ],
      stated: [] as VaultAgentStatedShare[],
      tradeoffs: ['The business may lose value.'],
      unknowns: [],
    },
  });
  return {
    app,
    asset,
    exitCapacity,
    owner,
    other,
    evm,
    chains,
    assets,
    vaults,
    liquidityEntry,
    inputs,
    model,
    post,
    body,
    path,
    proposal,
    logs,
    cash,
    stocks: listed
      .filter((item) => item.cls === 'stock' || item.cls === 'etf')
      .map((item) => item.id),
  };
}

describe('new-goal model preview route', () => {
  it('requires matching sign-in tokens and the verified wallet family before context reads', async () => {
    const s = await setup();
    const anonymous = await s.app.inject({ method: 'POST', url: s.path, payload: s.body });
    const mismatch = await s.app.inject({
      method: 'POST',
      url: s.path,
      payload: s.body,
      headers: {
        authorization: s.owner.headers.authorization ?? '',
        'privy-id-token': s.other.headers['privy-id-token'] ?? '',
      },
    });
    expect([anonymous.statusCode, mismatch.statusCode, (await s.post(s.evm)).statusCode]).toEqual([
      401, 401, 403,
    ]);
    expect(s.assets).not.toHaveBeenCalled();
    expect(s.model.read).not.toHaveBeenCalled();
  });
  it('sends real catalog and exact chronology without a vault, planning size, DB writes or liquidity sizing', async () => {
    const s = await setup();
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    // which agent wrote it is said: here the model-led conversation, no relaxed agent being set
    expect(res.json().agent).toBe('model_led');
    expect(res.json()).toMatchObject({
      version: 1,
      messageId: 'goal-person',
      chain: 'solana',
      proposal: null,
    });
    expect(res.json()).not.toHaveProperty('address');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(s.model.read).toHaveBeenCalledWith(
      s.owner.sub,
      expect.objectContaining({
        kind: 'new_goal',
        chain: 'solana',
        vault: null,
        latestPerson: s.body.messages.at(-1)?.text,
        messages: s.body.messages,
        currentGoals: [],
        catalog: expect.any(Array),
        evidence: expect.arrayContaining([
          expect.objectContaining({ id: expect.stringMatching(/^price:/), provenance: 'mock' }),
          {
            id: `capacity:${s.asset.id}`,
            assetId: s.asset.id,
            label:
              'Largest sale within the cost tolerance, worst regime of the exit window; does not depend on an amount',
            value: 42_000,
            unit: 'USD',
            provenance: 'mock',
          },
        ]),
        unknowns: expect.arrayContaining([
          expect.stringContaining('No planning amount has been confirmed'),
        ]),
        analytics: null,
      }),
    );
    expect(s.vaults).not.toHaveBeenCalled();
    expect(s.liquidityEntry).not.toHaveBeenCalled();
    expect(s.inputs).toHaveBeenCalledOnce();
    const source = readFileSync(new URL('./goal-conversation-reply.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(
      /\b(?:homeChain|personChain|compose|personalize|insertProposal|prepareOrder|buildOrder)\s*\(/,
    );
  });
  it("reads Bearing's analytics at the reference size and serves a cited figure with its server source", async () => {
    const analytics = vi.fn<AgentAnalytics>(async () => ({
      sizeUsd: 10_000,
      basis: 'reference',
      tau: 0.01,
      assets: [],
    }));
    const s = await setup(true, analytics);
    analytics.mockImplementation(async () => ({
      sizeUsd: 10_000,
      basis: 'reference',
      tau: 0.01,
      assets: [
        {
          assetId: s.asset.id,
          modelledOn: null,
          figures: [
            {
              metric: 'exit_worst',
              regime: 'us_offhours_weekday',
              value: 0.004,
              unit: 'fraction',
              source: 'offline fact sheet',
              method: 'fixture (facts-0.1)',
              fetchedAt: '2026-10-07T20:00:00.000Z',
              provenance: 'mock',
            },
            { metric: 'volatility', value: null, reason: 'no_reference_price' },
          ],
        },
      ],
    }));
    const cited = s.proposal();
    cited.proposal.allocations[0]?.evidenceIds.push(`exit:${s.asset.id}:worst`);
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cited });
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(analytics).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'solana', sizeUsd: null, provenance: 'mock' }),
    );
    expect(analytics.mock.calls[0]?.[0].assets.length).toBeGreaterThan(1);
    const prompt = vi.mocked(s.model.read).mock.calls[0]?.[1];
    expect(prompt?.analytics).toMatchObject({
      sizeUsd: 10_000,
      basis: 'reference',
      assets: [
        {
          assetId: s.asset.id,
          values: { [`exit:${s.asset.id}:worst`]: 0.004 },
          provenance: 'mock',
          worstRegime: 'us_offhours_weekday',
        },
      ],
      unknowns: [
        `Annualised price volatility: unknown (no reference prices collected), for ${s.asset.symbol}.`,
      ],
    });
    // Once, in the analytics block; not again as an evidence row.
    expect(prompt?.evidence.some((row) => row.id === `exit:${s.asset.id}:worst`)).toBe(false);
    expect(res.json().proposal.sources).toContainEqual(
      expect.objectContaining({
        id: `exit:${s.asset.id}:worst`,
        source: 'offline fact sheet',
        method: 'fixture (facts-0.1)',
        fetchedAt: '2026-10-07T20:00:00.000Z',
      }),
    );
  });
  it('goes on without analytics that fail, says so to the model and logs the code', async () => {
    const s = await setup(true, async () => {
      throw new Error('the pool is exhausted');
    });
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(vi.mocked(s.model.read).mock.calls[0]?.[1].analytics).toEqual({
      unknowns: [
        "Bearing's exit, liquidity and market analytics could not be read for this reply; those figures are unknown, not zero.",
      ],
    });
    expect(
      s.logs
        .map((line) => JSON.parse(line))
        .filter((line) => line.msg === 'the new-goal conversation went on without its analytics'),
    ).toEqual([expect.objectContaining({ level: 40, code: 'analytics_threw', chain: 'solana' })]);
    expect(s.logs.join('')).not.toContain('pool is exhausted');
  });
  it('weighs the picks equally unless the person stated shares, and appends server unknowns without creating a buyable plan', async () => {
    const s = await setup();
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal() });
    const first = await s.post();
    const seventy = s.proposal();
    seventy.proposal.stated = [
      { assetIds: [s.asset.id], kind: 'exact', bps: 7000, quote: `70% ${s.asset.symbol}` },
    ];
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: seventy });
    const second = await s.post(s.owner, {
      ...s.body,
      messages: [{ who: 'person', text: `I want 70% ${s.asset.symbol}, the rest in cash.` }],
    });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const weights = (res: typeof first) =>
      res.json().proposal.allocations.map((line: { weightBps: number }) => line.weightBps);
    expect(weights(first)).toEqual([5000, 5000]);
    expect(weights(second)).toEqual([7000, 3000]);
    expect(first.json().weightNotes).toEqual([
      { code: 'equal_split', assetIds: [s.asset.id, s.cash.id] },
    ]);
    expect(second.json().weightNotes).toEqual([
      { code: 'stated', assetIds: [s.asset.id], quote: `70% ${s.asset.symbol}` },
      { code: 'equal_split', assetIds: [s.cash.id] },
    ]);
    expect(second.json().proposal.unknowns.join(' ')).toContain(
      'A deposit needs the goal and amount confirmed again',
    );
    expect(second.json()).not.toHaveProperty('id');
    expect(second.json().proposal).not.toHaveProperty('recipes');
  });
  it('serves the goal and risk the server read in the person’s words, whatever the model replies', async () => {
    const s = await setup();
    const person = (text: string) => ({ who: 'person', text });
    const ask = async (messages: object[], reply: object = s.proposal()) => {
      vi.mocked(s.model.read).mockResolvedValueOnce({ reply });
      const res = await s.post(s.owner, { ...s.body, messages });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    // unsaid: null, with the proposal still served, and the model told what is missing
    const unsaid = await ask([person('Some of the named business.')]);
    expect(unsaid).toMatchObject({ goal: null, risk: null });
    expect(unsaid.proposal).not.toBeNull();
    expect(vi.mocked(s.model.read).mock.lastCall?.[1]).toMatchObject({
      statedPurpose: { goal: null, risk: null },
    });
    const said = await ask([person('I want it to grow, high risk is fine.')]);
    expect(said).toMatchObject({ goal: 'grow', risk: 'high' });
    expect(vi.mocked(s.model.read).mock.lastCall?.[1]).toMatchObject({
      statedPurpose: { goal: 'grow', risk: 'high' },
    });
    // a reply with no proposal carries them too, and a field of the model's own is not a way in
    expect(
      await ask([person('Keep it safe, low risk.')], {
        message: 'Noted.',
        question: null,
        proposal: null,
      }),
    ).toMatchObject({ goal: 'protect', risk: 'low', proposal: null });
    vi.mocked(s.model.read).mockResolvedValue({
      reply: { ...s.proposal(), purpose: { goal: 'grow', risk: 'high' } },
    });
    expect(
      (await s.post(s.owner, { ...s.body, messages: [person('Tell me about Tesla.')] })).statusCode,
    ).toBe(503);
  });
  it('serves the sum the person wrote in dollars, never one the app wrote (DEPOSIT-DERIVE)', async () => {
    const s = await setup();
    const person = (text: string) => ({ who: 'person', text });
    const app = (text: string) => ({ who: 'app', text });
    const ask = async (messages: object[]) => {
      vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal() });
      const res = await s.post(s.owner, { ...s.body, messages });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().amountUsd;
    };
    const split = person('I want to invest 2k, 70% in safe income and 30% in AI stocks');
    expect(await ask([split])).toBe(2000);
    expect(
      await ask([split, app('When will you need this money? $2,500 is…'), person('In five years')]),
    ).toBe(2000);
    expect(await ask([split, person('make it $3,000')])).toBe(3000);
    expect(await ask([person('70% in safe income and 30% in AI stocks')])).toBeNull();
    expect(await ask([person('R$ 3.000 em renda fixa')])).toBeNull();
  });
  it.each([
    [['I do not want growth, I am retired.']],
    [['Only low risk please.'], { goal: null, risk: 'low' }],
    [['Is protect better than grow for me?']],
    // a correction withdraws: never the value before it, and the person is asked by a tap
    [['I want it to grow, high risk is fine.', 'Actually no. Keep it safe, low risk.']],
    [['For anything but income.']],
    [['I want it safe but growing']],
    [['High risk. No thanks.']],
    [["I don't want\nhigh risk"]],
    [['I want it to grow.', 'Actually, income']],
    [['high risk is fine', 'Honestly low risk suits me']],
    [['Na\u0303o quero crescer']],
    [['growth 👎']],
    [['It is safe to take high risk']],
    [['I want it to grow, high risk is fine.', 'Medium risk'], { goal: 'grow', risk: 'medium' }],
    // the skip rule: only a message plainly about the mix leaves what was said standing
    [['I want it to grow, high risk is fine.', 'scrap that']],
    [['I want it to grow, high risk is fine.', 'safer please']],
    [['I want it to grow, high risk is fine.', 'esquece']],
    [['I want it to grow, high risk is fine.', 'what do you think?']],
    [['I want it to grow, high risk is fine.', 'more cash'], { goal: 'grow', risk: 'high' }],
    [['This is for my retirement in Tesla and Nvidia.']],
    [['Tell me about Tesla.']],
    [['Go slow, I am incoming to this.']],
    [['Não quero risco alto nem crescer rápido.']],
  ] as [string[], { goal: string | null; risk: string | null }?][])(
    'never serves a goal or risk the person did not state: %j',
    async (texts, expected = { goal: null, risk: null }) => {
      const s = await setup();
      vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal() });
      const res = await s.post(s.owner, {
        ...s.body,
        messages: texts.map((text) => ({ who: 'person', text })),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject(expected);
    },
  );
  it('does not take a yes to the app’s question as a goal or a risk', async () => {
    const s = await setup();
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal() });
    const res = await s.post(s.owner, {
      ...s.body,
      messages: [
        { who: 'app', text: 'Should this be kept safe, at low risk?' },
        { who: 'person', text: 'yes' },
      ],
    });
    expect(res.json()).toMatchObject({ goal: null, risk: null });
  });
  it('retains the explicit stock minimum and returns a useful question for a conflicting model draft', async () => {
    const s = await setup();
    // Cash alone cannot hold a stock minimum, and the repair sends the same picks: the person is asked.
    const text = 'i think i want way more stocks on them. like at least 40% stocks';
    const cashOnly = s.proposal(true);
    cashOnly.proposal.stated = [{ assetIds: s.stocks, kind: 'min', bps: 4000, quote: text }];
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cashOnly });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cashOnly });
    const res = await s.post(s.owner, {
      ...s.body,
      messages: [{ who: 'person', text }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().proposal).toBeNull();
    expect(res.json().question).toBeTruthy();
    expect(res.json().question).toContain('within that limit');
    expect(s.model.read).toHaveBeenCalledTimes(2);
    expect(
      s.logs
        .map((line) => JSON.parse(line))
        .filter(
          (line) =>
            line.msg ===
            'the new-goal conversation reply asks about a stated limit its repair attempt still missed',
        ),
    ).toEqual([
      expect.objectContaining({
        level: 40,
        repair: { failed: 'allocation_constraint', outcome: 'allocation_constraint' },
        chain: 'solana',
      }),
    ]);
    expect(s.logs.join('')).not.toContain('at least 40%');
  });
  it('rejects cross-chain assets, malformed last turns and attempted request authority', async () => {
    const s = await setup();
    const value = s.proposal();
    value.proposal.allocations[0]!.assetId = 'robinhood:foreign';
    // The repair call sends it again: still refused.
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: value });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: value });
    expect((await s.post()).json()).toMatchObject({ reason: 'invalid' });
    expect(s.model.read).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(s.model.read).mock.calls.length;
    expect(
      (await s.post(s.owner, { ...s.body, messages: [{ who: 'app', text: 'Apply that.' }] }))
        .statusCode,
    ).toBe(400);
    expect((await s.post(s.owner, { ...s.body, vault: { cash: 2000 } })).statusCode).toBe(400);
    expect(vi.mocked(s.model.read).mock.calls.length).toBe(calls);
  });
  it('refuses unavailable chains before catalog/model reads and skips inputs when the model is absent', async () => {
    const s = await setup();
    vi.spyOn(s.chains, 'get').mockImplementationOnce(() => {
      throw new Refusal(503, 'Chain unavailable');
    });
    expect((await s.post()).statusCode).toBe(503);
    expect(s.assets).not.toHaveBeenCalled();
    expect(s.model.read).not.toHaveBeenCalled();
    const absent = await setup(false);
    expect((await absent.post()).json()).toMatchObject({
      code: 'GOAL_AGENT_UNAVAILABLE',
      reason: 'unavailable',
    });
    expect(absent.inputs).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'budget', 'invalid'] as const)(
    'returns typed %s failures without a wizard fallback',
    async (why) => {
      const s = await setup();
      vi.mocked(s.model.read).mockResolvedValueOnce({ reply: null, why });
      const res = await s.post();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'GOAL_AGENT_UNAVAILABLE', reason: why });
    },
  );
  it('logs the reason and the failed check at warn, without the person or the model words', async () => {
    const s = await setup();
    vi.mocked(s.model.read).mockResolvedValueOnce({
      reply: null,
      why: 'timeout',
      detail: 'model_timeout',
    });
    expect((await s.post()).json()).toMatchObject({ reason: 'timeout' });
    const figure = { message: 'It will return 12% a year.', question: null, proposal: null };
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    expect((await s.post()).json()).toMatchObject({ reason: 'invalid' });
    // Repaired on the second call: the corrected reply is shown and the repair is logged.
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    const repaired = await s.post();
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().message).toBe('We can explore that direction.');
    expect(repaired.body).not.toContain('12%');
    const parsed = s.logs.map((line) => JSON.parse(line));
    expect(
      parsed.filter(
        (line) => line.msg === 'the new-goal conversation reply passed on its repair attempt',
      ),
    ).toEqual([
      expect.objectContaining({
        level: 40,
        repair: { failed: 'prose_figure', outcome: 'repaired' },
        chain: 'solana',
      }),
    ]);
    const failures = s.logs
      .map((line) => JSON.parse(line))
      .filter((line) => line.msg === 'the new-goal conversation returned no reply');
    expect(failures).toEqual([
      expect.objectContaining({
        level: 40,
        reason: 'timeout',
        detail: 'model_timeout',
        chain: 'solana',
      }),
      expect.objectContaining({
        level: 40,
        reason: 'invalid',
        detail: 'prose_figure',
        repair: { failed: 'prose_figure', outcome: 'prose_figure' },
        chain: 'solana',
      }),
    ]);
    const written = s.logs.join('');
    expect(written).not.toContain('named business');
    expect(written).not.toContain('12%');
  });
  it('serves a reply whose repair attempt still states a figure without that sentence, and logs a count', async () => {
    const s = await setup();
    const figure = {
      message: 'We can explore that direction. It will return 12% a year.',
      question: null,
      proposal: null,
    };
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: figure });
    const res = await s.post();
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe(
      'We can explore that direction.\nPart of this reply was left out because it stated a figure that could not be confirmed.',
    );
    expect(s.logs.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        level: 40,
        detail: 'prose_figure_trimmed',
        sentencesCut: 1,
        repair: { failed: 'prose_figure', outcome: 'prose_figure_trimmed', sentencesCut: 1 },
        chain: 'solana',
        msg: 'the new-goal conversation reply was served without the sentences that stated a figure',
      }),
    ]);
    const written = s.logs.join('');
    expect(written).not.toContain('named business');
    expect(written).not.toContain('12%');
    expect(written).not.toContain('explore that direction');
  });
  it.each(['I created your vault.', 'I funded your portfolio.', 'Eu abri seu cofre.'])(
    'rejects a false creation or funding claim: %s',
    async (message) => {
      const s = await setup();
      for (const _attempt of [1, 2])
        vi.mocked(s.model.read).mockResolvedValueOnce({
          reply: { message, question: null, proposal: null },
        });
      expect((await s.post()).json()).toMatchObject({ reason: 'invalid' });
      expect(s.model.read).toHaveBeenCalledTimes(2);
    },
  );
});

describe('the goal agent behind /goal (gate RELAXED-INTAKE)', () => {
  const fromEnv = (env: Record<string, string | undefined>) =>
    relaxedGoalAgentFromEnv(env, createModelQuota({ dailyCalls: 1, dailyCallsPerPerson: 1 }));
  const relaxedReply = (messageId: string) => ({
    version: 1 as const,
    messageId,
    message: 'You want to grow this money; how much will you put in?',
    question: null,
    warnings: [],
    weightNotes: [],
    proposal: null,
  });
  it('is the relaxed intake whenever a model key is set and GOAL_AGENT is unset or relaxed', () => {
    for (const env of [
      { ANTHROPIC_API_KEY: 'placeholder' },
      { ANTHROPIC_API_KEY: 'placeholder', GOAL_AGENT: 'relaxed' },
      { ANTHROPIC_API_KEY: 'placeholder', GOAL_AGENT: '  ' },
    ])
      expect(fromEnv(env)?.id).toBe('claude-sonnet-5-5');
    expect(fromEnv({ ANTHROPIC_API_KEY: 'placeholder', RELAXED_MODEL: 'claude-x' })?.id).toBe(
      'claude-x',
    );
  });
  it('leaves the model-led conversation to answer only on the explicit opt-out, or with no key', () => {
    expect(fromEnv({ ANTHROPIC_API_KEY: 'placeholder', GOAL_AGENT: 'model-led' })).toBeNull();
    expect(fromEnv({})).toBeNull();
    expect(fromEnv({ GOAL_AGENT: 'relaxed' })).toBeNull();
  });
  it('refuses a GOAL_AGENT value it does not know, so a misspelt opt-out is never ignored', () => {
    expect(() => fromEnv({ ANTHROPIC_API_KEY: 'placeholder', GOAL_AGENT: 'vault' })).toThrow(
      /GOAL_AGENT/,
    );
  });
  it('answers through the relaxed intake when it is there, and never calls the model-led one', async () => {
    const reply = vi.fn(async (request: { messageId: string }) => ({
      kind: 'reply' as const,
      reply: relaxedReply(request.messageId),
    }));
    const s = await setup(true, undefined, { id: 'relaxed-double', reply } as RelaxedGoalAgent);
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      messageId: 'goal-person',
      chain: 'solana',
      agent: 'relaxed',
      proposal: null,
    });
    expect(reply).toHaveBeenCalledWith(
      s.body,
      expect.objectContaining({ kind: 'new_goal', chain: 'solana' }),
    );
    expect(s.model.read).not.toHaveBeenCalled();
  });
  it('carries the goal and risk the server read in the person’s words, never the relaxed reply’s own', async () => {
    // a reply that tries to say the goal and risk itself: the route's reading of the words stands
    const reply = vi.fn(async (request: { messageId: string }) => ({
      kind: 'reply' as const,
      reply: { ...relaxedReply(request.messageId), goal: 'protect', risk: 'low' },
    }));
    const s = await setup(false, undefined, { id: 'relaxed-double', reply } as RelaxedGoalAgent);
    const ask = async (text: string) => {
      const res = await s.post(s.owner, { ...s.body, messages: [{ who: 'person', text }] });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    expect(await ask('I want it to grow, high risk is fine.')).toMatchObject({
      chain: 'solana',
      goal: 'grow',
      risk: 'high',
    });
    expect(await ask('Some of the named business.')).toMatchObject({ goal: null, risk: null });
    expect(reply).toHaveBeenCalledTimes(2);
  });
  it('answers through the relaxed intake with no model-led model configured', async () => {
    const reply = vi.fn(async (request: { messageId: string }) => ({
      kind: 'reply' as const,
      reply: relaxedReply(request.messageId),
    }));
    const s = await setup(false, undefined, { id: 'relaxed-double', reply } as RelaxedGoalAgent);
    expect((await s.post()).statusCode).toBe(200);
    expect(reply).toHaveBeenCalledOnce();
  });
  it('answers 503 unavailable with neither agent, as before', async () => {
    const s = await setup(false, undefined, null);
    const res = await s.post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'GOAL_AGENT_UNAVAILABLE', reason: 'unavailable' });
  });
  it('serves the relaxed failure as the route’s 503 with its reason, and logs which agent failed', async () => {
    const s = await setup(true, undefined, {
      id: 'relaxed-double',
      reply: async () => ({ kind: 'failure', reason: 'timeout' }),
    } as RelaxedGoalAgent);
    const res = await s.post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'GOAL_AGENT_UNAVAILABLE', reason: 'timeout' });
    expect(s.logs.join('\n')).toContain('"agent":"relaxed"');
  });
  it('serves a measured figure the relaxed intake names, with its source, and reads no sum or goal from it', async () => {
    // the real agent with the model stubbed; the asset is found in the route's own catalog
    let asked = '';
    let reference = '';
    const relaxed = createRelaxedGoalAgent({
      apiKey: 'placeholder',
      log: () => {},
      create: async () => ({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            citations: null,
            text: JSON.stringify({
              say: `The largest sale of ${asked} within the cost tolerance is ${reference}.`,
              shape: 'pick',
              lines: [],
              buckets: null,
              stated: {
                amount: null,
                currency: null,
                when: null,
                need_by: null,
                monthly: null,
                withdraw_months: null,
                withdraw_start: null,
                weights: null,
                risk: null,
              },
              not_available: [],
              open: [],
            }),
          },
        ],
      }),
    });
    const s = await setup(false, undefined, relaxed);
    asked = s.asset.symbol;
    reference = `{{fact:capacity:${s.asset.id}}}`;
    const res = await s.post(s.owner, {
      ...s.body,
      messages: [{ who: 'person', text: `How deep is the pool for ${asked}?` }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ agent: 'relaxed', amountUsd: null, goal: null, risk: null });
    expect(body.message).toBe(
      `The largest sale of ${asked} within the cost tolerance is $42,000.00.`,
    );
    expect(body.figures.prose.message).toContain(reference);
    expect(body.figures.facts).toEqual([
      expect.objectContaining({
        id: `capacity:${s.asset.id}`,
        assetId: s.asset.id,
        text: '$42,000.00',
        value: 42_000,
        unit: 'USD',
        source: 'offline measured input',
        method: expect.stringContaining('offline-exit-fixture'),
        fetchedAt: '2026-10-07T20:00:00.000Z',
        provenance: 'mock',
      }),
    ]);
  });
  it('is made with no network call: the client is built, nothing is sent until a reply is asked', () => {
    expect(createRelaxedGoalAgent({ apiKey: 'placeholder' }).id).toBe('claude-sonnet-5-5');
  });
});

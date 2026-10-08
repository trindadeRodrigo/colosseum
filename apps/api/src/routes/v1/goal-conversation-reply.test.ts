import { readFileSync } from 'node:fs';
import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import type { AgentAnalytics } from '../../orders/vault-agent';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import type { VaultAgentModel } from '../../vault-agent-model';
import { registerGoalConversationReplyRoute } from './goal-conversation-reply';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(available = true, analytics?: AgentAnalytics) {
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
  const proposal = (weightBps: number) => ({
    message: 'Here is a draft direction.',
    question: null,
    proposal: {
      objective: 'Explore the named business',
      summary: 'Retain a liquid cushion.',
      allocations: [
        {
          assetId: asset.id,
          weightBps,
          why: 'Express the stated preference.',
          evidenceIds: [`catalog:${asset.id}`],
        },
        {
          assetId: cash.id,
          weightBps: 10000 - weightBps,
          why: 'Keep a cushion.',
          evidenceIds: [`catalog:${cash.id}`],
        },
      ],
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
              'Largest sale at no more than 1% cost, worst regime of the exit window; does not depend on an amount',
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
    const cited = s.proposal(1000);
    cited.proposal.allocations[0]?.evidenceIds.push(`exit:${s.asset.id}:worst`);
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cited });
    const res = await s.post();
    expect(res.statusCode, res.body).toBe(200);
    expect(analytics).toHaveBeenCalledWith(
      expect.objectContaining({ chain: 'solana', sizeUsd: null, provenance: 'mock' }),
    );
    expect(analytics.mock.calls[0]?.[0].assets.length).toBeGreaterThan(1);
    const prompt = vi.mocked(s.model.read).mock.calls[0]?.[1];
    expect(prompt?.analytics).toEqual({
      sizeUsd: 10_000,
      basis: 'reference',
      unknowns: [
        `Annualised price volatility: unknown (no reference prices collected), for ${s.asset.symbol}.`,
      ],
    });
    expect(prompt?.evidence).toContainEqual({
      id: `exit:${s.asset.id}:worst`,
      assetId: s.asset.id,
      label: 'Exit cost at the $10,000 reference size, worst measured regime (weekday off-hours)',
      value: 0.004,
      unit: 'fraction',
      provenance: 'mock',
    });
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
  it('preserves different model-selected weights and appends server unknowns without creating a buyable plan', async () => {
    const s = await setup();
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal(1000) });
    const first = await s.post();
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal(2000) });
    const second = await s.post();
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(first.json().proposal.allocations[0].weightBps).toBe(1000);
    expect(second.json().proposal.allocations[0].weightBps).toBe(2000);
    expect(second.json().proposal.unknowns.join(' ')).toContain(
      'Funding requires fresh confirmation',
    );
    expect(second.json()).not.toHaveProperty('id');
    expect(second.json().proposal).not.toHaveProperty('recipes');
  });
  it('retains the explicit stock minimum and returns a useful question for a conflicting model draft', async () => {
    const s = await setup();
    // The repair call sends the same draft: the person is asked about the limit.
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal(1000) });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: s.proposal(1000) });
    const res = await s.post(s.owner, {
      ...s.body,
      messages: [
        { who: 'person', text: 'i think i want way more stocks on them. like at least 40%' },
      ],
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
    const value = s.proposal(1000);
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

import { readFileSync } from 'node:fs';
import type { Db } from '@colosseum/db';
import { parseChainConfigs, parseFlags, type VaultAgentStatedShare } from '@colosseum/schemas';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainRegistry } from '../../orders/chains';
import { Refusal } from '../../orders/errors';
import { registerAuth } from '../../plugins/auth';
import { person, testIssuer } from '../../testing/harness';
import type { VaultAgentModel } from '../../vault-agent-model';
import { registerGoalConversationReplyRoute } from './goal-conversation-reply';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(available = true) {
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
  const inputs = vi.fn(async () => ({
    liquidity: { provider: { entry: liquidityEntry }, source: 'offline measured input' },
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
    asset,
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
        ]),
        unknowns: expect.arrayContaining([
          expect.stringContaining('No planning amount has been confirmed'),
        ]),
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
      'Funding requires fresh confirmation',
    );
    expect(second.json()).not.toHaveProperty('id');
    expect(second.json().proposal).not.toHaveProperty('recipes');
  });
  it('retains the explicit stock minimum and returns a useful question for a conflicting model draft', async () => {
    const s = await setup();
    // Cash alone cannot hold a stock minimum, and the repair sends the same picks: the person is asked.
    const text = 'i think i want way more stocks on them. like at least 40%';
    const cashOnly = s.proposal(true);
    cashOnly.proposal.stated = [{ assetIds: s.stocks, kind: 'min', bps: 4000, quote: text }];
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cashOnly });
    vi.mocked(s.model.read).mockResolvedValueOnce({ reply: cashOnly });
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

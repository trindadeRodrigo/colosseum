import { conversationText, runIntake } from '@colosseum/engine/personal';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_FOLLOW_UPS,
  INTAKE_TEXT_BUDGET,
  IntakeRequest,
} from '../apps/api/src/routes/v1/intake';
import {
  MAX_FOLLOW_UPS,
  readIntake,
  INTAKE_TEXT_BUDGET as WEB_BUDGET,
} from '../apps/web/features/invest/intake';
import { intakeConversation } from '../apps/web/features/invest/intake-conversation';

// The actual frontend emits requests; the actual API validates them; the actual engine reads the
// exact chronological text and the matching form snapshots. Only the model's reading is a fixture.
const model = {
  goal: 'grow',
  amountUsd: 2000,
  incomeTargetUsdMonthly: null,
  horizonMonths: 60,
  risk: 'high',
  currency: null,
  chain: null,
  portfolios: [],
  language: 'en',
  noCredit: false,
  cannotHold: [],
  unclear: [],
  openEnded: false,
  mayNeedInMonths: null,
  sleeves: null,
  markets: [],
  mix: null,
  marketFilter: null,
};
function bridge(reading: Parameters<typeof runIntake>[0]['reply'] = model) {
  const posted: ReturnType<typeof IntakeRequest.parse>[] = [];
  const results: ReturnType<typeof runIntake>[] = [];
  const api = async (_path: string, options?: RequestInit) => {
    const body = IntakeRequest.parse(JSON.parse(String(options?.body)));
    posted.push(body);
    const result = runIntake({
      text: conversationText(body.text, body.followUps),
      nowMonth: '2026-10',
      language: body.language,
      reply: reading,
      answers: body.answers,
      answersThen: body.answersThen,
      homeChain: 'solana',
      portfolios: [],
    });
    results.push(result);
    return Response.json({
      ...result,
      reader: { method: 'model', model: 'fixture', provenance: 'mock', why: null },
    });
  };
  return {
    posted,
    results,
    talk: intakeConversation(api, {
      lang: 'en',
      chain: 'solana',
      fallback: {
        turn: async () => {
          throw Error('unexpected fallback');
        },
      },
    }),
  };
}
function latest<T>(items: T[]): T {
  const value = items.at(-1);
  if (value === undefined) throw Error('Expected an intake request');
  return value;
}
async function history(first = 'Grow $2,000 over 5 years, high risk. No gold.') {
  const b = bridge();
  let reply = await b.talk.turn({ kind: 'text', text: first }, null);
  for (let i = 1; i <= 12; i++)
    reply = await b.talk.turn({ kind: 'text', text: `Another detail ${i}.` }, reply.sheet);
  return { ...b, sheet: reply.sheet, first };
}

describe('intake history across the frontend/API/engine boundary', () => {
  it('a newer refusal joins the earlier one instead of being overridden by absorbed form limits', async () => {
    const b = await history();
    await b.talk.turn({ kind: 'text', text: 'no stocks please' }, b.sheet);
    const last = latest(b.posted);
    expect(last.followUps).toHaveLength(13);
    expect(last.followUps?.[0]).toBe('Another detail 1.');
    expect(last.answers ?? {}).not.toHaveProperty('limits');
    expect(b.results.at(-1)?.sheet?.limits?.cannotHold?.classes).toEqual(
      expect.arrayContaining(['gold', 'stock', 'etf']),
    );
  });
  it.each(['I can hold gold now', 'Actually, do not exclude gold anymore'])(
    'a later cancellation removes the earlier exclusion: %s',
    async (text) => {
      const b = await history();
      await b.talk.turn({ kind: 'text', text }, b.sheet);
      expect(b.posted.at(-1)?.answers ?? {}).not.toHaveProperty('limits');
      expect(b.results.at(-1)?.sheet).not.toBeNull();
      expect(b.results.at(-1)?.sheet?.limits?.cannotHold?.classes ?? []).not.toContain('gold');
    },
  );
  it('keeps omitted-turn glide, credit and cash instructions in the actual text the engine reads', async () => {
    const b = await history('Grow $2,000 over 5 years, high risk.');
    let reply = await b.talk.turn(
      { kind: 'text', text: 'Take less risk over time. No credit. Keep $1,000 in cash.' },
      b.sheet,
    );
    for (let i = 0; i < 12; i++)
      reply = await b.talk.turn({ kind: 'text', text: `More detail ${i}.` }, reply.sheet);
    const body = latest(b.posted);
    expect(conversationText(body.text, body.followUps)).toContain(
      'Take less risk over time. No credit. Keep $1,000 in cash.',
    );
    expect(body.answers ?? {}).not.toHaveProperty('rules');
    expect(body.answers ?? {}).not.toHaveProperty('limits');
    expect(b.results.at(-1)?.limits.creditTolerance).toBe('none');
    expect(b.results.at(-1)?.sheet?.rules.glide).toBe(true);
    // The cash instruction is preserved exactly; this test does not invent an engine capability
    // to turn that phrase into mustKeepCashUsd where the intake has no such reader.
  });
  it('reopens an ancient model-only refusal confirmation instead of building an unrestricted sheet', async () => {
    const b = bridge({ ...model, cannotHold: ['gold'] });
    let r = await b.talk.turn({ kind: 'text', text: 'Grow $2,000 over 5 years, high risk.' }, null);
    expect(b.results.at(-1)?.questions.map((q) => q.field)).toContain('limits');
    r = await b.talk.turn({ kind: 'text', text: 'yes' }, r.sheet);
    expect(b.results.at(-1)?.sheet?.limits?.cannotHold?.classes).toContain('gold');
    for (let i = 0; i < 15; i++)
      r = await b.talk.turn({ kind: 'text', text: `Another neutral detail ${i}.` }, r.sheet);
    expect(b.posted.at(-1)?.followUps?.[0]).toBe('yes');
    expect(b.results.at(-1)?.questions.map((q) => q.field)).toContain('limits');
    expect(b.results.at(-1)?.sheet).toBeNull();
    expect(r.valid).toBeNull();
  });
  it('retains answersThen at the time of each later message, not today’s answers', async () => {
    const b = bridge();
    let r = await b.talk.turn({ kind: 'text', text: 'Grow $2,000 over 5 years, high risk.' }, null);
    r = await b.talk.turn({ kind: 'answer', fact: 'risk', value: 'low' }, r.sheet);
    r = await b.talk.turn({ kind: 'text', text: 'Another detail before editing' }, r.sheet);
    r = await b.talk.turn({ kind: 'answer', fact: 'risk', value: 'high' }, r.sheet);
    for (let i = 0; i < 12; i++)
      r = await b.talk.turn({ kind: 'text', text: `Later detail ${i}` }, r.sheet);
    const last = latest(b.posted);
    expect(last.answersThen).toEqual([
      { risk: 'low' },
      ...Array.from({ length: 12 }, () => ({ risk: 'high' })),
    ]);
    expect(last.answers).toEqual({ risk: 'high' });
    expect(last.followUps?.[0]).toBe('Another detail before editing');
  });
});

describe('intake request bounds', () => {
  it('keeps matching client/server bounds and validates the actual combined text', () => {
    expect(MAX_FOLLOW_UPS).toBe(INTAKE_FOLLOW_UPS);
    expect(WEB_BUDGET).toBe(INTAKE_TEXT_BUDGET);
    const body = {
      text: 'x'.repeat(2000),
      followUps: [...Array.from({ length: 9 }, () => 'y'.repeat(2000)), 'z'.repeat(1980)],
    };
    expect(conversationText(body.text, body.followUps)).toHaveLength(22000);
    expect(IntakeRequest.safeParse(body).success).toBe(true);
    expect(IntakeRequest.safeParse({ ...body, followUps: [...body.followUps, 'a'] }).success).toBe(
      false,
    );
    expect(
      IntakeRequest.safeParse({ text: 'goal', followUps: Array.from({ length: 199 }, () => 'a') })
        .success,
    ).toBe(true);
    expect(
      IntakeRequest.safeParse({ text: 'goal', followUps: Array.from({ length: 200 }, () => 'a') })
        .success,
    ).toBe(false);
    expect(IntakeRequest.safeParse({ text: 'goal', followUps: ['a'.repeat(2001)] }).success).toBe(
      false,
    );
    expect(
      IntakeRequest.safeParse({
        text: 'goal',
        followUps: Array.from({ length: 199 }, () => 'a'),
        answersThen: Array.from({ length: 200 }, () => ({})),
      }).success,
    ).toBe(false);
    expect(IntakeRequest.safeParse({ text: 'goal', followUps: ['yes'] }).success).toBe(true);
    expect(
      IntakeRequest.safeParse({ text: 'goal', followUps: ['yes'], answersThen: [{}] }).success,
    ).toBe(true);
    expect(
      IntakeRequest.safeParse({ text: 'goal', followUps: ['yes'], answersThen: [] }).success,
    ).toBe(false);
  });
  it('refuses invalid snapshot count and aggregate capacity in the client before fetching', async () => {
    let calls = 0;
    const api = async () => {
      calls++;
      throw Error('not requested');
    };
    const ask = {
      text: 'goal',
      language: 'en' as const,
      followUps: ['yes'],
      answers: {},
      answersThen: [],
    };
    expect(await readIntake(api, ask)).toEqual({ kind: 'refused' });
    expect(
      await readIntake(api, {
        ...ask,
        followUps: Array.from({ length: 200 }, () => 'a'),
        answersThen: [],
      }),
    ).toEqual({ kind: 'capacity' });
    expect(
      await readIntake(api, {
        ...ask,
        text: 'x'.repeat(2000),
        followUps: Array.from({ length: 11 }, () => 'x'.repeat(2000)),
        answersThen: Array.from({ length: 11 }, () => ({})),
      }),
    ).toEqual({ kind: 'capacity' });
    expect(calls).toBe(0);
  });
});

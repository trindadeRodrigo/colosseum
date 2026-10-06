import { describe, expect, it, vi } from 'vitest';
import { json } from '../wallet/test/fake-port';
import { INTAKE_PATH, readIntake } from './intake';
import { intakeAsking, intakeSaid } from './test/plan';

// The intake's one call (gate GUIDED-INTAKE): what is sent, and what of the answer is shown. The
// questions and the read-back are the server's; the sheet to confirm is shown only when nothing is
// left to ask, and is kept as it came, with whatever the server put on it.

const ask = (over: Partial<Parameters<typeof readIntake>[1]> = {}) => ({
  text: 'Grow $40,000 for an apartment',
  language: 'en' as const,
  followUps: [],
  answers: {},
  ...over,
});

describe('the intake', () => {
  it('sends the text, the language, the later words and the answers, and leaves out what is empty', async () => {
    const api = vi.fn(async () => json(intakeAsking()));
    await readIntake(api, ask());
    expect(api).toHaveBeenLastCalledWith(INTAKE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Grow $40,000 for an apartment', language: 'en' }),
    });
    await readIntake(
      api,
      ask({ followUps: ['I live in Brazil'], answers: { amountUsd: 40_000, horizonOpen: true } }),
    );
    const [, init] = api.mock.lastCall as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Grow $40,000 for an apartment',
      language: 'en',
      followUps: ['I live in Brazil'],
      answers: { amountUsd: 40_000, horizonOpen: true },
    });
  });

  it('sends no answer the sheet does not take, and no text the reader does not', async () => {
    const api = vi.fn(async () => json(intakeAsking()));
    for (const answers of [
      { amountUsd: 5 },
      { risk: 'extreme' },
      { country: 'BR' },
      { weights: 1 },
    ])
      expect(
        await readIntake(api, ask({ answers: answers as never })),
        JSON.stringify(answers),
      ).toEqual({ kind: 'refused' });
    expect(await readIntake(api, ask({ text: 'ab' }))).toEqual({ kind: 'too_short' });
    expect(await readIntake(api, ask({ text: 'x'.repeat(2001) }))).toEqual({ kind: 'too_long' });
    expect(api).not.toHaveBeenCalled();
  });

  it('reads the questions while anything is open, and no sheet with them', async () => {
    const read = await readIntake(async () => json(intakeAsking()), ask());
    expect(read).toMatchObject({
      kind: 'read',
      reading: { reader: { method: 'rules' }, sheet: null, readBack: null },
    });
    if (read.kind !== 'read') throw new Error('read');
    expect(read.reading.questions.map((q) => q.field)).toEqual([
      'amountUsd',
      'horizonMonths',
      'risk',
    ]);
    // a sheet sent beside an open question is not one to confirm
    const both = await readIntake(
      async () => json({ ...intakeSaid(), questions: intakeAsking().questions }),
      ask(),
    );
    expect(both).toMatchObject({ kind: 'read', reading: { sheet: null, readBack: null } });
  });

  it('keeps the sheet said back as it came, limits and all, with its read-back', async () => {
    const read = await readIntake(async () => json(intakeSaid()), ask());
    expect(read).toMatchObject({
      kind: 'read',
      reading: { sheet: intakeSaid().sheet, readBack: intakeSaid().readBack, questions: [] },
    });
  });

  it('shows nothing that is not an answer in the route’s shape', async () => {
    const base = intakeAsking();
    for (const body of [
      { ...base, reader: { method: 'oracle', model: null, provenance: null } },
      { ...base, language: 'fr' },
      { ...base, questions: [{ field: 'weights', template: 'X', text: 'Which assets?' }] },
      { ...base, questions: [{ field: 'risk', template: 'RISK', text: '' }] },
      { ...intakeSaid(), sheet: { goal: 'grow' } },
      { ...intakeSaid(), readBack: [1, 2] },
      'ok',
      null,
    ])
      expect(await readIntake(async () => json(body), ask()), JSON.stringify(body)).toEqual({
        kind: 'unreadable',
      });
  });

  it('names each refusal for what the person can do about it', async () => {
    const answered = (status: number, body: unknown = { error: 'x' }) =>
      readIntake(async () => json(body, status), ask());
    expect(await answered(404)).toEqual({ kind: 'unavailable' });
    expect(await answered(429)).toEqual({ kind: 'busy' });
    expect(await answered(401)).toEqual({ kind: 'signed-out' });
    expect(await answered(403)).toEqual({ kind: 'signed-out' });
    expect(await answered(401, { error: 'sign in first: no identity token was sent' })).toEqual({
      kind: 'no-identity',
    });
    expect(await answered(400)).toEqual({ kind: 'refused' });
    expect(await answered(502)).toEqual({ kind: 'unreachable' });
    expect(
      await readIntake(async () => {
        throw new TypeError('fetch failed');
      }, ask()),
    ).toEqual({ kind: 'unreachable' });
  });
});

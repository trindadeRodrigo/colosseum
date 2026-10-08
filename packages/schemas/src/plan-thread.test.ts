import { describe, expect, it } from 'vitest';
import { BasketSheet } from './basket-sheet';
import {
  factsNotHeld,
  THREAD_LIMITS,
  THREAD_SAY_KEYS,
  ThreadEvent,
  ThreadKey,
  ThreadReply,
  ThreadStart,
  ThreadText,
  ThreadTurnRequest,
} from './plan-thread';

// A plan's thread, as it is taken and stored: a person's words as plain text, the app's reply as keys
// and facts with no room for a sentence, and events only the server writes.

const reply = {
  say: [{ key: 'understood' }, { key: 'set', fact: 'amount' }],
  ask: 'horizon',
  open: ['horizon', 'risk'],
  facts: { goal: 'grow', amountUsd: 5000 },
};

describe('a person’s words', () => {
  it('are plain text of a bounded length, in any language, with line breaks', () => {
    for (const text of [
      'Grow $5,000 over five years',
      'Quero proteger R$ 50.000 por 18 meses, risco baixo',
      'two lines\nand a\ttab',
      'emoji are text too 🙂',
      'x'.repeat(THREAD_LIMITS.textMax),
    ])
      expect(ThreadText.safeParse(text).success, text.slice(0, 20)).toBe(true);
  });

  it('have a line break from Windows stored as the one character, and a return alone refused', () => {
    expect(ThreadText.parse('two lines\r\nfrom Windows\r\n')).toBe('two lines\nfrom Windows\n');
    expect(ThreadText.safeParse('a carriage\rreturn').success).toBe(false);
  });

  it('are refused when empty, too long, or holding a control or direction character', () => {
    for (const text of [
      '',
      '   \n ',
      'x'.repeat(THREAD_LIMITS.textMax + 1),
      'null\u0000byte',
      'escape\u001b[31m',
      'a carriage\rreturn',
      // the marks that reorder what is read: an override, an isolate, a mark
      'pay \u202eevil\u202c',
      'pay \u2066evil\u2069',
      'left\u200fright',
      'c1 \u0085 control',
    ])
      expect(ThreadText.safeParse(text).success, JSON.stringify(text).slice(0, 24)).toBe(false);
  });
});

describe('the app’s reply', () => {
  it('is keys and the sheet’s own facts', () => {
    expect(ThreadReply.parse(reply)).toEqual(reply);
    expect(ThreadReply.safeParse({ say: [], ask: null, open: [], facts: {} }).success).toBe(true);
    // a stock asked for by name is said back by the screen's key for it, and an income target the
    // person declined to give is null: asked, and not asked again
    const more = {
      ...reply,
      say: [{ key: 'cantPick', pick: 'nvidia' }],
      facts: { goal: 'income', incomeTargetUsdMonthly: null },
    };
    expect(ThreadReply.parse(more)).toEqual(more);
    expect(
      ThreadReply.safeParse({ ...reply, say: [{ key: 'cantPick', pick: 'Buy NVDA now' }] }).success,
    ).toBe(false);
  });

  it('says only what is on its list: a key the screen has no words for is refused', () => {
    expect(THREAD_SAY_KEYS).toEqual([
      'understood',
      'notUnderstood',
      'held',
      'set',
      'failed',
      'unfit',
      'cantPick',
      'riskTop',
      'riskBottom',
      'ready',
    ]);
    for (const say of [
      { key: 'set', fact: 'amount' },
      { key: 'unfit', fact: 'horizon' },
      { key: 'failed', why: 'busy' },
      { key: 'cantPick', pick: 'nvidia' },
      { key: 'riskTop' },
      { key: 'ready' },
    ])
      expect(ThreadReply.safeParse({ ...reply, say: [say] }).success, say.key).toBe(true);
    for (const say of [
      { key: 'I recommend buying NVDA now' },
      { key: 'plan.built' },
      { key: 'promise' },
      // a key with a value that is not its own, or without the one it is said with
      { key: 'set' },
      { key: 'set', fact: 'returns' },
      { key: 'understood', fact: 'amount' },
      { key: 'failed', why: 'the market crashed' },
      { key: 'cantPick', pick: 'gamestop' },
      { key: 'ready', pick: 'nvidia' },
    ])
      expect(ThreadReply.safeParse({ ...reply, say: [say] }).success, JSON.stringify(say)).toBe(
        false,
      );
    // the question and what is open are facts by name
    expect(ThreadReply.safeParse({ ...reply, ask: 'how much?' }).success).toBe(false);
    expect(ThreadReply.safeParse({ ...reply, ask: 'returns' }).success).toBe(false);
    expect(ThreadReply.safeParse({ ...reply, open: ['amount', 'yield'] }).success).toBe(false);
  });

  it('holds only the plan’s own facts: a figure the sheet does not have is named', () => {
    const sheet = BasketSheet.parse({
      basketType: 'standard',
      goal: 'grow',
      amountUsd: 5000,
      horizonMonths: 60,
      risk: 'high',
      themes: [],
      country: 'BR',
      chains: ['solana'],
      rules: { useHoldings: false, glide: true },
      language: 'en',
    });
    expect(factsNotHeld({}, sheet)).toEqual([]);
    expect(
      factsNotHeld(
        { goal: 'grow', amountUsd: 5000, horizonMonths: 60, risk: 'high', chain: 'solana' },
        sheet,
      ),
    ).toEqual([]);
    // asked and declined is held by a sheet with no income target, and a figure is not
    expect(factsNotHeld({ incomeTargetUsdMonthly: null }, sheet)).toEqual([]);
    expect(factsNotHeld({ incomeTargetUsdMonthly: 400 }, sheet)).toEqual([
      'incomeTargetUsdMonthly',
    ]);
    expect(
      factsNotHeld({ goal: 'income', amountUsd: 999_999, risk: 'low', chain: 'robinhood' }, sheet),
    ).toEqual(['goal', 'amountUsd', 'risk', 'chain']);
    const income = { ...sheet, goal: 'income' as const, incomeTargetUsdMonthly: 400 };
    expect(factsNotHeld({ incomeTargetUsdMonthly: 400 }, income)).toEqual([]);
    expect(factsNotHeld({ incomeTargetUsdMonthly: null }, income)).toEqual([
      'incomeTargetUsdMonthly',
    ]);
  });

  it('keeps a key of a sheet’s field to letters and digits: no room for a sentence', () => {
    for (const key of ['amountUsd', 'horizonMonths', 'a1.b2'])
      expect(ThreadKey.safeParse(key).success, key).toBe(true);
    for (const key of ['You will earn 8% a year', 'earn8%', '$5,000', '', '.set', 'x'.repeat(49)])
      expect(ThreadKey.safeParse(key).success, key).toBe(false);
  });

  it('takes no field it does not name: free text has nowhere to go', () => {
    expect(ThreadReply.safeParse({ ...reply, text: 'a sentence' }).success).toBe(false);
    expect(ThreadReply.safeParse({ ...reply, say: [{ key: 'set', text: 'x' }] }).success).toBe(
      false,
    );
    expect(ThreadReply.safeParse({ ...reply, facts: { note: 'x' } }).success).toBe(false);
    // a fact is the sheet's own value, as the sheet types it
    expect(ThreadReply.safeParse({ ...reply, facts: { amountUsd: '5,000 dollars' } }).success).toBe(
      false,
    );
    expect(ThreadReply.safeParse({ ...reply, facts: { goal: 'get rich' } }).success).toBe(false);
    expect(ThreadReply.safeParse({ ...reply, say: Array(9).fill({ key: 'held' }) }).success).toBe(
      false,
    );
  });
});

describe('a turn sent by a person', () => {
  it('is their words and the reply, and nothing else: no event, no who, no time', () => {
    expect(ThreadTurnRequest.safeParse({ text: 'Grow $5,000', reply }).success).toBe(true);
    const id = '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60';
    for (const extra of [
      { event: { type: 'buy_done', orderId: id } },
      { who: 'event' },
      { at: '2026-10-07T00:00:00.000Z' },
    ])
      expect(ThreadTurnRequest.safeParse({ text: 'x', reply, ...extra }).success).toBe(false);
  });

  it('names what happened by kind and id only', () => {
    const id = '3c1f9a7e-5b2d-4c8e-9f0a-1b2c3d4e5f60';
    expect(ThreadEvent.safeParse({ type: 'plan_built', planId: id }).success).toBe(true);
    // a plan built again names both plans and the sheet's fields that changed, as keys
    const rebuilt = {
      type: 'plan_rebuilt',
      planId: id,
      previousPlanId: id,
      changed: ['amountUsd'],
    };
    expect(ThreadEvent.parse(rebuilt)).toEqual(rebuilt);
    expect(ThreadEvent.safeParse({ ...rebuilt, changed: ['from $5,000 to $7,000'] }).success).toBe(
      false,
    );
    expect(
      ThreadEvent.safeParse({ type: 'order_made', orderId: id, kind: 'add', amountUsd: 100 })
        .success,
    ).toBe(true);
    expect(ThreadEvent.safeParse({ type: 'rug_pulled', orderId: id }).success).toBe(false);
    expect(ThreadEvent.safeParse({ type: 'buy_done', orderId: 'not-an-id' }).success).toBe(false);
  });
});

describe('guided history attachment capacity', () => {
  it('retains 200 chronological person messages within the 22000 aggregate budget', () => {
    const turns = Array.from({ length: 200 }, (_, i) => ({ text: `message ${i}`, reply }));
    expect(ThreadStart.parse(turns)).toEqual(turns);
    expect(ThreadStart.safeParse([...turns, turns[0]]).success).toBe(false);
    expect(
      ThreadStart.safeParse(Array.from({ length: 12 }, () => ({ text: 'x'.repeat(2000), reply })))
        .success,
    ).toBe(false);
  });
});

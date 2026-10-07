import { describe, expect, it } from 'vitest';
import {
  THREAD_LIMITS,
  ThreadEvent,
  ThreadKey,
  ThreadReply,
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

  it('has no room for a sentence or a figure with its unit: a key has no space and no sign', () => {
    for (const key of ['understood', 'plan.built', 'set_amount', 'a1.b2'])
      expect(ThreadKey.safeParse(key).success, key).toBe(true);
    for (const key of [
      'You will earn 8% a year',
      'earn8%',
      '$5,000',
      'amount: 5000',
      '',
      '.set',
      'set.',
      'x'.repeat(49),
    ])
      expect(ThreadKey.safeParse(key).success, key).toBe(false);
    const sentence = { ...reply, say: [{ key: 'I recommend buying NVDA now' }] };
    expect(ThreadReply.safeParse(sentence).success).toBe(false);
    expect(ThreadReply.safeParse({ ...reply, ask: 'how much?' }).success).toBe(false);
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
    expect(ThreadReply.safeParse({ ...reply, say: Array(9).fill({ key: 'set' }) }).success).toBe(
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
    expect(
      ThreadEvent.safeParse({ type: 'order_made', orderId: id, kind: 'add', amountUsd: 100 })
        .success,
    ).toBe(true);
    expect(ThreadEvent.safeParse({ type: 'rug_pulled', orderId: id }).success).toBe(false);
    expect(ThreadEvent.safeParse({ type: 'buy_done', orderId: 'not-an-id' }).success).toBe(false);
  });
});

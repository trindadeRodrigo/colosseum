import { describe, expect, it } from 'vitest';
import { VaultConversationCheckpoint, VaultConversationWrite } from './vault-conversation';

const checkpoint = {
  version: 1,
  language: 'en',
  words: ['I want to grow', 'yes'],
  answers: {},
  answersThen: [{}],
};
const body = {
  version: 1,
  expectedNetwork: 'testnet',
  expectedRevision: 0,
  transcript: [{ id: '1', who: 'person', text: 'I want to grow' }],
  checkpoint: null,
};
describe('private vault conversation data', () => {
  it('retains history text as data, including markup, without treating it as a sheet', () => {
    const value = {
      ...body,
      transcript: [{ id: '1', who: 'app', text: '<script>trade()</script>' }],
    };
    expect(VaultConversationWrite.parse(value)).toEqual(value);
    for (const key of ['sheet', 'confirmed', 'proposalId', 'threadId', 'network'])
      expect(VaultConversationWrite.safeParse({ ...value, [key]: true }).success).toBe(false);
  });
  it('requires an exact supported expected network without selecting the authoritative network', () => {
    for (const expectedNetwork of ['mainnet', 'testnet', 'local'])
      expect(VaultConversationWrite.safeParse({ ...body, expectedNetwork }).success).toBe(true);
    const { expectedNetwork: _expectedNetwork, ...unscoped } = body;
    expect(VaultConversationWrite.safeParse(unscoped).success).toBe(false);
    expect(VaultConversationWrite.safeParse({ ...body, expectedNetwork: 'unknown' }).success).toBe(
      false,
    );
  });
  it('keeps all 200 chronological person messages and refuses 201', () => {
    const words = Array.from({ length: 200 }, (_, i) => `message ${i}`);
    expect(
      VaultConversationCheckpoint.parse({
        ...checkpoint,
        words,
        answersThen: words.slice(1).map(() => ({})),
      }).words,
    ).toEqual(words);
    expect(
      VaultConversationCheckpoint.safeParse({
        ...checkpoint,
        words: [...words, 'more'],
        answersThen: words.map(() => ({})),
      }).success,
    ).toBe(false);
  });
  it('enforces combined person capacity and exact snapshot alignment', () => {
    expect(
      VaultConversationCheckpoint.safeParse({
        ...checkpoint,
        words: Array(12).fill('x'.repeat(2000)),
        answersThen: Array(11).fill({}),
      }).success,
    ).toBe(false);
    expect(VaultConversationCheckpoint.safeParse({ ...checkpoint, answersThen: [] }).success).toBe(
      false,
    );
    expect(VaultConversationCheckpoint.safeParse({ ...checkpoint, questionThen: [] }).success).toBe(
      false,
    );
  });
  it('grounds pending interest in the original message and holds explicit null distinct from omission', () => {
    expect(
      VaultConversationCheckpoint.parse({
        ...checkpoint,
        held: null,
        pendingInterest: { quote: 'grow', sourceTurn: 0 },
      }).held,
    ).toBe(null);
    expect(
      VaultConversationCheckpoint.safeParse({
        ...checkpoint,
        pendingInterest: { quote: 'Tesla', sourceTurn: 0 },
      }).success,
    ).toBe(false);
    expect(
      VaultConversationCheckpoint.safeParse({
        ...checkpoint,
        held: { growthBps: 1, dollarYieldBps: 0, goldBps: 0, cashBps: 0 },
      }).success,
    ).toBe(false);
  });
  it('refuses forged server prose or confirmations inside replay checkpoints', () => {
    for (const key of ['sheet', 'question', 'readBack', 'confirmed'])
      expect(VaultConversationCheckpoint.safeParse({ ...checkpoint, [key]: true }).success).toBe(
        false,
      );
    expect(
      VaultConversationCheckpoint.safeParse({ ...checkpoint, answers: { amountUsd: -1 } }).success,
    ).toBe(false);
  });
  it('rejects duplicate message ids, controls and oversized replies atomically', () => {
    expect(
      VaultConversationWrite.safeParse({
        ...body,
        transcript: [...body.transcript, ...body.transcript],
      }).success,
    ).toBe(false);
    for (const text of ['bad\u202e', 'bad\u0000', 'x'.repeat(8001)])
      expect(
        VaultConversationWrite.safeParse({ ...body, transcript: [{ id: '1', who: 'app', text }] })
          .success,
      ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { replyText } from './agent';
import { jointLayout, jointMotion, SEAT_MS, staggerMs } from './MixJoint';

const mix = (...bps: number[]) => bps.map((b, i) => ({ key: `solana:a${i}`, bps: b }));
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('where the pieces of a mix lie', () => {
  it('gives each piece its share of the beam, end to end', () => {
    expect(jointLayout(mix(5000, 3000, 2000)).map((s) => [s.left, s.width])).toEqual([
      [0, 50],
      [50, 30],
      [80, 20],
    ]);
    expect(jointLayout(mix(10_000)).map((s) => [s.left, s.width])).toEqual([[0, 100]]);
    expect(jointLayout([])).toEqual([]);
  });
  it('draws a sliver at the narrowest width and takes the room from the rest in proportion', () => {
    const slots = jointLayout(mix(9800, 100, 100));
    expect(slots.map((s) => s.width)).toEqual([94, 3, 3]);
    expect(slots[2]?.left).toBe(97);
    // a piece lifted to the narrowest width does not push a neighbour under it
    const many = jointLayout(
      mix(6000, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 240, 240),
    );
    expect(sum(many.map((s) => s.width))).toBeCloseTo(100, 9);
    expect(Math.min(...many.map((s) => s.width))).toBeGreaterThanOrEqual(3 - 1e-9);
  });
  it('fits the most a reply may hold, every piece wide enough to point at', () => {
    for (const n of [17, 64]) {
      const slots = jointLayout(
        mix(...Array.from({ length: n }, (_, i) => (i ? 1 : 10_000 - n + 1))),
      );
      expect(sum(slots.map((s) => s.width))).toBeCloseTo(100, 9);
      expect(Math.min(...slots.map((s) => s.width))).toBeCloseTo(Math.min(3, 60 / n), 9);
    }
  });
});

describe('what moves when one mix follows another', () => {
  it('moves nothing for the same shares, the difference for a shared piece, all of it otherwise', () => {
    const before = mix(5000, 3000, 2000);
    expect(jointMotion(before, mix(5000, 3000, 2000))).toEqual({ kind: 'still' });
    expect(jointMotion(before, [{ key: 'solana:other', bps: 10_000 }])).toEqual({ kind: 'arrive' });
    const change = jointMotion(before, [
      { key: 'solana:a0', bps: 6000 },
      { key: 'solana:a2', bps: 4000 },
    ]);
    if (change.kind !== 'change') throw new Error('expected a change');
    expect(change.from.get('solana:a2')).toMatchObject({ left: 80, width: 20, index: 2 });
    expect(change.gone).toEqual([{ key: 'solana:a1', bps: 3000, index: 1, left: 50, width: 30 }]);
    // the same assets in another order is a change too
    expect(jointMotion(before, [...before].reverse()).kind).toBe('change');
  });
  it('seats any number of pieces, their rows and their figures within 1.2 seconds', () => {
    for (const n of [1, 2, 6, 17, 64]) {
      const last = (n - 1) * staggerMs(n);
      expect(last + SEAT_MS).toBeLessThanOrEqual(900);
      // a row starts 160ms after its piece, and its figure 120ms later, over 160ms
      expect(last + 160 + 120 + 160).toBeLessThanOrEqual(1200);
    }
    expect(staggerMs(6)).toBe(60);
  });
});

describe('a reply said as one text', () => {
  it('says the question once when the message already ends with it', () => {
    expect(replyText('Here it is.', null)).toBe('Here it is.');
    expect(replyText('Here it is.', 'How long?')).toBe('Here it is.\n\nHow long?');
    expect(replyText('Here it is. How long?', 'How long?')).toBe('Here it is. How long?');
    expect(replyText('Here it is.\n\nHow  long? ', 'how long?')).toBe('Here it is.\n\nHow  long? ');
    // a question asked earlier in the message, and not at its end, is still asked at the end
    expect(replyText('How long? I ask because it matters.', 'How long?')).toBe(
      'How long? I ask because it matters.\n\nHow long?',
    );
  });
});

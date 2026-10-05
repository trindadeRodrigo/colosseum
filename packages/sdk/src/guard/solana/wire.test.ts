import { describe, expect, it, vi } from 'vitest';
import { refusalOf } from '../../../test/bites';
import {
  BASKET_ID,
  depositIx,
  handWritten,
  join,
  keysOf,
  OWNER,
  SOLANA,
  STRANGER,
  solanaTx,
  someone,
  type Wire,
} from '../../../test/solana';
import { base64Decode } from '../../bytes';
import { BASKET_PROGRAM } from '../generated/basket-program';
import { guardTransaction } from '../index';
import type { ApprovedStep } from '../types';
import { parseSolanaTransaction } from './wire';

vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));

// The reader of Solana's wire format, on messages written by hand: what @solana/kit would never
// compile. One case per rule of the reader, each refused for that rule's own reason, and by the guard
// as bytes it cannot read.

const CASH = '1000000000';
const step: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: OWNER,
  basketId: BASKET_ID,
  kind: 'deposit',
  amountRaw: CASH,
  trades: [],
};
const deposit = await depositIx(BASKET_PROGRAM, CASH);
const keys = keysOf([OWNER], [deposit]);
const guarded = (w: Wire) =>
  refusalOf(() => guardTransaction({ step, tx: solanaTx(step, w), deployment: SOLANA }));
const read = (w: Wire) => () => parseSolanaTransaction(base64Decode(w.payload));

describe('the Solana wire reader, on messages written by hand', () => {
  it('reads a well-formed one, which the guard passes, on both message versions', () => {
    for (const version of [0, 'legacy'] as const) {
      const w = handWritten({ keys, instructions: [deposit], version });
      const parsed = parseSolanaTransaction(base64Decode(w.payload));
      expect(parsed.keys).toEqual(keys);
      expect(parsed.signers).toBe(1);
      expect(guarded(w)?.message ?? null, String(version)).toBeNull();
    }
  });

  const longKeyCount = () => {
    // The count of keys, one byte, written as two: 0x80 | n, then 0.
    const { message } = handWritten({ keys, instructions: [deposit] });
    const at = 1 + 3;
    expect(message[at]).toBe(keys.length);
    const long = join(
      message.slice(0, at),
      Uint8Array.of(0x80 | keys.length, 0),
      message.slice(at + 1),
    );
    return {
      payload: Buffer.from(join(Uint8Array.of(1), new Uint8Array(64), long)).toString('base64'),
      messageHash: '',
    };
  };
  const programAt = keys.indexOf(BASKET_PROGRAM.address);
  const table = { table: someone('table'), writable: [0], readonly: [] };

  const cases: [string, () => Wire, RegExp][] = [
    [
      'two signature slots for one signer',
      () => handWritten({ keys, instructions: [deposit], slots: 2 }),
      /signature slots/,
    ],
    [
      'no signature slot for its signer',
      () => handWritten({ keys, instructions: [deposit], slots: 0 }),
      /signature slots/,
    ],
    ['a count written the long way', longKeyCount, /the long way/],
    [
      'a length past what sixteen bits hold',
      () =>
        handWritten({
          keys,
          instructions: [{ ...deposit, data: new Uint8Array(0x10000) }],
        }),
      /out of range/,
    ],
    [
      'an account listed twice',
      () => handWritten({ keys: [...keys, STRANGER, STRANGER], instructions: [deposit] }),
      /listed twice/,
    ],
    [
      'more signers than accounts',
      () =>
        handWritten({
          keys,
          instructions: [deposit],
          header: [keys.length + 1, 0, 0],
        }),
      /more signers than accounts/,
    ],
    [
      'the fee payer read-only',
      () => handWritten({ keys, instructions: [deposit], header: [1, 1, 0] }),
      /pays the fee is read-only/,
    ],
    [
      'more read-only accounts than there are',
      () => handWritten({ keys, instructions: [deposit], header: [1, 0, keys.length] }),
      /more read-only accounts than accounts/,
    ],
    [
      'a program that a lookup table loads',
      () =>
        handWritten({
          keys,
          instructions: [{ program: keys.length, accounts: [0], data: Uint8Array.of(1) }],
          tables: [table],
        }),
      /a program that is not there/,
    ],
    [
      'an account past those the lookup tables load',
      () =>
        handWritten({
          keys,
          instructions: [
            { program: programAt, accounts: [keys.length + 1], data: Uint8Array.of(1) },
          ],
          tables: [table],
        }),
      /an account that is not there/,
    ],
  ];

  for (const [name, bytes, why] of cases)
    it(`refuses ${name}`, () => {
      const w = bytes();
      expect(read(w)).toThrow(why);
      expect(guarded(w)?.code).toBe('malformed');
    });

  it('takes as many read-only accounts as there are, and no more', () => {
    const w = handWritten({ keys, instructions: [deposit], header: [1, 0, keys.length - 1] });
    expect(parseSolanaTransaction(base64Decode(w.payload)).readonlyOthers).toBe(keys.length - 1);
  });
});

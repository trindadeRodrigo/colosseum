import { describe, expect, it } from 'vitest';
import * as e from '../../test/evm';
import vectors from '../../test/fixtures/evm-vectors.json';
import * as s from '../../test/solana';
import { base58Encode, base64Decode, base64Encode, hexDecode, hexEncode } from '../bytes';
import { BASKET_PROGRAM } from '../guard/generated/basket-program';
import type { Guarded } from '../guard/run';
import type { ApprovedStep } from '../guard/types';
import { type ChainRead, chainReadOf } from './chain-read';
import { heldToPass, signedEvm, signedSolana } from './signed';

// What the executor reads from the bytes a wallet handed back, and the rule that says whether they can
// still land. The EVM transactions are viem's own serialization (test/fixtures/evm-vectors.json), with
// a signature made of fixed bytes; the Solana ones are @solana/kit's.

const depositStep: ApprovedStep = {
  legId: 'leg-1',
  chain: 'solana',
  owner: s.OWNER,
  basketId: s.BASKET_ID,
  kind: 'deposit',
  amountRaw: '1000',
  trades: [],
};
const SIGNATURE = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
/** The transaction with its one signature slot filled, as a wallet hands it back. */
const signedBy = (payload: string, signature = SIGNATURE) => {
  const bytes = base64Decode(payload);
  bytes.set(signature, 1);
  return base64Encode(bytes);
};
const built = async () => s.wire([await s.depositIx(BASKET_PROGRAM, '1000')]);
const passOf = (tx: unknown) => ({ tx, step: depositStep }) as Guarded;

describe('a signed Solana transaction, read from its bytes', () => {
  it('names its signature and the blockhash it is bound to', async () => {
    const { payload } = await built();
    const signed = signedSolana(signedBy(payload));
    expect(signed.signature).toBe(base58Encode(SIGNATURE));
    expect(signed.blockhash).toBe(s.someone('blockhash'));
    expect(hexEncode(signed.message)).toBe(hexEncode(base64Decode(payload).slice(65)));
  });

  it('refuses one nobody signed, and anything that is not a transaction', async () => {
    const { payload } = await built();
    expect(() => signedSolana(payload)).toThrow(/not signed/);
    expect(() => signedSolana(`${signedBy(payload)}AAAA`)).toThrow();
    expect(() => signedSolana('0x02')).toThrow();
    expect(() => signedSolana('')).toThrow();
  });

  it('is the transaction the guard passed only when its message is the same, byte for byte', async () => {
    const { payload } = await built();
    const pass = passOf(s.solanaTx(depositStep, { payload, messageHash: '' }));
    expect(() => heldToPass(pass, s.SOLANA, signedBy(payload))).not.toThrow();
    // The same instructions for another amount: a wallet that signed something else.
    const other = s.wire([await s.depositIx(BASKET_PROGRAM, '1001')]);
    expect(() => heldToPass(pass, s.SOLANA, signedBy(other.payload))).toThrow(/another message/);
    expect(() => heldToPass(pass, s.SOLANA, payload)).toThrow(/not signed/);
  });
});

describe('a signed EVM transaction, read from its bytes', () => {
  it("reads every field of viem's own serialization: legacy, type 1 and type 2", () => {
    expect(vectors.signed.length).toBeGreaterThan(20);
    expect(new Set(vectors.signed.map((v) => v.type))).toEqual(
      new Set(['legacy', 'eip2930', 'eip1559']),
    );
    for (const v of vectors.signed) {
      const signed = signedEvm(v.raw);
      expect(
        {
          hash: signed.hash,
          type: ['legacy', 'eip2930', 'eip1559'][signed.type],
          chainId: signed.chainId === null ? null : signed.chainId.toString(),
          nonce: signed.nonce,
          to: signed.to,
          value: signed.value.toString(),
          data: `0x${hexEncode(signed.data)}`,
          accessList: signed.accessList,
        },
        v.raw.slice(0, 40),
      ).toEqual({
        hash: v.hash,
        type: v.type,
        chainId: v.chainId,
        nonce: v.nonce,
        to: v.to,
        value: v.value,
        data: v.data,
        accessList: v.accessList,
      });
    }
  });

  it('reads no transaction that carries an authorization list, and nothing that is nearly a transaction', () => {
    expect(() => signedEvm(vectors.delegating)).toThrow(/type the executor does not read/);
    const [first] = vectors.signed;
    if (!first) throw new Error('no vector');
    const raw = hexDecode(first.raw);
    const hex = (bytes: Uint8Array) => `0x${hexEncode(bytes)}`;
    expect(() => signedEvm('0x')).toThrow(/empty/);
    expect(() => signedEvm(hex(raw.slice(0, -1)))).toThrow(/ends early/);
    expect(() => signedEvm(`${first.raw}00`)).toThrow(/left over/);
    // Type 3 (blobs), and a type nobody has defined.
    expect(() => signedEvm(hex(Uint8Array.of(3, ...raw.slice(1))))).toThrow(/type/);
    expect(() => signedEvm(hex(Uint8Array.of(0x7f, ...raw.slice(1))))).toThrow(/type/);
    // The body of a type 2 transaction under the type 1 byte: one field too many.
    expect(() => signedEvm(hex(Uint8Array.of(1, ...raw.slice(1))))).toThrow(/number of fields/);
    // A list where the nonce is, and bytes where the whole is a list.
    expect(() => signedEvm('0x02c3c0c0c0')).toThrow(/number of fields/);
    expect(() => signedEvm('0x0283010203')).toThrow(/not a list/);
    // Lengths written the long way.
    expect(() => signedEvm('0x02b80180')).toThrow(/long way/);
    expect(() => signedEvm('0x028105')).toThrow(/long way/);
    expect(() => signedEvm('0x02f800')).toThrow(/long way/);
    expect(() => signedEvm('0x02f90001c0')).toThrow(/long way/);
  });

  it('refuses a transaction with no signature in it', () => {
    // Twelve fields, the last two empty: r and s are zero.
    const unsigned = `0x02${'cc'}${'80'.repeat(8)}${'c0'}${'80'.repeat(3)}`;
    expect(() => signedEvm(unsigned)).toThrow(/not signed/);
  });

  it('is the call the guard passed only on its chain, to its target, with no value, its data and no access list', () => {
    const plain = vectors.signed.filter(
      (v) => v.chainId === String(e.CHAIN_ID) && v.to && v.value === '0' && v.accessList === 0,
    );
    expect(plain.map((v) => v.type)).toEqual(
      expect.arrayContaining(['legacy', 'eip2930', 'eip1559']),
    );
    const callOf = (v: (typeof plain)[number], change: Record<string, unknown> = {}) =>
      passOf({ payload: v.data, evm: { to: v.to, value: '0', chainId: e.CHAIN_ID }, ...change });
    for (const v of plain) {
      expect(() => heldToPass(callOf(v), e.EVM, v.raw), v.type).not.toThrow();
      // A target in upper case is the same target.
      const upper = {
        to: `0x${(v.to as string).slice(2).toUpperCase()}`,
        value: '0',
        chainId: e.CHAIN_ID,
      };
      expect(() => heldToPass(callOf(v, { evm: upper }), e.EVM, v.raw)).not.toThrow();
      const another = { to: e.STRANGER, value: '0', chainId: e.CHAIN_ID };
      expect(() => heldToPass(callOf(v, { evm: another }), e.EVM, v.raw)).toThrow(
        /another transaction/,
      );
      expect(() => heldToPass(callOf(v, { payload: `${v.data}00` }), e.EVM, v.raw)).toThrow(
        /another transaction/,
      );
    }
    const [one] = plain;
    if (!one) throw new Error('no vector');
    // Signed for another chain, for no chain, with value, with an access list, or creating a contract.
    const wrong = vectors.signed.filter(
      (v) => v.chainId !== String(e.CHAIN_ID) || !v.to || v.value !== '0' || v.accessList !== 0,
    );
    expect(wrong.some((v) => v.chainId === null)).toBe(true);
    expect(wrong.some((v) => v.value !== '0')).toBe(true);
    expect(wrong.some((v) => v.accessList > 0 && v.chainId === String(e.CHAIN_ID))).toBe(true);
    expect(wrong.some((v) => v.to === null)).toBe(true);
    for (const v of wrong) {
      const pass = passOf({
        payload: v.data,
        evm: { to: v.to ?? one.to, value: '0', chainId: e.CHAIN_ID },
      });
      expect(() => heldToPass(pass, e.EVM, v.raw), v.raw.slice(0, 30)).toThrow(
        /another transaction/,
      );
    }
    expect(() => heldToPass(callOf(one), e.EVM, vectors.delegating)).toThrow(/type/);
  });
});

describe('whether a signed transaction can still land, by the chain itself', () => {
  type Answers = { valid?: boolean; has?: boolean; next?: number };
  const asked: string[] = [];
  const readOf = (a: Answers): ChainRead =>
    chainReadOf({
      solana: {
        blockhashValid: async (blockhash) => {
          asked.push(`valid ${blockhash}`);
          return a.valid as boolean;
        },
        hasTransaction: async (signature) => {
          asked.push(`has ${signature}`);
          return a.has as boolean;
        },
      },
      evm: {
        nonceOf: async (chain, address) => {
          asked.push(`nonce ${chain} ${address}`);
          return a.next as number;
        },
        hasTransaction: async (chain, hash) => {
          asked.push(`has ${chain} ${hash}`);
          return a.has as boolean;
        },
      },
    });

  it('Solana: gone only when the blockhash is dead and the chain has no such transaction', async () => {
    const signedTx = signedBy((await built()).payload);
    const fate = (a: Answers) =>
      readOf(a).fateOf({ chain: 'solana', owner: s.OWNER, proof: { signedTx } });
    asked.length = 0;
    expect(await fate({ valid: false, has: false })).toBe('gone');
    // The blockhash is asked about first: once it is dead, what is not there cannot arrive.
    expect(asked).toEqual([`valid ${s.someone('blockhash')}`, `has ${base58Encode(SIGNATURE)}`]);
    expect(await fate({ valid: true, has: false })).toBe('open');
    expect(await fate({ valid: true, has: true })).toBe('landed');
    expect(await fate({ valid: false, has: true })).toBe('landed');
    // An answer that is not a yes or a no proves nothing.
    expect(await fate({ valid: undefined, has: false })).toBe('unknown');
    expect(await fate({ valid: false, has: undefined })).toBe('unknown');
  });

  it('EVM: gone only when the nonce has moved past it and the chain has no such transaction', async () => {
    const v = vectors.signed.find((x) => x.nonce === 128);
    if (!v) throw new Error('no vector');
    const fate = (a: Answers) =>
      readOf(a).fateOf({ chain: 'robinhood', owner: e.OWNER, proof: { signedTx: v.raw } });
    asked.length = 0;
    expect(await fate({ next: 129, has: false })).toBe('gone');
    expect(asked).toEqual([`nonce robinhood ${e.OWNER}`, `has robinhood ${v.hash}`]);
    // Its own nonce is still the account's next: it never expires, so it can still land.
    expect(await fate({ next: 128, has: false })).toBe('open');
    expect(await fate({ next: 5, has: false })).toBe('open');
    expect(await fate({ next: 129, has: true })).toBe('landed');
    expect(await fate({ next: 128, has: true })).toBe('landed');
    expect(await fate({ next: Number.NaN, has: false })).toBe('unknown');
    expect(await fate({ next: 129, has: undefined })).toBe('unknown');
  });

  it('a transaction the wallet sent by itself is known by its id: landed, or nothing can be said', async () => {
    for (const chain of ['solana', 'robinhood'] as const) {
      const fate = (a: Answers) =>
        readOf(a).fateOf({ chain, owner: e.OWNER, proof: { txId: 'an id' } });
      expect(await fate({ has: true }), chain).toBe('landed');
      expect(await fate({ has: false, valid: false, next: 10 ** 6 }), chain).toBe('unknown');
    }
  });

  it('says nothing for a chain it was given no read of', async () => {
    const signedTx = signedBy((await built()).payload);
    expect(
      await chainReadOf({}).fateOf({ chain: 'solana', owner: s.OWNER, proof: { signedTx } }),
    ).toBe('unknown');
    expect(
      await chainReadOf({}).fateOf({ chain: 'base', owner: e.OWNER, proof: { txId: 'x' } }),
    ).toBe('unknown');
  });

  it('throws on signed bytes it cannot read, which the executor takes as not knowing', async () => {
    const read = readOf({ valid: false, has: false, next: 9 });
    await expect(
      read.fateOf({ chain: 'solana', owner: s.OWNER, proof: { signedTx: 'not a transaction' } }),
    ).rejects.toThrow();
    await expect(
      read.fateOf({ chain: 'robinhood', owner: e.OWNER, proof: { signedTx: vectors.delegating } }),
    ).rejects.toThrow();
  });
});

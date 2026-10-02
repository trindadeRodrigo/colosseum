import {
  address,
  appendTransactionMessageInstruction,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  parseSolanaTx,
  sameBytes,
  withSolanaSignature,
} from './bytes';
import { solanaSelfTransferBytes } from './dev/self-transfer';

// The wire reading is ours, so it is checked against @solana/kit, which the wallet provider uses.

const PAYER = address('So11111111111111111111111111111111111111112');
const SECOND = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' as Blockhash;
const SYSTEM = '11111111111111111111111111111111';

const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 1n };
/** SECOND pays PAYER and PAYER pays the fee, so both must sign. */
const transfer = getTransferSolInstruction({
  source: createNoopSigner(SECOND),
  destination: PAYER,
  amount: 5n,
});
const encode = (message: Parameters<typeof compileTransaction>[0]) =>
  new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));

/** The same transaction built by kit, in each of the two formats. */
const KIT = {
  0: encode(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(PAYER, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
      (m) => appendTransactionMessageInstruction(transfer, m),
    ),
  ),
  legacy: encode(
    pipe(
      createTransactionMessage({ version: 'legacy' }),
      (m) => setTransactionMessageFeePayer(PAYER, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
      (m) => appendTransactionMessageInstruction(transfer, m),
    ),
  ),
};

describe('encodings', () => {
  it('base58 goes both ways, leading zeros included', () => {
    expect(base58Encode(new Uint8Array(32))).toBe(SYSTEM);
    expect(base58Decode(SYSTEM)).toEqual(new Uint8Array(32));
    for (const text of [PAYER, SECOND, BLOCKHASH]) {
      expect(base58Decode(text)).toHaveLength(32);
      expect(base58Encode(base58Decode(text))).toBe(text);
    }
    expect(() => base58Decode('0OIl')).toThrow('not base58');
  });

  it('base64 goes both ways and refuses what is not base64', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    expect(() => base64Decode('not base64 !')).toThrow('not base64');
    expect(() => base64Decode('abc')).toThrow('not base64');
  });
});

describe('parseSolanaTx', () => {
  for (const version of [0, 'legacy'] as const) {
    it(`reads the signers, the fee payer and the message of a ${version} transaction as kit does`, () => {
      const bytes = KIT[version];
      const wire = parseSolanaTx(bytes);
      const decoded = getTransactionDecoder().decode(bytes);
      expect(wire.signers).toEqual(Object.keys(decoded.signatures));
      expect(wire.signers).toEqual([PAYER, SECOND]);
      expect(wire.feePayer).toBe(PAYER);
      expect(sameBytes(wire.message, new Uint8Array(decoded.messageBytes))).toBe(true);
      expect(wire.signatures).toHaveLength(2);
    });
  }

  it('refuses bytes that are not a transaction', () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(10), Uint8Array.from([1, 2, 3])])
      expect(() => parseSolanaTx(bytes)).toThrow('not a Solana transaction');
    // A signature count that does not match the message header.
    const bytes = KIT[0];
    expect(() => parseSolanaTx(Uint8Array.from([1, ...bytes.slice(1 + 64)]))).toThrow();
  });

  it('writes a signature into one slot and touches nothing else', () => {
    const bytes = KIT[0];
    const signature = new Uint8Array(64).fill(7);
    const out = withSolanaSignature(bytes, 1, signature);
    const wire = parseSolanaTx(out);
    expect(wire.signatures[0]).toEqual(new Uint8Array(64));
    expect(wire.signatures[1]).toEqual(signature);
    expect(sameBytes(wire.message, parseSolanaTx(bytes).message)).toBe(true);
    expect(parseSolanaTx(bytes).signatures[1]).toEqual(new Uint8Array(64));
    expect(() => withSolanaSignature(bytes, 2, signature)).toThrow();
    expect(() => withSolanaSignature(bytes, 0, new Uint8Array(63))).toThrow();
  });
});

describe("the dev page's Solana self-transfer", () => {
  it('is a v0 System Program transfer from the owner to the owner, as kit reads it', () => {
    const { transaction, message } = solanaSelfTransferBytes(PAYER, BLOCKHASH, 1n);
    const decoded = getTransactionDecoder().decode(transaction);
    expect(Object.keys(decoded.signatures)).toEqual([PAYER]);
    expect(sameBytes(new Uint8Array(decoded.messageBytes), message)).toBe(true);

    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    expect(compiled.version).toBe(0);
    expect(compiled.header).toEqual({
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: 1,
    });
    expect(compiled.staticAccounts).toEqual([PAYER, SYSTEM]);
    expect(compiled.lifetimeToken).toBe(BLOCKHASH);
    expect(compiled.instructions).toHaveLength(1);
    const [instruction] = compiled.instructions;
    expect(instruction?.programAddressIndex).toBe(1);
    expect(instruction?.accountIndices).toEqual([0, 0]);
    // Transfer is instruction 2 of the System Program, then the amount as a 64-bit number.
    expect(Array.from(instruction?.data ?? [])).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);

    // The same bytes kit builds for the same transfer.
    const kitBytes = encode(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(PAYER, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(LIFETIME, m),
        (m) =>
          appendTransactionMessageInstruction(
            getTransferSolInstruction({
              source: createNoopSigner(PAYER),
              destination: PAYER,
              amount: 1n,
            }),
            m,
          ),
      ),
    );
    expect(sameBytes(kitBytes, transaction)).toBe(true);
  });
});

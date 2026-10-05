import { createHash, randomBytes } from 'node:crypto';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import vectors from '../test/fixtures/evm-vectors.json';
import { base58Encode, hexDecode, hexEncode, utf8Encode } from './bytes';
import { programAddress } from './guard/solana/addresses';
import { keccak256, onEd25519Curve, sha256 } from './hash';

// The guard's own hashing, held to other implementations: Node's SHA-256, viem's Keccak-256 (recorded
// in the fixture by scripts/gen-evm-vectors.mjs) and @solana/kit's derived addresses.

describe('sha256', () => {
  it("is Node's on random input of every length up to three blocks, and on a long one", () => {
    for (let length = 0; length <= 200; length += 1) {
      const input = randomBytes(length);
      expect(hexEncode(sha256(input))).toBe(createHash('sha256').update(input).digest('hex'));
    }
    const long = randomBytes(100_000);
    expect(hexEncode(sha256(long))).toBe(createHash('sha256').update(long).digest('hex'));
  });
});

describe('keccak256', () => {
  it('gives the known hashes of nothing and of "abc"', () => {
    expect(hexEncode(keccak256(new Uint8Array()))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(hexEncode(keccak256(utf8Encode('abc')))).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });

  it("is viem's on input around every block boundary", () => {
    expect(vectors.keccak.length).toBeGreaterThan(10);
    for (const { input, hash } of vectors.keccak)
      expect(`0x${hexEncode(keccak256(hexDecode(input)))}`, `${(input.length - 2) / 2} bytes`).toBe(
        hash,
      );
  });
});

describe('derived addresses', () => {
  const encoder = getAddressEncoder();

  it('are the ones @solana/kit derives, for random programs and seeds', {
    timeout: 60_000,
  }, async () => {
    for (let i = 0; i < 200; i += 1) {
      const program = base58Encode(randomBytes(32));
      const seeds = Array.from({ length: 1 + (i % 4) }, () => randomBytes(1 + (i % 32)));
      const [expected] = await getProgramDerivedAddress({
        programAddress: program as Parameters<typeof getProgramDerivedAddress>[0]['programAddress'],
        seeds,
      });
      expect(programAddress(seeds, program)).toBe(expected);
    }
  });

  it('are off the curve, and a real key is on it', () => {
    const pda = programAddress([utf8Encode('config')], base58Encode(randomBytes(32)));
    expect(
      onEd25519Curve(new Uint8Array(encoder.encode(pda as Parameters<typeof encoder.encode>[0]))),
    ).toBe(false);
    // The Ed25519 base point, and the point (0, 1).
    const base = hexDecode('0x5866666666666666666666666666666666666666666666666666666666666666');
    expect(onEd25519Curve(base)).toBe(true);
    const one = new Uint8Array(32);
    one[0] = 1;
    expect(onEd25519Curve(one)).toBe(true);
    // y = 2 is on no point of the curve.
    const two = new Uint8Array(32);
    two[0] = 2;
    expect(onEd25519Curve(two)).toBe(false);
    expect(() => onEd25519Curve(new Uint8Array(31))).toThrow();
  });
});

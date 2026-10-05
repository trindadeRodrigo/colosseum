import { describe, expect, it } from 'vitest';
import vectors from '../../../test/fixtures/evm-vectors.json';
import { hexDecode, hexEncode } from '../../bytes';
import { EVM_INTERFACE } from '../generated/evm-interface';
import { type AbiValue, decodeArgs, encodeArgs, parseSignature } from './abi';
import { evmVaultAddress } from './addresses';
import { GUARDED_EVM_FUNCTIONS } from './check';

// The ABI codec and the vault address rule, held to viem: the fixture is what viem 2.56.0 encodes and
// derives for the same values (scripts/gen-evm-vectors.mjs writes it).

type Json = string | boolean | { u: string } | { b: string } | Json[];
const value = (v: Json): AbiValue =>
  Array.isArray(v)
    ? v.map(value)
    : typeof v === 'object'
      ? 'u' in v
        ? BigInt(v.u)
        : hexDecode(v.b)
      : v;

describe('the ABI codec', () => {
  it('encodes every recorded call as viem does, and reads it back', () => {
    expect(vectors.calls.length).toBeGreaterThan(15);
    for (const call of vectors.calls) {
      const { inputs } = parseSignature(call.signature);
      const values = (call.args as Json[]).map(value);
      expect(`0x${hexEncode(encodeArgs(inputs, values))}`, call.signature).toBe(call.data);
      expect(decodeArgs(inputs, hexDecode(call.data)), call.signature).toEqual(values);
    }
  });

  it('refuses call data that is not the one canonical encoding', () => {
    const types = parseSignature('approve(address,uint256)').inputs;
    const good = hexDecode(vectors.calls[0]?.data ?? '0x');
    expect(() => decodeArgs(types, good)).not.toThrow();
    // A byte after the last argument.
    expect(() => decodeArgs(types, Uint8Array.from([...good, 0]))).toThrow(/canonical/);
    // Cut short.
    expect(() => decodeArgs(types, good.slice(0, 63))).toThrow(/ends early/);
    // Bits set above the address.
    const dirty = Uint8Array.from(good);
    dirty[0] = 1;
    expect(() => decodeArgs(types, dirty)).toThrow(/address/);

    const swaps = vectors.calls.find((c) => c.signature.startsWith('ownerSwap'));
    const swapTypes = parseSignature(swaps?.signature ?? '').inputs;
    const data = hexDecode(swaps?.data ?? '0x');
    // The offset of the list moved one word on, and a word put in the gap.
    const moved = Uint8Array.from([...data.slice(0, 32), ...new Uint8Array(32), ...data.slice(32)]);
    moved[31] = 0x40;
    expect(() => decodeArgs(swapTypes, moved)).toThrow(/canonical/);
    // An offset that points past the end.
    const far = Uint8Array.from(data);
    far[30] = 0xff;
    expect(() => decodeArgs(swapTypes, far)).toThrow(/runs past/);
    // A flag that is 2.
    const flag = parseSignature('setAutoFollow(bool)').inputs;
    const two = new Uint8Array(32);
    two[31] = 2;
    expect(() => decodeArgs(flag, two)).toThrow(/flag/);
    // A uint16 with a 17th bit.
    const weights = parseSignature('setTargets((address,uint16)[])').inputs;
    const one = vectors.calls.find(
      (c) => c.signature.startsWith('setTargets') && (c.args[0] as Json[]).length === 1,
    );
    const wide = Uint8Array.from(hexDecode(one?.data ?? '0x'));
    wide[wide.length - 3] = 1;
    expect(() => decodeArgs(weights, wide)).toThrow(/uint16/);
  });

  it('refuses a type it does not read', () => {
    expect(() => parseSignature('f(int256)')).toThrow();
    expect(() => parseSignature('f(uint7)')).toThrow();
    expect(() => parseSignature('f(bytes33)')).toThrow();
    expect(() => parseSignature('f(string)')).toThrow();
    expect(() => parseSignature('nothing')).toThrow();
  });
});

describe('the generated selectors', () => {
  it("are viem's, for every function the fixture has", () => {
    // The fixture is written from the table as it stood; a function added to an ABI since is not in it
    // until scripts/gen-evm-vectors.mjs runs again. What the guard calls has to be.
    const table = new Map(Object.values(EVM_INTERFACE).flatMap((fns) => Object.entries(fns)));
    let held = 0;
    for (const { signature, selector } of vectors.selectors) {
      if (!table.has(signature)) continue;
      held += 1;
      expect(table.get(signature), signature).toBe(selector);
    }
    expect(held).toBeGreaterThan(100);
    for (const [contract, signature] of GUARDED_EVM_FUNCTIONS)
      if (EVM_INTERFACE[contract]?.[signature])
        expect(
          vectors.selectors.some((v) => v.signature === signature),
          signature,
        ).toBe(true);
  });
});

describe("a vault's address", () => {
  it("is the one viem derives from the factory, the beacon, the owner and the plan's number", () => {
    expect(vectors.vaults.length).toBeGreaterThan(3);
    for (const v of vectors.vaults) expect(evmVaultAddress(v, v.owner, v.basketId)).toBe(v.vault);
  });

  it('changes with the owner and with the plan', () => {
    const v = vectors.vaults[0];
    if (!v) throw new Error('no vector');
    const other = vectors.vaults[1]?.owner ?? '';
    expect(evmVaultAddress(v, other, v.basketId)).not.toBe(v.vault);
    expect(evmVaultAddress(v, v.owner, '2')).not.toBe(v.vault);
  });
});

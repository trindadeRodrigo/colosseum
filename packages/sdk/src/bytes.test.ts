import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addressBytes,
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  hexDecode,
  hexEncode,
  utf8Decode,
} from './bytes';

describe('encodings take one spelling of a value', () => {
  it('base64 round-trips, and refuses what another decoder could read differently', () => {
    for (let length = 0; length < 70; length += 1) {
      const bytes = randomBytes(length);
      const text = Buffer.from(bytes).toString('base64');
      expect(base64Encode(bytes)).toBe(text);
      expect([...base64Decode(text)]).toEqual([...bytes]);
    }
    // "QQ==" is the byte 0x41. "QR==" decodes to the same byte with spare bits set.
    expect([...base64Decode('QQ==')]).toEqual([0x41]);
    for (const bad of ['QR==', 'QQ=', 'QQ', 'Q Q=', 'QQ==\n', 'QQ-_', '=QQ=', 'QUJD='])
      expect(() => base64Decode(bad), bad).toThrow();
  });

  it('hex takes whole bytes behind 0x', () => {
    expect([...hexDecode('0x00ffAb')]).toEqual([0, 255, 171]);
    expect(hexEncode(hexDecode('0x00ffAb'))).toBe('00ffab');
    expect([...hexDecode('0x')]).toEqual([]);
    for (const bad of ['00ff', '0x0', '0xzz', '0X00', ' 0x00'])
      expect(() => hexDecode(bad)).toThrow();
  });

  it('base58 keeps leading zeros, and an address is exactly 32 bytes', () => {
    for (let i = 0; i < 50; i += 1) {
      const bytes = randomBytes(32);
      if (i % 5 === 0) bytes[0] = 0;
      expect([...base58Decode(base58Encode(bytes))]).toEqual([...bytes]);
    }
    expect(base58Encode(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(addressBytes('11111111111111111111111111111111')).toHaveLength(32);
    expect(() => addressBytes('1111111111111111111111111111111')).toThrow();
    expect(() => addressBytes('0OIl')).toThrow();
  });

  it('text is UTF-8 or it is refused', () => {
    expect(utf8Decode(Uint8Array.of(0x7b, 0x7d))).toBe('{}');
    expect(() => utf8Decode(Uint8Array.of(0xff, 0xfe))).toThrow();
  });
});

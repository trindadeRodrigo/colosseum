// Encodings. Each decoder takes one spelling of a value and refuses every other, so the bytes the guard
// checks are the bytes any other decoder reads from the same text.

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new Error('not base58');
    n = n * 58n + BigInt(digit);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...out]);
}

/** A Solana address as its 32 bytes. Throws on anything else. */
export function addressBytes(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 32 || base58Encode(bytes) !== address)
    throw new Error('not a base58 address of 32 bytes');
  return bytes;
}

/** Standard base64 with padding, and only its one canonical spelling. */
export function base64Decode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error('not base64');
  const raw = atob(text);
  // Two spellings can decode to the same bytes when the last character carries spare bits.
  if (btoa(raw) !== text) throw new Error('not canonical base64');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

/** `0x` and whole bytes of hex, in either case. */
export function hexDecode(hex: string): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('not whole bytes of 0x hex');
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Lower-case hex with no prefix. */
export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export const utf8Encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Throws on bytes that are not UTF-8. */
export const utf8Decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

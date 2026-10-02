// Encodings and the little of Solana's wire format a wallet seam needs: which keys must sign, who pays
// the fee, and where a signature goes. Nothing here builds or changes a message.

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

export function base64Decode(text: string): Uint8Array {
  // atob takes anything; a transaction is refused unless it is base64 and nothing else.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error('not base64');
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `0x${out}`;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Solana's compact-u16: 1 to 3 bytes, 7 bits each, low bits first. */
function readShortVec(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const b = bytes[at + i];
    if (b === undefined) break;
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) return { value, next: at + i + 1 };
  }
  throw new Error('not a Solana transaction');
}

export type SolanaWire = {
  /** One 64-byte slot per required signer, in the message's order. Zeros until signed. */
  signatures: Uint8Array[];
  /** The exact bytes a signer signs. */
  message: Uint8Array;
  /** The keys that must sign, base58. The first one pays the fee. */
  signers: string[];
  feePayer: string;
};

/** Reads a serialized transaction (legacy or v0) without changing a byte of it. */
export function parseSolanaTx(bytes: Uint8Array): SolanaWire {
  const count = readShortVec(bytes, 0);
  const messageStart = count.next + count.value * 64;
  if (count.value === 0 || messageStart >= bytes.length)
    throw new Error('not a Solana transaction');
  const signatures = Array.from({ length: count.value }, (_, i) =>
    bytes.slice(count.next + i * 64, count.next + (i + 1) * 64),
  );
  const message = bytes.slice(messageStart);
  // A versioned message starts with a byte whose high bit is set; a legacy one starts with its header.
  const header = (message[0] ?? 0) & 0x80 ? 1 : 0;
  const required = message[header];
  const keys = readShortVec(message, header + 3);
  if (required === undefined || required !== count.value || required > keys.value)
    throw new Error('not a Solana transaction');
  if (keys.next + required * 32 > message.length) throw new Error('not a Solana transaction');
  const signers = Array.from({ length: required }, (_, i) =>
    base58Encode(message.slice(keys.next + i * 32, keys.next + (i + 1) * 32)),
  );
  const feePayer = signers[0];
  if (!feePayer) throw new Error('not a Solana transaction');
  return { signatures, message, signers, feePayer };
}

/** A copy of the transaction with one signature written into its slot. The message is not touched. */
export function withSolanaSignature(
  bytes: Uint8Array,
  signerIndex: number,
  signature: Uint8Array,
): Uint8Array {
  const count = readShortVec(bytes, 0);
  if (signature.length !== 64 || signerIndex < 0 || signerIndex >= count.value)
    throw new Error('no slot for that signature');
  const out = bytes.slice();
  out.set(signature, count.next + signerIndex * 64);
  return out;
}

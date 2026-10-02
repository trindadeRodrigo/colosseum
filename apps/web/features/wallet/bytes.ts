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

const NOT_A_TRANSACTION = 'not a Solana transaction';

/** Reads forward through bytes, and refuses to read past their end. */
function reader(bytes: Uint8Array) {
  let at = 0;
  const take = (n: number): Uint8Array => {
    if (at + n > bytes.length) throw new Error(NOT_A_TRANSACTION);
    at += n;
    return bytes.slice(at - n, at);
  };
  const u8 = (): number => take(1)[0] as number;
  /** Solana's compact-u16: 1 to 3 bytes, 7 bits each, low bits first. */
  const shortVec = (): number => {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      const b = u8();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) return value;
    }
    throw new Error(NOT_A_TRANSACTION);
  };
  return { take, u8, shortVec, at: () => at, done: () => at === bytes.length };
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

/**
 * Reads a serialized transaction, legacy or version 0, without changing a byte of it. The whole message
 * is walked, so bytes that are not a transaction from the first to the last are refused.
 */
export function parseSolanaTx(bytes: Uint8Array): SolanaWire {
  const outer = reader(bytes);
  const slots = outer.shortVec();
  if (slots === 0) throw new Error(NOT_A_TRANSACTION);
  const signatures = Array.from({ length: slots }, () => outer.take(64));
  const message = bytes.slice(outer.at());

  const m = reader(message);
  // A versioned message starts with a byte whose high bit is set, then the version: only 0 exists.
  // A legacy message starts with its header, whose first byte is a small count.
  const versioned = ((message[0] ?? 0) & 0x80) !== 0;
  if (versioned && m.u8() !== 0x80) throw new Error(NOT_A_TRANSACTION);
  const required = m.u8();
  m.take(2); // how many of the signers, and of the others, are read-only
  const accounts = m.shortVec();
  if (required !== slots || required > accounts) throw new Error(NOT_A_TRANSACTION);
  const keys = Array.from({ length: accounts }, () => m.take(32));
  m.take(32); // the recent blockhash
  for (let i = m.shortVec(); i > 0; i -= 1) {
    m.u8(); // the program, as an index into the accounts
    m.take(m.shortVec()); // its accounts, as indexes
    m.take(m.shortVec()); // its data
  }
  if (versioned)
    for (let i = m.shortVec(); i > 0; i -= 1) {
      m.take(32); // an address lookup table
      m.take(m.shortVec()); // the writable indexes read from it
      m.take(m.shortVec()); // the read-only ones
    }
  if (!m.done()) throw new Error(NOT_A_TRANSACTION);

  const signers = keys.slice(0, required).map(base58Encode);
  return { signatures, message, signers, feePayer: signers[0] as string };
}

/** True when every byte is zero: a signature slot nobody has signed. */
export function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

/**
 * Is `signature` the signature of `message` by the Ed25519 key `publicKey`? Throws a DOMException named
 * NotSupportedError in a browser that has no Ed25519.
 */
export async function ed25519Valid(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', publicKey as BufferSource, 'Ed25519', false, [
    'verify',
  ]);
  return crypto.subtle.verify('Ed25519', key, signature as BufferSource, message as BufferSource);
}

/** A copy of the transaction with one signature written into its slot. The message is not touched. */
export function withSolanaSignature(
  bytes: Uint8Array,
  signerIndex: number,
  signature: Uint8Array,
): Uint8Array {
  const start = reader(bytes);
  const slots = start.shortVec();
  if (signature.length !== 64 || signerIndex < 0 || signerIndex >= slots)
    throw new Error('no slot for that signature');
  const out = bytes.slice();
  out.set(signature, start.at() + signerIndex * 64);
  return out;
}

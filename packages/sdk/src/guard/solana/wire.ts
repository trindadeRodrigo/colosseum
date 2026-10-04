import { base58Encode } from '../../bytes';

// A Solana transaction as it travels: the signatures, then the message. This reads the whole of it and
// refuses anything it cannot account for byte by byte: a count written the long way, a trailing byte,
// an index that points nowhere.

export type WireInstruction = {
  /** Index of the program in `keys`. */
  program: number;
  /** Indexes into the account list: `keys` first, then what the lookup tables load. */
  accounts: number[];
  data: Uint8Array;
};

export type WireTransaction = {
  /** One 64-byte slot per required signature. */
  signatures: Uint8Array[];
  /** The bytes that are signed: everything after the signatures. */
  message: Uint8Array;
  version: 'legacy' | 0;
  /** How many of the first `keys` must sign. The first of them pays the fee. */
  signers: number;
  /** The accounts the message names itself, in order, as base58. */
  keys: string[];
  instructions: WireInstruction[];
  /** How many accounts the message loads from lookup tables. Their addresses are not in the bytes. */
  loaded: number;
};

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get offset(): number {
    return this.at;
  }
  get done(): boolean {
    return this.at === this.bytes.length;
  }
  byte(): number {
    const b = this.bytes[this.at];
    if (b === undefined) throw new Error('the transaction ends early');
    this.at += 1;
    return b;
  }
  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new Error('the transaction ends early');
    const out = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }
  /** Solana's compact length: one to three bytes, seven bits each, and only its shortest spelling. */
  compact(): number {
    let value = 0;
    for (let i = 0; i < 3; i += 1) {
      const b = this.byte();
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        if (i > 0 && b === 0) throw new Error('a length is written the long way');
        if (value > 0xffff) throw new Error('a length is out of range');
        return value;
      }
    }
    throw new Error('a length runs past three bytes');
  }
  indexes(): number[] {
    return [...this.take(this.compact())];
  }
}

/** Throws when the bytes are not exactly one legacy or version 0 transaction. */
export function parseSolanaTransaction(bytes: Uint8Array): WireTransaction {
  const r = new Reader(bytes);
  const count = r.compact();
  const signatures = Array.from({ length: count }, () => r.take(64));
  const message = bytes.slice(r.offset);

  let first = r.byte();
  let version: WireTransaction['version'] = 'legacy';
  if (first & 0x80) {
    if ((first & 0x7f) !== 0) throw new Error('a transaction version this guard does not read');
    version = 0;
    first = r.byte();
  }
  const signers = first;
  r.byte(); // how many signers are read-only
  r.byte(); // how many of the rest are read-only
  const keys = Array.from({ length: r.compact() }, () => base58Encode(r.take(32)));
  r.take(32); // the recent blockhash
  const instructions = Array.from({ length: r.compact() }, () => ({
    program: r.byte(),
    accounts: r.indexes(),
    data: r.take(r.compact()),
  }));
  let loaded = 0;
  if (version === 0)
    for (let n = r.compact(); n > 0; n -= 1) {
      r.take(32); // the table's address
      loaded += r.indexes().length + r.indexes().length;
    }
  if (!r.done) throw new Error('bytes are left over after the transaction');

  if (signers !== signatures.length)
    throw new Error('the signature slots are not the signers the message asks for');
  if (signers > keys.length) throw new Error('more signers than accounts');
  if (new Set(keys).size !== keys.length) throw new Error('an account is listed twice');
  for (const ix of instructions) {
    // A program is always one of the message's own accounts, never one a table loads.
    if (ix.program >= keys.length)
      throw new Error('an instruction names a program that is not there');
    if (ix.accounts.some((i) => i >= keys.length + loaded))
      throw new Error('an instruction names an account that is not there');
  }
  return { signatures, message, version, signers, keys, instructions, loaded };
}

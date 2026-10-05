import { base58Encode } from '../../bytes';
import type { IdlField, IdlType, ProgramTable } from './table';

// An instruction's arguments, read by the types the interface file gives them. Every byte has to be
// accounted for: a flag that is neither 0 nor 1, a length past the end and a byte left over are refused.

/** A decoded value: a number for the small integers, a bigint for 64 bits, base58 for an address. */
export type Value =
  | number
  | bigint
  | boolean
  | string
  | Uint8Array
  | null
  | Value[]
  | { [field: string]: Value };

class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new Error('the arguments end early');
    const out = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return out;
  }
  /** Little-endian, as Borsh writes every integer. */
  uint(bytes: number): bigint {
    let v = 0n;
    for (const b of [...this.take(bytes)].reverse()) v = (v << 8n) | BigInt(b);
    return v;
  }
  flag(): boolean {
    const b = this.uint(1);
    if (b > 1n) throw new Error('a flag is neither 0 nor 1');
    return b === 1n;
  }
  /** A length. Each item takes at least one byte, so a length past the end is refused before any loop. */
  length(): number {
    const n = Number(this.uint(4));
    if (n > this.bytes.length - this.at) throw new Error('a length runs past the end');
    return n;
  }
}

function read(type: IdlType, c: Cursor, types: ProgramTable['types']): Value {
  if (typeof type === 'string')
    switch (type) {
      case 'bool':
        return c.flag();
      case 'u8':
        return Number(c.uint(1));
      case 'u16':
        return Number(c.uint(2));
      case 'u32':
        return Number(c.uint(4));
      case 'u64':
        return c.uint(8);
      case 'i64':
        return BigInt.asIntN(64, c.uint(8));
      case 'pubkey':
        return base58Encode(c.take(32));
      case 'bytes':
        return c.take(c.length());
    }
  if ('vec' in type) return Array.from({ length: c.length() }, () => read(type.vec, c, types));
  if ('option' in type) return c.flag() ? read(type.option, c, types) : null;
  if ('array' in type) {
    const [item, length] = type.array;
    if (item === 'u8') return c.take(length);
    return Array.from({ length }, () => read(item, c, types));
  }
  const fields = types[type.defined];
  if (!fields) throw new Error(`the interface has no type ${type.defined}`);
  return readFields(fields, c, types);
}

function readFields(
  fields: readonly IdlField[],
  c: Cursor,
  types: ProgramTable['types'],
): { [field: string]: Value } {
  const out: { [field: string]: Value } = {};
  for (const f of fields) out[f.name] = read(f.type, c, types);
  return out;
}

/** The arguments after the discriminator, by name. Throws unless they are exactly the fields given. */
export function decodeArgs(
  fields: readonly IdlField[],
  data: Uint8Array,
  types: ProgramTable['types'],
): { [field: string]: Value } {
  const c = new Cursor(data);
  const out = readFields(fields, c, types);
  if (c.at !== data.length) throw new Error('bytes are left over after the arguments');
  return out;
}

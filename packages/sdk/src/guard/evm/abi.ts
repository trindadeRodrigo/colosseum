import { concatBytes, hexEncode, sameBytes } from '../../bytes';

// The contract ABI for the few types our interfaces use. A call is read only if it is the one canonical
// encoding of its values: `decodeCall` decodes, encodes what it read again and compares, so two
// spellings of one call, an offset that points somewhere odd and a byte left over are all refused, and
// what the guard reads is what the contract reads.

export type AbiType =
  | { kind: 'uint'; bits: number }
  | { kind: 'address' }
  | { kind: 'bool' }
  | { kind: 'fixed'; size: number }
  | { kind: 'bytes' }
  | { kind: 'tuple'; items: AbiType[] }
  | { kind: 'array'; item: AbiType };

/** uint: bigint. address and bytesN: lower-case 0x hex. bool: boolean. bytes: the bytes. tuple, array: a list. */
export type AbiValue = bigint | string | boolean | Uint8Array | AbiValue[];

const WORD = 32;

/** The types between the outer brackets of `name(type,type)`, split at the commas that are not nested. */
function splitTypes(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    if (list[i] === ')') depth -= 1;
    if (list[i] === ',' && depth === 0) {
      out.push(list.slice(from, i));
      from = i + 1;
    }
  }
  if (list.length) out.push(list.slice(from));
  return out;
}

export function parseType(text: string): AbiType {
  if (text.endsWith('[]')) return { kind: 'array', item: parseType(text.slice(0, -2)) };
  if (text.startsWith('(') && text.endsWith(')'))
    return { kind: 'tuple', items: splitTypes(text.slice(1, -1)).map(parseType) };
  if (text === 'address') return { kind: 'address' };
  if (text === 'bool') return { kind: 'bool' };
  if (text === 'bytes') return { kind: 'bytes' };
  const uint = /^uint(\d+)$/.exec(text);
  if (uint) {
    const bits = Number(uint[1]);
    if (bits >= 8 && bits <= 256 && bits % 8 === 0) return { kind: 'uint', bits };
  }
  const fixed = /^bytes(\d+)$/.exec(text);
  if (fixed) {
    const size = Number(fixed[1]);
    if (size >= 1 && size <= 32) return { kind: 'fixed', size };
  }
  throw new Error(`the guard does not read the type ${text}`);
}

/** `deposit(uint256)` as its name and the types of its arguments. */
export function parseSignature(signature: string): { name: string; inputs: AbiType[] } {
  const open = signature.indexOf('(');
  if (open < 1 || !signature.endsWith(')')) throw new Error(`not a signature: ${signature}`);
  return {
    name: signature.slice(0, open),
    inputs: splitTypes(signature.slice(open + 1, -1)).map(parseType),
  };
}

const dynamic = (t: AbiType): boolean =>
  t.kind === 'bytes' || t.kind === 'array' || (t.kind === 'tuple' && t.items.some(dynamic));
/** How many bytes a value takes where it is listed: one word for a dynamic one, which is an offset. */
const headSize = (t: AbiType): number =>
  dynamic(t) ? WORD : t.kind === 'tuple' ? t.items.reduce((n, i) => n + headSize(i), 0) : WORD;

function wordAt(data: Uint8Array, at: number): bigint {
  if (at < 0 || at + WORD > data.length) throw new Error('the call data ends early');
  let v = 0n;
  for (let i = 0; i < WORD; i += 1) v = (v << 8n) | BigInt(data[at + i] as number);
  return v;
}

/** A length or an offset: a word that is small enough to be a place in this data. */
function sizeAt(data: Uint8Array, at: number): number {
  const v = wordAt(data, at);
  if (v > BigInt(data.length)) throw new Error('a length or an offset runs past the call data');
  return Number(v);
}

function decodeAt(t: AbiType, data: Uint8Array, at: number): AbiValue {
  switch (t.kind) {
    case 'uint': {
      const v = wordAt(data, at);
      if (v >> BigInt(t.bits) !== 0n) throw new Error(`a uint${t.bits} is out of range`);
      return v;
    }
    case 'address': {
      const v = wordAt(data, at);
      if (v >> 160n !== 0n) throw new Error('an address has bits set above it');
      return `0x${v.toString(16).padStart(40, '0')}`;
    }
    case 'bool': {
      const v = wordAt(data, at);
      if (v > 1n) throw new Error('a flag is neither 0 nor 1');
      return v === 1n;
    }
    case 'fixed': {
      wordAt(data, at);
      const word = data.slice(at, at + WORD);
      if (word.slice(t.size).some((b) => b !== 0)) throw new Error('fixed bytes are not padded');
      return `0x${hexEncode(word.slice(0, t.size))}`;
    }
    case 'bytes': {
      const length = sizeAt(data, at);
      if (at + WORD + length > data.length) throw new Error('bytes run past the call data');
      return data.slice(at + WORD, at + WORD + length);
    }
    case 'array': {
      const length = sizeAt(data, at);
      return decodeTuple(new Array<AbiType>(length).fill(t.item), data, at + WORD);
    }
    case 'tuple':
      return decodeTuple(t.items, data, at);
  }
}

function decodeTuple(types: AbiType[], data: Uint8Array, base: number): AbiValue[] {
  const out: AbiValue[] = [];
  let head = base;
  for (const t of types) {
    out.push(decodeAt(t, data, dynamic(t) ? base + sizeAt(data, head) : head));
    head += headSize(t);
  }
  return out;
}

function word(v: bigint): Uint8Array {
  const out = new Uint8Array(WORD);
  let n = v;
  for (let i = WORD - 1; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function padded(bytes: Uint8Array, left: boolean): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
  out.set(bytes, left ? out.length - bytes.length : 0);
  return out;
}

function hexBytes(v: AbiValue): Uint8Array {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(v)) throw new Error('expected 0x hex');
  return Uint8Array.from(v.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

function encodeOne(t: AbiType, v: AbiValue): Uint8Array {
  switch (t.kind) {
    case 'uint':
      if (typeof v !== 'bigint' || v < 0n || v >> BigInt(t.bits) !== 0n)
        throw new Error(`not a uint${t.bits}`);
      return word(v);
    case 'address': {
      const bytes = hexBytes(v);
      if (bytes.length !== 20) throw new Error('not an address');
      return padded(bytes, true);
    }
    case 'bool':
      if (typeof v !== 'boolean') throw new Error('not a flag');
      return word(v ? 1n : 0n);
    case 'fixed': {
      const bytes = hexBytes(v);
      if (bytes.length !== t.size) throw new Error(`not bytes${t.size}`);
      return padded(bytes, false);
    }
    case 'bytes':
      if (!(v instanceof Uint8Array)) throw new Error('not bytes');
      return concatBytes(word(BigInt(v.length)), padded(v, false));
    case 'array':
      if (!Array.isArray(v)) throw new Error('not a list');
      return concatBytes(
        word(BigInt(v.length)),
        encodeTuple(new Array<AbiType>(v.length).fill(t.item), v),
      );
    case 'tuple':
      if (!Array.isArray(v)) throw new Error('not a tuple');
      return encodeTuple(t.items, v);
  }
}

function encodeTuple(types: AbiType[], values: AbiValue[]): Uint8Array {
  if (types.length !== values.length) throw new Error('a tuple has another number of values');
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailAt = types.reduce((n, t) => n + headSize(t), 0);
  types.forEach((t, i) => {
    const encoded = encodeOne(t, values[i] as AbiValue);
    if (!dynamic(t)) {
      heads.push(encoded);
      return;
    }
    heads.push(word(BigInt(tailAt)));
    tails.push(encoded);
    tailAt += encoded.length;
  });
  return concatBytes(...heads, ...tails);
}

/** The arguments of a call as their one canonical encoding, without the selector. */
export const encodeArgs = (types: AbiType[], values: AbiValue[]): Uint8Array =>
  encodeTuple(types, values);

/**
 * The arguments of a call. Throws unless `data` is exactly the canonical encoding of what it decodes
 * to: every value in range, every offset where the encoder would put it, nothing after the last byte.
 */
export function decodeArgs(types: AbiType[], data: Uint8Array): AbiValue[] {
  const values = decodeTuple(types, data, 0);
  if (!sameBytes(encodeTuple(types, values), data))
    throw new Error('the call data is not the canonical encoding of its values');
  return values;
}

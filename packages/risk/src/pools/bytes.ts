import { getAddressDecoder } from '@solana/kit';

const addr = getAddressDecoder();

/** Little-endian readers over raw account bytes. All layouts are checked against live accounts in tests. */
export class Reader {
  private readonly v: DataView;
  constructor(readonly b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8 = (o: number) => this.v.getUint8(o);
  u16 = (o: number) => this.v.getUint16(o, true);
  u32 = (o: number) => this.v.getUint32(o, true);
  i32 = (o: number) => this.v.getInt32(o, true);
  u64 = (o: number) => this.v.getBigUint64(o, true);
  i64 = (o: number) => this.v.getBigInt64(o, true);
  u128 = (o: number) => this.v.getBigUint64(o, true) + (this.v.getBigUint64(o + 8, true) << 64n);
  i128 = (o: number) => {
    const u = this.u128(o);
    return u >= 1n << 127n ? u - (1n << 128n) : u;
  };
  pubkey = (o: number): string => addr.decode(this.b.subarray(o, o + 32));
  disc = () => Array.from(this.b.subarray(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');
}

export const Q64 = 2 ** 64;

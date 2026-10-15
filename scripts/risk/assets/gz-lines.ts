import { gunzipSync } from 'node:zlib';

/**
 * The non-empty lines of a gzip file (members appended one after another, one per piece a fetch wrote), each
 * decoded on its own over the unpacked bytes. A busy day unpacks past V8's longest string (~512 MB), so a day is
 * never made one string (found 2026-10-14: "Cannot create a string longer than 0x1fffffe8 characters").
 */
export function* gzLines(gz: Buffer): Generator<string> {
  const b = gunzipSync(gz);
  for (let s = 0; s < b.length; ) {
    let e = b.indexOf(0x0a, s);
    if (e < 0) e = b.length;
    if (e > s) yield b.toString('utf8', s, e);
    s = e + 1;
  }
}

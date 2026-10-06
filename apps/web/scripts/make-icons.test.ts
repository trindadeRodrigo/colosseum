import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BLACK, HINOKI, INK, ico, rgba, SMALL, tabSvg } from './make-icons.mjs';

// The icons are made by scripts/make-icons.mjs and committed; this holds the committed files to what
// the script says it makes, and the two encoders it writes them with.

const WEB = join(__dirname, '..');

/** A 2 × 1 RGB PNG: one red pixel, one blue. */
function rgbPng() {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const head = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const rows = Buffer.from([0, 255, 0, 0, 0, 0, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('the icons', () => {
  it('draws the tab icon as the small cut, in ink on a light tab and hinoki on a dark one', () => {
    const svg = readFileSync(join(WEB, 'app/icon.svg'), 'utf8');
    expect(svg).toBe(tabSvg());
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain(SMALL.shapes);
    expect(svg).toMatch(new RegExp(`fill: ${INK};.*prefers-color-scheme: dark.*fill: ${HINOKI};`));
    // no blue, no violet: the brand's colours and nothing else
    expect(svg.match(/#[0-9A-F]{6}/gi)?.sort()).toEqual([HINOKI, INK].sort());
    expect(BLACK).toBe('#0D0B09');
  });

  it('holds 16, 32 and 48 px in the .ico, each an RGBA PNG', () => {
    const file = readFileSync(join(WEB, 'app/favicon.ico'));
    expect([file.readUInt16LE(0), file.readUInt16LE(2), file.readUInt16LE(4)]).toEqual([0, 1, 3]);
    const entries = [0, 1, 2].map((i) => {
      const [length, offset] = [
        file.readUInt32LE(6 + 16 * i + 8),
        file.readUInt32LE(6 + 16 * i + 12),
      ];
      return { size: file[6 + 16 * i], png: file.subarray(offset, offset + length) };
    });
    expect(entries.map((e) => e.size)).toEqual([16, 32, 48]);
    for (const { size, png } of entries) {
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png[25]).toBe(6);
    }
  });

  it('writes an .ico header that points at each entry', () => {
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbbbb');
    const out = ico([
      { size: 16, png: a },
      { size: 256, png: b },
    ]);
    expect(out.readUInt16LE(4)).toBe(2);
    expect([out[6], out[22]]).toEqual([16, 0]);
    expect(out.subarray(out.readUInt32LE(18), out.readUInt32LE(18) + 4)).toEqual(a);
    expect(out.subarray(out.readUInt32LE(34), out.readUInt32LE(34) + 6)).toEqual(b);
  });

  it('turns an RGB PNG into RGBA, opaque, with the same pixels', async () => {
    const out = rgba(rgbPng());
    expect(out[25]).toBe(6);
    const { inflateSync } = await import('node:zlib');
    const length = out.readUInt32BE(33);
    const rows = inflateSync(out.subarray(41, 41 + length));
    expect([...rows]).toEqual([0, 255, 0, 0, 255, 0, 0, 255, 255]);
    // an RGBA PNG is left as it is
    expect(rgba(out)).toBe(out);
  });

  it('makes the Apple tile 180 px and the manifest’s 192 and 512', () => {
    for (const [file, size] of [
      ['app/apple-icon.png', 180],
      ['public/icon-192.png', 192],
      ['public/icon-512.png', 512],
    ] as const)
      expect(readFileSync(join(WEB, file)).readUInt32BE(16), file).toBe(size);
  });
});

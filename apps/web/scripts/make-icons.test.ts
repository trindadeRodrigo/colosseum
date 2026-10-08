import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HONEY, INK, ico, rgba, SMALL, shapes, tabSvg } from './make-icons.mjs';

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
  it('draws the tab icon as the small cut of the face: honey tile, ink cut, honey pin, in any tab', () => {
    const svg = readFileSync(join(WEB, 'app/icon.svg'), 'utf8');
    expect(svg).toBe(tabSvg());
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain(shapes(SMALL));
    // logo-directions.md, "Cuts by size": the 16 cut
    expect(SMALL).toMatchObject({
      tile: [0, 0, 16, 16, 4],
      cut: [3, 5, 10, 6, 1],
      pin: [9, 6.5, 3, 3, 0.6],
    });
    // the same in a light tab and a dark one: the cut is ink on honey either way
    expect(svg).not.toContain('prefers-color-scheme');
    // honey and ink and nothing else: no white, no blue (the mark has no white)
    expect([...new Set(svg.match(/#[0-9A-F]{6}/gi))].sort()).toEqual([HONEY, INK].sort());
    expect([HONEY, INK]).toEqual(['#F5A83A', '#15161C']);
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

  it('makes the Apple tile 180 px and the manifest’s 192 and 512, honey to the edge', () => {
    for (const [file, size] of [
      ['app/apple-icon.png', 180],
      ['public/icon-192.png', 192],
      ['public/icon-512.png', 512],
    ] as const)
      expect(readFileSync(join(WEB, file)).readUInt32BE(16), file).toBe(size);
    // its corner pixel is honey: the tile is square, and the platform's mask rounds it
    const tile = readFileSync(join(WEB, 'public/icon-192.png'));
    const length = tile.readUInt32BE(33);
    const rows = inflateSync(tile.subarray(41, 41 + length));
    expect(rows[0]).toBe(0); // no filter on the first row
    expect([...rows.subarray(1, 5)]).toEqual([0xf5, 0xa8, 0x3a, 255]);
  });
});

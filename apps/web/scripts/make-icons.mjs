#!/usr/bin/env node
// Writes the app's icons from the mark, "the face" (LOGO-2; logo-directions.md, "Cuts by size" and
// "Colour variants"; the same geometry as components/shell/Mark.tsx). Run it again when the mark
// changes:
//
//   pnpm --filter @colosseum/web exec node scripts/make-icons.mjs
//
// It writes, and the files are committed:
//   app/icon.svg          the small cut (16 grid, for 12–19 px: a tab): the honey tile, the tenon end
//                         cut in ink, the honey pin. The same in a light tab and a dark one, since the
//                         cut is ink on honey either way
//   app/favicon.ico       16, 32 and 48 px for what reads no SVG: the small cut at 16 and the master at
//                         32 and 48 (each cut drawn on its own grid, never one scaled into another's)
//   app/apple-icon.png    180 px: the app tile, honey to the edge (the platform's mask is the only
//                         rounding), the master's cut and pin on it
//   public/icon-192.png, public/icon-512.png   the same tile, for the web app manifest
// The rasters are drawn by Chromium (Playwright, already here for the e2e), so no image library is
// added; the .ico is written by hand (PNG entries, which every browser since 2010 reads).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// color-system.md
export const HONEY = '#F5A83A';
export const INK = '#15161C';

const rect = ([x, y, w, h, r], fill) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;

/** The small cut, on its 16 grid: the tile, the tenon end cut into it, the pin. */
export const SMALL = {
  grid: 16,
  tile: [0, 0, 16, 16, 4],
  cut: [3, 5, 10, 6, 1],
  pin: [9, 6.5, 3, 3, 0.6],
};
/** The master, on its 32 grid. */
export const MASTER = {
  grid: 32,
  tile: [0, 0, 32, 32, 7],
  cut: [7, 10, 18, 12, 2],
  pin: [18, 13.5, 5, 5, 1],
};

/** A cut's drawing on its own grid: the tile (or none, for the app tile), the cut in ink, the pin. */
export function shapes(cut, { tile = true } = {}) {
  return `${tile ? rect(cut.tile, HONEY) : ''}${rect(cut.cut, INK)}${rect(cut.pin, HONEY)}`;
}

/** The tab icon: the small cut, the same in both colour schemes. */
export function tabSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <title>tenonfi</title>
  ${shapes(SMALL)}
</svg>
`;
}

/** The mark at `size` px on a clear ground: the cut drawn on its own grid, edge to edge. */
export function markSvg(cut, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cut.grid} ${cut.grid}" width="${size}" height="${size}">${shapes(cut)}</svg>`;
}

/** The app tile at `size` px: honey to the edge, the master's cut and pin on it (app-tile-1024.svg). */
export function tileSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MASTER.grid} ${MASTER.grid}" width="${size}" height="${size}"><rect width="${MASTER.grid}" height="${MASTER.grid}" fill="${HONEY}"/>${shapes(MASTER, { tile: false })}</svg>`;
}

/**
 * The PNG as 8-bit RGBA. Chromium writes an opaque picture as RGB, and an .ico's PNG entries must be
 * RGBA (Windows, and the image decoder Next builds the favicon with, refuse anything else).
 */
export function rgba(png) {
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    chunks.push({
      type: png.toString('latin1', at + 4, at + 8),
      data: png.subarray(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  const head = chunks.find((c) => c.type === 'IHDR').data;
  const [width, height, depth, kind] = [
    head.readUInt32BE(0),
    head.readUInt32BE(4),
    head[8],
    head[9],
  ];
  if (depth !== 8 || (kind !== 2 && kind !== 6) || head[12] !== 0)
    throw new Error('expected an 8-bit RGB or RGBA PNG, not interlaced');
  if (kind === 6) return png;
  const raw = inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)),
  );
  const [from, to] = [width * 3, width * 4];
  const rows = Buffer.alloc(height * (to + 1));
  let previous = Buffer.alloc(from);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (from + 1)];
    const line = Buffer.from(raw.subarray(y * (from + 1) + 1, (y + 1) * (from + 1)));
    for (let x = 0; x < from; x++) {
      const a = x >= 3 ? line[x - 3] : 0;
      const b = previous[x];
      const c = x >= 3 ? previous[x - 3] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
    for (let x = 0; x < width; x++) {
      line.copy(rows, y * (to + 1) + 1 + x * 4, x * 3, x * 3 + 3);
      rows[y * (to + 1) + 1 + x * 4 + 3] = 255;
    }
    previous = line;
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.from(head);
  ihdr[9] = 6;
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico of PNG entries (ICONDIR, one ICONDIRENTRY each, then the PNGs). */
export function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, at);
    head.writeUInt8(size >= 256 ? 0 : size, at + 1);
    head.writeUInt8(0, at + 2);
    head.writeUInt8(0, at + 3);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const png = async (svg, size) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    return rgba(
      await page.screenshot({
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: true,
      }),
    );
  };
  try {
    writeFileSync(join(WEB, 'app/icon.svg'), tabSvg());
    writeFileSync(
      join(WEB, 'app/favicon.ico'),
      ico([
        { size: 16, png: await png(markSvg(SMALL, 16), 16) },
        { size: 32, png: await png(markSvg(MASTER, 32), 32) },
        { size: 48, png: await png(markSvg(MASTER, 48), 48) },
      ]),
    );
    writeFileSync(join(WEB, 'app/apple-icon.png'), await png(tileSvg(180), 180));
    for (const size of [192, 512])
      writeFileSync(join(WEB, `public/icon-${size}.png`), await png(tileSvg(size), size));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node
// Writes the app's icons from the mark (logo-directions.md, "Cuts by size" and "Icon"; the same
// geometry as components/shell/Mark.tsx). Run it again when the mark changes:
//
//   pnpm --filter @colosseum/web exec node scripts/make-icons.mjs
//
// It writes, and the files are committed:
//   app/icon.svg          the small cut (16 grid, for 12–21 px: a tab), ink on a light tab and
//                         hinoki on a dark one, the pin a hole in both
//   app/favicon.ico       16, 32 and 48 px for what reads no SVG: hinoki on `black`, the small cut
//                         at 16 and the master at 32 and 48 (each cut drawn at its own size, never
//                         scaled across one)
//   app/apple-icon.png    180 px: the master at 62% of the tile, on `black`
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
export const INK = '#1C1712';
export const BLACK = '#0D0B09';
export const HINOKI = '#E6D3B7';

/** The small cut, on its 16 grid: post, then the tenon end with the pin knocked out. */
export const SMALL = {
  grid: 16,
  box: [1, 1, 15, 15],
  shapes:
    '<rect x="1" y="1" width="4" height="14"/><path fill-rule="evenodd" d="M6 4h9v8H6z M11 6a2 2 0 1 0 0.001 0z"/>',
};
/** The master, on its 32 grid: rail, post, tenon end, pin; every gap one unit. */
export const MASTER = {
  grid: 32,
  box: [1, 2, 30, 30],
  shapes:
    '<rect x="1" y="10" width="5" height="12"/><rect x="7" y="2" width="10" height="28"/><path fill-rule="evenodd" d="M18 12h12v8H18z M25 14a2 2 0 1 0 0.001 0z"/>',
};

/** The tab icon: the small cut in the tab's ink, by the browser's colour scheme. */
export function tabSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <title>tenonfi</title>
  <style>path, rect { fill: ${INK}; } @media (prefers-color-scheme: dark) { path, rect { fill: ${HINOKI}; } }</style>
  ${SMALL.shapes}
</svg>
`;
}

/**
 * A square tile of `size` px: the cut in hinoki on black. `fill` is the share of the tile the mark's
 * width takes, centred on its bounding box; 1 leaves the cut on its own grid, edge to edge.
 */
export function tileSvg(cut, size, fill) {
  const [x0, y0, x1, y1] = cut.box;
  const scale = fill === 1 ? size / cut.grid : (size * fill) / (x1 - x0);
  const dx = fill === 1 ? 0 : (size - (x1 - x0) * scale) / 2 - x0 * scale;
  const dy = fill === 1 ? 0 : (size - (y1 - y0) * scale) / 2 - y0 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="${BLACK}"/>
  <g fill="${HINOKI}" transform="translate(${dx} ${dy}) scale(${scale})">${cut.shapes}</g>
</svg>`;
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
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    return rgba(await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }));
  };
  try {
    writeFileSync(join(WEB, 'app/icon.svg'), tabSvg());
    writeFileSync(
      join(WEB, 'app/favicon.ico'),
      ico([
        { size: 16, png: await png(tileSvg(SMALL, 16, 1), 16) },
        { size: 32, png: await png(tileSvg(MASTER, 32, 1), 32) },
        { size: 48, png: await png(tileSvg(MASTER, 48, 1), 48) },
      ]),
    );
    writeFileSync(join(WEB, 'app/apple-icon.png'), await png(tileSvg(MASTER, 180, 0.62), 180));
    for (const size of [192, 512])
      writeFileSync(
        join(WEB, `public/icon-${size}.png`),
        await png(tileSvg(MASTER, size, 0.62), size),
      );
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

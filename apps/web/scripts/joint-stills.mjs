#!/usr/bin/env node
// Makes the stills of the landing's joint (public/landing/joint/*.svg) from the scene itself, so a
// still and the 3D stage always agree (imagery-style.md: one model, every output). Run `next dev`
// first, then `node scripts/joint-stills.mjs [origin]` from apps/web (origin defaults to
// http://localhost:3130). It opens /dev/joint apart and seated, on black and on paper, and saves the
// drawing the page makes of each (features/landing/dev/joint-svg.ts).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://localhost:3130';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'landing', 'joint');
// the GPU, not a software rasteriser: the depth the edges are cut against is read back from it
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
for (const ground of ['dark', 'light']) {
  const context = await browser.newContext({
    viewport: { width: 480, height: 480 },
    deviceScaleFactor: 2,
  });
  await context.addCookies([{ name: 'tf-theme', value: ground, url: origin }]);
  const page = await context.newPage();
  for (const state of ['apart', 'seated']) {
    await page.goto(`${origin}/dev/joint?state=${state}`);
    const canvas = page.locator('canvas[data-ready="true"]');
    await canvas.waitFor({ timeout: 60_000 });
    const svg = await canvas.getAttribute('data-svg');
    const file = join(out, `joint-${state}-${ground}.svg`);
    writeFileSync(file, `${svg}\n`);
    console.log(file, svg?.length);
  }
  await context.close();
}
await browser.close();

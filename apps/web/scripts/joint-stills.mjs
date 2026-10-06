#!/usr/bin/env node
// Makes the stills of the landing's joint (public/landing/joint/*.webp) from the scene itself, so a
// still and the 3D stage always agree (imagery-style.md: one model, every output). Run `next dev`
// first, then `node scripts/joint-stills.mjs [origin]` from apps/web (origin defaults to
// http://localhost:3130). It photographs /dev/joint apart and seated, on black and on paper, at
// 960 × 960 with a clear ground, and has the browser encode each as WebP.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const origin = process.argv[2] ?? 'http://localhost:3130';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'landing', 'joint');
// the GPU, not a software rasteriser: the stills must look like the stage
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
    // the dev server's own badge sits over the corner of the frame
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    const canvas = page.locator('canvas[data-ready="true"]');
    await canvas.waitFor({ timeout: 60_000 });
    const png = await canvas.screenshot({ omitBackground: true });
    const webp = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.9).split(',')[1];
    }, png.toString('base64'));
    const file = join(out, `joint-${state}-${ground}.webp`);
    writeFileSync(file, Buffer.from(webp ?? '', 'base64'));
    console.log(file);
  }
  await context.close();
}
await browser.close();

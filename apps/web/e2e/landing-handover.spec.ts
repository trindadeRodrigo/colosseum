import { expect, type Page, test } from '@playwright/test';

// The hero hands over to the showcase (JointStage.tsx). The joint's layer is pinned, one screen tall,
// while the reader goes through the three steps. Where the stage ends, the joint is either whole on
// the screen or not there at all: the showcase never rises over it and cuts it flat, and it never
// rides up into the bar's band. And it is seated before it goes. Scrolled down through the hand-over
// and back up, at three sizes.

const SIZES = [
  { width: 1365, height: 836 },
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const STEP = 60;

function handOver(page: Page) {
  return page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-ui="joint-layer"]');
    const stage = document.querySelector('[data-ui="joint-stage"]');
    const next = stage?.nextElementSibling;
    if (!layer || !stage || !next) throw new Error('no stage');
    const box = layer.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      next: next.getBoundingClientRect().top,
      screen: window.innerHeight,
      shown: Number(getComputedStyle(layer).opacity),
      seated: layer.dataset.seated === 'true',
    };
  });
}

for (const size of SIZES)
  test(`the joint is whole or gone where the hero hands over, at ${size.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.locator('#showcase h2')).toBeVisible();
    const foot = await page.evaluate(() => {
      const stage = document.querySelector('[data-ui="joint-stage"]');
      if (!stage) throw new Error('no stage');
      return stage.getBoundingClientRect().bottom + window.scrollY;
    });
    // from two screens before the stage's foot reaches the window's foot, to the stage wholly gone
    const from = Math.max(0, foot - 3 * size.height);
    const stops: number[] = [];
    for (let y = from; y <= foot + STEP; y += STEP) stops.push(y);
    let shownAtAll = false;
    let goneAtAll = false;
    for (const y of [...stops, ...stops.toReversed()]) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
      // a frame for the stage to read the scroll, and one for the page to draw it
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      const at = await handOver(page);
      const where = `scrolled to ${y}`;
      if (at.shown > 0) {
        shownAtAll = true;
        // whole: pinned to the screen, with the showcase not yet on it
        expect(at.top, where).toBeGreaterThanOrEqual(-1);
        expect(at.bottom, where).toBeLessThanOrEqual(at.screen + 1);
        expect(at.next, where).toBeGreaterThanOrEqual(at.screen - 1);
      } else goneAtAll = true;
      // seated before it starts to go
      if (at.shown < 1) expect(at.seated, where).toBe(true);
      // and the layer never lies under the section that follows
      expect(at.bottom, where).toBeLessThanOrEqual(at.next + 1);
    }
    expect(shownAtAll).toBe(true);
    expect(goneAtAll).toBe(true);
  });

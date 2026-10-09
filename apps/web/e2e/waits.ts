import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import { inTheme } from './theme';

// What the specs of the waiting states share (WEB-SKELETONS): an API answer held until the spec lets
// it go, the boxes of a page's regions measured while it waits and once it has its data, and axe on
// the wait itself. A wait is held, never slept through, so a slow runner changes nothing.

export const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
export const WIDTHS = [1440, 375] as const;

export type Answer = { status?: number; body: unknown } | 'fail' | 'pass';

/**
 * Holds every API answer whose address matches `pattern` until `release` is called. `answer` says
 * what comes then: the stub's own answer (`pass`), a body of the spec's, or a failure of the network.
 */
export async function hold(
  page: Page,
  pattern: RegExp,
  answer: (url: URL) => Answer = () => 'pass',
) {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const handler = async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.continue();
    await gate;
    const a = answer(new URL(route.request().url()));
    if (a === 'pass') return route.continue();
    if (a === 'fail') return route.abort('connectionfailed');
    return route.fulfill({
      status: a.status ?? 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(a.body),
    });
  };
  await page.route(pattern, handler);
  return {
    release: () => open(),
    /** Stops holding: later reads go straight to the stub. */
    drop: () => page.unroute(pattern, handler),
  };
}

export type Box = { x: number; y: number; width: number; height: number };

/** The box of the first element `selector` names, on the page (not the window), in whole pixels. */
export async function boxOf(page: Page, selector: string): Promise<Box> {
  const target = page.locator(selector).first();
  await expect(target, selector).toBeVisible();
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 2) / 2;
    return {
      x: round(r.left + window.scrollX),
      y: round(r.top + window.scrollY),
      width: round(r.width),
      height: round(r.height),
    };
  });
}

/**
 * A region of a page, as it waits and as it is with its data. Its place is always compared; its width
 * and height too, unless its data sizes it (a list of however many rows came, a button as wide as
 * its words).
 */
export type Region = {
  name: string;
  waiting: string;
  loaded: string;
  /** `by-data`: its height is its data's. `by-words`: its width and height are its words'. */
  sized?: 'by-data' | 'by-words';
};

/** The foot of what the regions are measured from: the page's top, or the element `under` names. */
async function footOf(page: Page, under?: string): Promise<number> {
  if (!under) return 0;
  const box = await boxOf(page, under);
  return box.y + box.height;
}

const from = (box: Box, foot: number, name: string): Box =>
  // what stands over the foot is the foot's own business: only what is under it is measured from it
  name === 'title' || box.y < foot ? box : { ...box, y: box.y - foot };

export async function boxesWaiting(page: Page, regions: Region[], under?: string) {
  const foot = await footOf(page, under);
  const boxes: Record<string, Box> = {};
  for (const r of regions) boxes[r.name] = from(await boxOf(page, r.waiting), foot, r.name);
  return boxes;
}

/** Each region is where its skeleton was, to the pixel; as tall too, unless its data sizes it. */
export async function expectNoShift(
  page: Page,
  regions: Region[],
  before: Record<string, Box>,
  at: string,
  under?: string,
) {
  const foot = await footOf(page, under);
  for (const r of regions) {
    const was = before[r.name] as Box;
    const now = from(await boxOf(page, r.loaded), foot, r.name);
    const pick = (b: Box) =>
      r.sized === 'by-words'
        ? { x: b.x, y: b.y }
        : r.sized === 'by-data'
          ? { x: b.x, y: b.y, width: b.width }
          : { ...b };
    expect.soft(pick(now), `${at}: ${r.name} stays where its skeleton was`).toEqual(pick(was));
  }
}

/** The wait is one busy region with one polite line, its boxes hidden from a screen reader. */
export async function expectAnnouncedOnce(page: Page, label?: string | RegExp) {
  const wait = page.locator('main [data-ui="waiting"]').first();
  await expect(wait).toHaveAttribute('aria-busy', 'true');
  await expect(wait.locator('[role="status"]')).toHaveCount(1);
  if (label) await expect(wait.locator('[role="status"]')).toContainText(label);
  // nothing a skeleton draws is read out: every box sits under an aria-hidden parent
  const loud = await wait.evaluate(
    (el) =>
      [...el.querySelectorAll('[data-ui="skeleton"]')].filter(
        (b) => !b.closest('[aria-hidden="true"]'),
      ).length,
  );
  expect(loud, 'skeleton boxes a screen reader would meet').toBe(0);
}

/** axe on the page as it is, in light and in dark, and nothing wider than the window. */
export async function axe(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
  }
  const width = page.viewportSize()?.width ?? 0;
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(wide, `${name}: no sideways scroll at ${width}px`).toBeLessThanOrEqual(width);
}

export async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true });
}

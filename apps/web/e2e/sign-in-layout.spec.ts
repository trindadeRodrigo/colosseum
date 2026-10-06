import { expect, type Page, test } from '@playwright/test';

// The sign-in screen on one centred column (Thom, Oct 6): the headline, the lead, both cards, the
// disclaimer and the row of language and appearance share one left edge and one width, under the
// centred bar. At desktop width the two cards are as tall as each other, their one button each on one
// line at the foot and as wide as the other (SIGN-IN-FLOW). At 375 and 1440, light and dark, in English and
// Portuguese. The bar's "Sign in" is the page it marks, not a button.

const SIZES = [
  { width: 1440, height: 1000 },
  { width: 375, height: 812 },
] as const;

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};

for (const size of SIZES)
  for (const theme of ['dark', 'light'] as const)
    for (const lang of ['en', 'pt'] as const)
      test(`one column at ${size.width}, ${theme}, ${lang}`, async ({ page, context, baseURL }) => {
        await page.setViewportSize(size);
        await context.addCookies([
          { name: 'tf-theme', value: theme, url: baseURL ?? '' },
          { name: 'tf-lang', value: lang, url: baseURL ?? '' },
        ]);
        await page.goto('/sign-in');
        await expect(page.locator('[data-ui="sign-in"][data-state="ready"]')).toBeVisible({
          timeout: 60_000,
        });
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));

        const edges = {
          headline: (await box(page, '[data-ui="sign-in-screen"] h1')).x,
          lead: (await box(page, '[data-ui="sign-in-screen"] header p')).x,
          cards: (await box(page, '[data-ui="sign-in"] [data-ui="card"]')).x,
          disclaimer: (await box(page, '[data-ui="app-foot"] [data-ui="disclaimer"]')).x,
          choices: (await box(page, '[data-ui="app-foot"] [data-ui="language-switch"]')).x,
        };
        for (const [what, x] of Object.entries(edges))
          expect(
            Math.abs(x - edges.headline),
            `${what} at ${x}, headline at ${edges.headline}`,
          ).toBeLessThan(1);
        // one width: the cards and the foot end where the column does
        const column = await box(page, '[data-ui="sign-in-screen"]');
        const foot = await box(page, '[data-ui="app-foot"]');
        expect(Math.abs(foot.x + foot.width - (column.x + column.width))).toBeLessThan(1);
        // centred under the bar, at desktop width
        if (size.width >= 1000)
          expect(Math.abs(column.x + column.width / 2 - size.width / 2)).toBeLessThan(2);

        if (size.width >= 1000) {
          const cards = page.locator('[data-ui="sign-in"] [data-ui="card"]');
          const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
          expect(Math.abs((a?.height ?? 0) - (b?.height ?? 1))).toBeLessThan(1);
          // the last button of each card on one line
          const lastBottoms = await page
            .locator('[data-ui="sign-in"] [data-ui="sign-in-buttons"]')
            .evaluateAll((lists) =>
              lists.map((l) => (l.lastElementChild as HTMLElement).getBoundingClientRect().bottom),
            );
          expect(lastBottoms).toHaveLength(2);
          expect(Math.abs((lastBottoms[0] ?? 0) - (lastBottoms[1] ?? 1))).toBeLessThan(1);
        }
        // the two ways in, one button each, as wide as each other
        const widths = await page
          .locator('[data-ui="sign-in"] [data-ui="sign-in-buttons"] button')
          .evaluateAll((buttons) =>
            buttons.map((b) => Math.round(b.getBoundingClientRect().width)),
          );
        expect(widths, `${widths}`).toHaveLength(2);
        expect(new Set(widths).size, `${widths}`).toBe(1);

        // the bar's way in is the page itself: marked, and not a second primary button
        const here = page.locator('header [data-ui="sign-in-here"]');
        await expect(here).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('[data-variant="primary"], a.bg-primary')).toHaveCount(1);
        // nothing scrolls sideways
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      });

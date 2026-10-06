import { expect, type Page, test } from '@playwright/test';

// Sign-in is a dialog over the page (SIGN-IN-FLOW, Thom, Oct 6): opened by the bar's "Sign in", at
// 375 and 1440, light and dark, in English and Portuguese. On a phone it is a sheet the height of the
// window; on a desktop a centred box over a scrim. Inside it the title, the cards and the disclaimer
// share one left edge, the two cards are as tall as each other and their one button each sits on one
// line, of one width. The page at `/sign-in` still renders the same panel for a direct link.

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
      test(`the dialog at ${size.width}, ${theme}, ${lang}`, async ({ page, context, baseURL }) => {
        await page.setViewportSize(size);
        await context.addCookies([
          { name: 'tf-theme', value: theme, url: baseURL ?? '' },
          { name: 'tf-lang', value: lang, url: baseURL ?? '' },
        ]);
        await page.goto('/goal');
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
        await page.locator('header a[href="/sign-in"]').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveAttribute('aria-modal', 'true');
        await expect(dialog.locator('[data-ui="sign-in"][data-state="ready"]')).toBeVisible({
          timeout: 60_000,
        });
        // the page stays where it was
        await expect(page).toHaveURL(/\/goal$/);

        const panel = await box(page, '[role="dialog"]');
        // The scrim covers the window but for the scrollbar's room, which the locked page keeps
        // (`scrollbar-gutter: stable`): a browser with a classic scrollbar, as CI's, keeps 15px of it.
        const scrim = await box(page, '[data-ui="sign-in-dialog"]');
        expect(Math.round(scrim.x)).toBe(0);
        expect(size.width - scrim.width).toBeLessThan(20);
        if (size.width < 640) {
          // a sheet the size of the window
          expect(Math.round(panel.x)).toBe(Math.round(scrim.x));
          expect(Math.round(panel.width)).toBe(Math.round(scrim.width));
          expect(Math.round(panel.height)).toBe(size.height);
        } else {
          // a box centred over the scrim
          expect(Math.abs(panel.x + panel.width / 2 - (scrim.x + scrim.width / 2))).toBeLessThan(2);
          expect(panel.width).toBeLessThan(scrim.width);
        }

        const edges = {
          title: (await box(page, '[role="dialog"] [data-ui="sign-in-screen"] h2')).x,
          lead: (await box(page, '[role="dialog"] [data-ui="sign-in-screen"] header p')).x,
          cards: (await box(page, '[role="dialog"] [data-ui="sign-in"] [data-ui="card"]')).x,
          disclaimer: (await box(page, '[role="dialog"] [data-ui="disclaimer"]')).x,
        };
        for (const [what, x] of Object.entries(edges))
          expect(
            Math.abs(x - edges.title),
            `${what} at ${x}, title at ${edges.title}`,
          ).toBeLessThan(1);

        if (size.width >= 1000) {
          const cards = dialog.locator('[data-ui="sign-in"] [data-ui="card"]');
          const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
          expect(Math.abs((a?.height ?? 0) - (b?.height ?? 1))).toBeLessThan(1);
          const lastBottoms = await dialog
            .locator('[data-ui="sign-in"] [data-ui="sign-in-buttons"]')
            .evaluateAll((lists) =>
              lists.map((l) => (l.lastElementChild as HTMLElement).getBoundingClientRect().bottom),
            );
          expect(lastBottoms).toHaveLength(2);
          expect(Math.abs((lastBottoms[0] ?? 0) - (lastBottoms[1] ?? 1))).toBeLessThan(1);
        }
        // the two ways in, one button each, as wide as each other
        const widths = await dialog
          .locator('[data-ui="sign-in"] [data-ui="sign-in-buttons"] button')
          .evaluateAll((buttons) =>
            buttons.map((b) => Math.round(b.getBoundingClientRect().width)),
          );
        expect(widths, `${widths}`).toHaveLength(2);
        expect(new Set(widths).size, `${widths}`).toBe(1);
        // one primary in the dialog
        await expect(dialog.locator('[data-variant="primary"]')).toHaveCount(1);
        // nothing scrolls sideways, and the page behind does not scroll
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden');
        // Escape closes it
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      });

test('a direct link to /sign-in still gets the panel, as a page', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.locator('[data-ui="sign-in"][data-state="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('header [data-ui="sign-in-here"]')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('[data-variant="primary"], a.bg-primary')).toHaveCount(1);
});

test('the bar keeps its height: signed out, on /sign-in, and signed in', async ({ page }) => {
  const height = async () =>
    Math.round((await page.locator('[data-ui="compact-nav-bar"]').boundingBox())?.height ?? 0);
  await page.goto('/goal');
  await expect(page.locator('header a[href="/sign-in"]')).toBeVisible({ timeout: 60_000 });
  const out = await height();
  expect(out).toBe(58);
  await page.goto('/sign-in');
  await expect(page.locator('header [data-ui="sign-in-here"]')).toBeVisible();
  expect(await height()).toBe(out);
  await page.getByRole('button', { name: /Continue with a passkey/ }).click();
  await page.getByRole('button', { name: 'Solana' }).click();
  await page.getByRole('button', { name: /My plan lives on Solana/ }).click();
  await expect(page.locator('header [data-ui="account"]')).toBeVisible();
  expect(await height()).toBe(out);
});

test('on the landing, "Sign in" opens the dialog over it, the URL stays /, and Escape gives focus back', async ({
  page,
}) => {
  // with reduced motion the landing's bar is compact at once, with its call to action
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const cta = page.locator('[data-ui="compact-nav"] a[href^="/sign-in"]').first();
  await expect(cta).toBeVisible({ timeout: 60_000 });
  await cta.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page).toHaveURL(/\/$/);
  // the panel arrives in it: the same two ways in as the product's
  await expect(dialog.locator('[data-ui="sign-in"][data-state="ready"]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByRole('button', { name: /Continue with a passkey/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('href'))).toMatch(
    /^\/sign-in/,
  );
});

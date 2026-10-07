import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { dictionary, type Lang } from '../i18n';
import { portfolioDictionary } from '../i18n/portfolio';

// What the specs of the portfolio section share (PORT-3): signing in on a page of the section, the
// side menu on a phone, and the checks every page gets: axe in light and in dark at 375 px and at
// 1280 px, nothing wider than the window, and a pin on every figure. The stub answers the section's
// routes with its sample answers (tests/e2e/stub-api.ts): seven vaults on two chains, a test network
// and the mock, with Base switched off.

export const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
export const WIDTHS = [375, 1280] as const;

/**
 * Opens a page of the section and signs in on it: the bar's "Sign in" opens the dialog over the page,
 * the throwaway wallet signs in, and the person stays where they were. That wallet lives in the page:
 * a load of another address signs it out, so move on from here with the menu or a link, never with
 * `page.goto`.
 */
export async function openSignedIn(page: Page, path: string, lang: Lang = 'en') {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto(path);
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: dictionary(lang).signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  // nothing still being read
  await expect(page.locator('main [data-ui="waiting"]')).toHaveCount(0, { timeout: 60_000 });
}

/** Follows an item of the section's side menu: on a phone the menu is a drawer, opened first. */
export async function toPage(page: Page, href: string, lang: Lang = 'en') {
  const toggle = page.locator('button[aria-controls="portfolio-nav"]');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
    await expect(toggle).toHaveText(portfolioDictionary(lang).shell.menu.hide);
  }
  await page.locator(`#portfolio-nav a[href="${href}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
}

/**
 * axe on the page as it is, in light and in dark, at 375 px and at 1280 px, and nothing wider than
 * the window at either. The page is left at 375 px.
 */
export async function check(page: Page, name: string) {
  // Colours ease from one theme to the other: with easing off, axe reads the theme it was given.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 812 });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        const html = document.documentElement;
        html.classList.remove('light', 'dark', 'tf-auto');
        html.classList.add(t);
      }, theme);
      await page.waitForTimeout(100);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const found = result.violations.flatMap((v) =>
        v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
      );
      expect(found, `${name}, ${theme}, ${width}px`).toEqual([]);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(wide, `${name}, ${theme}: no sideways scroll at ${width}px`).toBeLessThanOrEqual(
        width,
      );
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
}

/**
 * Every figure on the page carries its pin, and none is drawn as live: the stub's figures are a test
 * network's and the mock's. The boxed word MOCK is nowhere (gate MOCK-QUIET).
 */
export async function pinned(page: Page, name: string) {
  const figures = page.locator('main [data-ui="figure"]');
  const n = await figures.count();
  expect(n, `${name}: figures`).toBeGreaterThan(0);
  expect(await page.locator('main [data-ui="figure"] button[data-ui="pin"]').count(), name).toBe(n);
  await expect(page.locator('main [data-ui="figure"][data-state="missing"]')).toHaveCount(0);
  await expect(page.locator('main [data-ui="figure"][data-state="live"]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('MOCK');
}

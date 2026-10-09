import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary, SIGNED_IN_COOKIE } from '../i18n';
import { inTheme } from './theme';

// The bar's one account control (Thom, Oct 9), in a browser, on the landing and on /goal: a still
// placeholder until it is known who is here, "Sign in", and the account chip, with the page under it
// saying the same. Sign-in from either page stays on it and needs no reload. A wait that lasts is
// never the control's label: after half a minute the help is under it. axe at 375 px, light and dark.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');

const control = (page: Page) => page.locator('header [data-ui="account-control"]');
const chip = (page: Page) => page.locator('header [data-ui="account-menu-button"]');

/** axe in light and in dark, and nothing wider than the phone. */
async function check(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
  }
}

/** Someone signed in on this browser before (the hint), whose wallet never says who is here. */
async function silentFor(page: Page) {
  await page
    .context()
    .addCookies([{ name: SIGNED_IN_COOKIE, value: '1', url: 'http://localhost' }]);
  // our server never answers, so the wallet is never mounted: as a server that is waking
  await page.route('**/v1/config', () => new Promise(() => {}));
  await page.clock.install();
}

test.beforeEach(async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
});

test('from the landing: "Sign in" opens the dialog over it, and the bar is the person’s with no reload', async ({
  page,
}) => {
  await page.goto('/');
  const bar = page.locator('[data-ui="landing-bar"]');
  await expect(control(page)).toHaveAttribute('data-state', 'signed-out');
  await expect(bar.getByText(/Open the app|Go to app/)).toHaveCount(0);
  await bar.getByRole('link', { name: en.shell.signIn }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click({ timeout: 60_000 });
  await expect(dialog).toHaveCount(0);
  // still on the landing, and the same chip as the product's bar: the chain, and the menu
  await expect(page).toHaveURL(/\/$/);
  await expect(chip(page)).toHaveAttribute('data-chain', 'solana');
  await expect(chip(page)).toBeFocused();
  await expect(bar.getByRole('link', { name: en.shell.signIn })).toHaveCount(0);
  await check(page, 'landing, signed in');
  await chip(page).click();
  const menu = page.locator('[data-ui="account-menu"]');
  await expect(menu.getByRole('button', { name: en.shell.copyAddress })).toBeVisible();
  await check(page, 'landing, the account menu');
  // signed out from the menu, the bar's way in is back, with focus
  await menu.locator('[data-ui="sign-out"]').click();
  await expect(control(page)).toHaveAttribute('data-state', 'signed-out');
  await expect(bar.getByRole('link', { name: en.shell.signIn })).toBeFocused();
  await check(page, 'landing, signed out');
});

test('from /goal: the page’s "Sign in" is the bar’s, and both are the person’s after it', async ({
  page,
}) => {
  await page.goto('/goal');
  await expect(control(page)).toHaveAttribute('data-state', 'signed-out', { timeout: 60_000 });
  const mine = page.locator('[data-ui="goal-sign-in"]');
  const theirs = control(page).getByRole('link', { name: en.shell.signIn });
  await expect(page.getByText(en.goal.explore.signIn)).toBeVisible();
  expect(await mine.getAttribute('href')).toBe(await theirs.getAttribute('href'));
  await check(page, 'goal, signed out');
  await mine.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click({ timeout: 60_000 });
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
  await expect(chip(page)).toHaveAttribute('data-chain', 'solana');
  await expect(page.getByText(en.goal.explore.signIn)).toHaveCount(0);
  await expect(mine).toHaveCount(0);
  await expect(page.locator('[data-ui="goal-conversation"] textarea')).toBeEnabled();
  await check(page, 'goal, signed in');
});

for (const [name, path] of [
  ['the landing', '/'],
  ['/goal', '/goal'],
] as const)
  test(`on ${name}, a wait is a still box, then help under it: never a label, never "Sign in"`, async ({
    page,
  }) => {
    await silentFor(page);
    await page.goto(path);
    await expect(control(page)).toHaveAttribute('data-state', 'loading');
    const box = control(page).locator('[data-ui="account-placeholder"]');
    await expect(box).toHaveAttribute('data-shape', 'account');
    await expect(box).toHaveAttribute('aria-hidden', 'true');
    await page.clock.fastForward(5_000);
    // said once, politely; nothing to press; and the page asks nobody to sign in
    await expect(control(page).locator('[data-ui="account-said"]')).toHaveText(
      en.shell.accountLoading,
    );
    await expect(control(page).locator('a, button')).toHaveCount(0);
    await expect(page.locator('a[href^="/sign-in"]')).toHaveCount(0);
    if (path === '/goal') {
      await expect(page.getByText(en.goal.explore.signIn)).toHaveCount(0);
      await expect(page.locator('[data-ui="goal-conversation"]')).toContainText(
        en.goal.explore.loadingAccount,
      );
    }
    const before = await box.boundingBox();
    await check(page, `${name}, not known yet`);
    // half a minute on: the same box, and the help under it
    await page.clock.fastForward(30_000);
    const help = control(page).locator('[data-ui="sign-in-slow"]');
    await expect(help).toContainText(en.shell.slow.title);
    await expect(help.getByRole('button', { name: en.shell.slow.again })).toBeVisible();
    await expect(help.getByRole('button', { name: en.shell.signOut })).toBeVisible();
    expect(await box.boundingBox()).toEqual(before);
    await expect(page.locator('body')).not.toContainText('Sign-in is slow');
    await check(page, `${name}, slow`);
    // "Sign out" there leaves as far as this browser can: the visitor's way in, with focus
    await help.getByRole('button', { name: en.shell.signOut }).click();
    await expect(control(page)).toHaveAttribute('data-state', 'signed-out');
    await expect(control(page).getByRole('link', { name: en.shell.signIn })).toBeFocused();
  });

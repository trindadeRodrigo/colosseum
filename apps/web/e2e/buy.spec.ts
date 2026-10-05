import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';

// A person's buy, end to end in a browser, on the mock chain: sign in with the throwaway wallet, read a
// goal, build the plan, look at it, buy it, review every step and sign. The order screen's executor
// builds each step from the stub API, holds it to the review with the real guard, has the throwaway
// wallet sign it and reports it, until the stub's mock chain confirms every step. A second buy has the
// stub lie about one step, and the guard refuses it. Every screen is checked with axe at 375 px, in
// light and in dark, and for no sideways scroll.

const en = dictionary('en');
const STUB = 'http://localhost:3901';

/** axe on the page as it is, in light and in dark, and nothing wider than the window. */
async function check(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      const html = document.documentElement;
      html.classList.remove('light', 'dark', 'tf-auto');
      html.classList.add(t);
    }, theme);
    // Colours ease from one theme to the other: axe reads them once they have.
    await page.waitForTimeout(600);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
    await page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`), fullPage: true });
  }
}

/** From a signed-out page to the buy screen of a plan, with the wallet funded and the notice ticked. */
async function toReview(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: en.signIn.passkey.create }).click();
  await page.getByRole('button', { name: 'Solana' }).click();
  await page.getByRole('button', { name: en.chain.pick.confirm('Solana') }).click();
  await expect(page).toHaveURL(/\/goal$/);

  const goal = page.getByRole('textbox', { name: en.goal.composer.label, exact: true });
  await goal.fill('Grow $40 for three years, medium risk');
  await goal.press('Enter');
  await page.getByLabel(en.goal.fields.amount, { exact: true }).fill('40');
  await page.getByLabel(en.goal.fields.country, { exact: true }).selectOption('BR');
  await page.getByRole('button', { name: en.goal.sheet.build }).click();
  await page.getByRole('link', { name: en.goal.built.done.see }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grow $40 over 36 months.');
  await check(page, 'plan');
  await page.getByRole('link', { name: en.plan.buy }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await page.getByRole('button', { name: en.buy.funding.mockFund }).click();
  await expect(page.getByText(en.buy.funding.ok)).toBeVisible();
  await page.getByLabel(en.trust.accept).check();
  await check(page, 'buy');
  await page.getByRole('button', { name: en.buy.review('$40') }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.order.review.title);
}

test('a buy on the mock chain: plan, buy, review, sign, every step confirmed', async ({ page }) => {
  await toReview(page);
  const steps = page.locator('[data-ui="order-step"]');
  // a vault opened with the deposit, then one swap per asset: the mock trades separately
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(1)).toContainText('receive at least');
  await check(page, 'review');

  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  const status = page.locator('[data-ui="order-status"]');
  await expect(status).toHaveText(en.order.outcome.done('Solana'), { timeout: 90_000 });
  for (let i = 0; i < 4; i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');
  await check(page, 'done');
});

test('a step the server lies about is refused by the guard, and nothing is signed for it', async ({
  page,
}) => {
  await toReview(page);
  await page.request.post(`${STUB}/__stub/tamper`);
  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  const status = page.locator('[data-ui="order-status"]');
  await expect(status).toContainText(en.order.outcome.refused(2), { timeout: 60_000 });
  await expect(status).toContainText(en.order.outcome.check('minimum'));
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
  await expect(steps.nth(1)).not.toHaveAttribute('data-status', 'confirmed');
  await expect(page.getByRole('link', { name: en.order.outcome.newOrder })).toBeVisible();
  await check(page, 'refused');
});

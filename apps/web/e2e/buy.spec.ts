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

// These run on the stub's Solana; the Robinhood Chain run (E2E_CHAIN=robinhood) is buy-robinhood.spec.ts.
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const shot = (name: string) => `${SHOTS}/${name}.png`;
const WIDTHS = [375, 1280] as const;
const REFERENCE = new URL('../../../.design/branding/working-brand/patterns/', import.meta.url)
  .href;

/**
 * axe on the page as it is at 375 px, in light and in dark, nothing wider than the window, and a
 * screenshot of each theme at 375 px and at 1280 px to set beside the guide's.
 */
async function check(page: Page, name: string) {
  // Colours ease from one theme to the other: with easing off, axe reads the theme it was given.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
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
    expect(found, `${name}, ${theme}`).toEqual([]);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
    if (SHOTS) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 812 });
        await page.screenshot({ path: shot(`${name}-${width}-${theme}`), fullPage: true });
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
  }
}

/** Follows a link of the product's bar, as a phone does: the menu button, then the link in its sheet. */
async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

/** From a signed-out page to the buy screen of a plan, with the wallet funded and the notice ticked. */
test('his landing page: the hero, the two sample cases, the typing box that hands a goal on', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.stage.title);
  await expect(page.locator('article[data-ui="showcase-case"]')).toHaveCount(2);
  // a jump to the end of the page, over the stage, finds his bar compact, with its action
  await page.keyboard.press('End');
  await expect(page.locator('[data-ui="compact-nav"]')).toHaveAttribute('data-compact', 'true');
  await expect(
    page.locator('[data-ui="compact-nav"]').getByRole('link', { name: en.landing.nav.cta }),
  ).toBeVisible();
  await page.keyboard.press('Home');
  await check(page, 'landing');
  const box = page.locator('#simulate textarea');
  await box.fill('Grow $2,000 for ten years, high risk');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/goal$/);
  // the goal screen reads what the landing handed it
  await expect(page.getByText(en.goal.sheet.title).first()).toBeVisible();
});

test('the two sample cases fit their cards on a phone and a tablet, in English and Portuguese', async ({
  page,
  context,
  baseURL,
}) => {
  for (const lang of ['en', 'pt'] as const) {
    await context.addCookies([{ name: 'tf-lang', value: lang, url: baseURL ?? '' }]);
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.locator('article[data-ui="showcase-case"]')).toHaveCount(2);
      // every box inside a case that is drawn at all stays within the case's own edges; a box inside
      // a part that scrolls on its own (the chart on a phone) is held to that part instead
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('article[data-ui="showcase-case"]')].flatMap((card) => {
          const edge = card.getBoundingClientRect();
          const scrolls = (el: Element) => {
            for (let a = el.parentElement; a && a !== card; a = a.parentElement)
              if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX)) return true;
            return false;
          };
          return [...card.querySelectorAll('*')].flatMap((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || el.closest('.sr-only') || scrolls(el)) return [];
            const over = r.right - edge.right > 0.5 || edge.left - r.left > 0.5;
            return over ? [`${el.tagName} "${(el.textContent ?? '').slice(0, 30)}"`] : [];
          });
        }),
      );
      expect(out, `${lang} at ${width}px`).toEqual([]);
    }
  }
});

async function toReview(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: en.signIn.passkey.create }).click();
  await page.getByRole('button', { name: 'Solana' }).click();
  await page.getByRole('button', { name: en.chain.pick.confirm('Solana') }).click();
  // sign-in leads to the goal; `/` is his landing page for a visitor (WEB-2b)
  await expect(page).toHaveURL(/\/goal$/);
  await check(page, 'home');

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
  // the review names the chain over the page and over its steps
  await expect(page.locator('main [data-ui="chain-badge"]')).toHaveText(['Solana', 'Solana']);
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

  // The monitor reads the vault the buy opened, with a pin on its value, under the MOCK plate.
  // at 375 px his bar keeps its links in the sheet under the menu button
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/monitor$/);
  const vault = page.locator('section[data-ui="card"]').filter({
    has: page.getByRole('heading', { name: en.portfolio.vault.title }),
  });
  await expect(vault).toHaveCount(1);
  // his goal card, joined to the goal the plan was built for, and what reached the chain, with links
  await expect(page.locator('[data-ui="goal-card"] h3')).toHaveText('Grow $40 over 36 months.');
  await expect(
    page.locator('[data-ui="activity-panel"] [data-ui="execution-list"] li a[href]'),
  ).toHaveCount(4);
  await expect(vault.locator('[data-ui="vault-value"] [data-ui="figure"]')).toHaveCount(1);
  await expect(vault.locator('[data-ui="mock-plate"]').first()).toBeVisible();
  await expect(vault.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
  await check(page, 'monitor');
  // the disclaimer is under the vault, once: the shell's foot does not repeat it
  await expect(page.locator('main [data-ui="disclaimer"]')).toBeVisible();
  await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
  // and home says where the money is, under the goal
  await go(page, en.shell.invest);
  await expect(page.getByRole('link', { name: en.portfolio.summary.see })).toBeVisible();
  // a page with no disclaimer of its own keeps the foot's
  await expect(page.locator('footer [data-ui="disclaimer"]')).toBeVisible();
  await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
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
  // The wallet was never asked for the refused step: the stub was handed signed bytes for the first
  // step and for nothing after it.
  const reported = (await (await page.request.get(`${STUB}/__stub/reports`)).json()) as string[];
  const legs = await page.locator('[data-ui="order-step"]').count();
  expect(legs).toBe(4);
  expect(new Set(reported).size).toBe(1);
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
  await expect(steps.nth(1)).not.toHaveAttribute('data-status', 'confirmed');
  await expect(page.getByRole('link', { name: en.order.outcome.newOrder })).toBeVisible();
  await check(page, 'refused');
});

test('the guide and the prototype, photographed beside the screens', async ({ page }) => {
  test.skip(!SHOTS, 'only when SCREENSHOTS_DIR names a folder');
  // What each screen is held to (guidelines.html, components and provenance; the prototype's plan
  // pane), at the same widths and in both themes, for the report that compares them.
  for (const width of WIDTHS)
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${REFERENCE}guidelines.html${theme === 'dark' ? '?theme=dark' : ''}`);
      for (const part of ['components', 'provenance'])
        await page
          .locator(`#${part}`)
          .screenshot({ path: shot(`guide-${part}-${width}-${theme}`) });
      await page.goto(`${REFERENCE}prototypes/hero-3d.html`);
      await page
        .locator('article.case')
        .first()
        .screenshot({ path: shot(`prototype-case-${width}`) });
    }
});

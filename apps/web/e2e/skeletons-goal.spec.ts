import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';
import { axe, boxOf, hold, STUB, settled, shot, WIDTHS } from './waits';

// The waits of /goal in outline (WEB-SKELETONS-2): the first draft's card, the funds check and the
// order's steps in the pane where the deposit is signed. Each read is held, the wait is checked (its
// outline hidden from a screen reader, its words said, axe clean) and its boxes are compared with
// what lands, at 1440 px and at 375 px. The reply row, the box and the card's width are held by
// reply-waiting.spec.ts; the bar's account control by sign-in-layout.spec.ts. Nothing here changes
// what is deposited or signed.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

async function say(page: Page, words: string) {
  const box = page.locator('textarea');
  await box.fill(words);
  await box.press('Enter');
}

/** No box of an outline is met by a screen reader, and none draws a figure. */
async function hiddenAndBlank(page: Page, outline: string) {
  const root = page.locator(outline);
  await expect(root).toBeVisible();
  expect(await root.evaluate((el) => el.closest('[aria-hidden="true"]') !== null)).toBe(true);
  expect(await root.innerText()).not.toMatch(/[\d%$]/);
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test('the first draft waits as the draft’s own outline, and its bar lands where the outline’s was', async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const strategy = page.locator('[data-ui="goal-strategy"]');
      const h = await hold(page, /\/goal\/reply/);
      await say(page, 'A broad fund and some gold, to grow, at medium risk');
      const building = strategy.locator('[data-ui="draft-building"]');
      await expect(building.locator('h2')).toHaveText(en.goal.explore.building);
      await hiddenAndBlank(page, '[data-ui="draft-skeleton"]');
      // one treatment of the wait: the pending row in the transcript, the words on the card, and
      // the one announcement; no second status on the card
      await expect(page.locator('[data-ui="reply-pending"]')).toHaveCount(1);
      await expect(strategy.locator('[role="status"]')).toHaveCount(0);
      await axe(page, `first draft waiting, ${width}px`);
      await inTheme(page, 'dark');
      const card = await boxOf(page, '[data-ui="goal-empty-preview"]');
      const legs = await boxOf(page, '[data-wait="legs"]');
      await shot(page, 'goal-draft-loading');
      h.release();
      await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
      await settled(page);
      await inTheme(page, 'dark');
      const drawn = await boxOf(page, '[data-ui="goal-strategy"] [data-ui="card"]');
      const bar = await boxOf(page, '[data-ui="holding-legs"]');
      expect.soft([drawn.x, drawn.width], 'the card').toEqual([card.x, card.width]);
      if (width >= 768) {
        // beside the chat on a desk: the card does not move, and the bar is where its outline was.
        // (On a phone the card is under the chat, which the reply makes taller.)
        expect.soft(drawn.y, 'the card’s top').toBe(card.y);
        expect.soft(bar.y, 'the bar’s top').toBe(legs.y);
      }
      // the bar's own row is as tall as the outline drew it
      expect.soft(bar.width - legs.width, 'the sample card’s hatch band takes 6px').toBe(-6);
      await shot(page, 'goal-draft-loaded');
      await h.drop();
    });

    test('in the pane where a deposit is signed, the funds check and the steps wait in outline', async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page);
      const strategy = page.locator('[data-ui="goal-strategy"]');
      await say(page, 'A broad fund and some gold, to grow, at medium risk');
      await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
      await strategy.getByRole('button', { name: en.mix.preview.deposit, exact: true }).click();
      await page.getByLabel(en.buy.amount.label, { exact: true }).fill('100');
      await expect(page.locator('[data-ui="deposit-check"]')).toHaveText(en.mix.deposit.checked);
      await page.getByRole('button', { name: en.mix.deposit.reviewOf('$100') }).click();
      const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
      await expect(boxes.first()).toBeVisible();
      for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).check();

      // the wallet's funds are read: said in words, over the outline of what the check brings
      const funds = await hold(page, /\/v1\/funding/);
      await page.getByRole('button', { name: en.mix.goal.confirm }).click();
      const pane = page.locator('[data-ui="deposit-sign"]');
      const reading = pane.locator('[data-ui="invest-funds-reading"]');
      await expect(reading).toContainText(en.invest.checkingFunds);
      await hiddenAndBlank(page, '[data-ui="funds-wait"]');
      await axe(page, `funds check waiting, ${width}px`);
      await inTheme(page, 'dark');
      const fundsWait = await boxOf(page, '[data-ui="funds-wait"]');
      await shot(page, 'deposit-funds-loading');
      funds.release();
      await expect(pane.locator('[data-ui="funding-step"]')).toBeVisible({ timeout: 30_000 });
      await settled(page);
      await inTheme(page, 'dark');
      const step = await boxOf(page, '[data-ui="deposit-sign"] [data-ui="funding-step"]');
      // what is needed lands where its outline was, a line lower at most: the words over the
      // outline give way to it
      expect.soft([step.x, step.width], 'the funding step').toEqual([fundsWait.x, fundsWait.width]);
      expect.soft(Math.abs(step.y - fundsWait.y), 'the funding step’s top').toBeLessThanOrEqual(34);
      await shot(page, 'deposit-funds-loaded');
      await funds.drop();

      // the order is made: its steps wait as three figures and a line a step, in the pane itself
      // (the order's own read, by its id: making it is the card's busy button)
      const orders = await hold(page, /\/v1\/orders\/[^/]+$/);
      await page.getByRole('button', { name: en.buy.funding.mockFund }).click();
      const making = pane.locator('[data-ui="invest-reading"]');
      await expect(making).toContainText(en.invest.preparing, { timeout: 30_000 });
      await hiddenAndBlank(page, '[data-ui="steps-wait"]');
      // not a card inside the card
      await expect(making.locator('[data-ui="card"]')).toHaveCount(0);
      await axe(page, `steps waiting, ${width}px`);
      await inTheme(page, 'dark');
      const stats = await boxOf(page, '[data-ui="steps-wait"] [data-ui="skeleton-stats"]');
      await shot(page, 'deposit-steps-loading');
      orders.release();
      await expect(pane.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
      await settled(page);
      await inTheme(page, 'dark');
      const row = await boxOf(page, '[data-ui="deposit-sign"] [data-ui="stat-row"]');
      expect.soft([row.x, row.width], 'the three figures').toEqual([stats.x, stats.width]);
      await shot(page, 'deposit-steps-loaded');
      // nothing was signed by any of this
      await expect(pane.locator('[data-ui="order-step"][data-status="confirmed"]')).toHaveCount(0);
      await orders.drop();
    });
  });
}

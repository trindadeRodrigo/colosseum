import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// The deposit, signed in place on /goal (gate DEPOSIT-IN-PLACE), end to end on the mock chain: the
// conversation, the proposal, the deposit step, the review, and then the steps to sign in the same
// pane, every one signed through the guard, to the finished state and the vault's own page. The
// address never changes until "Open your vault". Then a step the server lies about, refused in the
// pane; the pane taken up again after the conversation's screen is left and opened again; and a quote
// that ran out. Every stage is checked with axe at 375 px, in light and in dark, and for no sideways
// scroll at 375 and at 1440.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;

async function check(page: Page, name: string) {
  // A pointer resting on the drawing lights one piece and dims the others: read with the pointer off.
  await page.mouse.move(0, 0);
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    );
    expect(found, `${name}, ${theme}`).toEqual([]);
    for (const width of [1440, 375] as const) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(wide, `${name}, ${theme}, ${width}: no sideways scroll`).toBeLessThanOrEqual(width);
      // nothing in the pane is wider than the pane: a step's line wraps
      const spill = await page.evaluate(() => {
        const pane = document.querySelector('[data-ui="goal-strategy"]');
        if (!pane) return [];
        const edge = pane.getBoundingClientRect().right + 1;
        return [...pane.querySelectorAll('[data-ui="order-step"], [data-ui="deposit-sign"] p')]
          .filter((el) => el.getBoundingClientRect().right > edge)
          .map((el) => el.textContent?.slice(0, 60));
      });
      expect(spill, `${name}, ${theme}, ${width}: nothing wider than the pane`).toEqual([]);
      if (SHOTS)
        await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png`, fullPage: true });
    }
  }
}

async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

const pane = (page: Page) => page.locator('[data-ui="deposit-sign"]');
const press = (page: Page) =>
  pane(page)
    .locator('[data-ui="invest-card"]')
    .getByRole('button', {
      name: en.invest.press('$100'),
    });

/** From the conversation to the steps on the pane, the wallet funded and the notice ticked. */
async function toSteps(page: Page, shots = false) {
  const box = page.locator('textarea');
  if (shots) await check(page, '01-chat');
  await box.fill('A broad fund and some gold, to grow, at medium risk');
  await box.press('Enter');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  if (shots) await check(page, '02-proposal');
  await strategy.getByRole('button', { name: en.mix.preview.deposit, exact: true }).click();
  const step = page.locator('[data-ui="deposit-step"]');
  await expect(step.getByRole('heading', { name: en.mix.deposit.title })).toBeVisible();
  if (shots) await check(page, '03-deposit');
  await page.getByLabel(en.buy.amount.label, { exact: true }).fill('100');
  await expect(step.locator('[data-ui="deposit-check"]')).toHaveText(en.mix.deposit.checked);
  if (shots) await check(page, '04-amount');
  await page.getByRole('button', { name: en.mix.deposit.reviewOf('$100') }).click();
  await expect(page.getByRole('heading', { name: en.mix.review.title })).toBeFocused();
  const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).check();
  if (shots) await check(page, '05-review');
  await page.getByRole('button', { name: en.mix.goal.confirm }).click();

  // the steps to sign take the pane: the amount as a fact, and no field to type it again
  await expect(pane(page)).toHaveAttribute('data-state', 'ready');
  await expect(
    pane(page).getByRole('heading', { name: en.mix.deposit.signing.title }),
  ).toBeFocused();
  await expect(pane(page).locator('[data-ui="deposit-sign-amount"]')).toContainText('$100');
  await expect(pane(page).locator('input[inputmode="decimal"]')).toHaveCount(0);
  const card = pane(page).locator('[data-ui="invest-card"]');
  // the wallet is short: what is missing and the way to fill it, and no order yet
  await expect(card.locator('[data-ui="funding-step"]')).toBeVisible();
  await expect(card.locator('[data-ui="order-step"]')).toHaveCount(0);
  if (shots) await check(page, '06-sign-wallet-short');
  await card.getByRole('button', { name: en.buy.funding.mockFund }).click();
  await expect(card.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
  // a first deposit: the notice is in the pane and holds the press until it is ticked
  await expect(press(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel(en.trust.accept).check();
  await expect(press(page)).not.toHaveAttribute('aria-disabled', 'true');
  // the amount, the number of steps and the time to sign by, then each step's own line
  await expect(card).toContainText(en.order.review.deposit);
  await expect(card).toContainText(en.order.review.steps);
  await expect(card).toContainText(en.order.review.expires);
  await expect(card.locator('[data-ui="order-step"]').first()).toContainText('100');
  // sample figures on the mock: the card's hatch says so, and nothing reads as live
  await expect(pane(page)).toContainText(en.shell.mockAnnounce);
}

test('the whole deposit on /goal: chat, proposal, amount, review, every step signed, then the vault', async ({
  page,
}) => {
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await signIn(page);
  visited.length = 0;
  await toSteps(page, true);
  // nobody is asked for the amount again, and nothing reads "mix" or "buy" on the way
  const words = (await page.locator('main').innerText()).toLowerCase();
  expect(words.match(/[^.\n]*\b(mix|buy|buys|bought|buying)\b[^.\n]*/g) ?? []).toEqual([]);
  await check(page, '07-sign-ready');

  await press(page).click();
  // while steps are signed the conversation waits and says why
  await expect(page.locator('textarea')).toBeDisabled();
  await expect(page.locator('[data-ui="goal-chat"]')).toContainText(
    en.goal.explore.deposit.signing,
  );
  await expect(page.locator('[data-ui="order-status"]')).toContainText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  await expect(pane(page)).toHaveAttribute('data-state', 'done');
  const steps = pane(page).locator('[data-ui="order-step"]');
  for (let i = 0; i < (await steps.count()); i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');
  const open = pane(page).getByRole('link', { name: en.mix.deposit.signing.openVault });
  await expect(open).toBeVisible();
  await expect(page.locator('textarea')).toBeEnabled();
  await check(page, '08-done');
  // the address never changed
  expect(visited.filter((path) => path !== '/goal')).toEqual([]);
  await expect(page).toHaveURL(/\/goal$/);

  await open.click();
  await expect(page).toHaveURL(/\/vaults\/solana\/[^/]+$/);
});

test('a step the server lies about is refused in the pane, and the pane is taken up again where it was', async ({
  page,
}) => {
  await signIn(page);
  await toSteps(page);
  await page.request.post(`${STUB}/__stub/tamper`);
  await press(page).click();
  const status = pane(page).locator('[data-ui="order-status"]');
  await expect(status).toContainText(en.order.outcome.refused(2), { timeout: 60_000 });
  await expect(pane(page).locator('[data-ui="invest-landed"]')).toContainText(
    en.invest.things.deposit,
  );
  await expect(pane(page)).toHaveAttribute('data-state', 'approved');
  const steps = pane(page).locator('[data-ui="order-step"]');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
  await expect(steps.nth(1)).not.toHaveAttribute('data-status', 'confirmed');
  // the wallet was asked for the first step and for nothing after it
  const reported = (await (await page.request.get(`${STUB}/__stub/reports`)).json()) as string[];
  expect(new Set(reported).size).toBe(1);
  // the conversation waits while the deposit is open, and says how to get it back
  await expect(page.locator('textarea')).toBeDisabled();
  await expect(page.locator('[data-ui="goal-chat"]')).toContainText(en.goal.explore.deposit.open);
  await expect(page).toHaveURL(/\/goal$/);
  await check(page, '09-step-refused');

  // The screen is left and opened again, as a reload does to it (the throwaway sign-in does not
  // outlive a page load, so the app's own links stand in): the same order, its steps where they were.
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/portfolio$/);
  await go(page, en.shell.invest);
  await expect(page).toHaveURL(/\/goal$/);
  await expect(pane(page)).toHaveAttribute('data-state', 'approved');
  await expect(pane(page)).toContainText(en.mix.deposit.signing.resumed);
  await expect(pane(page).locator('[data-ui="deposit-sign-amount"]')).toContainText('$100');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
  await expect(steps.nth(0).getByRole('link')).toBeVisible();
  await expect(page.locator('textarea')).toBeDisabled();
  // no second deposit was made by opening it again
  expect(
    new Set((await (await page.request.get(`${STUB}/__stub/reports`)).json()) as string[]).size,
  ).toBe(1);
  await check(page, '10-opened-again');

  // "Start over" asks first; staying keeps the deposit, leaving gives the conversation back
  await page.getByRole('button', { name: en.talk.startOver }).click();
  const ask = page.getByRole('alertdialog');
  await expect(ask).toContainText(en.goal.explore.deposit.leave);
  await check(page, '11-leave-asked');
  await ask.getByRole('button', { name: en.goal.explore.deposit.stay }).click();
  await expect(pane(page)).toBeVisible();
  await pane(page).getByRole('button', { name: en.mix.deposit.backToProposal }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator('textarea')).toBeEnabled();
  // left with its cash in the vault: said over the proposal, with the way back to the same steps
  const note = page.locator('[data-ui="deposit-unfinished"]');
  await expect(note).toHaveAttribute('data-landed', 'true');
  await expect(note).toContainText(en.goal.explore.deposit.unfinished.landed('$100'));
  await check(page, '13-left-unfinished');
  await note.getByRole('button', { name: en.goal.explore.deposit.unfinished.back }).click();
  await expect(pane(page)).toHaveAttribute('data-state', 'approved');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
});

test('a quote that ran out before the press: the pane says so and offers a fresh check', async ({
  page,
}) => {
  // The stub's orders run out at a fixed time of its own: the page's clock starts a little before it.
  await page.clock.install({ time: new Date('2026-10-05T15:10:00Z') });
  await signIn(page);
  const placed = page.waitForResponse(
    (res) => res.url().endsWith('/v1/orders') && res.request().method() === 'POST',
  );
  await toSteps(page);
  const { expiresAt } = (await (await placed).json()) as { expiresAt: number };
  const left = expiresAt * 1000 - (await page.evaluate(() => Date.now()));
  await page.clock.fastForward(left + 2_000);
  const card = pane(page).locator('[data-ui="invest-card"]');
  await expect(card.locator('[data-ui="invest-old"]')).toHaveText(en.invest.old);
  await expect(card.locator('[data-ui="order-step"]')).toHaveCount(0);
  await check(page, '12-quote-ran-out');
  await card.getByRole('button', { name: en.invest.again }).click();
  await expect(card.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/goal$/);
});

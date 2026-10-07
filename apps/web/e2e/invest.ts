import { expect, type Page } from '@playwright/test';
import { dictionary } from '../i18n';

// The invest card as a person takes it (InvestCard, gate INVEST-ONE-PRESS): the amount (left as it
// is, or `amount`), the funds, which the card shows because the wallet starts short (MOCK cash from
// the stub, or test funds where the stub says it can send them), and the trust notice ticked (every
// e2e buy is a first one). It ends with the order on the card, every step to read, and its one
// button ready to press: nothing has been signed.

const en = dictionary('en');

export async function readyToInvest(
  page: Page,
  o: { amount?: string; fund?: 'mock' | 'test'; dollars?: string } = {},
) {
  if (o.amount !== undefined)
    await page.getByLabel(en.buy.amount.label, { exact: true }).fill(o.amount);
  const card = page.locator('[data-ui="invest-card"]');
  const press = card.getByRole('button', { name: en.invest.press(o.dollars ?? '$40') });
  // the wallet is short: the card says what is missing, offers the way to fill it, and no order
  await expect(card.locator('[data-ui="funding-step"]')).toBeVisible();
  await expect(card.locator('[data-ui="order-step"]')).toHaveCount(0);
  await expect(press).toHaveAttribute('aria-disabled', 'true');
  await card
    .getByRole('button', {
      name: o.fund === 'test' ? en.buy.funding.testFunds : en.buy.funding.mockFund,
    })
    .click();
  // the wallet holds it now: the funds leave the card, and the order is there with its steps
  await expect(card.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
  // test funds that were sent are still said; sample cash on the mock leaves nothing to say
  if (o.fund === 'test') await expect(card.locator('[data-ui="test-funds-sent"]')).toBeVisible();
  else await expect(card.locator('[data-ui="funding-step"]')).toHaveCount(0);
  // a first buy in this browser: the notice is on the card, and holds the press until it is ticked
  await expect(press).toHaveAttribute('aria-disabled', 'true');
  await page.getByLabel(en.trust.accept).check();
  await expect(press).not.toHaveAttribute('aria-disabled', 'true');
  return press;
}

/**
 * From the Invest screen to a plan's own page, as a person on a phone does (gate INVEST-TWO-PANE):
 * the goal said in one sentence that names every fact, what our server asks to be sure of confirmed,
 * "Build my plan", the plan opened from the line
 * at the foot, then its own page.
 */
export async function planFromGoal(page: Page, goal: string) {
  const box = page.locator('[data-ui="invest-chat"] textarea');
  await box.fill(goal);
  await box.press('Enter');
  // what was understood is said back, and the plan is built only when asked for
  await expect(page.locator('[data-ui="invest-turns"] [data-who="person"]').first()).toContainText(
    goal,
  );
  // Signed in, our server's intake reads the goal. With no model it asks each thing it read once,
  // with what it read as the first reply: each is confirmed by a press, until the build is offered.
  const build = page.getByRole('button', { name: en.talk.replies.build });
  const first = page.locator('[data-ui="invest-replies"] button').first();
  const said = page.locator('[data-ui="invest-turns"] [data-who="person"]');
  for (let asked = 0; asked < 8; asked++) {
    await expect(first).toBeVisible();
    if (await build.isVisible()) break;
    const before = await said.count();
    await first.click();
    await expect(said).toHaveCount(before + 1);
  }
  await build.click();
  // on a phone the plan is the line at the foot, which opens
  await page.getByRole('button', { name: en.talk.pane.open }).click();
  const pane = page.locator('[data-ui="invest-pane"]');
  // signed in, the invest card is under the plan (`invest`); a visitor has the plan alone
  await expect(pane).toHaveAttribute('data-state', /^(plan|invest)$/);
  await expect(pane.locator('[data-ui="plan-pane"]')).toBeVisible();
  await pane.getByRole('link', { name: en.talk.pane.ownPage }).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
}

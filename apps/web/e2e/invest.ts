import { expect, type Page } from '@playwright/test';
import { dictionary } from '../i18n';

// The invest card as a person takes it (InvestCard, gate INVEST-ONE-PRESS): the amount (left as it
// is, or `amount`), the funds, which the card shows because the wallet starts short (MOCK cash from
// the stub, or test funds where the stub says it can send them), and the trust notice ticked (every
// e2e buy is a first one). It ends with the order on the card, every step to read, and its one
// button ready to press: nothing has been signed.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

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
 * To a plan's own page by its link, as the portfolio's "See the plan" or an agent's link leads there:
 * the stub stores a $40 plan to grow over three years as the person's own
 * (`POST /v1/baskets/personalize`), on the chain it runs, and the page reads it back by its id. The
 * link is opened through sign-in, because a page load gives the throwaway wallet new keys.
 */
export async function openPlan(page: Page) {
  const made = await page.request.post(`${STUB}/v1/baskets/personalize`, {
    data: {
      sheet: {
        basketType: 'standard',
        goal: 'grow',
        amountUsd: 40,
        horizonMonths: 36,
        risk: 'medium',
        themes: [],
        country: 'BR',
        chains: [process.env.E2E_CHAIN ?? 'solana'],
        rules: { useHoldings: false, glide: true },
        language: 'en',
      },
    },
  });
  expect(made.status()).toBe(200);
  const { id } = (await made.json()) as { id: string };
  await page.goto(`/sign-in?next=${encodeURIComponent(`/plan/${id}`)}`);
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
}

import { expect, type Page } from '@playwright/test';
import { dictionary } from '../i18n';

// The buy's four steps as a person takes them (BuySteps): the amount (left as it is, or `amount`),
// the funds (MOCK cash from the stub, or test funds where the stub says it can send them), the trust
// notice ticked, then the last step open with its one primary button. Only the open step is visible,
// so each "Continue" is the open step's.

const en = dictionary('en');

export async function throughBuySteps(
  page: Page,
  o: { amount?: string; fund?: 'mock' | 'test' } = {},
) {
  if (o.amount !== undefined)
    await page.getByLabel(en.buy.amount.label, { exact: true }).fill(o.amount);
  await page.getByRole('button', { name: en.buy.steps.next }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`^${en.buy.steps.names.funds}`), expanded: true }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: o.fund === 'test' ? en.buy.funding.testFunds : en.buy.funding.mockFund,
    })
    .click();
  if (o.fund === 'test') await expect(page.locator('[data-ui="test-funds-sent"]')).toBeVisible();
  await expect(page.getByText(en.buy.funding.ok)).toBeVisible();
  await page.getByRole('button', { name: en.buy.steps.next }).click();
  await page.getByLabel(en.trust.accept).check();
  await page.getByRole('button', { name: en.buy.steps.next }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`^${en.buy.steps.names.review}`), expanded: true }),
  ).toBeVisible();
}

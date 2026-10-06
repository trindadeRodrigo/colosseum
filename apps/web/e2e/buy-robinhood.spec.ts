import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';

// A person's buy on Robinhood Chain, end to end in a browser, on the mock chain: the stub runs its
// mock as Robinhood Chain (E2E_CHAIN=robinhood sets STUB_CHAIN), so the order is what apps/api plans
// on an EVM chain: an approval of the deposit, then a create that deposits and trades. The executor
// builds each step from the stub, holds it to the review with the real guard, has the throwaway wallet
// sign it and reports it, until both steps confirm. Runs only with E2E_CHAIN=robinhood:
//
//   E2E_CHAIN=robinhood E2E_WEB_PORT=3110 E2E_API_PORT=3911 pnpm --filter @colosseum/web e2e buy-robinhood

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
const NAME = 'Robinhood Chain';

test.skip(
  process.env.E2E_CHAIN !== 'robinhood',
  'the stub runs Robinhood Chain only with E2E_CHAIN=robinhood',
);

test('a buy on Robinhood Chain on the mock: an approval, then a create that buys, both confirmed', async ({
  page,
}) => {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: en.signIn.passkey.create }).click();
  await page.getByRole('button', { name: NAME }).click();
  await page.getByRole('button', { name: en.chain.pick.confirm(NAME) }).click();
  await expect(page).toHaveURL(/\/goal$/);

  const goal = page.getByRole('textbox', { name: en.goal.composer.label, exact: true });
  await goal.fill('Grow $40 for three years, medium risk');
  await goal.press('Enter');
  // The intake asks what the goal leaves open, then says back what it understood (GUIDED-INTAKE).
  await page.getByLabel('How much do you put in, in dollars?', { exact: true }).fill('40');
  await page.getByRole('button', { name: en.goal.intake.questions.reply }).click();
  await expect(page.getByText('You set growing it with $40 over 36 months')).toBeVisible();
  await page.getByRole('button', { name: en.goal.intake.readBack.confirm }).click();
  await page.getByRole('link', { name: en.goal.built.done.see(3) }).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
  await page.getByRole('radio', { name: en.plan.choice.names.carry }).check();
  await page
    .getByRole('link', { name: en.plan.choice.picker.buy(en.plan.choice.names.carry) })
    .click();

  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await page.getByRole('button', { name: en.buy.funding.mockFund }).click();
  await expect(page.getByText(en.buy.funding.ok)).toBeVisible();
  await page.getByLabel(en.trust.accept).check();
  await page.getByRole('button', { name: en.buy.review('$40') }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText(en.order.kind.approve);
  await expect(steps.nth(1)).toContainText(en.order.kind.create_vault);
  await expect(steps.nth(1)).toContainText('receive at least');

  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(en.order.outcome.done(NAME), {
    timeout: 90_000,
  });
  for (let i = 0; i < 2; i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');
});

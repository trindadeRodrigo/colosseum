import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { throughBuySteps } from './buy-steps';

// A person's buy on Robinhood Chain, end to end in a browser, on the mock chain: they switch the bar to
// Robinhood Chain before they sign in, see its shelf, and the plan they build is on it (CHAIN-SWITCH).
// The stub runs its mock as Robinhood Chain (E2E_CHAIN=robinhood sets STUB_CHAIN), so the order is what apps/api plans
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
  // signed out, the bar's switcher moves the shelf to Robinhood Chain, and the address names it
  await page.goto('/shelf');
  const switcher = page.locator('[data-ui="chain-switch"] > button');
  await expect(switcher).toHaveAttribute('aria-label', en.chain.switch.current('Solana'), {
    timeout: 60_000,
  });
  await switcher.click();
  await page.locator('[data-ui="chain-switch-panel"] button[data-chain="robinhood"]').click();
  await expect(switcher).toHaveAttribute('aria-label', en.chain.switch.current(NAME));
  await expect(page).toHaveURL(/\/shelf\?chain=robinhood$/);
  await expect(page.locator('main')).toContainText(en.shared.shelf.lead(NAME));

  // the bar's "Sign in" opens the sign-in dialog over the goal (SIGN-IN-FLOW); nothing more is asked
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
  // signed in, the bar's one account control is on the chain the switcher was on
  await expect(page.locator('header [data-ui="account-menu-button"]')).toHaveAttribute(
    'data-chain',
    'robinhood',
  );

  const goal = page.getByRole('textbox', { name: en.goal.composer.label, exact: true });
  await goal.fill('Grow $40 for three years, medium risk');
  await goal.press('Enter');
  await page.getByLabel(en.goal.fields.amount, { exact: true }).fill('40');
  await page.getByLabel(en.goal.fields.country, { exact: true }).selectOption('BR');
  await page.getByRole('button', { name: en.goal.sheet.build }).click();
  await page.getByRole('link', { name: en.goal.built.done.see }).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
  await named(page);
  await page.getByRole('link', { name: en.plan.buy }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await throughBuySteps(page);
  await named(page);
  await page.getByRole('button', { name: en.buy.review('$40') }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps).toHaveCount(2);
  await expect(steps.nth(0)).toContainText(en.order.kind.approve);
  await expect(steps.nth(1)).toContainText(en.order.kind.create_vault);
  await expect(steps.nth(1)).toContainText('receive at least');
  await named(page);

  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(en.order.outcome.done(NAME), {
    timeout: 90_000,
  });
  for (let i = 0; i < 2; i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');
  // each step's link names the explorer it opens, and each line of the activity its chain
  await expect(steps.locator('[data-ui="explorer-name"]')).toHaveText([
    en.chain.explorers.robinhood,
    en.chain.explorers.robinhood,
  ]);
  await expect(page.locator('[data-ui="execution-list"] li [data-ui="chain-badge"]')).toHaveText([
    NAME,
    NAME,
  ]);
  await named(page);

  // the monitor: the vault the buy opened, badged with its chain, its cash in tUSDG
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page
    .locator('[data-ui="compact-nav-sheet"]')
    .getByRole('link', { name: en.shell.portfolio })
    .click();
  await expect(page).toHaveURL(/\/monitor$/);
  const vault = page.locator('[data-ui="vault"]');
  await expect(vault).toHaveCount(1);
  await expect(vault.locator('[data-ui="chain-badge"]').first()).toHaveText(NAME);
  await expect(vault).toContainText('tUSDG');
  await named(page);
});

/** The screen names Robinhood Chain with its badge, and nowhere says USDC: its dollar is tUSDG. */
async function named(page: Page) {
  const badges = page.locator('main [data-ui="chain-badge"]');
  await expect(badges.first()).toHaveText(NAME);
  for (const chain of await badges.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-chain')),
  ))
    expect(chain).toBe('robinhood');
  await expect(page.locator('main')).not.toContainText(/usdc/i);
}

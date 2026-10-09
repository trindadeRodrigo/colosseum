import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { readyToInvest } from './invest';
import { inTheme } from './theme';

// A mix, end to end on the mock chain (gate ANY-COMPOSITION, #191): a new goal's mix from the
// conversation, taken through the deposit step (gate DEPOSIT-STEP: one amount, the goal and risk the
// person said, the weights changed by hand only behind their own control), reviewed with each warning
// ticked, stored as a plan and bought through the unchanged buy; and a vault's own weights, edited by hand, reviewed, ordered and
// signed step by step through the guard, which holds the targets step to the reviewed targets. Every screen is checked with axe at
// 375 px, in light and in dark, and for no sideways scroll.

const en = dictionary('en');
const pt = dictionary('pt');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const WIDTHS = [375, 1280, 1440] as const;

async function check(page: Page, name: string) {
  // A pointer resting on the mix lights one piece and dims the others (MixJoint): the page is read
  // with the pointer off it.
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
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
    if (SHOTS) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 812 });
        await page.screenshot({
          path: `${SHOTS}/mix-${name}-${width}-${theme}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
  }
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

/** Ticks every warning of the review on the page, and checks the confirm waits for the last one. */
async function tickAll(page: Page, confirm: string) {
  const press = page.getByRole('button', { name: confirm });
  const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
  const n = await boxes.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) {
    await expect(press).toHaveAttribute('aria-disabled', 'true');
    await boxes.nth(i).check();
  }
  await expect(press).not.toHaveAttribute('aria-disabled', 'true');
  return press;
}

/** Says a goal in the conversation and opens the deposit step of the mix it proposes. */
async function toDeposit(page: Page, words: string, use = en.mix.preview.deposit) {
  const box = page.locator('textarea');
  await box.fill(words);
  await box.press('Enter');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  await strategy.getByRole('button', { name: use, exact: true }).click();
  return page.locator('[data-ui="deposit-step"]');
}
const dollarsOf = (step: ReturnType<Page['locator']>, asset: string) =>
  step.locator(`[data-asset="solana:${asset}"] [data-ui="mix-line-amount"]`);

test('a new goal’s mix from the conversation: one amount, edited by hand, reviewed, ticked, stored and bought', async ({
  page,
}) => {
  await signIn(page);
  const step = await toDeposit(page, 'A broad fund and some gold, to grow, at medium risk');
  // no form: what the person said, one amount to type, and the editor closed
  await expect(step.locator('[data-ui="deposit-purpose"]')).toContainText(
    en.mix.deposit.purpose('grow', 'medium'),
  );
  await expect(step.locator('select')).toHaveCount(0);
  await expect(step.locator('input')).toHaveCount(1);
  await expect(step.getByText(en.mix.editor.unit)).toHaveCount(0);
  await expect(dollarsOf(step, 'spy')).toHaveText(`—${en.mix.deposit.unchecked}`);
  await check(page, 'deposit-empty');

  // the amount, and what it becomes in each asset as the server checked it
  await page.getByLabel(en.buy.amount.label, { exact: true }).fill('100');
  await expect(dollarsOf(step, 'spy')).toHaveText('$50.00');
  await expect(dollarsOf(step, 'gold')).toHaveText('$50.00');
  await expect(step.locator('[data-ui="deposit-check"]')).toHaveText(en.mix.deposit.checked);
  await check(page, 'deposit-amount');

  // changing the mix is the conversation's: the box takes focus and the step stays
  await step.getByRole('button', { name: en.mix.deposit.changeMix }).click();
  await expect(page.locator('textarea')).toBeFocused();
  await expect(page.getByLabel(en.buy.amount.label, { exact: true })).toHaveValue('100');

  // by hand, behind its own control: SPY down to 40 leaves 10 in cash, and the mix says it is edited
  const open = step.getByRole('button', { name: en.mix.deposit.editByHand });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  const spy = page.getByLabel(en.mix.editor.weight('SPY'), { exact: true });
  await expect(spy).toHaveValue('50');
  await spy.fill('40');
  await expect(page.locator('[data-ui="targets-cash"]')).toHaveText(en.mix.editor.cash('10%'));
  await expect(step.locator('[data-ui="deposit-edited"]')).toHaveText(en.mix.deposit.edited);
  await expect(dollarsOf(step, 'spy')).toHaveText('$40.00');
  await expect(dollarsOf(step, 'usdc')).toHaveText('$10.00');
  await check(page, 'deposit-editor');
  await page.getByRole('button', { name: en.mix.deposit.reviewOf('$100') }).click();

  const lines = page.locator('[data-ui="mix-review-lines"]');
  await expect(lines).toContainText('SPY');
  await expect(lines).toContainText('$40.00');
  await expect(lines).toContainText('$10.00');
  await expect(lines.locator('[data-ui="exit-ceiling"]').first()).toContainText(en.mix.review.tier);
  await check(page, 'goal-review');
  const confirm = await tickAll(page, en.mix.goal.confirm);
  await confirm.click();

  // the stored plan, bought through the unchanged buy, at the amount reviewed
  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await expect(page.getByLabel(en.buy.amount.label, { exact: true })).toHaveValue('100');
  const press = await readyToInvest(page, { dollars: '$100' });
  await press.click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
});

test('the deposit step asks by one tap what the conversation did not hear, and holds the amount to its limits', async ({
  page,
}) => {
  await signIn(page);
  const step = await toDeposit(page, 'A broad fund and some gold');
  await expect(step.locator('[data-ui="deposit-purpose"]')).toHaveCount(0);
  const goal = step.getByRole('group', { name: en.mix.deposit.askGoal });
  const risk = step.getByRole('group', { name: en.mix.deposit.askRisk });
  await expect(goal.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(risk.locator('[aria-pressed="true"]')).toHaveCount(0);
  const amount = page.getByLabel(en.buy.amount.label, { exact: true });
  await amount.fill('100');
  // nothing is checked for a goal nobody said
  await expect(step.locator('[data-ui="deposit-check"]')).toHaveText(en.mix.deposit.needPurpose);
  await expect(dollarsOf(step, 'spy')).toHaveText(`—${en.mix.deposit.unchecked}`);
  await check(page, 'deposit-unknown');
  await goal.getByRole('button', { name: en.mix.goal.goals.grow }).click();
  await risk.getByRole('button', { name: en.mix.goal.risks.high }).click();
  await expect(dollarsOf(step, 'spy')).toHaveText('$50.00');

  // below the least: said on the field, the figures gone, the press held
  await amount.fill('5');
  await expect(step.getByText(en.mix.deposit.errors.belowMin)).toBeVisible();
  await expect(amount).toHaveAttribute('aria-invalid', 'true');
  await expect(dollarsOf(step, 'spy')).toHaveText(`—${en.mix.deposit.unchecked}`);
  await expect(step.getByRole('button', { name: en.mix.deposit.review })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await check(page, 'deposit-error');
  // a quick amount puts it right
  await step.getByRole('button', { name: en.mix.deposit.quickOne('$500') }).click();
  await expect(amount).toHaveValue('500');
  await expect(dollarsOf(step, 'gold')).toHaveText('$250.00');
});

test('the deposit step by keyboard, in Portuguese', async ({ page }) => {
  await signIn(page);
  await page
    .locator('[data-ui="language-switch"]')
    .getByRole('button', { name: 'Português' })
    .click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  // by keyboard from the conversation: Enter sends, Enter on "Depositar" opens the step
  const box = page.locator('textarea');
  await box.fill('Um fundo amplo e ouro, para crescer, com risco alto');
  await box.press('Enter');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  await expect(strategy.locator('[data-ui="weight-notes"]')).toBeVisible();
  await strategy.getByRole('button', { name: pt.mix.preview.deposit, exact: true }).press('Enter');
  const step = page.locator('[data-ui="deposit-step"]');
  await expect(step.locator('[data-ui="deposit-purpose"]')).toContainText(
    pt.mix.deposit.purpose('grow', 'high'),
  );
  // focus lands on the amount: the person types straight away
  const amount = page.getByLabel(pt.buy.amount.label, { exact: true });
  await expect(amount).toBeFocused();
  await page.keyboard.type('100,50');
  await expect(dollarsOf(step, 'spy')).toHaveText(/50,25/);
  await check(page, 'deposit-pt');
  // from the amount: the three quick amounts, the drawing of the mix (one stop), then the press,
  // which Enter takes to the review
  const press = page.getByRole('button', { name: pt.mix.deposit.reviewOf('US$ 100,50') });
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
  await expect(press).toBeFocused();
  await page.keyboard.press('Enter');
  // the review's heading takes focus, and it says what the mix was checked for
  await expect(page.getByRole('heading', { name: pt.mix.review.title })).toBeFocused();
  await expect(page.locator('[data-ui="mix-review-purpose"]')).toHaveText(
    pt.mix.deposit.purpose('grow', 'high'),
  );
  await expect(page.locator('[data-ui="mix-review-total"]')).toContainText('100,50');
  await page.getByRole('button', { name: pt.mix.deposit.backToDeposit }).press('Enter');
  // back on the step: the press that led to the review, with the amount as it was
  await expect(press).toBeFocused();
  await expect(amount).toHaveValue('100,50');
  await step.getByRole('button', { name: pt.mix.deposit.backToProposal }).press('Enter');
  await expect(
    strategy.getByRole('button', { name: pt.mix.preview.deposit, exact: true }),
  ).toBeFocused();
});

test('a vault’s own weights, edited by hand: reviewed, ordered, every step signed', async ({
  page,
}) => {
  await signIn(page);
  const shownWallet = page.locator('[data-ui="account-menu-button"] span[title]').first();
  await expect(shownWallet).toHaveAttribute('title', /.+/);
  const owner = await shownWallet.getAttribute('title');
  const source = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner,
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:nvda', weightBps: 4000 },
      ],
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const { address } = await source.json();

  // through the app's own links: the throwaway sign-in does not outlive a page load
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page
    .locator('[data-ui="compact-nav-sheet"]')
    .getByRole('link', { name: en.shell.portfolio })
    .click();
  await page
    .locator('[data-ui="vault-summary"]')
    .getByRole('link', { name: en.portfolio.overview.open })
    .click();
  await expect(page).toHaveURL(new RegExp(`/vaults/solana/${address}$`));
  await page.getByRole('link', { name: en.mix.editor.edit }).click();
  await expect(page).toHaveURL(new RegExp(`/vaults/solana/${address}/targets$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.mix.editor.title);
  // from 60/40 to 70 SPY, nothing in NVDA, 30 left in cash
  await page.getByLabel(en.mix.editor.weight('SPY'), { exact: true }).fill('70');
  await page.getByRole('button', { name: en.mix.editor.remove('NVDA') }).click();
  await expect(page.locator('[data-ui="targets-cash"]')).toHaveText(en.mix.editor.cash('30%'));
  await check(page, 'editor');
  await page.getByRole('button', { name: en.mix.vault.review }).click();

  await expect(page.locator('[data-ui="mix-review-lines"]')).toContainText('SPY');
  await check(page, 'vault-review');
  const confirm = await tickAll(page, en.mix.vault.confirm);
  await confirm.click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole('region', { name: en.mix.order.title })).toContainText('70%');
  await check(page, 'vault-order');
  await page.getByRole('button', { name: en.mix.order.signTargets }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  const vault = await page.request.get(`${STUB}/v1/vaults/solana/${address}`);
  const read = await vault.json();
  expect(
    read.vault.positions
      .filter((p: { targetBps: number }) => p.targetBps > 0)
      .map((p: { asset: string; targetBps: number }) => [p.asset, p.targetBps]),
  ).toEqual([['solana:spy', 7000]]);
});

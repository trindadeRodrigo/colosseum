import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { readyToInvest } from './invest';
import { inTheme } from './theme';

// Shared portfolios end to end in a browser, on the mock chain (WEB-4): sign in with the throwaway
// wallet, share an already-owned vault's fixture strategy, review it and sign it, find it on the shelf, open its
// page, buy it (which opens a vault that follows it), and see the vault and its public page. Every
// signature goes through the order screen's executor and the real guard: the publish is held to the
// form's id, text and weights, the buy to the version the page showed. A second portfolio holds gold,
// which has no price oracle on the stub, and offers no auto-follow (gate GOLD-ONE-TAP). Every screen is
// checked with axe at 375 px, in light and in dark, and for no sideways scroll.

const en = dictionary('en');

// These run on the stub's Solana; the Robinhood Chain run (E2E_CHAIN=robinhood) is buy-robinhood.spec.ts.
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
const SHOTS = process.env.SCREENSHOTS_DIR;
const shot = (name: string) => `${SHOTS}/${name}.png`;
const WIDTHS = [375, 1280] as const;
const REFERENCE = new URL('../../../.design/branding/working-brand/patterns/', import.meta.url)
  .href;

async function check(page: Page, name: string) {
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
        await page.screenshot({ path: shot(`shared-${name}-${width}-${theme}`), fullPage: true });
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
  }
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  // the bar's "Sign in" opens the sign-in dialog over the goal (SIGN-IN-FLOW); the person stays there
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

/**
 * The shelf, by the bar: the throwaway wallet lives in the page, so every move stays inside it. The
 * bar is his compact bar, whose links are in the sheet under the menu button at 375 px; the shelf is
 * his "Products".
 */
async function toShelf(page: Page) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page
    .locator('[data-ui="compact-nav-sheet"]')
    .getByRole('link', { name: en.shell.products })
    .click();
  // the address names the chain the shelf shows (CHAIN-SWITCH)
  await expect(page).toHaveURL(/\/shelf\?chain=solana$/);
}

/** A portfolio's page, from the shelf. */
async function toFamily(page: Page, name: string) {
  await toShelf(page);
  await page.locator('[data-ui="shelf-card"]').getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
}

/** Share an owned source's exact strategy and sign the publish, through the unchanged guard. */
async function publish(page: Page, name: string, weights: [string, string][], photograph = false) {
  await toShelf(page);
  await page.getByRole('link', { name: en.shared.shelf.publish }).first().click();
  await expect(page.getByText(en.shared.publish.noVaults, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: en.shared.publish.review })).toBeDisabled();
  await expect(page.locator('[data-ui="publish-row"]')).toHaveCount(0);
  const shownWallet = page.locator('[data-ui="account-menu-button"] span[title]').first();
  await expect(shownWallet).toHaveAttribute('title', /.+/);
  const owner = await shownWallet.getAttribute('title');
  const source = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner,
      targets: weights.map(([asset, weight]) => ({ asset, weightBps: Number(weight) * 100 })),
    },
  });
  expect(source.ok(), await source.text()).toBe(true);
  const { address } = await source.json();
  await toShelf(page);
  await page.getByRole('link', { name: en.shared.shelf.publish }).first().click();
  await expect(page).toHaveURL(/\/publish$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.shared.publish.title);
  await page
    .getByRole('combobox', { name: en.shared.publish.sourceVault, exact: true })
    .selectOption(address);
  await page.getByLabel(en.shared.publish.name, { exact: true }).fill(name);
  await page.getByLabel(en.shared.publish.copy, { exact: true }).fill('Three test tokens.');
  const allocation = page.getByRole('region', { name: en.shared.publish.assets, exact: true });
  const symbols: Record<string, string> = {
    'solana:spy': 'SPY',
    'solana:nvda': 'NVDA',
    'solana:tsla': 'TSLA',
    'solana:gold': 'Gold',
  };
  const rows = allocation.locator('[data-ui="publish-row"]');
  await expect(rows).toHaveCount(weights.length);
  for (const [asset, weight] of weights) {
    const row = rows.filter({ has: page.getByText(symbols[asset] ?? asset, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${weight}%`);
  }
  await expect(allocation.locator('input,select')).toHaveCount(0);
  await expect(page.locator('[data-ui="family-id"]')).not.toHaveText('—');
  if (photograph) await check(page, 'publish');
  await page.getByRole('button', { name: en.shared.publish.review }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.order.review.title);
  await expect(page.getByRole('region', { name: en.order.shared.publishTitle })).toContainText(
    name,
  );
  await page.getByLabel(en.order.review.consent.publish).check();
  if (photograph) await check(page, 'publish-review');
  await page.getByRole('button', { name: en.order.shared.signPublish }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
}

test('publish a portfolio, find it on the shelf, buy it and follow it, every step signed', async ({
  page,
}) => {
  await signIn(page);
  await publish(
    page,
    'Three of the largest',
    [
      ['solana:spy', '40'],
      ['solana:nvda', '30'],
      ['solana:tsla', '30'],
    ],
    true,
  );

  await toShelf(page);
  const card = page.locator('[data-ui="shelf-card"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Three of the largest');
  await expect(card).toContainText('SPY 40%');
  await check(page, 'shelf');

  await card.getByRole('link', { name: 'Three of the largest' }).click();
  await expect(page).toHaveURL(/\/indexes\/three-of-the-largest$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Three of the largest');
  // The mock has no chain to read: the page says the version is the server's word.
  await expect(page.locator('[data-ui="source-mark"]').first()).toContainText(
    en.shared.check.notChecked,
  );
  await expect(page.locator('[data-ui="auto-follow-offer"]')).toHaveAttribute(
    'data-offered',
    'true',
  );
  await check(page, 'family');

  // The invest step is on the portfolio's own page, under what it holds (gate PRODUCTS-PLAN-PANE).
  const press = await readyToInvest(page, { amount: '40' });
  await check(page, 'family-buy');
  // the review is on the invest card, under where the version and weights were read from
  await expect(page).toHaveURL(/\/indexes\/three-of-the-largest$/);
  const steps = page.locator('[data-ui="order-step"]');
  // a vault that follows the portfolio, opened with the deposit, then a swap per asset
  await expect(steps).toHaveCount(4);
  await expect(page.locator('[data-ui="source-mark"]')).toBeVisible();
  await check(page, 'family-review');
  await press.click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  for (let i = 0; i < 4; i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');

  // The vault follows it now, and its public page reads it from the chain.
  await toFamily(page, 'Three of the largest');
  const mine = page.locator('[data-ui="my-vault"]');
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText(en.shared.vaults.following);
  await expect(mine.getByRole('button', { name: en.shared.vaults.autoOn })).toBeVisible();
  await mine.getByRole('link').first().click();
  await expect(page).toHaveURL(/\/vaults\/solana\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.shared.vault.title);
  await expect(page.locator('[data-ui="vault-screen"]')).toContainText('SPY');
  await check(page, 'vault');
});

test('a portfolio that holds gold offers no auto-follow, and says why', async ({ page }) => {
  await signIn(page);
  await publish(page, 'With some gold', [
    ['solana:spy', '40'],
    ['solana:nvda', '30'],
    ['solana:gold', '30'],
  ]);
  await toFamily(page, 'With some gold');
  const offer = page.locator('[data-ui="auto-follow-offer"]');
  await expect(offer).toHaveAttribute('data-offered', 'false');
  await expect(offer).toContainText(en.shared.offer.noOracle('Gold', 'Solana'));
  await check(page, 'family-gold');
});

test('the guide, photographed beside the screens', async ({ page }) => {
  test.skip(!SHOTS, 'only when SCREENSHOTS_DIR names a folder');
  for (const width of WIDTHS)
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${REFERENCE}guidelines.html${theme === 'dark' ? '?theme=dark' : ''}`);
      for (const part of ['components', 'legbar', 'provenance'])
        await page
          .locator(`#${part}`)
          .screenshot({ path: shot(`guide-${part}-${width}-${theme}`) });
      await page.goto(`${REFERENCE}prototypes/hero-3d.html`);
      await page
        .locator('article.case')
        .first()
        .screenshot({ path: shot(`prototype-case-${width}`) });
      await page.locator('#updates').screenshot({ path: shot(`prototype-updates-${width}`) });
    }
});

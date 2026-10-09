import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// Sign-in in two steps at most, in the dialog over the page (SIGN-IN-FLOW, SIGN-IN-PAIR), on the
// throwaway wallet of development: "Create a passkey" and "Use my passkey" are a pair at the top of
// the passkey side, and neither asks for a chain: the person starts on the chain the bar shows
// (CHAIN-SWITCH). The wallets found are one list, one entry each, and a wallet that signs on both
// families asks which chain before it signs. The throwaway wallet announces itself on both, as
// Phantom and Backpack do.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

/** axe on the open dialog at 375 px, in light and in dark, and nothing wider than the phone. */
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
  }
}

test.beforeEach(async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
});

test('someone new: "Create a passkey" is there from the start with what it opens, and no chain is asked', async ({
  page,
}) => {
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  const create = dialog.getByRole('button', { name: en.signIn.passkey.create });
  await expect(create).toBeVisible({ timeout: 60_000 });
  // focus opens on the heading, so Enter starts nothing: nobody is signed in and the dialog stays
  await expect(dialog.locator('[data-ui="sign-in-screen"] > header h2')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(1);
  await expect(page.locator('header [data-ui="account-menu-button"]')).toHaveCount(0);
  // the first thing Tab reaches, with its warning beside it before any press
  await page.keyboard.press('Tab');
  await expect(create).toBeFocused();
  await expect(dialog.locator('[data-ui="passkey-create-note"]')).toHaveText(
    en.signIn.passkey.createNote,
  );
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await check(page, 'the sign-in dialog, first open');
  await dialog.locator('[data-ui="passkey-what"] summary').click();
  await dialog.locator('[data-ui="wallet-other"] summary').click();
  await check(page, 'the sign-in dialog, with its two disclosures open');
  await create.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('header [data-ui="account-menu-button"]')).toHaveAttribute(
    'data-chain',
    'solana',
  );
});

test('someone with a passkey: "Use my passkey" signs in, and leads the pair the next time on this browser', async ({
  page,
}) => {
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  const passkey = dialog.getByRole('button', { name: en.signIn.passkey.continue });
  await expect(passkey).toBeVisible({ timeout: 60_000 });
  // nothing is known about this browser yet: the two are equals
  await expect(dialog.locator('[data-ui="passkey-pair"]')).toHaveAttribute('data-leads', 'neither');
  await passkey.click();
  await expect(dialog).toHaveCount(0);
  const chip = page.locator('header [data-ui="account-menu-button"]');
  await expect(chip).toHaveAttribute('data-chain', 'solana');
  // signed out and back at the dialog, the one who has a passkey leads; the order has not moved
  await page.getByRole('button', { name: en.shell.menu, exact: true }).click();
  await page.locator('[data-ui="compact-nav-sheet"] [data-ui="sign-out"]').click();
  await page.keyboard.press('Escape');
  await page.locator('header a[href^="/sign-in"]').click();
  await expect(dialog.locator('[data-ui="passkey-pair"]')).toHaveAttribute(
    'data-leads',
    'continue',
    { timeout: 60_000 },
  );
  await expect(passkey).toHaveAttribute('data-variant', 'primary');
  await expect(dialog.locator('[data-variant="primary"]')).toHaveCount(1);
  await expect(dialog.locator('[data-ui="passkey-pair"] button').first()).toHaveAttribute(
    'data-act',
    'passkey-create',
  );
});

test('a wallet: one list with where each vault lives, and the chain asked for a wallet that does both', async ({
  page,
}) => {
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  // the list is there from the start, inside the dialog: no button opens it
  const list = dialog.getByRole('list', { name: en.signIn.wallet.found });
  await expect(list).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  // one entry for the wallet, whatever families it signs on, no chain in its name, and under the
  // name where a plan made with it lives; then "Other wallet"
  await expect(list.locator('button[data-wallet]')).toHaveCount(1);
  await expect(list.locator('[data-ui="wallet-name"]')).toHaveText('Throwaway wallet');
  await expect(list.locator('[data-ui="wallet-lives"]')).toHaveText(
    en.signIn.wallet.livesEither('Solana', 'Robinhood Chain'),
  );
  // under the list, as words: what to do about a wallet that is not in it
  await expect(list.getByRole('button')).toHaveCount(1);
  await dialog.locator('[data-ui="wallet-other"] summary').click();
  await expect(dialog.locator('[data-ui="wallet-other-body"]')).toHaveText(
    en.signIn.wallet.otherBody,
  );
  await list.getByRole('button', { name: 'Throwaway wallet' }).click();
  const chains = dialog.getByRole('group', { name: en.signIn.wallet.chains });
  await expect(chains).toContainText(en.signIn.wallet.both('Throwaway wallet'));
  await chains.getByRole('button', { name: 'Solana' }).click();
  // signed in with the Solana side: the plan lives there, nothing more is asked, and the dialog closes
  // on the page the person was on
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
  await expect(page.locator('header [data-ui="account"]')).toBeVisible();
  // the chain that stands is the Solana side's: the bar shows that wallet's address, not an EVM one
  const address = page.locator('header [data-ui="account"] .font-mono[title]');
  await expect(address).toHaveAttribute('title', /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';

// Sign-in in two steps at most (SIGN-IN-FLOW, Thom, Oct 6), on the throwaway wallet of development:
// "Continue with a passkey" signs in and asks the chain once, as CHAIN-PICK has it; "Connect a wallet"
// lists the wallets found, one entry each, and a wallet that signs on both families asks which chain
// before it signs. The throwaway wallet announces itself on both, as Phantom and Backpack do.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

test.beforeEach(async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
});

test('a passkey: one button, then the chain is asked once', async ({ page }) => {
  await page.goto('/sign-in');
  const passkey = page.getByRole('button', { name: en.signIn.passkey.continue });
  await expect(passkey).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /create a passkey|use a passkey/i })).toHaveCount(
    0,
  );
  await passkey.click();
  await expect(page.getByRole('heading', { name: en.chain.pick.title })).toBeVisible();
});

test('a wallet: one button, its own list, and the chain asked for a wallet that does both', async ({
  page,
}) => {
  await page.goto('/sign-in');
  const connect = page.getByRole('button', { name: en.signIn.wallet.connect });
  await expect(connect).toBeVisible({ timeout: 60_000 });
  await expect(connect).toHaveAttribute('aria-expanded', 'false');
  await connect.click();
  const list = page.getByRole('list', { name: en.signIn.wallet.found });
  // one entry for the wallet, whatever families it signs on, and no chain in its name
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list).not.toContainText(/Solana|Ethereum/);
  await list.getByRole('button', { name: 'Throwaway wallet' }).click();
  const chains = page.getByRole('group', { name: en.signIn.wallet.chains });
  await expect(chains).toContainText(en.signIn.wallet.both('Throwaway wallet'));
  await chains.getByRole('button', { name: 'Solana' }).click();
  // signed in with the Solana side: the plan lives there, nothing more is asked, and the person goes on
  await expect(page.locator('[data-ui="sign-in-said"]')).toHaveText(en.chain.is.wallet('Solana'));
  await expect(page.getByRole('heading', { name: en.chain.pick.title })).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
});

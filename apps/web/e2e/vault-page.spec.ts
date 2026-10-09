import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { readyToInvest } from './invest';
import { inTheme } from './theme';

// A person's own vault page, end to end on the mock chain (gate VAULT-PAGE-ACTIONS): the head, the
// pair of actions, the holdings; a deposit and a withdrawal signed in the page's right pane with the
// address unchanged; a change proposed in the conversation applied the same way; and what a visitor
// sees. Every state is checked with axe at 375 px, in light and in dark, and for no sideways scroll;
// at desk sizes the page itself does not scroll and each pane does.

const en = dictionary('en');
const p = en.shared.vault.page;
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const PHONE = { width: 375, height: 812 };

async function check(page: Page, name: string) {
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
      for (const size of [PHONE, { width: 1440, height: 900 }]) {
        await page.setViewportSize(size);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${name}, ${theme}, ${size.width}: no sideways scroll`,
        ).toBeLessThanOrEqual(size.width);
        await page.screenshot({
          path: `${SHOTS}/vault-${name}-${size.width}-${theme}.png`,
          fullPage: size.width === 375,
        });
      }
      await page.setViewportSize(PHONE);
    }
  }
  await inTheme(page, 'light');
}

/** Follows a link of the product's bar, as a phone does: the menu button, then the link in its sheet. */
async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

/** Signed in, with a vault of the person's own (60% SPY, 40% NVDA, $100 in), on its page. */
async function toVault(page: Page): Promise<string> {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
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
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/portfolio$/);
  await go(page, en.shell.invest);
  await expect(page).toHaveURL(/\/goal$/);
  await page.locator('[data-ui="goal-picker"]').selectOption(`vault:solana:${address}`);
  await expect(page).toHaveURL(new RegExp(`/vaults/solana/${address}$`));
  await expect(page.locator('[data-ui="vault-screen"]')).toHaveAttribute('data-pane', 'holdings');
  return address;
}

/** The page under the bar is a fixed workbench at desk sizes: it never scrolls, its panes do. */
async function fixedWorkbench(page: Page, pane: string) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1280, height: 650 },
  ]) {
    await page.setViewportSize(size);
    const at = `${size.width}x${size.height}`;
    const m = await page.evaluate((selector) => {
      const doc = document.scrollingElement as HTMLElement;
      doc.scrollTop = 500;
      const right = document.querySelector<HTMLElement>(selector);
      const head = document.querySelector<HTMLElement>('[data-ui="vault-conversation"] > header');
      const box = right?.getBoundingClientRect();
      return {
        pageScrolled: doc.scrollTop,
        pageTall: doc.scrollHeight - doc.clientHeight,
        paneOverflow: right ? getComputedStyle(right).overflowY : '',
        paneBottom: box ? Math.round(box.bottom) : -1,
        paneHeight: box ? Math.round(box.height) : -1,
        headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : -1,
        nested: right
          ? [...right.querySelectorAll<HTMLElement>('*')].filter((el) => {
              const y = getComputedStyle(el).overflowY;
              return (y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight + 1;
            }).length
          : -1,
        window: window.innerHeight,
      };
    }, pane);
    expect(m.pageScrolled, `${at}: the page does not scroll`).toBe(0);
    expect(m.pageTall, `${at}: nothing under the fold`).toBeLessThanOrEqual(0);
    expect(m.paneOverflow, `${at}: the pane scrolls inside itself`).toBe('auto');
    expect(m.paneBottom, `${at}: the pane ends in the window`).toBeLessThanOrEqual(m.window);
    expect(m.paneHeight, `${at}: the pane has room`).toBeGreaterThan(200);
    expect(m.headBottom, `${at}: the head stays compact`).toBeLessThan(m.window / 2);
    expect(m.nested, `${at}: no scroll area inside the pane`).toBe(0);
  }
  await page.setViewportSize(PHONE);
}

test('the owner’s vault page: a deposit, then a withdrawal, signed in place', async ({ page }) => {
  const address = await toVault(page);
  const here = new RegExp(`/vaults/solana/${address}$`);
  const screen = page.locator('[data-ui="vault-screen"]');
  const pane = page.locator('[data-ui="vault-action-pane"]');
  const title = pane.locator(':scope > header h2');

  // The head: the name in full, the value with what kind of figure it is, the chain as a quiet label.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(p.yourVault);
  await expect(screen.locator('[data-ui="vault-value"]')).toContainText(/\$\d\d\.\d\d/);
  const before = Number(
    (await screen.locator('[data-ui="vault-value"]').innerText()).match(/\$([\d.]+)/)?.[1],
  );
  await expect(screen.locator('[data-ui="vault-chain"]')).toHaveText('Solana');
  // what kind of figure it is: once in the pane, on the holdings' card, and on the value's own pin
  await expect(screen.locator('[data-ui="vault-plan"]')).toContainText(en.shell.mockAnnounce);
  // The pair, Deposit the one primary; the rest behind "More"; the way back is a link, not an action.
  const actions = screen.locator('[data-ui="vault-page-actions"]');
  await expect(actions.getByRole('button')).toHaveText([p.deposit, en.withdraw.action, p.more]);
  await expect(actions.locator('[data-action="vault-deposit"]')).toHaveClass(
    /(?:^|\s)bg-primary(?:\s|$)/,
  );
  await expect(screen.locator('[data-ui="vault-back"]')).toHaveText(en.shared.vault.back);
  await expect(screen).not.toContainText(/\b(mix|buy)\b/i);
  // The holdings are on the page, bar over table, with nothing to open first.
  await expect(screen.locator('[data-ui="holding-legs"]')).toBeVisible();
  await expect(screen.locator('[data-ui="vault-plan"] table')).toContainText('SPY');
  await expect(screen.locator('[data-ui="holding-drift"]:visible').first()).toBeVisible();
  await expect(screen.locator('[data-ui="vault-details"]')).not.toHaveAttribute('open', '');
  await check(page, 'idle');
  await fixedWorkbench(page, '[data-ui="vault-plan"]');

  // A head that grows (the rename form, on a short screen) gives way before the panes do: they keep
  // their room, the page still does not scroll, and the form's last control can be reached.
  await page.setViewportSize({ width: 1280, height: 650 });
  await screen.getByRole('button', { name: en.portfolio.actions.rename }).click();
  const tall = await page.evaluate(() => {
    const doc = document.scrollingElement as HTMLElement;
    doc.scrollTop = 500;
    const plan = document.querySelector<HTMLElement>('[data-ui="vault-plan"]');
    const head = document.querySelector<HTMLElement>('[data-ui="vault-conversation"] > header');
    return {
      page: doc.scrollTop,
      plan: plan ? Math.round(plan.getBoundingClientRect().height) : -1,
      bottom: plan ? Math.round(plan.getBoundingClientRect().bottom) : -1,
      head: head ? getComputedStyle(head).overflowY : '',
      window: window.innerHeight,
    };
  });
  expect(tall.page).toBe(0);
  expect(tall.plan).toBeGreaterThanOrEqual(200);
  expect(tall.bottom).toBeLessThanOrEqual(tall.window);
  expect(tall.head).toBe('auto');
  const cancel = screen.getByRole('button', { name: en.portfolio.actions.cancel });
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel).toBeInViewport();
  await cancel.click();
  await page.setViewportSize(PHONE);

  // "More": the weights by hand, sharing and the explorer, out of the way; Escape gives the focus back.
  const more = actions.locator('[data-ui="vault-more"]');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(screen.locator('[data-ui="vault-more-list"]')).toContainText(p.editWeights);
  await check(page, 'more');
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await screen.locator('[data-ui="vault-details"] > summary').click();
  await expect(screen.locator('[data-ui="vault-address"]')).not.toContainText(address);
  await expect(screen.locator('[data-ui="vault-address"] [data-ui="copy-button"]')).toBeVisible();
  await check(page, 'details');
  await screen.locator('[data-ui="vault-details"] > summary').click();

  // 1. A deposit, in the pane: the amount, the wallet's check, the order with its steps, one press.
  await actions.locator('[data-action="vault-deposit"]').click();
  await expect(screen).toHaveAttribute('data-pane', 'deposit');
  await expect(title).toHaveText(p.panes.deposit.title);
  await expect(title).toBeFocused();
  // the conversation's box is inert, and says why
  await expect(page.locator('[data-ui="vault-chat-waits"]')).toHaveText(p.waits.deposit);
  await expect(page.locator('[data-ui="vault-chat"] [inert] textarea')).toHaveCount(1);
  await expect(actions).toHaveCount(0);
  await check(page, 'deposit-amount');
  const press = await readyToInvest(page, { amount: '40' });
  await expect(pane.locator('[data-ui="order-step"]').first()).toBeVisible();
  await check(page, 'deposit-review');
  await fixedWorkbench(page, '[data-ui="vault-action"]');
  await press.click();
  await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  await expect(page).toHaveURL(here);
  await expect(title).toHaveText(p.ended);
  for (const step of await pane.locator('[data-ui="order-step"]').all())
    await expect(step).toHaveAttribute('data-status', 'confirmed');
  // done: one way on, the page's own, which also gives the conversation back
  await expect(pane.locator('[data-ui="order-next"]')).toHaveCount(0);
  await expect(page.locator('[data-ui="vault-chat-waits"]')).toHaveText(p.waits.done);
  await check(page, 'deposit-done');
  await pane.getByRole('button', { name: p.backToVault }).click();
  await expect(screen).toHaveAttribute('data-pane', 'holdings');
  await expect(screen.locator('[data-ui="vault-value"]')).toContainText(/\$1\d\d\.\d\d/);
  const after = Number(
    (await screen.locator('[data-ui="vault-value"]').innerText()).match(/\$([\d.]+)/)?.[1],
  );
  expect(after - before).toBeGreaterThan(39);
  expect(after - before).toBeLessThan(41);
  await expect(actions.locator('[data-action="vault-deposit"]')).toBeFocused();

  // 2. A withdrawal of everything, in the pane: what leaves, the review, then the steps to sign.
  const w = en.withdraw;
  await actions.locator('[data-action="vault-withdraw"]').click();
  await expect(screen).toHaveAttribute('data-pane', 'withdraw');
  await expect(title).toHaveText(p.panes.withdraw.title);
  await check(page, 'withdraw-what');
  await pane.getByRole('button', { name: w.steps.next }).click();
  await expect(pane.locator('[data-ui="withdraw-to"]:visible')).toHaveText(/^\S+$/);
  await pane.getByLabel(w.check.confirm).check();
  await pane.getByRole('button', { name: w.steps.next }).click();
  await pane.getByRole('button', { name: w.confirm.button }).click();
  await expect(title).toHaveText(p.panes.withdraw.signTitle);
  await expect(page).toHaveURL(here);
  await expect(pane.locator('[data-ui="order-step"]')).toHaveCount(2);
  await check(page, 'withdraw-steps');
  await pane.getByRole('button', { name: en.order.shared.signWithdraw }).click();
  await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  await expect(page).toHaveURL(here);
  await expect(pane.locator('[data-ui="withdraw-done"]')).toBeVisible();
  await check(page, 'withdraw-done');
  await pane.getByRole('button', { name: p.backToVault }).click();
  // Emptied, with its targets kept: said once, with what a deposit goes into and the one action,
  // which is in the pane. No withdrawal is offered, and the conversation starts from what fits.
  await expect(screen.locator('[data-ui="vault-empty"]')).toHaveText(p.empty.withTargets);
  await expect(screen.locator('[data-ui="vault-empty-targets"]')).toContainText('SPY');
  await expect(screen.locator('[data-action="vault-withdraw"]')).toHaveCount(0);
  await expect(screen.locator('[data-action="vault-deposit"]')).toHaveCount(1);
  await expect(
    screen.locator('[data-ui="vault-plan"] [data-action="vault-deposit"]'),
  ).toBeVisible();
  await expect(screen.locator('[data-ui="vault-chat"]')).toContainText(p.empty.choose);
  await expect(screen.locator('[data-ui="vault-chat"]')).not.toContainText(
    en.shared.vault.conversation.explain,
  );
  await check(page, 'empty-targets');
  await fixedWorkbench(page, '[data-ui="vault-plan"]');

  // With no targets either (the read is answered here: the stub's vault keeps its targets).
  await page.route(`**/v1/vaults/solana/${address}`, async (route) => {
    const answer = await route.fetch();
    const read = await answer.json();
    read.vault.positions = [];
    await route.fulfill({ response: answer, json: read });
  });
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/portfolio$/);
  await go(page, en.shell.invest);
  await page.locator('[data-ui="goal-picker"]').selectOption(`vault:solana:${address}`);
  await expect(page).toHaveURL(here);
  await expect(screen.locator('[data-ui="vault-empty"]')).toHaveText(p.empty.noTargets);
  await expect(screen.locator('[data-ui="vault-empty-targets"]')).toHaveCount(0);
  await screen.locator('[data-ui="vault-more"]').click();
  await expect(screen.locator('[data-ui="vault-share-strategy"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await check(page, 'empty');
  await page.unroute(`**/v1/vaults/solana/${address}`);

  // 3. Anybody else: the same vault with no owner's action and no conversation. A page load gives the
  // throwaway wallet new keys, so this load is not the owner's.
  await page.goto(`/vaults/solana/${address}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.shared.vault.title);
  const visitor = page.locator('[data-ui="vault-screen"]');
  await expect(
    visitor.locator('[data-ui="vault-explorer"], [data-ui="vault-back"]'),
  ).not.toHaveCount(0);
  for (const owned of [
    '[data-ui="vault-page-actions"]',
    '[data-action="vault-deposit"]',
    '[data-action="vault-withdraw"]',
    '[data-ui="vault-more"]',
  ])
    await expect(page.locator(owned)).toHaveCount(0);
  await expect(page.locator('[data-ui="vault-conversation"]')).toHaveCount(0);
  await check(page, 'visitor');
});

test('a change proposed in the conversation is applied in place, and the weights by hand too', async ({
  page,
}) => {
  const address = await toVault(page);
  const here = new RegExp(`/vaults/solana/${address}$`);
  const screen = page.locator('[data-ui="vault-screen"]');
  const pane = page.locator('[data-ui="vault-action-pane"]');
  const title = pane.locator(':scope > header h2');
  // The stub has no model: the reply is answered here, as apps/api declares it, for this vault.
  await page.route('**/conversation/reply', async (route) => {
    const asked = route.request().postDataJSON() as { messageId: string };
    const source = {
      id: 'exit',
      source: 'e2e',
      fetchedAt: '2026-10-05T12:00:00.000Z',
      method: 'sample exit read',
      provenance: 'mock',
      label: 'Measured cost',
      value: 0,
      unit: 'bps',
    };
    await route.fulfill({
      json: {
        version: 1,
        chain: 'solana',
        address,
        messageId: asked.messageId,
        message: 'Here is more SPY and less NVDA, to look at before anything changes.',
        question: null,
        proposal: {
          objective: 'More SPY, less NVDA.',
          summary: 'A draft for discussion.',
          allocations: [
            {
              assetId: 'solana:spy',
              weightBps: 7000,
              why: 'You asked for more of it.',
              evidenceIds: ['exit'],
              symbol: 'SPY',
            },
            {
              assetId: 'solana:nvda',
              weightBps: 3000,
              why: 'You asked for less of it.',
              evidenceIds: ['exit'],
              symbol: 'NVDA',
            },
          ],
          tradeoffs: ['The vault leans further on one fund.'],
          unknowns: [],
          sources: [source],
          warnings: [],
          weightNotes: [],
        },
      },
    });
  });
  await page.locator('[data-ui="vault-chat"] textarea').fill('More SPY, less NVDA.');
  await page.locator('[data-ui="composer-send"]').click();
  const proposal = page.locator('[data-ui="vault-proposal"]');
  await expect(proposal).toBeVisible();
  await check(page, 'proposal');
  await fixedWorkbench(page, '[data-ui="vault-plan"]');
  await expect(page.locator('[data-ui="vault-transcript"]')).toHaveCSS('overflow-y', 'auto');
  await proposal.getByRole('button', { name: en.mix.preview.apply }).click();
  await proposal.getByRole('button', { name: en.mix.vault.review }).click();
  await expect(page.locator('[data-ui="mix-review-lines"]')).toContainText('SPY');
  const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).check();
  await check(page, 'apply-review');
  await page.getByRole('button', { name: en.mix.vault.confirm }).click();
  // the order's steps take the pane: no other page
  await expect(screen).toHaveAttribute('data-pane', 'apply');
  await expect(page).toHaveURL(here);
  await expect(title).toHaveText(p.panes.change.signTitle);
  await expect(page.locator('[data-ui="vault-chat-waits"]')).toHaveText(p.waits.change);
  await expect(pane.getByRole('region', { name: en.mix.order.title })).toContainText('70%');
  await check(page, 'apply-steps');
  await pane.getByRole('button', { name: en.mix.order.signTargets }).click();
  await expect(pane).toHaveAttribute('data-state', 'done', { timeout: 90_000 });
  await expect(page).toHaveURL(here);
  await check(page, 'apply-done');
  await pane.getByRole('button', { name: p.backToVault }).click();
  await expect(screen).toHaveAttribute('data-pane', 'holdings');
  const targets = async () => {
    const vault = await page.request.get(`${STUB}/v1/vaults/solana/${address}`);
    const read = await vault.json();
    return read.vault.positions
      .filter((row: { targetBps: number }) => row.targetBps > 0)
      .map((row: { asset: string; targetBps: number }) => [row.asset, row.targetBps]);
  };
  expect(await targets()).toEqual([
    ['solana:spy', 7000],
    ['solana:nvda', 3000],
  ]);

  // By hand, behind "More": the same editor, review and steps, in the pane. Left before the review,
  // the holdings are back and the focus is on "More".
  const more = screen.locator('[data-ui="vault-more"]');
  await more.click();
  await screen.locator('[data-action="vault-edit-weights"]').click();
  await expect(screen).toHaveAttribute('data-pane', 'weights');
  await expect(title).toHaveText(p.panes.change.title);
  await check(page, 'weights');
  await pane.getByRole('button', { name: p.backToHoldings }).click();
  await expect(screen).toHaveAttribute('data-pane', 'holdings');
  await expect(more).toBeFocused();
});

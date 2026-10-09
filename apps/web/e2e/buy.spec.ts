import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { openPlan, readyToInvest } from './invest';
import { inTheme } from './theme';

// A person's buy, end to end in a browser, on the mock chain: sign in with the throwaway wallet, open
// a plan, look at it, buy it, review every step and sign. The order screen's executor
// builds each step from the stub API, holds it to the review with the real guard, has the throwaway
// wallet sign it and reports it, until the stub's mock chain confirms every step. A second buy has the
// stub lie about one step, and the guard refuses it. Every screen is checked with axe at 375 px, in
// light and in dark, and for no sideways scroll.

const en = dictionary('en');

// These run on the stub's Solana; the Robinhood Chain run (E2E_CHAIN=robinhood) is buy-robinhood.spec.ts.
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const shot = (name: string) => `${SHOTS}/${name}.png`;
const WIDTHS = [375, 1280] as const;
const REFERENCE = new URL('../../../.design/branding/working-brand/patterns/', import.meta.url)
  .href;

/**
 * axe on the page as it is at 375 px, in light and in dark, nothing wider than the window, and a
 * screenshot of each theme at 375 px and at 1280 px to set beside the guide's.
 */
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
        await page.screenshot({ path: shot(`${name}-${width}-${theme}`), fullPage: true });
      }
      await page.setViewportSize({ width: 375, height: 812 });
    }
  }
}

/** Follows a link of the product's bar, as a phone does: the menu button, then the link in its sheet. */
async function go(page: Page, name: string) {
  await page.getByRole('button', { name: en.shell.menu }).click();
  await page.locator('[data-ui="compact-nav-sheet"]').getByRole('link', { name }).click();
}

/** From a signed-out page to the buy screen of a plan, with the wallet funded and the notice ticked. */
test('his landing page: the hero alone, its faces, its numbers, and "Start a plan" into the goal', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.hero.title);
  // the three faces are the app's own files (app/fonts.ts): loaded, named as before with their
  // fallbacks, and what the heading is actually set in
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = (el: Element | null) => (el ? getComputedStyle(el).fontFamily : '');
    const width = (font: string) => {
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) return 0;
      ctx.font = font;
      return ctx.measureText('No product fits everyone').width;
    };
    return {
      heading: family(document.querySelector('h1')),
      body: family(document.body),
      loaded: ['600 16px "Inter Tight"', '400 16px Inter'].map((f) => document.fonts.check(f)),
      fromGoogle: performance
        .getEntriesByType('resource')
        .filter((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.name)).length,
      display: width('600 100px "Inter Tight"'),
      fallback: width('600 100px Arial'),
    };
  });
  expect(faces.heading).toMatch(/^"?interTight"?, "?Inter Tight"?, "?Inter Tight Fallback"?/);
  expect(faces.body).toMatch(/^"?inter"?, "?Inter"?, "?Inter Fallback"?/);
  expect(faces.loaded).toEqual([true, true]);
  expect(faces.fromGoogle).toBe(0);
  // set in Inter Tight itself, not its fallback: the two measure differently
  expect(Math.abs(faces.display - faces.fallback)).toBeGreaterThan(1);
  // the hero is the whole page: the numbers under it, each pinned, and nothing after them
  await expect(page.locator('[data-ui="landing-stats"] dt')).toHaveCount(3);
  await expect(page.locator('[data-ui="landing-stats"] [data-ui="pin-glyph"]')).toHaveCount(3);
  await expect(page.locator('main')).not.toContainText('MOCK');
  await expect(
    page.locator('[data-ui="landing-bar"]').getByRole('link', { name: en.landing.nav.cta }),
  ).toBeVisible();
  // no page scroll sideways, on a phone or a desk, in either ground
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  }
  // back to the phone, which is what check() measures against
  await page.setViewportSize({ width: 375, height: 812 });
  await check(page, 'landing');
  const automaticPosts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(goals|baskets|orders|conversations)\b/.test(request.url())
    )
      automaticPosts.push(request.url());
  });
  await page
    .locator('[data-ui="landing-hero"]')
    .getByRole('link', { name: en.landing.hero.start })
    .click();
  await expect(page).toHaveURL(/\/goal$/);
  // The hero's link opens /goal with nothing sent: no reply is asked for until an explicit Send.
  await expect(page.locator('[data-ui="goal-transcript"] li')).toHaveCount(0);
  await expect(page.locator('[data-ui="invest-screen"], [data-ui="invest-card"]')).toHaveCount(0);
  expect(automaticPosts).toEqual([]);
});

test('signed in, the logo leads to the landing, and its bar leads back into the app', async ({
  page,
}) => {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(page).toHaveURL(/\/goal$/);
  await page.getByRole('link', { name: en.shell.home }).click();
  // the landing, not a redirect back to the goal
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.hero.title);
  const bar = page.locator('[data-ui="landing-bar"]');
  await expect(bar.getByRole('link', { name: en.landing.nav.cta })).toHaveCount(0);
  await bar.getByRole('link', { name: en.landing.nav.openApp }).click();
  await expect(page).toHaveURL(/\/goal$/);
});

/** From a signed-out page to the buy screen of a $40 plan, on the stub's mock or its test network. */
async function toBuy(page: Page, o: { fund?: 'mock' | 'test' } = {}) {
  await page.request.post(`${STUB}/__stub/reset`);
  if (o.fund === 'test') await page.request.post(`${STUB}/__stub/test-network`);
  // the bar's "Sign in" opens the sign-in dialog over the goal (SIGN-IN-FLOW); the person stays there
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
  await check(page, 'home');

  await openPlan(page);

  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grow $40 over 36 months.');
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'plan');
  await page.getByRole('link', { name: en.plan.invest('$40') }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
}

async function toReview(page: Page, o: { fund?: 'mock' | 'test' } = {}) {
  await toBuy(page, o);
  // the amount starts at the plan's
  await expect(page.getByLabel(en.buy.amount.label, { exact: true })).toHaveValue('40');
  await check(page, 'buy-amount');
  const press = await readyToInvest(page, { fund: o.fund ?? 'mock' });
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'buy');
  // the review is on the buy's own card: no other page, and the chain named once over it
  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await expect(page.locator('main [data-ui="chain-badge"]')).toHaveText(['Solana']);
  return press;
}

test('a buy on the mock chain: plan, buy, review, sign, every step confirmed', async ({ page }) => {
  const press = await toReview(page);
  const steps = page.locator('[data-ui="order-step"]');
  // a vault opened with the deposit, then one swap per asset: the mock trades separately
  await expect(steps).toHaveCount(4);
  // a token by its name, its minimum in whole tokens with the price that means, never raw units
  await expect(steps.nth(1)).toContainText(
    /on SPY · receive at least [\d.,]+ SPY \(at most \$[\d.,]+ each\)/,
  );
  await expect(page.locator('main')).not.toContainText('smallest units');
  // who signs is said before the press: the wallet made here, with no other window
  await expect(page.locator('[data-ui="invest-signing"]')).toHaveText(en.invest.signs.passkey(4));
  await check(page, 'review');

  // one press, and every step is signed and sent in turn
  await press.click();
  const status = page.locator('[data-ui="order-status"]');
  await expect(status).toHaveText(en.order.outcome.done('Solana'), { timeout: 90_000 });
  for (let i = 0; i < 4; i += 1)
    await expect(steps.nth(i)).toHaveAttribute('data-status', 'confirmed');
  // the order's own page does not list its steps a second time
  await expect(page.locator('[data-ui="execution-list"]')).toHaveCount(0);
  await check(page, 'done');

  // the next step is offered: the portfolio the buy filled
  await expect(
    page
      .locator('[data-ui="order-next"]')
      .getByRole('link', { name: en.order.outcome.seePortfolio }),
  ).toBeVisible();

  // The monitor reads the vault the buy opened, with a pin on its value, its card saying it is sample.
  // The bar's Portfolio is the portfolio section's board (/portfolio, PORT-1); the monitor is where
  // the order's own next step leads.
  await page
    .locator('[data-ui="order-next"]')
    .getByRole('link', { name: en.order.outcome.seePortfolio })
    .click();
  await expect(page).toHaveURL(/\/monitor$/);
  const summary = page.locator('[data-ui="vault-summary"]');
  await expect(summary).toHaveCount(1);
  await expect(summary.locator('[data-ui="vault-add-money"]')).toBeVisible();
  await expect(summary.locator('[data-ui="holdings-bar"]')).toBeVisible();
  await expect(summary.getByRole('link', { name: en.portfolio.overview.open })).toBeVisible();
  const readDetails = page.locator('[data-ui="vault-read-details"]');
  await expect(readDetails).not.toHaveAttribute('open', '');
  await readDetails.locator(':scope > summary').click();
  await expect(readDetails).toHaveAttribute('open', '');
  await readDetails.getByText(en.portfolio.planDetails, { exact: true }).click();
  await page.locator('[data-ui="activity-details"] > summary').click();
  const vault = page.locator('section[data-ui="card"]').filter({
    has: page.getByRole('heading', { name: en.portfolio.vault.title }),
  });
  await expect(vault).toHaveCount(1);
  // his goal card, joined to the goal the plan was built for, and what reached the chain, with links
  await expect(page.locator('[data-ui="goal-card"] h3')).toHaveText('Grow $40 over 36 months.');
  await expect(
    page.locator('[data-ui="activity-panel"] [data-ui="execution-list"] li a[href]'),
  ).toHaveCount(4);
  await expect(vault.locator('[data-ui="vault-value"] [data-ui="figure"]')).toHaveCount(1);
  await expect(vault.locator('[data-ui="sample-note"]')).toBeVisible();
  await expect(page.locator('main')).not.toContainText('MOCK');
  await expect(vault.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
  await check(page, 'monitor');
  // the disclaimer is under the vault, once: the shell's foot does not repeat it
  await expect(page.locator('main [data-ui="disclaimer"]')).toBeVisible();
  await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
  // and home says where the money is, under the goal
  await go(page, en.shell.invest);
  await expect(page.getByRole('link', { name: en.portfolio.summary.see })).toBeVisible();
  // a page with no disclaimer of its own keeps the foot's
  await expect(page.locator('footer [data-ui="disclaimer"]')).toBeVisible();
  await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
});

test('a buy on a test network: test funds sent for what is missing, then every step signed', async ({
  page,
}) => {
  const press = await toReview(page, { fund: 'test' });
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps).toHaveCount(4);
  await press.click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
});

test('the invest card by keyboard, at 375 and 1440 px', async ({ page }) => {
  await toBuy(page, { fund: 'test' });
  const amount = page.getByLabel(en.buy.amount.label, { exact: true });
  await expect(amount).toHaveValue('40');
  const card = page.locator('[data-ui="invest-card"]');
  // the wallet is short: what is missing is on the card, with the way to fill it
  const ask = card.getByRole('button', { name: en.buy.funding.testFunds });
  await expect(ask).toBeVisible();
  await expect(page.locator('[data-ui="data-note"]')).toHaveText(
    en.buy.steps.note.testNetwork('Solana'),
  );
  // no MOCK word anywhere on the buy screen: the card's one line says what the figures are
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'buy-keyboard');
  // the full notice is one Enter away on the card
  const full = page.locator('details[data-ui="trust-full"] summary');
  await full.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details[data-ui="trust-full"]')).toHaveAttribute('open', '');
  // by keyboard to the end: the funds, the notice, and the one press
  await ask.focus();
  await page.keyboard.press('Enter');
  await expect(card.locator('[data-ui="order-step"]').first()).toBeVisible({ timeout: 30_000 });
  const accept = page.getByLabel(en.trust.accept);
  await accept.focus();
  await page.keyboard.press('Space');
  const press = card.getByRole('button', { name: en.invest.press('$40') });
  await expect(press).not.toHaveAttribute('aria-disabled', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});

test('a withdrawal: part of the cash, then everything, to the owner’s own wallet, and the vault says it is empty', async ({
  page,
}) => {
  await (await toReview(page)).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  const w = en.withdraw;
  const openDetails = async () => {
    const details = page.locator('[data-ui="vault-read-details"]');
    await expect(details).toHaveCount(1);
    if ((await details.getAttribute('open')) === null)
      await details.locator(':scope > summary').click();
    await expect(details).toHaveAttribute('open', '');
  };
  /** From the portfolio to the withdraw screen of the one vault. */
  const open = async () => {
    await expect(page).toHaveURL(/\/monitor$/);
    await openDetails();
    await page.locator('a[data-ui="vault-withdraw"]').click();
    await expect(page).toHaveURL(/\/vaults\/solana\/[^/]+\/withdraw$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.title);
    // the disclaimer is on this page, once, in the foot
    await expect(page.locator('footer [data-ui="disclaimer"]')).toBeVisible();
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
  };
  /** The review confirmed, the order made, every step signed, and back to the portfolio. */
  const through = async (steps: number) => {
    await page.getByRole('button', { name: w.steps.next }).click();
    // where it goes is the wallet that is signed in, and the person says this is what they want
    await expect(page.locator('[data-ui="withdraw-to"]:visible')).toHaveText(/^\S+$/);
    await page.getByLabel(w.check.confirm).check();
    await page.getByRole('button', { name: w.steps.next }).click();
    await page.getByRole('button', { name: w.confirm.button }).click();
    await expect(page).toHaveURL(/\/orders\/[^/]+$/);
    await expect(page.locator('[data-ui="order-step"]')).toHaveCount(steps);
    await page.getByRole('button', { name: en.order.shared.signWithdraw }).click();
    const done = page.locator('[data-ui="withdraw-done"]');
    await expect(done).toBeVisible({ timeout: 90_000 });
    for (let i = 0; i < steps; i += 1)
      await expect(page.locator('[data-ui="order-step"]').nth(i)).toHaveAttribute(
        'data-status',
        'confirmed',
      );
    await done.getByRole('link', { name: w.back }).click();
  };

  // 1. Part of the cash: the plan keeps 5% of $40 in cash, and $1 of it leaves.
  // The bar's Portfolio is the portfolio section's board (/portfolio, PORT-1); the monitor is where
  // the order's own next step leads.
  await page
    .locator('[data-ui="order-next"]')
    .getByRole('link', { name: en.order.outcome.seePortfolio })
    .click();
  await open();
  await check(page, 'withdraw');
  await page.getByLabel(w.what.some).check();
  await page.getByLabel(w.what.take('USDC')).check();
  await page.getByLabel(w.what.amount('USDC'), { exact: true }).fill('3');
  await expect(page.getByText(w.what.errors.over('2 USDC'))).toBeVisible();
  await page.getByLabel(w.what.amount('USDC'), { exact: true }).fill('1');
  await through(1);
  await openDetails();
  await expect(page.locator('a[data-ui="vault-withdraw"]')).toBeVisible();
  await expect(page.locator('[data-ui="vault-empty"]')).toHaveCount(0);

  // 2. Everything that is left: a step per token, and then the vault says it is empty.
  await open();
  await page.getByRole('button', { name: w.steps.next }).click();
  await expect(page.locator('[data-ui="withdraw-steps"] tbody tr:visible')).toHaveCount(4);
  await check(page, 'withdraw-review');
  await page.getByRole('button', { name: new RegExp(`^${w.steps.names.what}`) }).click();
  await through(4);
  await expect(page).toHaveURL(/\/monitor$/);
  await expect(page.locator('[data-ui="vault-summary"]')).toContainText(
    en.shared.vault.conversation.noHoldings,
  );
  await openDetails();
  await expect(page.locator('[data-ui="vault-empty"]')).toHaveText(w.empty);
  await expect(page.locator('a[data-ui="vault-withdraw"]')).toHaveCount(0);
  await check(page, 'monitor-emptied');
});

test('a step the server lies about is refused by the guard, and nothing is signed for it', async ({
  page,
}) => {
  const press = await toReview(page);
  await page.request.post(`${STUB}/__stub/tamper`);
  await press.click();
  const status = page.locator('[data-ui="order-status"]');
  await expect(status).toContainText(en.order.outcome.refused(2), { timeout: 60_000 });
  await expect(status).toContainText(en.order.outcome.check('minimum'));
  // The wallet was never asked for the refused step: the stub was handed signed bytes for the first
  // step and for nothing after it.
  const reported = (await (await page.request.get(`${STUB}/__stub/reports`)).json()) as string[];
  const legs = await page.locator('[data-ui="order-step"]').count();
  expect(legs).toBe(4);
  expect(new Set(reported).size).toBe(1);
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'confirmed');
  await expect(steps.nth(1)).not.toHaveAttribute('data-status', 'confirmed');
  // what landed and what did not, in one sentence, and a new order offered in the same card
  await expect(page.locator('[data-ui="invest-landed"]')).toContainText(en.invest.things.deposit);
  await expect(page.getByRole('button', { name: en.order.outcome.newOrder })).toBeVisible();
  await check(page, 'refused');
});

test('the guide and the prototype, photographed beside the screens', async ({ page }) => {
  test.skip(!SHOTS, 'only when SCREENSHOTS_DIR names a folder');
  // What each screen is held to (guidelines.html, components and provenance; the prototype's plan
  // pane), at the same widths and in both themes, for the report that compares them.
  for (const width of WIDTHS)
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${REFERENCE}guidelines.html${theme === 'dark' ? '?theme=dark' : ''}`);
      for (const part of ['components', 'provenance'])
        await page
          .locator(`#${part}`)
          .screenshot({ path: shot(`guide-${part}-${width}-${theme}`) });
      await page.goto(`${REFERENCE}prototypes/hero-3d.html`);
      await page
        .locator('article.case')
        .first()
        .screenshot({ path: shot(`prototype-case-${width}`) });
    }
});

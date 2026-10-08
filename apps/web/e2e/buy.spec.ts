import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { throughBuySteps } from './buy-steps';
import { inTheme } from './theme';

// A person's buy, end to end in a browser, on the mock chain: sign in with the throwaway wallet, read a
// goal, build the plan, look at it, buy it, review every step and sign. The order screen's executor
// builds each step from the stub API, holds it to the review with the real guard, has the throwaway
// wallet sign it and reports it, until the stub's mock chain confirms every step. A second buy has the
// stub lie about one step, and the guard refuses it. Every screen is checked with axe at 375 px, in
// light and in dark, and for no sideways scroll.

const en = dictionary('en');
const pt = dictionary('pt');

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
test('his landing page: the hero, the two sample cases, the typing box that hands a goal on', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.stage.title);
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
      loaded: ['400 16px Newsreader', '500 16px "IBM Plex Sans"'].map((f) =>
        document.fonts.check(f),
      ),
      fromGoogle: performance
        .getEntriesByType('resource')
        .filter((r) => /fonts\.(googleapis|gstatic)\.com/.test(r.name)).length,
      serif: width('400 100px Newsreader'),
      fallback: width('400 100px "Times New Roman"'),
    };
  });
  expect(faces.heading).toMatch(/^"?newsreader"?, "?Newsreader"?, "?Newsreader Fallback"?/);
  expect(faces.body).toMatch(/^"?plexSans"?, "?IBM Plex Sans"?, "?IBM Plex Sans Fallback"?/);
  expect(faces.loaded).toEqual([true, true]);
  expect(faces.fromGoogle).toBe(0);
  // set in Newsreader itself, not its fallback: the two measure differently
  expect(Math.abs(faces.serif - faces.fallback)).toBeGreaterThan(1);
  await expect(page.locator('article[data-ui="showcase-case"]')).toHaveCount(2);
  // a jump to the end of the page, over the stage, finds his bar compact, with its action
  await page.keyboard.press('End');
  await expect(page.locator('[data-ui="compact-nav"]')).toHaveAttribute('data-compact', 'true');
  await expect(
    page.locator('[data-ui="compact-nav"]').getByRole('link', { name: en.landing.nav.cta }),
  ).toBeVisible();
  await page.keyboard.press('Home');
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'landing');
  // the closing: its heading over the joint's canvas, readable (CLOSING-INK, Oct 6)
  const words = page.locator('#updates [data-ui="closing-words"]');
  await words.scrollIntoViewIfNeeded();
  await expect(page.locator('#updates canvas[data-ui="closing-canvas"]')).toHaveCount(1);
  // CI's browser has no GPU: the plan drawn flat, its ten coins, and the line under it
  await expect(page.locator('#updates [data-ui="coins-still"] [data-part="coin"]')).toHaveCount(10);
  await expect(page.locator('#updates [data-ui="closing-plan-line"]')).toContainText(
    en.landing.closing.coins.line,
  );
  await expect(words.getByRole('heading', { level: 2 })).toHaveText(en.landing.closing.title);
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const read = await new AxeBuilder({ page })
      .include('#updates [data-ui="closing-words"]')
      .withRules(['color-contrast'])
      .analyze();
    expect(
      read.violations.map((v) => v.id),
      theme,
    ).toEqual([]);
  }
  await page.keyboard.press('Home');
  const box = page.locator('#simulate textarea');
  await box.fill('Grow $2,000 for ten years, high risk');
  await box.press('Enter');
  await expect(page).toHaveURL(/\/goal$/);
  // the goal screen reads what the landing handed it
  await expect(page.getByText(en.goal.sheet.title).first()).toBeVisible();
});

test('the two sample cases fit their cards on a phone and a tablet, in English and Portuguese', async ({
  page,
  context,
  baseURL,
}) => {
  for (const lang of ['en', 'pt'] as const) {
    await context.addCookies([{ name: 'tf-lang', value: lang, url: baseURL ?? '' }]);
    for (const width of [360, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.locator('article[data-ui="showcase-case"]')).toHaveCount(2);
      // every box inside a case that is drawn at all stays within the case's own edges; a box inside
      // a part that scrolls on its own (the chart on a phone) is held to that part instead
      const out = await page.evaluate(() =>
        [...document.querySelectorAll('article[data-ui="showcase-case"]')].flatMap((card) => {
          const edge = card.getBoundingClientRect();
          const scrolls = (el: Element) => {
            for (let a = el.parentElement; a && a !== card; a = a.parentElement)
              if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX)) return true;
            return false;
          };
          return [...card.querySelectorAll('*')].flatMap((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || el.closest('.sr-only') || scrolls(el)) return [];
            const over = r.right - edge.right > 0.5 || edge.left - r.left > 0.5;
            return over ? [`${el.tagName} "${(el.textContent ?? '').slice(0, 30)}"`] : [];
          });
        }),
      );
      expect(out, `${lang} at ${width}px`).toEqual([]);
    }
  }
});

test('the plan drawn as a joint answers a mouse and a finger, and lights its part in the list', async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const growth = page.locator('article[data-ui="showcase-case"]').nth(1);
  await growth.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  // a mouse resting in the middle of the stocks layer's face, not on any of its lines
  const stocks = growth.locator('[data-part="layer"][data-chart="3"]');
  const face = await stocks.locator('path[data-part="hit"]').boundingBox();
  if (!face) throw new Error('the stocks layer has no face to rest on');
  await page.mouse.move(face.x + face.width * 0.3, face.y + face.height / 2);
  await expect(stocks).toHaveAttribute('data-lit', 'true');
  await expect(growth.locator('[data-ui="case-leg"][data-chart="3"]')).toHaveAttribute(
    'data-lit',
    'true',
  );
  // and a row lights its layer
  await growth.locator('[data-ui="case-leg"][data-chart="1"]').hover();
  await expect(growth.locator('[data-part="layer"][data-chart="1"]')).toHaveAttribute(
    'data-lit',
    'true',
  );
  // a phone: a tap picks the part, a tap elsewhere lets it go
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const tap = await phone.newPage();
  await tap.goto(page.url());
  const card = tap.locator('article[data-ui="showcase-case"]').nth(1);
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const gold = card.locator('[data-part="layer"][data-chart="4"]');
  await gold.tap();
  await expect(gold).toHaveAttribute('data-lit', 'true');
  await card.locator('blockquote').tap();
  await expect(gold).toHaveAttribute('data-lit', 'false');
  await phone.close();
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.landing.stage.title);
  await page.keyboard.press('End');
  const bar = page.locator('[data-ui="compact-nav"]');
  await expect(bar).toHaveAttribute('data-compact', 'true');
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

  const goal = page.getByRole('textbox', { name: en.goal.composer.label, exact: true });
  await goal.fill('Grow $40 for three years, medium risk');
  await goal.press('Enter');
  await page.getByLabel(en.goal.fields.amount, { exact: true }).fill('40');
  // the country is not asked for: it shapes no plan and sits folded away (gate COUNTRY-REMOVED)
  await expect(page.getByLabel(en.goal.fields.country, { exact: true })).toBeHidden();
  await page.getByRole('button', { name: en.goal.sheet.build }).click();
  await page.getByRole('link', { name: en.goal.built.done.see }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grow $40 over 36 months.');
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'plan');
  await page.getByRole('link', { name: en.plan.buy }).click();

  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
}

async function toReview(page: Page, o: { fund?: 'mock' | 'test' } = {}) {
  await toBuy(page, o);
  // the amount starts at the plan's
  await expect(page.getByLabel(en.buy.amount.label, { exact: true })).toHaveValue('40');
  await check(page, 'buy-amount');
  await throughBuySteps(page, { fund: o.fund ?? 'mock' });
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'buy');
  await page.getByRole('button', { name: en.buy.review('$40') }).click();

  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.order.review.title);
  // the review names the chain once, over the page
  await expect(page.locator('main [data-ui="chain-badge"]')).toHaveText(['Solana']);
}

test('a buy on the mock chain: plan, buy, review, sign, every step confirmed', async ({ page }) => {
  await toReview(page);
  const steps = page.locator('[data-ui="order-step"]');
  // a vault opened with the deposit, then one swap per asset: the mock trades separately
  await expect(steps).toHaveCount(4);
  // a token by its name, its minimum in whole tokens with the price that means, never raw units
  await expect(steps.nth(1)).toContainText(
    /on SPY · receive at least [\d.,]+ SPY \(at most \$[\d.,]+ each\)/,
  );
  await expect(page.locator('main')).not.toContainText('smallest units');
  await check(page, 'review');

  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
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
  // at 375 px his bar keeps its links in the sheet under the menu button
  await go(page, en.shell.portfolio);
  await expect(page).toHaveURL(/\/monitor$/);
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
  await toReview(page, { fund: 'test' });
  const steps = page.locator('[data-ui="order-step"]');
  await expect(steps).toHaveCount(4);
  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
});

test('the buy’s steps by keyboard, in Portuguese, at 375 and 1440 px', async ({ page }) => {
  await toBuy(page, { fund: 'test' });
  // Portuguese from the switch in the foot: the page is asked for again, and the sign-in stays
  await page
    .locator('[data-ui="language-switch"]')
    .getByRole('button', { name: 'Português' })
    .click();
  // The page has arrived in Portuguese, all of it: its language, and its title, which comes last.
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(page).toHaveTitle(new RegExp(`^${pt.buy.title}`));
  const amount = page.getByLabel(pt.buy.amount.label, { exact: true });
  await expect(amount).toHaveValue('40');
  // Enter in the amount continues, and the focus moves to the step it opens
  await amount.focus();
  await page.keyboard.press('Enter');
  const funds = page.getByRole('button', { name: new RegExp(`^${pt.buy.steps.names.funds}`) });
  await expect(funds).toHaveAttribute('aria-expanded', 'true');
  await expect(funds).toBeFocused();
  await expect(page.getByRole('button', { name: pt.buy.funding.testFunds })).toBeVisible();
  await expect(page.locator('[data-ui="data-note"]')).toHaveText(
    pt.buy.steps.note.testNetwork('Solana'),
  );
  // no MOCK word anywhere on the buy screen: the card's one line says what the figures are
  await expect(page.locator('main')).not.toContainText('MOCK');
  await check(page, 'buy-pt');
  // the full notice is one Tab and Enter away in the trust step
  await page.getByRole('button', { name: new RegExp(`^${pt.buy.steps.names.trust}`) }).click();
  const full = page.locator('details[data-ui="trust-full"] summary');
  await full.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details[data-ui="trust-full"]')).toHaveAttribute('open', '');
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
  await toReview(page);
  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  const w = en.withdraw;
  /** From the portfolio to the withdraw screen of the one vault. */
  const open = async () => {
    await expect(page).toHaveURL(/\/monitor$/);
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
  await go(page, en.shell.portfolio);
  await open();
  await check(page, 'withdraw');
  await page.getByLabel(w.what.some).check();
  await page.getByLabel(w.what.take('USDC')).check();
  await page.getByLabel(w.what.amount('USDC'), { exact: true }).fill('3');
  await expect(page.getByText(w.what.errors.over('2 USDC'))).toBeVisible();
  await page.getByLabel(w.what.amount('USDC'), { exact: true }).fill('1');
  await through(1);
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
  await expect(page.locator('[data-ui="vault-empty"]')).toHaveText(w.empty);
  await expect(page.locator('a[data-ui="vault-withdraw"]')).toHaveCount(0);
  await check(page, 'monitor-emptied');
});

test('a step the server lies about is refused by the guard, and nothing is signed for it', async ({
  page,
}) => {
  await toReview(page);
  await page.request.post(`${STUB}/__stub/tamper`);
  await page.getByRole('button', { name: en.order.signAndBuy('$40') }).click();
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
  await expect(page.getByRole('link', { name: en.order.outcome.newOrder })).toBeVisible();
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

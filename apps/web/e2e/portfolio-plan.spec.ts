import { expect, type Page, test } from '@playwright/test';
import type { Lang } from '../i18n';
import { portfolioDictionary } from '../i18n/portfolio';
import { check, openSignedIn, pinned } from './portfolio-steps';

// A plan's own page end to end (PORT-3): reached from its card on the overview, for a person signed
// in with the throwaway wallet, against the e2e stub's sample answers. The income plan's vault is the
// one the stub has an exposure of its own for: two deposits, a part outside its band, a measured
// selling cost. The page is checked with axe in light and in dark at 375 px and at 1280 px, for no
// sideways scroll and for a pin on every figure; then once more in Portuguese. Nothing here signs.

const w = portfolioDictionary('en');
const pt = portfolioDictionary('pt');

/** The income plan's vault of the stub's sample answers, on Solana's test network. */
const INCOME = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** A vault the reader never read. */
const NEVER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** From the overview, by the plan's own address: the throwaway wallet lives in the page. */
async function toPlan(page: Page, address: string, lang: Lang = 'en') {
  // no link on the overview leads here any more (its rows open the vault's own page): the app's
  // router goes, so the page and its wallet stay
  void lang;
  await page.evaluate((href) => {
    (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push(href);
  }, `/portfolio/plan/solana/${address}`);
  await expect(page).toHaveURL(new RegExp(`/portfolio/plan/solana/${address}$`));
  await expect(page.locator('main [data-ui="plan-blocks"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main [data-ui="waiting"]')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('a plan’s page on the stub', () => {
  test('the goal first, then the plan over time, every figure with its pin, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    await toPlan(page, INCOME);
    // the goal is the page's heading and its one serif line
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Earn income from $80,000 for 60 months.',
    );
    await expect(page.locator('main .font-display')).toHaveCount(1);
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveCount(0);
    const head = page.locator('main [data-ui="plan-head"]');
    await expect(head.locator('[data-ui="status"]')).toHaveText(w.status.words.watch);
    await expect(head.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
    await expect(head.locator('[data-ui="plan-figures"] [data-ui="figure"]')).toHaveCount(2);
    await expect(
      page.getByRole('heading', { level: 2 }).filter({ hasText: w.plan.history.heading }),
    ).toBeVisible();

    // the figure: a solid line, two deposits marked, one pinned reading, and it reads by keyboard
    const chart = page.locator('main [data-ui="plan-value-chart"]');
    await expect(chart.locator('polyline[data-ui="value-line"]')).toHaveCount(1);
    await expect(chart.locator('[data-ui="deposit-mark"]')).toHaveCount(2);
    await expect(chart.locator('[data-ui="chart-readout"] [data-ui="figure"]')).toHaveCount(1);
    await expect(page.locator('main [data-ui="history-deposits"] li')).toHaveCount(2);
    const plot = chart.getByRole('img');
    await plot.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(chart.locator('[data-ui="chart-readout"]')).toContainText('Oct 6, 2026');
    await page.keyboard.press('Escape');
    await expect(chart.locator('[data-ui="chart-readout"]')).toContainText(w.plan.history.newest);
    // another window is asked for and drawn
    const windows = page.locator('main [data-ui="plan-history"] [data-ui="segmented"] button');
    await expect(windows).toHaveCount(4);
    await windows.filter({ hasText: w.plan.history.window.quarter }).click();
    await expect(windows.filter({ hasText: w.plan.history.window.quarter })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(chart.locator('polyline[data-ui="value-line"]')).toHaveCount(1);

    // each part against its target: the band drawn, and "outside the band" in words and shape
    const parts = page.locator('main [data-ui="plan-parts"]');
    await expect(parts.locator('[data-ui="status"]:visible')).toHaveText(w.plan.parts.outside);
    await expect(parts.locator('svg[data-ui="band-gauge"]:visible')).toHaveCount(3);
    // what leaving would cost, and where the risk sits
    const exit = page.locator('main [data-ui="plan-exit"]');
    await expect(exit.locator('[data-ui="exit-line"]')).toHaveCount(2);
    await expect(exit.locator('[data-ui="exit-cost"] [data-ui="figure"]')).toHaveText(
      /7\.1 basis points/,
    );
    await expect(exit).toContainText(w.plan.exit.beyond);
    await expect(page.locator('main [data-ui="risk-flags"] li')).toHaveCount(1);
    // the latest trades, and the way to all of them
    const trades = page.locator('main [data-ui="plan-trades"]');
    await expect(trades.locator('[data-ui="trades-list"] li')).toHaveCount(2);
    await expect(trades.locator('a[href="/portfolio/rebalancing"]')).toHaveText(w.plan.trades.all);

    await pinned(page, 'a plan');
    // a pin opens on its source, its time and its method
    await head.locator('[data-ui="figure"] button[data-ui="pin"]').first().click();
    await expect(head.locator('[data-ui="pin-source"]')).toContainText('2026-10-07T11:56:02Z');
    await page.keyboard.press('Escape');
    // exactly one disclaimer: the activity panel's, the frame's and the app's standing down
    await expect(
      page.locator('main [data-ui="plan-activity"] [data-ui="disclaimer"]'),
    ).toBeVisible();
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(0);
    await check(page, 'a plan');

    // the way back, with the plans kept
    await page.locator('main [data-ui="plan-back"]').click();
    await expect(page).toHaveURL(/\/portfolio$/);
    await expect(page.locator('main [data-ui="overview-vault"]')).toHaveCount(7);
  });

  test('a vault never read says so and shows no figure, axe clean', async ({ page }) => {
    await openSignedIn(page, '/portfolio');
    await toPlan(page, NEVER);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rainy day');
    await expect(page.locator('main [data-ui="plan-no-status"]')).toHaveText(w.status.none);
    await expect(page.locator('main')).toContainText(w.plan.unread);
    await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
    await expect(page.locator('main [data-ui="plan-history"]')).toHaveCount(0);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await check(page, 'a plan never read');
  });

  test('an address that is no vault of theirs is one sentence and the way back', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio/plan/solana/4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.plan.title);
    await expect(page.locator('main')).toContainText(w.plan.notFound);
    await expect(page.locator('main [data-ui="card-empty"] a')).toHaveAttribute(
      'href',
      '/portfolio',
    );
    await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await check(page, 'no plan at the address');
  });

  test('in Portuguese, its figures in Brazil’s format, axe clean', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'tf-lang', value: 'pt', url: baseURL as string }]);
    await openSignedIn(page, '/portfolio', 'pt');
    await toPlan(page, INCOME, 'pt');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    const head = page.locator('main [data-ui="plan-head"]');
    await expect(head.locator('[data-ui="status"]')).toHaveText(pt.status.words.watch);
    await expect(head.locator('[data-ui="plan-figures"]')).toContainText(/US\$\s81\.243,55/);
    await expect(
      page.getByRole('heading', { level: 2 }).filter({ hasText: pt.plan.exit.heading }),
    ).toBeVisible();
    await expect(page.locator('main [data-ui="plan-parts"] [data-ui="status"]:visible')).toHaveText(
      pt.plan.parts.outside,
    );
    await expect(
      page.locator('main [data-ui="plan-exit"] [data-ui="exit-cost"] [data-ui="figure"]'),
    ).toHaveText(/7,1 pontos-base/);
    await expect(page.locator('main [data-ui="plan-back"]')).toHaveText(pt.plan.back);
    await expect(page.locator('main')).not.toContainText(w.plan.history.lead);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await pinned(page, 'a plan in Portuguese');
    await check(page, 'a plan in Portuguese');
  });
});

import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { portfolioDictionary } from '../i18n/portfolio';
import { check, openSignedIn, pinned, toPage } from './portfolio-steps';

// The portfolio section end to end (PORT-3): its overview and its methodology, for a person signed
// in with the throwaway wallet, against the e2e stub's sample answers of the section's routes. Every
// page is checked with axe in light and in dark at 375 px and at 1280 px, for no sideways scroll, and
// for a pin on every figure; then once more in Portuguese. Nothing here signs.

const t = dictionary('en');
const w = portfolioDictionary('en');
const pt = portfolioDictionary('pt');

/** A vault of the stub's sample answers: the plan to grow, on Solana's test network. */
const GROW = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';

test.describe('the portfolio section on the stub', () => {
  test('signed out, it asks for a sign-in and shows no figure', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.overview.title);
    await expect(page.locator('main')).toContainText(w.shell.signedOut, { timeout: 60_000 });
    await expect(page.locator('main a[href="/sign-in?next=/portfolio"]')).toHaveText(
      t.shell.signIn,
    );
    await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await check(page, 'overview, signed out');
  });

  test('the overview: the board, the chart and a row a vault, every figure with its pin, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    const rows = page.locator('main [data-ui="overview-vault"]');
    await expect(rows).toHaveCount(7);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.overview.title);
    // the board: Solana's four vaults that were read, added up; the mock chain's left out
    const board = page.locator(`main section[aria-label="${w.overview.board.total}"]`);
    await expect(board.locator('[data-ui="board-total"]')).toContainText('$84,047.10');
    await expect(board.locator('[data-ui="board-vaults"] dd')).toHaveText('5');
    await expect(board).toContainText(w.overview.board.leftOut('sample chain'));
    // the chart opens on the line over 30 days, and the stacks are one press away
    await expect(page.locator('main [data-ui="overview-chart"]')).toHaveAttribute(
      'data-kind',
      'line',
    );
    await page.getByRole('button', { name: w.overview.board.chart.byAsset }).click();
    await expect(page.locator('main [data-ui="overview-chart"]')).toHaveAttribute(
      'data-kind',
      'bars',
    );
    await page.getByRole('button', { name: w.overview.board.chart.line }).click();
    // a row a vault, named as everywhere, with its status as the server says it
    const grow = page.locator(`main [data-ui="overview-vault"][data-address="${GROW}"]`);
    await expect(grow.locator('[data-ui="vault-sentence"]')).toHaveText(
      'Grow $2,000 over 36 months.',
    );
    await expect(grow.locator('[data-ui="status"]')).toHaveText(w.status.words.on_track);
    await expect(grow.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
    await expect(page.locator('main [data-ui="chains-out"]')).toHaveText(
      t.portfolio.chainOff('Base'),
    );
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveAttribute(
      'href',
      '/portfolio',
    );
    await pinned(page, 'overview');
    // the disclaimer is under the page, once: the app's foot does not repeat it
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    // nothing on the page signs
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(0);
    await check(page, 'overview');

    // a row opens the vault's own page, where its chat and its plan are
    await expect(grow.locator('a')).toHaveAttribute('href', `/vaults/solana/${GROW}`);
  });

  test('the methodology: every line of the rule, plain text, the disclaimer once, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    await toPage(page, '/portfolio/methodology');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.methodology.title);
    await expect(page.getByRole('heading', { name: w.methodology.status.heading })).toBeVisible();
    await expect(page.locator('main [data-ui="rule-name"]')).toContainText('ON-TRACK-V1');
    await expect(page.locator('main [data-ui="rule-lines"] > li')).toHaveCount(13);
    await expect(page.locator('main [data-ui="status-legend"] [data-ui="status"]')).toHaveCount(3);
    // plain text: no figure, so no pin
    await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
    await expect(page.locator('main .font-display')).toHaveCount(1);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveAttribute(
      'href',
      '/portfolio/methodology',
    );
    await check(page, 'methodology');
    // and back: the plans were kept while the person was away, so the rows are there at once
    await toPage(page, '/portfolio');
    await expect(page.locator('main [data-ui="overview-vault"]')).toHaveCount(7);
  });

  test('the side menu hides to a rail on a wide screen and comes back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/portfolio/methodology');
    const toggle = page.locator('button[aria-controls="portfolio-nav"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveText(w.shell.menu.hide);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-ui="portfolio"]')).toHaveAttribute('data-collapsed', 'true');
    // the rail keeps the pages one click away, each still named
    await expect(page.locator('#portfolio-nav a[href="/portfolio/exposure"]')).toHaveAttribute(
      'title',
      w.exposure.label,
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('in Portuguese for a Portuguese reader, its figures in Brazil’s format, axe clean', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'tf-lang', value: 'pt', url: baseURL as string }]);
    await openSignedIn(page, '/portfolio', 'pt');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(pt.overview.title);
    const grow = page.locator(`main [data-ui="overview-vault"][data-address="${GROW}"]`);
    await expect(grow.locator('[data-ui="status"]')).toHaveText(pt.status.words.on_track);
    // the same figure, written as Brazil writes it
    await expect(grow).toContainText(/US\$\s2\.051,37/);
    await expect(page.locator('main')).toContainText(pt.overview.table.heading);
    await pinned(page, 'overview in Portuguese');
    await check(page, 'overview in Portuguese');
    await toPage(page, '/portfolio/methodology', 'pt');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(pt.methodology.title);
    await expect(page.locator('main [data-ui="rule-lines"] > li')).toHaveCount(13);
    await check(page, 'methodology in Portuguese');
  });
});

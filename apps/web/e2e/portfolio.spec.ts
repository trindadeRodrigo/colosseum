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

  test('the overview: a card a plan, the goal first, every figure with its pin, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    const cards = page.locator('main [data-ui="plan-card"]');
    await expect(cards).toHaveCount(7);
    // the heading is the sans face over the cards, whose sentences are the serif
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.overview.title);
    await expect(page.locator('main .font-display')).toHaveCount(7);
    const grow = page.locator(`main [data-ui="plan-card"][data-address="${GROW}"]`);
    await expect(grow.locator('h3')).toHaveText('Grow $2,000 over 36 months.');
    await expect(grow.locator('[data-ui="status"]')).toHaveText(w.status.words.on_track);
    await expect(grow.locator('[data-ui="plan-figures"] [data-ui="figure"]')).toHaveCount(2);
    await expect(grow.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
    await expect(grow.locator('[data-ui="sample-note"]')).toHaveText(t.shell.testNetworkLine);
    // each status word once at least, and no status where the rule gives none
    for (const word of Object.values(w.status.words))
      await expect(cards.locator('[data-ui="status"]', { hasText: word }).first()).toBeVisible();
    await expect(cards.locator('[data-ui="plan-no-status"]')).toHaveCount(2);
    // a snapshot older than an hour says so, with its age
    await expect(cards.locator('[data-ui="stale-plate"]')).toHaveCount(3);
    await expect(cards.locator('[data-ui="stale-plate"]').first()).toHaveText('stale · 3 h');
    // and so does the sum of a chain that one of them is in
    await expect(page.locator('main [data-ui="chain-total"] [data-ui="stale-plate"]')).toHaveCount(
      2,
    );
    // each chain's own sum, and the chain that is switched off said in a sentence
    await expect(page.locator('main [data-ui="chain-total"]')).toHaveCount(2);
    await expect(page.locator('main [data-ui="chains-out"]')).toHaveText(
      t.portfolio.chainOff('Base'),
    );
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveAttribute(
      'href',
      '/portfolio',
    );
    await pinned(page, 'overview');
    // a pin opens on its source, its time and its method
    await grow.locator('[data-ui="figure"] button[data-ui="pin"]').first().click();
    await expect(grow.locator('[data-ui="pin-source"]')).toContainText('2026-10-07T11:56:00Z');
    await page.keyboard.press('Escape');
    // the disclaimer is under the page, once: the app's foot does not repeat it
    await expect(page.locator('main [data-ui="disclaimer"]')).toBeVisible();
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    // nothing on the page signs
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(0);
    await check(page, 'overview');

    // the card's one link opens the plan's own page, inside the section, still signed in
    await grow.getByRole('link', { name: w.overview.card.open }).click();
    await expect(page).toHaveURL(new RegExp(`/portfolio/plan/solana/${GROW}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.plan.title);
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveCount(0);
    await check(page, 'a plan’s page, not built yet');
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
    // and back: the plans were kept while the person was away, so the cards are there at once
    await toPage(page, '/portfolio');
    await expect(page.locator('main [data-ui="plan-card"]')).toHaveCount(7);
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
    const grow = page.locator(`main [data-ui="plan-card"][data-address="${GROW}"]`);
    await expect(grow.locator('[data-ui="status"]')).toHaveText(pt.status.words.on_track);
    // the same figure, written as Brazil writes it
    await expect(grow.locator('[data-ui="plan-figures"]')).toContainText(/US\$\s2\.051,37/);
    await expect(grow.getByRole('link')).toHaveText(pt.overview.card.open);
    await expect(grow.locator('[data-ui="stale-plate"]')).toHaveCount(0);
    await expect(
      page.locator('main [data-ui="plan-card"] [data-ui="stale-plate"]').first(),
    ).toHaveText('desatualizado · 3 h');
    await pinned(page, 'overview in Portuguese');
    await check(page, 'overview in Portuguese');
    await toPage(page, '/portfolio/methodology', 'pt');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(pt.methodology.title);
    await expect(page.locator('main [data-ui="rule-lines"] > li')).toHaveCount(13);
    await check(page, 'methodology in Portuguese');
  });
});

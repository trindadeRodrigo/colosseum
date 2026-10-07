import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { inTheme } from './theme';

// Bearing's analytics end to end (WEB-BEARING): the five pages and the methodology, against the e2e
// stub, whose /risk routes answer from Rodrigo's recording of the risk API (tests/e2e/stub-risk.ts,
// captured 2026-10-03 15:58 UTC). The browser's clock is set three hours after the capture, so the
// time of week is his (weekend), the collectors' newest reading is old, and every figure is stale with
// its age, as his snapshot shows them. Every page is checked with axe at 375 px in light and dark, for
// no sideways scroll at 375 and 1440, for a pin after every figure, and for no MOCK anywhere: these
// figures are measured.

const CAPTURED = Date.parse('2026-10-03T15:58:40.766Z');
const PAGES = ['stocks', 'commodities', 'stablecoins', 'lending', 'simulation'] as const;

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(CAPTURED + 3 * 3600e3);
  await page.goto(path);
  await expect(page.locator('[data-ui="bearing-banner"]')).toHaveAttribute('data-mode', 'stale');
  // nothing still reading or pricing
  await expect(page.locator('main p', { hasText: /^(Reading|Pricing)/ })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page.locator('main [data-ui="waiting"]')).toHaveCount(0, { timeout: 60_000 });
}

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
  }
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await page.waitForTimeout(300);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name} at ${width}: no sideways scroll`).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 375, height: 812 });
}

/** Every figure carries its pin, stale with its age; nothing is MOCK. */
async function pinned(page: Page, name: string) {
  const figures = page.locator('main [data-ui="figure"]');
  const n = await figures.count();
  expect(n, `${name}: figures`).toBeGreaterThan(0);
  expect(await page.locator('main [data-ui="figure"][data-state="stale"]').count(), name).toBe(n);
  expect(await page.locator('main [data-ui="figure"] [data-ui="pin"]').count(), name).toBe(n);
  expect(await page.locator('main [data-ui="stale-tag"]').count(), name).toBe(n);
  await expect(page.locator('main')).not.toContainText('MOCK');
  await expect(page.locator('main [data-ui="figure"][data-state="mock"]')).toHaveCount(0);
}

test.describe('Bearing analytics on the recorded risk API', () => {
  test('waits in the page’s own boxes: the row of figures does not move when the data comes', async ({
    page,
  }) => {
    await page.clock.setFixedTime(CAPTURED + 3 * 3600e3);
    await page.setViewportSize({ width: 1440, height: 900 });
    // the risk API answers slowly, as Render's free plan does after it slept
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/risk\//, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/analytics/stocks');
    const wait = page.locator('main [data-ui="waiting"]');
    await expect(wait).toHaveAttribute('aria-busy', 'true');
    await expect(wait.locator('[role="status"]')).toHaveText('Reading the pools…');
    const kpis = page.locator('main [data-ui="bearing-kpis"]');
    const before = await kpis.boundingBox();
    // the wait itself passes axe in light and dark, with no sideways scroll
    await check(page, 'waiting');
    await page.setViewportSize({ width: 1440, height: 900 });
    // after 4 seconds, one calm line: the data service may be waking
    await expect(wait.locator('[data-ui="waiting-slow"]')).toBeVisible({ timeout: 6_000 });
    release();
    await expect(wait).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('main [data-ui="figure"]').first()).toBeVisible();
    const after = await kpis.boundingBox();
    expect(before).not.toBeNull();
    expect(after).toEqual(before);
  });

  for (const id of PAGES)
    test(`${id}: stale figures with their pins, axe, no sideways scroll`, async ({ page }) => {
      await open(page, `/analytics/${id}`);
      // the bar's Analytics link is current (on a phone it is in the sheet under the menu button)
      await expect(
        page
          .locator('[data-ui="compact-nav"] a[href="/analytics/stocks"][aria-current="page"]')
          .first(),
      ).toBeAttached();
      await expect(page.locator('#bearing-nav [aria-current="page"]')).toContainText(
        id[0]?.toUpperCase() + id.slice(1),
      );
      await pinned(page, id);
      await check(page, id);
    });

  test('in Portuguese for a Portuguese reader, its figures in Brazil’s format, axe clean', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'tf-lang', value: 'pt', url: baseURL as string }]);
    await page.clock.setFixedTime(CAPTURED + 3 * 3600e3);
    await page.goto('/analytics/lending');
    await expect(page.locator('[data-ui="bearing-banner"]')).toContainText(
      'Todo número está defasado',
    );
    await expect(page.locator('main p', { hasText: /^(Lendo|Precificando)/ })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    const kpi = page.locator('[data-ui="bearing-kpi"]', {
      has: page.getByText('Coberto agora', { exact: true }),
    });
    // the same figure, written as Brazil writes it
    await expect(kpi).toContainText('≥ 6,82%');
    await check(page, 'lending in Portuguese');
  });

  test('the lending counters agree with the hand check of the prototype', async ({ page }) => {
    // CHECKS.md section 10: weekend, 1% tolerance, every pool: covered 6.82%, largest sale $2.57M.
    await open(page, '/analytics/lending');
    const kpi = (label: string) =>
      page.locator('[data-ui="bearing-kpi"]', { has: page.getByText(label, { exact: true }) });
    await expect(kpi('Covered now')).toContainText('≥ 6.82%');
    await expect(kpi('Largest sale within tolerance')).toContainText('≥ $2.6M');
    // Sentora xStocks Market · PYUSD: (79.3K + 418K + 1.01M) ÷ 2.875M
    await expect(
      page.locator('tbody tr', { hasText: 'Sentora xStocks Market · PYUSD' }),
    ).toContainText('52.57%');
  });

  test('one asset gets its hours of the week: the heatmap tile, by keyboard', async ({ page }) => {
    await open(page, '/analytics/commodities');
    const grid = page.getByRole('grid', { name: /Median sell cost of GLDx/ });
    await expect(grid).toBeVisible();
    await expect(grid.locator('td[tabindex="0"]')).toHaveCount(1);
    await grid.locator('td[data-how="0"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(grid.locator('td[data-how="1"]')).toBeFocused();
    await expect(page.locator('[data-ui="heatmap-tile"] [aria-live="polite"]')).toContainText(
      'Mon 01:00 ET',
    );
    // stale with the rest of the page: the band and the plate
    await expect(page.locator('[data-ui="heatmap-tile"]')).toHaveAttribute('data-state', 'stale');
    await expect(page.locator('[data-ui="heatmap-tile"] [data-ui="stale-plate"]')).toBeVisible();
  });

  test('the tolerance box refuses a value out of range and keeps the page', async ({ page }) => {
    await open(page, '/analytics/lending');
    const box = page.getByRole('textbox', { name: /Tolerance/ });
    await box.fill('50');
    await box.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Between 0.1% and 10%' })).toBeVisible();
  });

  test('the simulation prices TSLAx $100k as two hourly sales, the best path', async ({ page }) => {
    await open(page, '/analytics/simulation');
    await expect(
      page.getByText(/^Best path for \$100,000 of TSLAx now: split into 2 hourly sales/),
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Amount, USD' }).fill('12');
    await page.getByRole('button', { name: 'Simulate' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'between $100 and $1,000,000,000' }),
    ).toBeVisible();
  });

  test('the side menu hides and shows, and says so', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, '/analytics/stocks');
    const toggle = page.getByRole('button', { name: 'Hide menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Show menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('the methodology page, and the old /risk addresses lead into the section', async ({
    page,
  }) => {
    await open(page, '/analytics/methodology');
    await expect(page.getByRole('heading', { name: 'What a number means' })).toBeVisible();
    await check(page, 'methodology');
    // the section names the chain it reads in the address once it opens (Solana, with none chosen)
    await page.goto('/risk');
    await expect(page).toHaveURL(/\/analytics\/stocks(\?chain=solana)?$/);
    await page.goto('/risk/methodology');
    await expect(page).toHaveURL(/\/analytics\/methodology(\?chain=solana)?$/);
    await page.clock.setFixedTime(CAPTURED + 3 * 3600e3);
    await page.goto('/risk/gldx');
    await expect(page).toHaveURL(/\/analytics\/commodities\?asset=GLDx(&chain=solana)?$/);
    await expect(page.getByRole('button', { name: /Assets/ })).toContainText('GLDx');
  });
});

// Bearing per chain (web/bearing-chains). Robinhood Chain's answers come from a fixture
// (fixtures/risk/bearing-robinhood.json), which the recording predates: every one of its figures is
// labelled fixture, so the page shows it with the MOCK plate and never as a measurement.
test.describe('Bearing on each chain', () => {
  async function openOn(page: Page, path: string) {
    await page.clock.setFixedTime(CAPTURED + 3 * 3600e3);
    await page.goto(path);
    await expect(page.locator('main [data-ui="waiting"]')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('main p', { hasText: /^(Reading|Pricing)/ })).toHaveCount(0, {
      timeout: 60_000,
    });
  }
  const pressed = (page: Page) =>
    page.locator('[data-ui="bearing-chain"] button[aria-pressed="true"]');

  test('Robinhood Chain: its stocks, the chain said once by the switch, fixture never live', async ({
    page,
  }) => {
    await openOn(page, '/analytics/stocks?chain=robinhood');
    await expect(pressed(page)).toHaveText('Robinhood Chain');
    const kpis = page.locator('main [data-ui="bearing-kpi"]');
    await expect(kpis).toHaveCount(5);
    // no counter, card or row repeats the chain: only the chains side by side tags its rows
    await expect(kpis.locator('[data-ui="chain-badge"]')).toHaveCount(0);
    await expect(page.locator('main [data-ui="bearing-card"] [data-ui="chain-badge"]')).toHaveCount(
      await page.locator('main [data-ui="bearing-chains"] [data-ui="chain-badge"]').count(),
    );
    // its pools are not in Bearing's registry yet: said quietly, with no figure and no chain's name
    await expect(kpis.first().locator('[data-ui="bearing-reason"]')).toHaveText(
      'not collected yet',
    );
    const row = page.locator('section[aria-labelledby="bearing-table"] tbody tr');
    await expect(row.first().locator('th')).toContainText('NVDA');
    await expect(row.first().locator('[data-ui="chain-badge"]')).toHaveCount(0);
    // every figure is the fixture's, so every one has the MOCK plate: none is shown as live
    const figures = page.locator('main [data-ui="figure"]:not([data-state="missing"])');
    expect(await figures.count()).toBeGreaterThan(0);
    await expect(page.locator('main [data-ui="figure"][data-state="live"]')).toHaveCount(0);
    await expect(page.locator('main [data-ui="figure"][data-state="stale"]')).toHaveCount(0);
    await check(page, 'stocks on Robinhood Chain');
  });

  /**
   * A figure of the page's own chain: outside the chains side by side, whose rows name their own.
   * Not a counter's: on Robinhood Chain the counters are counts and what is not collected.
   */
  const ownFigure = (page: Page) =>
    page.locator('main [data-ui="bearing-fig"]:not([data-ui="bearing-chains"] *)').first();

  test('the toggle moves the page to Solana and back, in the address, and the menu keeps it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openOn(page, '/analytics/stocks');
    await expect(page).toHaveURL(/\/analytics\/stocks\?chain=solana$/);
    await expect(pressed(page)).toHaveText('Solana');
    await pinned(page, 'stocks on Solana');
    await page
      .locator('[data-ui="bearing-chain"]')
      .getByRole('button', { name: 'Robinhood Chain' })
      .click();
    await expect(page).toHaveURL(/\/analytics\/stocks\?chain=robinhood$/);
    await expect(ownFigure(page)).toHaveAttribute('data-chain', 'robinhood');
    await expect(page.locator('#bearing-nav a', { hasText: 'Lending' })).toHaveAttribute(
      'href',
      '/analytics/lending?chain=robinhood',
    );
    await page.locator('[data-ui="bearing-chain"]').getByRole('button', { name: 'Solana' }).click();
    await expect(page).toHaveURL(/\/analytics\/stocks\?chain=solana$/);
    await expect(ownFigure(page)).toHaveAttribute('data-chain', 'solana');
  });

  test('a page Robinhood Chain has nothing collected for says so, axe clean', async ({ page }) => {
    for (const id of ['lending', 'stablecoins'] as const) {
      await openOn(page, `/analytics/${id}?chain=robinhood`);
      await expect(page.locator('[data-ui="bearing-not-on-chain"]')).toHaveText(
        'Not collected yet on Robinhood Chain: Bearing measures this page on Solana only for now.',
      );
      await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
      await check(page, `${id} on Robinhood Chain`);
    }
  });
});

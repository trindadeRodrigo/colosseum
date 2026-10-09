import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { portfolioDictionary } from '../i18n/portfolio';
import { check, openSignedIn, pinned, toPage } from './portfolio-steps';

// The rebalancing and exposure pages of the portfolio section end to end (PORT-3), for a person
// signed in with the throwaway wallet, against the e2e stub's sample answers: each reached from the
// side menu, checked with axe in light and in dark at 375 px and at 1280 px, for no sideways scroll
// and for a pin on every figure; then once more for a reader who asked for Portuguese, in English (ENGLISH-ONLY). Nothing here signs.

const t = dictionary('en');
const w = portfolioDictionary('en');

/** Vaults of the stub's sample answers, on Solana's test network and on the sample chain. */
const INCOME = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const GROW = 'EPjFWdd5AufqSSqeM2qtbKqmnzN6gRLfV9YzcVz8kGDw';
const SILENT = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

test.describe('the lists of the portfolio section on the stub', () => {
  test('signed out, each asks for a sign-in and shows no figure', async ({ page }) => {
    for (const id of ['rebalancing', 'exposure'] as const) {
      await page.goto(`/portfolio/${id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(w[id].title);
      await expect(page.locator('main')).toContainText(w.shell.signedOut, { timeout: 60_000 });
      await expect(page.locator(`main a[href="/sign-in?next=/portfolio/${id}"]`)).toHaveText(
        t.shell.signIn,
      );
      await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
    }
    await check(page, 'exposure, signed out');
  });

  test('rebalancing: the steps under their vaults, whose and how each ended in words, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    await toPage(page, '/portfolio/rebalancing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.rebalancing.title);
    const groups = page.locator('main [data-ui="vault-steps"]');
    await expect(groups).toHaveCount(4);
    await expect(page.locator('main [data-ui="step"]')).toHaveCount(7);
    // the newest vault first, headed as the overview names it, leading to its own page
    const income = groups.first();
    await expect(income).toHaveAttribute('data-vault', INCOME);
    await expect(income.locator('h2')).toHaveText('Earn income from $80,000 for 60 months.');
    await expect(income.locator('[data-ui="chain-badge"]')).toHaveText('Solana');
    await expect(income.locator('[data-ui="sample-note"]')).toHaveText(t.shell.testNetworkLine);
    await expect(income.locator('header a')).toHaveAttribute(
      'href',
      `/portfolio/plan/solana/${INCOME}`,
    );
    // whose each step is and how it ended: a word beside a shape
    const keeper = income.locator('[data-ui="step"]').first();
    await expect(keeper.locator('[data-ui="step-by"]')).toHaveText(w.rebalancing.by.keeper);
    await expect(keeper.locator('[data-ui="step-by"] svg')).toBeVisible();
    await expect(keeper.locator('[data-ui="step-outcome"]')).toHaveText(
      w.rebalancing.outcome.confirmed,
    );
    await expect(keeper.locator('[data-ui="step-derived"]')).toHaveText(w.rebalancing.derived);
    await expect(keeper.locator('a')).toHaveCount(0);
    const own = income.locator('[data-ui="step"]').nth(1);
    await expect(own.locator('[data-ui="step-by"]')).toHaveText(w.rebalancing.by.owner);
    await expect(own.locator('[data-ui="step-when"]')).toContainText(w.rebalancing.when.built);
    await expect(own.locator('[data-ui="trade-sentence"]').first()).toHaveText(
      'Swapped cash (USDC) into USDY (Ondo).',
    );
    await expect(own.locator('dd[data-row="quoted"]').first()).toContainText('4 bps');
    await expect(own.locator('[data-ui="step-quote-note"]')).toHaveText(w.rebalancing.quoteNote);
    await expect(own.locator('a[data-ui="explorer-link"]')).toHaveAttribute(
      'href',
      /^https:\/\/solscan\.io\/tx\/5VER.*cluster=devnet$/,
    );
    // a step that failed says so
    const failed = page.locator(
      `main [data-ui="vault-steps"][data-vault="${GROW}"] [data-ui="step"][data-outcome="failed"]`,
    );
    await expect(failed.locator('[data-ui="step-outcome"]')).toHaveText(
      w.rebalancing.outcome.failed,
    );
    await expect(failed.locator('[data-ui="step-outcome"] svg')).toBeVisible();
    // the sample chain's step: its own quiet line, and a transaction no explorer shows
    const silent = page.locator(`main [data-ui="vault-steps"][data-vault="${SILENT}"]`);
    await expect(silent.locator('[data-ui="sample-note"]')).toHaveText(t.shell.mockAnnounce);
    await expect(silent.locator('[data-ui="step-tx"]')).toContainText(w.rebalancing.noExplorer);
    await expect(page.locator('main a[href^="mock:"]')).toHaveCount(0);
    // once, what the list cannot tell, with the way to the methodology
    await expect(page.locator('main [data-ui="steps-note"]')).toHaveCount(1);
    await expect(page.locator('main [data-ui="steps-note"] a')).toHaveAttribute(
      'href',
      '/portfolio/methodology',
    );
    await expect(page.locator('main [data-ui="chains-out"]')).toHaveText(
      t.portfolio.chainOff('Base'),
    );
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveAttribute(
      'href',
      '/portfolio/rebalancing',
    );
    await pinned(page, 'rebalancing');
    // a pin opens on the entry's own stamp
    await own.locator('[data-ui="figure"] button[data-ui="pin"]').first().click();
    await expect(own.locator('[data-ui="pin-source"]')).toContainText('2026-10-05T09:29:40Z');
    await page.keyboard.press('Escape');
    await expect(page.locator('main .font-display')).toHaveCount(1);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(0);
    await check(page, 'rebalancing');
  });

  test('exposure: a block a chain, shares as bars, what selling would cost, axe clean', async ({
    page,
  }) => {
    await openSignedIn(page, '/portfolio');
    await toPage(page, '/portfolio/exposure');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.exposure.title);
    const blocks = page.locator('main [data-ui="chain-exposure"]');
    await expect(blocks).toHaveCount(2);
    const solana = page.locator('main [data-ui="chain-exposure"][data-chain="solana"]');
    await expect(solana.locator('[data-ui="exposure-total"]')).toContainText(
      'The 4 vaults that were read hold $84,047.10',
    );
    await expect(solana.locator('[data-ui="exposure-oldest"]')).toContainText(
      'Oct 7, 2026, 08:55 UTC',
    );
    await expect(solana.locator('[data-ui="sample-note"]')).toHaveText(t.shell.testNetworkLine);
    // the shares, largest first, each a bar that is drawn
    const underlying = solana.locator('ol[data-ui="shares"][data-by="underlying"] > li');
    await expect(underlying).toHaveCount(5);
    await expect(underlying.first()).toContainText('USDY');
    await expect(underlying.first().locator('[data-ui="share-percent"]')).toHaveText('62.9%');
    const widths = await underlying
      .locator('[data-ui="share-fill"]')
      .evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));
    expect(widths.every((width) => width > 0)).toBe(true);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    await expect(solana.locator('ol[data-ui="shares"][data-by="issuer"] > li')).toHaveCount(5);
    // what selling would cost: a measured cost with its pin, or the sentence that says why not
    await expect(
      solana.locator('[data-ui="exit"][data-asset="solana:usdy"] [data-ui="exit-cost"]'),
    ).toContainText('7.25 bps');
    await expect(
      solana.locator('[data-ui="exit"][data-asset="solana:spyx"] [data-ui="exit-cost"]'),
    ).toHaveText(w.exposure.exit.undated);
    await expect(
      solana.locator('[data-ui="exit"][data-asset="solana:sgov"] [data-ui="exit-cost"]'),
    ).toHaveText(w.exposure.exit.beyond);
    await expect(
      solana.locator('[data-ui="exit"][data-asset="solana:syrupusdc"] [data-ui="exit-cost"]'),
    ).toHaveText(w.exposure.exit.tier('B'));
    await expect(solana.locator('[data-ui="flags"] li')).toHaveText([
      w.exposure.flags.say.exit_quote_missing,
    ]);
    await expect(solana.locator('[data-ui="unvalued"] li')).toHaveCount(1);
    // the sample chain says its figures are samples, and shows no split by issuer
    const robinhood = page.locator('main [data-ui="chain-exposure"][data-chain="robinhood"]');
    await expect(robinhood.locator('[data-ui="sample-note"]')).toHaveText(t.shell.mockAnnounce);
    await expect(robinhood.locator('[data-ui="issuer-stand-ins"]')).toHaveText(
      w.exposure.shares.standIns,
    );
    await expect(robinhood.locator('[data-ui="shares"][data-by="issuer"]')).toHaveCount(0);
    // chains are never added together, and the page says so once
    await expect(page.locator('main [data-ui="exposure-notes"]')).toContainText(
      w.exposure.notes.chains,
    );
    await expect(page.locator('main')).not.toContainText('$84,088.60');
    await expect(page.locator('main [data-ui="chains-out"]')).toHaveText(
      t.portfolio.chainOff('Base'),
    );
    await expect(page.locator('#portfolio-nav [aria-current="page"]')).toHaveAttribute(
      'href',
      '/portfolio/exposure',
    );
    await pinned(page, 'exposure');
    await expect(page.locator('main .font-display')).toHaveCount(1);
    await expect(page.locator('[data-ui="disclaimer"]:visible')).toHaveCount(1);
    await expect(page.locator('main [data-variant="primary"]')).toHaveCount(0);
    await check(page, 'exposure');
    // a holding with no price leads to its vault's own page, still signed in
    await solana.locator('[data-ui="unvalued"] a').click();
    await expect(page).toHaveURL(
      /\/portfolio\/plan\/solana\/ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL$/,
    );
  });

  // The app is English only (ENGLISH-ONLY): a reader whose browser asked for Portuguese (the old
  // cookie) is answered in English, with the figures as English writes them. This test was the
  // Portuguese reading of the section.
  test('a reader who asked for Portuguese reads them in English, axe clean', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([{ name: 'tf-lang', value: 'pt', url: baseURL as string }]);
    await openSignedIn(page, '/portfolio');
    await toPage(page, '/portfolio/rebalancing');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.rebalancing.title);
    await pinned(page, 'rebalancing, Portuguese asked');
    await check(page, 'rebalancing, Portuguese asked');
    await toPage(page, '/portfolio/exposure');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(w.exposure.title);
    const solana = page.locator('main [data-ui="chain-exposure"][data-chain="solana"]');
    await expect(solana.locator('[data-ui="exposure-total"]')).toContainText('$84,047.10');
    await pinned(page, 'exposure, Portuguese asked');
    await check(page, 'exposure, Portuguese asked');
  });
});

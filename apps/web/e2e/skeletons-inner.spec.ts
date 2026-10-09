import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';
import {
  axe,
  boxesWaiting,
  expectAnnouncedOnce,
  expectNoShift,
  hold,
  type Region,
  STUB,
  shot,
  WIDTHS,
  walletAddress,
} from './waits';

// The screens of a vault's own money in outline (WEB-SKELETONS-2): withdraw, add money and the
// publish form. Each opens on a vault the person owns, with its read held: the wait is checked (one
// busy region and one polite line where the screen waits as a whole, axe clean) and the boxes of
// its regions are compared with what lands, at 1440 px and at 375 px. Nothing is ordered or signed.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');

const push = (page: Page, href: string) =>
  page.evaluate((h) => {
    (window as unknown as { next: { router: { push(x: string): void } } }).next.router.push(h);
  }, href);

/** Signs in and gives the person a vault of their own on the stub; answers its address. */
async function withVault(page: Page): Promise<string> {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/sign-in?next=%2Fshelf');
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  const on = page.locator('main a[href="/shelf"]');
  if (await on.isVisible({ timeout: 3_000 }).catch(() => false))
    await on.click({ timeout: 3_000 }).catch(() => {});
  await expect(page).toHaveURL(/\/shelf/);
  const made = await page.request.post(`${STUB}/__stub/source-vault`, {
    data: {
      owner: await walletAddress(page),
      targets: [
        { asset: 'solana:spy', weightBps: 6000 },
        { asset: 'solana:gold', weightBps: 4000 },
      ],
    },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return ((await made.json()) as { address: string }).address;
}

async function waitsInPlace(
  page: Page,
  o: {
    name: string;
    path: string;
    held: RegExp;
    settled: string;
    regions: Region[];
    /** The page's title is there while it waits; a vault's name is not known yet. */
    title?: boolean;
  },
) {
  const h = await hold(page, o.held);
  await push(page, o.path);
  await expect(page.locator('main [data-ui="waiting"]').first()).toBeVisible();
  await expect(page.locator('main [data-ui="waiting"]').first()).not.toHaveAttribute(
    'data-phase',
    'quiet',
  );
  await expectAnnouncedOnce(page);
  // the page's own title is there while it waits, and only once
  if (o.title !== false) await expect(page.locator('main h1')).toHaveCount(1);
  await expect(async () => {
    expect(await page.title()).toMatch(/\S/);
  }).toPass();
  await axe(page, `${o.name} waiting`);
  await inTheme(page, 'dark');
  const before = await boxesWaiting(page, o.regions);
  await shot(page, `${o.name}-loading`);
  h.release();
  await expect(page.locator(o.settled).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('main [data-ui="waiting"]')).toHaveCount(0, { timeout: 60_000 });
  await inTheme(page, 'dark');
  await expectNoShift(page, o.regions, before, o.name);
  await shot(page, `${o.name}-loaded`);
  await h.drop();
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test('a vault’s own page waits as its workbench: its head, the conversation and what it holds', async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const address = await withVault(page);
      await waitsInPlace(page, {
        name: 'vault',
        path: `/vaults/solana/${address}`,
        // the vault's read; the name comes with the portfolio, which the page waits for by itself
        held: /\/v1\/vaults\//,
        settled: '[data-ui="vault-screen"]',
        title: false,
        regions: [
          {
            name: 'way back',
            waiting: '[data-ui="vault-wait"] a[href="/portfolio"]',
            loaded: '[data-ui="vault-back"]',
          },
          {
            name: 'conversation',
            waiting: '[data-wait="chat"]',
            loaded: '[data-ui="vault-chat"]',
            sized: 'by-data',
          },
          {
            name: 'what it holds',
            waiting: '[data-wait="holdings"]',
            loaded: '[data-ui="vault-plan"] [data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
      // the way back is a link while the page waits, not a picture of one
      await expect(page.locator('[data-ui="vault-back"]')).toHaveAttribute('href', '/portfolio');
    });

    test('withdraw waits as its head and the card of its steps', async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const address = await withVault(page);
      await waitsInPlace(page, {
        name: 'withdraw',
        path: `/vaults/solana/${address}/withdraw`,
        held: /\/v1\/vaults\//,
        settled: '[data-ui="withdraw-screen"]',
        regions: [
          { name: 'title', waiting: 'main h1', loaded: 'main h1' },
          {
            name: 'chain',
            waiting: '[data-ui="withdraw-wait"] [data-ui="chain-badge"]',
            loaded: '[data-ui="withdraw-screen"] [data-ui="chain-badge"]',
          },
          {
            name: 'steps',
            waiting: '[data-wait="steps"]',
            loaded: '[data-ui="withdraw-screen"] [data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('add money waits as its head, the amount, its card and where the deposit goes', async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const address = await withVault(page);
      await waitsInPlace(page, {
        name: 'add-money',
        path: `/vaults/solana/${address}/add`,
        held: /\/v1\/portfolio(\?|$)/,
        settled: '[data-ui="add-money-screen"]',
        regions: [
          { name: 'title', waiting: 'main h1', loaded: 'main h1' },
          {
            name: 'amount',
            waiting: '[data-wait="amount"]',
            loaded: '[data-ui="add-money-screen"] [data-ui="field"]',
            sized: 'by-data',
          },
          {
            name: 'card',
            waiting: '[data-wait="card"]',
            loaded: '[data-ui="add-money-screen"] section[data-ui="card"]',
            sized: 'by-data',
          },
          // beside the amount on a desk; under the card on a phone, where the card's data places it
          ...(width >= 1024
            ? [
                {
                  name: 'where it goes',
                  waiting: '[data-wait="strategy"]',
                  loaded: '[data-ui="add-money-screen"] section:has(> h2)',
                  sized: 'by-data' as const,
                },
              ]
            : []),
        ],
      });
    });

    test('the publish form keeps the place of what a vault brings while the vaults are read', async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await withVault(page);
      const h = await hold(page, /\/v1\/(portfolio|vaults)/);
      await push(page, '/publish');
      const form = page.locator('[data-ui="publish-screen"] form');
      await expect(form.locator('[data-ui="publish-rows-wait"]')).toBeVisible();
      // the outlines are hidden from a screen reader and draw no share
      for (const outline of ['publish-source-wait', 'publish-rows-wait']) {
        const el = form.locator(`[data-ui="${outline}"]`);
        await expect(el).toHaveAttribute('aria-hidden', 'true');
        expect(await el.innerText()).not.toMatch(/[\d%]/);
      }
      await expect(page.locator('[data-ui="publish-row"]')).toHaveCount(0);
      await axe(page, `publish waiting, ${width}px`);
      await inTheme(page, 'dark');
      const regions: Region[] = [
        { name: 'title', waiting: 'main h1', loaded: 'main h1' },
        {
          name: 'source vault',
          waiting: '[data-ui="publish-screen"] form > section >> nth=0',
          loaded: '[data-ui="publish-screen"] form > section >> nth=0',
          sized: 'by-data',
        },
        {
          name: 'its words',
          waiting: '[data-ui="publish-screen"] form > section >> nth=1',
          loaded: '[data-ui="publish-screen"] form > section >> nth=1',
          sized: 'by-data',
        },
      ];
      const before = await boxesWaiting(page, regions);
      await shot(page, 'publish-loading');
      h.release();
      await expect(page.locator('[data-ui="publish-row"]')).toHaveCount(2, { timeout: 60_000 });
      await expect(form.locator('[data-ui="publish-rows-wait"]')).toHaveCount(0);
      await inTheme(page, 'dark');
      await expectNoShift(page, regions, before, `publish at ${width}px`);
      await shot(page, 'publish-loaded');
      await h.drop();
    });
  });
}

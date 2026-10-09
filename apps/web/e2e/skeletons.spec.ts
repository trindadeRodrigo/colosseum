import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { openPlan } from './invest';
import { inTheme } from './theme';
import {
  type Answer,
  axe,
  boxesWaiting,
  expectAnnouncedOnce,
  expectNoShift,
  hold,
  type Region,
  STUB,
  shot,
  WIDTHS,
} from './waits';

// Every screen that waits for data waits in its own outline (WEB-SKELETONS): while the API's answer
// is held the screen is one busy region with one polite line, axe clean in light and dark, and when
// the answer lands each main region is where its skeleton was, to the pixel, at 1440 px and at 375 px.
// A region whose height is its data's (a list of however many rows came) is held to its place and its
// width. An answer that fails gives the failure and a retry, never a skeleton that runs on; an empty
// answer gives the empty state, which is neither.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');

const waiting = (page: Page) => page.locator('main [data-ui="waiting"]');

/** To a page through sign-in, as a link from outside leads there: the wallet lives in the page. */
async function signInTo(page: Page, path: string) {
  await page.goto(`/sign-in?next=${encodeURIComponent(path)}`);
  await expect(page.getByRole('button', { name: en.signIn.passkey.continue })).toBeVisible();
  return async () => {
    await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
    // signed in with nowhere of its own to go, the screen offers the way on: take it
    // (it may also go on by itself, and the link with it: a press that finds it gone is no failure)
    const on = page.locator(`main a[href="${path}"]`);
    if (await on.isVisible({ timeout: 3_000 }).catch(() => false))
      await on.click({ timeout: 3_000 }).catch(() => {});
  };
}

/**
 * One screen at one width: it waits in its outline, says so once, passes axe, and when the answer
 * lands nothing has moved. `arrive` opens the screen with its answer held.
 */
async function waitsInPlace(
  page: Page,
  o: {
    name: string;
    width: number;
    held: RegExp;
    /** What the held read is answered with; left out, the stub's own answer. */
    answer?: (page: Page) => Promise<(url: URL) => Answer>;
    arrive: (page: Page) => Promise<void>;
    label?: string | RegExp;
    regions: Region[];
    /** The settled screen is there: something only the answer brings. */
    settled: string;
    /** Measure from the foot of this, where what stands over the screen is sized by its own words. */
    under?: string;
  },
) {
  await page.setViewportSize({ width: o.width, height: 900 });
  const h = await hold(page, o.held, o.answer ? await o.answer(page) : undefined);
  await o.arrive(page);
  await expect(waiting(page).first()).toBeVisible();
  // A move inside the app names the page a moment after it draws it, and the route's own wait
  // gives way to the page's: the page is named, and its wait has said what it waits for.
  await expect(waiting(page).first()).not.toHaveAttribute('data-phase', 'quiet');
  await expect(async () => {
    expect(await page.title()).toMatch(/\S/);
    await page.waitForTimeout(250);
    expect(await page.title()).toMatch(/\S/);
  }).toPass();
  await expectAnnouncedOnce(page, o.label);
  await axe(page, `${o.name} waiting, ${o.width}px`);
  await inTheme(page, 'dark');
  const before = await boxesWaiting(page, o.regions, o.under);
  await shot(page, `${o.name}-loading`);
  h.release();
  await expect(page.locator(o.settled).first()).toBeVisible({ timeout: 60_000 });
  await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
  await inTheme(page, 'dark');
  await expectNoShift(page, o.regions, before, `${o.name} at ${o.width}px`, o.under);
  await shot(page, `${o.name}-loaded`);
  await h.drop();
}

test.beforeEach(async ({ page }) => {
  await page.request.post(`${STUB}/__stub/reset`);
});

/** A sample answer of the stub's, by name (tests/e2e/stub-api.ts, `/__stub/sample/…`). */
async function sample<T = unknown>(page: Page, name: string): Promise<T> {
  const answer = await page.request.get(`${STUB}/__stub/sample/${name}`);
  expect(answer.ok(), `sample ${name}`).toBe(true);
  return answer.json() as Promise<T>;
}

/** The portfolio section's reads, each answered with every chain read: no notice over the page. */
async function sectionAnswers(page: Page, plans = 'plans') {
  const [p, e, r] = await Promise.all([
    sample(page, plans),
    sample(page, 'exposure'),
    sample(page, 'rebalances'),
  ]);
  return (u: URL): Answer =>
    u.pathname.endsWith('/plans')
      ? { body: p }
      : u.pathname.endsWith('/exposure')
        ? { body: e }
        : u.pathname.endsWith('/rebalances')
          ? { body: r }
          : 'pass';
}

/** The income plan's vault of the stub's sample answers, and the sample portfolio's slug. */
const SOL_INCOME = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SLUG = 'three-of-the-largest';

/** To an order's page as its own browser opens it: the record kept here, for the wallet signed in. */
async function toOrder(p: Page) {
  const { id, record } = await sample<{ id: string; record: object }>(p, 'order');
  await (await signInTo(p, '/shelf'))();
  await expect(p).toHaveURL(/\/shelf/);
  const wallet = p.locator('[data-ui="account-menu-button"] span[title]').first();
  await expect(wallet).toHaveAttribute('title', /.+/);
  const address = (await wallet.getAttribute('title')) ?? '';
  // the app's router goes there, so the page and its wallet stay
  await p.evaluate(
    ([orderId, kept]) => {
      window.localStorage.setItem(`tf-order:${orderId}`, kept as string);
      (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push(
        `/orders/${orderId}`,
      );
    },
    [id, JSON.stringify({ ...record, userId: `test:${address.slice(0, 8)}` })],
  );
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test('the shelf waits as cards in its grid', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'shelf',
        width,
        held: /\/v1\/shelf/,
        answer: async (p) => {
          const body = await sample(p, 'shelf');
          return () => ({ body });
        },
        arrive: (p) => p.goto('/shelf').then(() => {}),
        label: en.shared.shelf.loading,
        settled: '[data-ui="shelf-card"]',
        regions: [
          { name: 'title', waiting: 'main h1', loaded: 'main h1' },
          {
            name: 'first card',
            waiting: '[data-wait="shelf-card"]',
            loaded: '[data-ui="shelf-card"]',
            sized: 'by-data',
          },
          // beside the first on a desk; under it on a phone, where the first card's data places it
          ...(width >= 1024
            ? [
                {
                  name: 'second card',
                  waiting: '[data-wait="shelf-card"] >> nth=1',
                  loaded: '[data-ui="shelf-card"] >> nth=1',
                  sized: 'by-data' as const,
                },
              ]
            : []),
        ],
      });
    });

    test('a shared portfolio waits as its head and its pane', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'family',
        width,
        held: /\/v1\/indexes\//,
        answer: async (p) => {
          const body = await sample(p, 'family');
          return (u) =>
            u.pathname.endsWith('/versions') ? { status: 404, body: { error: 'none' } } : { body };
        },
        arrive: (p) => p.goto(`/indexes/${SLUG}`).then(() => {}),
        label: en.shared.family.loading,
        settled: '[data-ui="family-screen"]',
        regions: [
          {
            name: 'title',
            waiting: '[data-ui="family-wait"] [data-ui="skeleton-line"]',
            loaded: 'main h1',
          },
          {
            name: 'pane',
            waiting: '[data-ui="plan-pane-wait"]',
            loaded: '[data-ui="plan-pane"] [data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('the portfolio board waits as its figures, its chart and its table', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'portfolio',
        width,
        held: /\/v1\/portfolio\//,
        // every chain answered: the notice of one that did not is not part of the settled page
        answer: (p) => sectionAnswers(p),
        arrive: async (p) => (await signInTo(p, '/portfolio'))(),
        settled: '[data-ui="overview-board"]',
        regions: [
          {
            name: 'board',
            waiting: '[data-wait="board"]',
            loaded: '[data-ui="overview-board"]',
            sized: 'by-data',
          },
          // beside the figures on a desk; under them on a phone, where the figures' data places them
          ...(width >= 1024
            ? [
                {
                  name: 'chart',
                  waiting: '[data-wait="board-chart"]',
                  loaded: '[data-ui="overview-board"] > div > div >> nth=1',
                  sized: 'by-data' as const,
                },
                {
                  name: 'vaults',
                  waiting: '[data-wait="vaults"]',
                  loaded: 'section[aria-labelledby="overview-vaults"]',
                  sized: 'by-data' as const,
                },
              ]
            : []),
        ],
      });
    });

    test('rebalancing waits as a card a vault', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'portfolio-rebalancing',
        width,
        held: /\/v1\/portfolio\//,
        answer: (p) => sectionAnswers(p),
        arrive: async (p) => (await signInTo(p, '/portfolio/rebalancing'))(),
        settled: '[data-ui="vault-steps"]',
        regions: [
          { name: 'title', waiting: 'main h1', loaded: 'main h1' },
          {
            name: 'first vault',
            waiting: '[data-wait="vault-steps"]',
            loaded: '[data-ui="vault-steps"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('exposure waits as its notes and a chain’s block', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'portfolio-exposure',
        width,
        held: /\/v1\/portfolio\//,
        answer: (p) => sectionAnswers(p),
        arrive: async (p) => (await signInTo(p, '/portfolio/exposure'))(),
        settled: '[data-ui="chain-exposure"]',
        regions: [
          { name: 'title', waiting: 'main h1', loaded: 'main h1' },
          {
            name: 'notes',
            waiting: '[data-ui="exposure-wait"] > ul',
            loaded: '[data-ui="exposure-notes"]',
          },
          {
            name: 'first chain',
            waiting: '[data-wait="chain-exposure"]',
            loaded: '[data-ui="chain-exposure"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('a vault’s page of the board waits block by block', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'portfolio-plan',
        width,
        held: /\/v1\/portfolio\//,
        arrive: async (p) => (await signInTo(p, `/portfolio/plan/solana/${SOL_INCOME}`))(),
        settled: '[data-ui="plan-blocks"]',
        regions: [
          { name: 'way back', waiting: '[data-ui="plan-back"]', loaded: '[data-ui="plan-back"]' },
          { name: 'title', waiting: 'main h1', loaded: 'main h1', sized: 'by-data' },
        ],
      });
    });

    test('the monitor waits as its sums and a vault’s card', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'monitor',
        width,
        held: /\/v1\/portfolio(\?|$)/,
        answer: async (p) => {
          const body = await sample(p, 'monitor');
          return () => ({ body });
        },
        arrive: async (p) => (await signInTo(p, '/monitor'))(),
        settled: '[data-ui="vault"]',
        regions: [
          {
            name: 'sums',
            waiting: '[data-ui="monitor-head-wait"] > div',
            loaded: '[data-ui="portfolio-summary"]',
          },
          {
            name: 'new plan',
            waiting: '[data-ui="monitor-head-wait"] > [data-ui="skeleton"]',
            loaded: '[data-ui="new-plan"]',
            sized: 'by-words',
          },
          {
            name: 'vault',
            waiting: '[data-wait="vault"]',
            loaded: '[data-ui="vault"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('a plan’s page waits as its head and its pane', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'plan',
        width,
        held: /\/v1\/baskets\//,
        arrive: (p) => openPlan(p),
        label: en.chain.reading,
        settled: '[data-ui="plan-screen"]',
        regions: [
          {
            name: 'chain',
            waiting: '[data-ui="plan-screen-wait"] [data-ui="skeleton"]',
            loaded: '[data-ui="plan-screen"] [data-ui="chain-badge"]',
            sized: 'by-words',
          },
          {
            name: 'title',
            waiting: '[data-ui="plan-screen-wait"] [data-ui="skeleton-line"]',
            loaded: 'main h1',
          },
          {
            name: 'pane',
            waiting: '[data-ui="plan-pane-wait"]',
            loaded: '[data-ui="plan-pane"] [data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('a plan’s buy page waits as its head, its amount and its card', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'buy',
        width,
        held: /\/v1\/baskets\//,
        arrive: (p) => openPlan(p, '/buy'),
        label: en.chain.reading,
        settled: '[data-ui="buy-screen"]',
        regions: [
          {
            name: 'title',
            waiting: '[data-ui="buy-screen-wait"] p',
            loaded: '[data-ui="buy-screen"] h1',
          },
          {
            name: 'amount',
            waiting: '[data-wait="amount"]',
            loaded: '[data-ui="buy-screen"] [data-ui="field"]',
            sized: 'by-data',
          },
          {
            name: 'card',
            waiting: '[data-wait="invest-card"]',
            loaded: '[data-ui="buy-screen"] section[data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
    });

    test('an order’s page waits as its head and its steps', async ({ page }) => {
      await waitsInPlace(page, {
        name: 'order',
        width,
        held: /\/v1\/orders\//,
        answer: async (p) => {
          const { order } = await sample<{ order: object }>(p, 'order');
          return () => ({ body: order });
        },
        arrive: toOrder,
        label: en.order.loading,
        settled: '[data-ui="order-screen"]',
        regions: [
          {
            name: 'chain',
            waiting: '[data-ui="order-screen-wait"] [data-ui="chain-badge"]',
            loaded: '[data-ui="order-screen"] [data-ui="chain-badge"]',
          },
          {
            name: 'title',
            waiting: '[data-ui="order-screen-wait"] h1',
            loaded: '[data-ui="order-screen"] h1',
          },
          {
            name: 'steps',
            waiting: '[data-wait="order-steps"]',
            loaded: '[data-ui="order-screen"] section[data-ui="card"]',
            sized: 'by-data',
          },
        ],
      });
    });

    for (const id of ['stocks', 'lending', 'stablecoins', 'simulation'] as const)
      test(`Bearing’s ${id} waits in the page’s own boxes`, async ({ page }) => {
        await page.clock.setFixedTime(Date.parse('2026-10-03T18:58:40.766Z'));
        await waitsInPlace(page, {
          name: `analytics-${id}`,
          width,
          held: /\/risk\//,
          arrive: (p) => p.goto(`/analytics/${id}`).then(() => {}),
          settled: 'main [data-ui="bearing-kpis"] [data-ui="figure"]',
          // The banner over the page is as tall as what it says, and the recording's readings are
          // old, which takes more words than live ones: the page is held to its place under it.
          under: '[data-ui="bearing-banner"]',
          regions: [
            { name: 'title', waiting: 'main h1', loaded: 'main h1' },
            {
              name: 'figures',
              waiting: '[data-ui="bearing-kpis"]',
              loaded: '[data-ui="bearing-kpis"]',
            },
            // the simulation opens with its form; the others with two chart cards under the figures
            id === 'simulation'
              ? {
                  name: 'form',
                  waiting: '[data-ui="bearing-skeleton"] [data-ui="bearing-card"]',
                  loaded: 'main [data-ui="bearing-card"]:has(form)',
                  sized: 'by-data',
                }
              : {
                  name: 'first chart',
                  waiting: '[data-ui="bearing-skeleton"] [data-ui="bearing-card"]',
                  loaded: '[data-ui="bearing-kpis"] ~ * [data-ui="bearing-card"]',
                  sized: 'by-data',
                },
          ],
        });
      });
  });
}

// A read that fails is not a wait that goes on, and an answer with nothing in it is neither: each is
// its own sentence, and while the answer is held the screen says neither.
const emptyCard = 'main [data-ui="card-empty"]';
const tryAgain = (page: Page) =>
  page
    .locator('main')
    .getByRole('button', { name: /again/i })
    .or(page.locator('main').getByRole('link', { name: /again/i }))
    .first();

type Outcome = {
  name: string;
  held: RegExp;
  arrive: (page: Page) => Promise<void>;
  /** The sample answer with nothing in it, where the screen has an empty state of its own. */
  empty?: string;
};
const OUTCOMES: Outcome[] = [
  {
    name: 'the shelf',
    held: /\/v1\/shelf/,
    arrive: (p) => p.goto('/shelf').then(() => {}),
    empty: 'shelf-empty',
  },
  {
    name: 'a shared portfolio',
    held: /\/v1\/indexes\//,
    arrive: (p) => p.goto(`/indexes/${SLUG}`).then(() => {}),
  },
  {
    name: 'the portfolio board',
    held: /\/v1\/portfolio\//,
    arrive: async (p) => (await signInTo(p, '/portfolio'))(),
    empty: 'plans-empty',
  },
  {
    name: 'rebalancing',
    held: /\/v1\/portfolio\//,
    arrive: async (p) => (await signInTo(p, '/portfolio/rebalancing'))(),
  },
  {
    name: 'exposure',
    held: /\/v1\/portfolio\//,
    arrive: async (p) => (await signInTo(p, '/portfolio/exposure'))(),
  },
  {
    name: 'a vault’s page of the board',
    held: /\/v1\/portfolio\//,
    arrive: async (p) => (await signInTo(p, `/portfolio/plan/solana/${SOL_INCOME}`))(),
  },
  {
    name: 'the monitor',
    held: /\/v1\/portfolio(\?|$)/,
    arrive: async (p) => (await signInTo(p, '/monitor'))(),
    empty: 'monitor-empty',
  },
  { name: 'an order’s page', held: /\/v1\/orders\//, arrive: toOrder },
];

for (const o of OUTCOMES) {
  test(`${o.name}: a read that fails says so and offers to read again`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const h = await hold(page, o.held, () => 'fail');
    await o.arrive(page);
    await expect(waiting(page).first()).toBeVisible();
    // while it waits, nothing says the read failed or came back empty
    await expect(tryAgain(page)).toHaveCount(0);
    await expect(page.locator(emptyCard)).toHaveCount(0);
    h.release();
    await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(tryAgain(page)).toBeVisible();
    await expect(page.locator('main [data-ui="skeleton"]:visible')).toHaveCount(0);
    await axe(page, `${o.name} failed`);
    // asked again with the API answering, the failure gives way to the screen
    const failed = await page.locator('main').innerText();
    await h.drop();
    await tryAgain(page).click();
    await expect.poll(() => page.locator('main').innerText(), { timeout: 60_000 }).not.toBe(failed);
    await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('main [data-ui="skeleton"]:visible')).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toBe(failed);
  });

  const { empty } = o;
  if (empty)
    test(`${o.name}: an answer with nothing in it is the empty state, not a wait`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      const body = await sample(page, empty);
      const h = await hold(page, o.held, (u) =>
        // the board's other reads answer as the stub does: only its plans are none
        o.name === 'the portfolio board' && !u.pathname.endsWith('/plans') ? 'pass' : { body },
      );
      await o.arrive(page);
      await expect(waiting(page).first()).toBeVisible();
      // loading and empty look different: while it waits, nothing says there is nothing
      await expect(page.locator(emptyCard)).toHaveCount(0);
      h.release();
      await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.locator(emptyCard).first()).toBeVisible();
      await expect(tryAgain(page)).toHaveCount(0);
      await expect(page.locator('main [data-ui="skeleton"]:visible')).toHaveCount(0);
      await axe(page, `${o.name} empty`);
    });
}

test('a plan the server does not have says so, with the way to build it again', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const h = await hold(page, /\/v1\/baskets\//, () => ({ status: 404, body: { error: 'none' } }));
  await openPlan(page);
  await expect(waiting(page).first()).toBeVisible();
  h.release();
  await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.plan.missing.title);
  await expect(page.getByRole('link', { name: en.plan.missing.again })).toBeVisible();
  await expect(page.locator('main [data-ui="skeleton"]:visible')).toHaveCount(0);
});

test('a long wait says the server may be waking, in the one status line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // the stub answers slowly, as the hosted API does on a first request after it slept
  await page.request.post(`${STUB}/__stub/delay`, { data: { ms: 6_000 } });
  await page.goto('/shelf');
  const wait = waiting(page).first();
  await expect(wait).toHaveAttribute('data-phase', 'slow', { timeout: 10_000 });
  await expect(wait.locator('[role="status"]')).toContainText(en.shell.wait.slow);
  // the line is in the window, over the skeleton's foot, and no bar pretends to know how far along
  await expect(wait.locator('[role="status"]')).toBeInViewport();
  await expect(page.locator('main [role="progressbar"], main progress')).toHaveCount(0);
  await expect(wait).toHaveCount(0, { timeout: 30_000 });
});

test('a Bearing page with nothing collected on a chain says so at once, with no skeleton of figures', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // the risk API is not answering: the page does not need it to know it has nothing to read
  const h = await hold(page, /\/risk\//);
  await page.goto('/analytics/lending?chain=robinhood');
  await expect(page.locator('[data-ui="bearing-not-on-chain"]')).toBeVisible();
  await expect(page.locator('main [data-ui="bearing-skeleton"]')).toHaveCount(0);
  await expect(page.locator('main [data-ui="figure"]')).toHaveCount(0);
  h.release();
  await expect(page.locator('[data-ui="bearing-not-on-chain"]')).toBeVisible();
  await expect(waiting(page)).toHaveCount(0);
});

test('a shared portfolio’s way back works while the page waits', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const h = await hold(page, /\/v1\/indexes\//);
  await page.goto(`/indexes/${SLUG}`);
  await expect(waiting(page).first()).toBeVisible();
  // a link, to a screen reader too, and it leads back while the read is still held
  const back = page.locator('main').getByRole('link', { name: en.shared.family.backToShelf });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/shelf/);
  h.release();
});

test('a vault’s page of the board moves once: a block that reads after the plans waits in the frame the page drew', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const BLOCKS = ['history', 'exit', 'risk', 'trades'] as const;
  const frames = (stage: 'page' | 'block') =>
    Promise.all(
      BLOCKS.map(async (b) => {
        const frame =
          stage === 'page'
            ? page.locator(`[data-ui="plan-${b}-wait"] > div`)
            : page.locator(`[data-ui="plan-${b}"] [data-ui="card"]:has([data-ui="waiting"])`);
        await expect(frame, `${b}, ${stage}`).toBeVisible();
        const box = await frame.boundingBox();
        return { block: b, x: box?.x, width: box?.width, height: box?.height };
      }),
    );
  const plans = await hold(page, /\/v1\/portfolio\/plans/);
  const rest = await hold(page, /\/v1\/portfolio\/(history|exposure|rebalances)/);
  await (await signInTo(page, `/portfolio/plan/solana/${SOL_INCOME}`))();
  await expect(page.locator('[data-ui="plan-wait"]')).toBeVisible();
  const drawn = await frames('page');
  // the plans land; each block's own read is still on its way
  plans.release();
  await expect(page.locator('[data-ui="plan-blocks"]')).toBeVisible({ timeout: 60_000 });
  // every block frame is the size the page's wait drew it: no room added for a line of its own
  expect(await frames('block')).toEqual(drawn);
  // and each says what it waits for, in its frame
  await expect(page.locator('[data-ui="plan-history"] [role="status"]')).toHaveCount(1);
  rest.release();
  await expect(waiting(page)).toHaveCount(0, { timeout: 60_000 });
});

test('the board’s chart says what it waits for, in words, while its history is read', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await hold(page, /\/v1\/portfolio\/history/);
  await (await signInTo(page, '/portfolio'))();
  const wait = page.locator('[data-ui="chart-wait"] [data-ui="waiting"]');
  await expect(wait).toHaveAttribute('aria-busy', 'true');
  // a sighted person reads it too: the line is on the page, not for a screen reader alone
  const line = wait.locator('[role="status"]');
  await expect(line).toHaveText(/\S/);
  await expect(line).toBeInViewport();
  expect(await line.evaluate((el) => el.classList.contains('sr-only'))).toBe(false);
  await expect(page.locator('[data-ui="board-pnl-wait"]')).toBeVisible();
  h.release();
  await expect(wait).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('[data-ui="overview-chart"]')).toBeVisible();
});

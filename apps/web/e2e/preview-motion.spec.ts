import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// The draft on /goal, drawn on the plan bar (plan-leg.md, HoldingLegs.tsx): at most four legs with
// their labels, every holding in the rows, how a draft arrives, and what the card shows while a reply
// is on its way. The stub answers
// every turn with the same two picks, so each reply here is the stub's own with its allocations
// swapped for the mix under test. No model is called and nothing is bought.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;

type Mix = readonly (readonly [symbol: string, bps: number])[];
const SIX: Mix = [
  ['SPY', 1667],
  ['QQQ', 1667],
  ['NVDA', 1667],
  ['AAPL', 1667],
  ['Gold', 1666],
  ['USDC', 1666],
];
/** The next turn's: one piece grows, one shrinks, one leaves, one comes. */
const CHANGED: Mix = [
  ['SPY', 3000],
  ['QQQ', 1000],
  ['NVDA', 1667],
  ['Gold', 1666],
  ['USDC', 1667],
  ['TSLA', 1000],
];
const TWO: Mix = [
  ['SPY', 6000],
  ['Gold', 4000],
];
const MANY: Mix = [
  ['SPY', 2500],
  ['QQQ', 1500],
  ['NVDA', 1000],
  ['AAPL', 1000],
  ['MSFT', 800],
  ['TSLA', 700],
  ['AMZN', 600],
  ['META', 500],
  ['Gold', 500],
  ['COIN', 400],
  ['HOOD', 300],
  ['USDC', 200],
];

const idOf = (symbol: string) => `solana:${symbol.toLowerCase()}`;
const proposalOf = (mix: Mix) => ({
  objective: 'Sample: grow with a hedge',
  summary: 'Sample: a mix the spec made up, to see it drawn.',
  allocations: mix.map(([symbol, weightBps]) => ({
    assetId: idOf(symbol),
    weightBps,
    why: `Sample: a reason the spec made up for ${symbol}.`,
    evidenceIds: [`catalog:${idOf(symbol)}`],
    symbol,
  })),
  tradeoffs: ['Sample: every part of this can fall.'],
  unknowns: ['Sample: nothing here is measured.'],
  sources: mix.map(([symbol]) => ({
    id: `catalog:${idOf(symbol)}`,
    label: 'Listed on this chain',
    source: 'the e2e spec',
    method: 'sample: made up for the end-to-end spec',
    fetchedAt: '2026-10-05T12:00:00.000Z',
    provenance: 'mock',
  })),
});

async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
    ),
    name,
  ).toEqual([]);
}

/** Answers the next turns with `mix`, each once `gate` lets it through. */
async function answerWith(page: Page, mix: Mix, gate: Promise<void> = Promise.resolve()) {
  await page.unroute('**/v1/conversations/*/goal/reply');
  await page.route('**/v1/conversations/*/goal/reply', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await gate;
    await route.fulfill({
      response,
      json: {
        ...body,
        proposal: proposalOf(mix),
        weightNotes: [{ code: 'equal_split', assetIds: mix.map(([symbol]) => idOf(symbol)) }],
      },
    });
  });
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

async function say(page: Page, words: string) {
  const box = page.locator('textarea');
  await box.fill(words);
  await box.press('Enter');
}

const shareOf = (bps: number) =>
  new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 }).format(
    bps / 10_000,
  );
/** Every row's holding and share, as the card shows them now. */
const shownShares = (page: Page) =>
  page
    .locator('[data-ui="goal-strategy"] tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.getAttribute('data-row'),
        row.querySelector('[data-part="share"]')?.textContent,
      ]),
    );
/** The labels under the bar: a leg's name and its share. */
const labels = (page: Page) =>
  page
    .locator('[data-ui="goal-strategy"] [data-ui="plan-legs"] ol > li')
    .evaluateAll((items) => items.map((item) => item.textContent));
/** What the bar draws: the three largest holdings a leg each, and the rest as one. */
const legsOf = (mix: Mix) => {
  if (mix.length <= 4) return mix.map(([symbol, bps]) => `${symbol}·${shareOf(bps)}`);
  const largest = [...mix.entries()]
    .sort(([a, [, x]], [b, [, y]]) => y - x || a - b)
    .slice(0, 3)
    .map(([at]) => at);
  const rest = mix.filter((_, at) => !largest.includes(at));
  return [
    ...mix
      .filter((_, at) => largest.includes(at))
      .map(([symbol, bps]) => `${symbol}·${shareOf(bps)}`),
    `${en.shared.vault.conversation.others(rest.length)}·${shareOf(rest.reduce((sum, [, bps]) => sum + bps, 0))}`,
  ];
};

test('a draft arrives on the plan bar with its rows, and the next one takes its place', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strategy = page.locator('[data-ui="goal-strategy"]');
  const bar = strategy.locator('[data-ui="plan-legs-bar"]');

  // while the first reply is on its way the card says it is being worked on
  let release = () => {};
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(strategy.locator('[data-ui="draft-building"] h2')).toHaveText(
    en.goal.explore.building,
  );
  release();

  // six holdings: three legs and one for the rest, each labelled; every holding in the rows, exact
  await expect(bar.locator('> *')).toHaveCount(4);
  const final = SIX.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]);
  expect(await shownShares(page)).toEqual(final);
  expect(await labels(page)).toEqual(legsOf(SIX));
  // the legs seat once (plan-lock), and the card is the same size while they do
  const seating = () =>
    bar.evaluate((el) =>
      el
        .getAnimations({ subtree: true })
        .map((a) => [(a as CSSAnimation).animationName, a.effect?.getComputedTiming().endTime]),
    );
  expect((await seating()).map(([name]) => name)).toEqual(['seat', 'seat', 'seat', 'seat']);
  expect(Math.max(...(await seating()).map(([, end]) => Number(end)))).toBeLessThanOrEqual(1200);
  const midway = await strategy.locator('[data-ui="card"]').boundingBox();
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.finish();
  });
  expect(await strategy.locator('[data-ui="card"]').boundingBox()).toEqual(midway);
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();

  // his bar: 24px tall on this card, pill ends, a 2px gap in the ground colour, the leg colours in turn
  const drawn = await bar.evaluate((el) => {
    const legs = [...el.children] as HTMLElement[];
    const style = (leg: HTMLElement | undefined) => (leg ? getComputedStyle(leg) : null);
    return {
      height: el.getBoundingClientRect().height,
      gap: getComputedStyle(el).columnGap,
      left: style(legs[0])?.borderTopLeftRadius !== '0px',
      right: style(legs.at(-1))?.borderTopRightRadius !== '0px',
      inner: style(legs[1])?.borderTopLeftRadius,
      widths: legs.map((leg) => leg.getBoundingClientRect().width),
      colours: legs.map((leg) => getComputedStyle(leg).backgroundColor),
    };
  });
  expect(drawn).toMatchObject({ height: 24, gap: '2px', left: true, right: true, inner: '0px' });
  expect(new Set(drawn.colours).size).toBe(4);
  const all = drawn.widths.reduce((sum, w) => sum + w, 0);
  expect((drawn.widths[0] ?? 0) / all).toBeCloseTo(0.1667, 2);
  expect((drawn.widths[3] ?? 0) / all).toBeCloseTo(0.4999, 2);
  // a row's swatch is the colour of the leg it is drawn in: the three grouped holdings share one
  const swatches = await strategy
    .locator('tbody [data-part="swatch"]')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(swatches).toEqual([...drawn.colours.slice(0, 3), ...Array(3).fill(drawn.colours[3])]);
  // pointing at a label rules its segment and dims nothing; the bar itself is not a control
  await expect(bar).toHaveAttribute('aria-hidden', 'true');
  await strategy.locator('[data-ui="plan-legs"] ol > li').nth(1).hover();
  const pointed = await bar.evaluate((el) =>
    ([...el.children] as HTMLElement[]).map((leg) => [
      getComputedStyle(leg).borderTopWidth,
      getComputedStyle(leg).opacity,
    ]),
  );
  expect(pointed).toEqual([
    ['0px', '1'],
    ['2px', '1'],
    ['0px', '1'],
    ['0px', '1'],
  ]);
  await page.mouse.move(0, 0);

  // the next turn: the draft stays, marked as the one from before, and cannot be used meanwhile
  await answerWith(page, CHANGED, new Promise<void>((done) => (release = done)));
  await say(page, 'More of the broad fund, and swap one stock');
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(
    en.shared.vault.conversation.reworking,
  );
  await expect(strategy.locator('[data-action="deposit"]')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(strategy.locator('[data-action="deposit"]')).toContainText(
    en.shared.vault.conversation.waitingAction,
  );
  expect(await shownShares(page)).toEqual(final);
  // a wait can be long: every word and figure on the waiting card stays readable, in both themes
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    await axe(page, `pending, ${theme}`);
  }
  release();
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText('');
  expect(await shownShares(page)).toEqual(
    CHANGED.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]),
  );
  expect(await labels(page)).toEqual(legsOf(CHANGED));
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();
});

test('with reduced motion a draft crossfades in, and nothing slides', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const bar = page.locator('[data-ui="goal-strategy"] [data-ui="plan-legs-bar"]');
  let release = () => {};
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(page.locator('[data-ui="draft-building"]')).toBeVisible();
  release();
  await expect(bar.locator('> *')).toHaveCount(4);
  // STYLE.md: every slide becomes a 120ms crossfade
  const moving = await bar.evaluate((el) =>
    el
      .getAnimations({ subtree: true })
      .map((a) => [(a as CSSAnimation).animationName, a.effect?.getComputedTiming().duration]),
  );
  for (const [name, duration] of moving) expect([name, duration]).toEqual(['fade', 120]);
  expect(await labels(page)).toEqual(legsOf(SIX));
});

for (const [name, mix] of [
  ['two', TWO],
  ['six', SIX],
  ['twelve', MANY],
] as const)
  test(`a draft of ${name} holdings fits a phone and a desk`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const strategy = page.locator('[data-ui="goal-strategy"]');
    const bar = strategy.locator('[data-ui="plan-legs-bar"]');
    await answerWith(page, mix);
    await say(page, 'A draft to look at');
    await expect(bar.locator('> *')).toHaveCount(Math.min(mix.length, 4));
    expect(await labels(page)).toEqual(legsOf(mix));
    // every holding has a row with its exact share, however the bar groups them
    expect(await shownShares(page)).toEqual(
      mix.map(([symbol, bps]) => [idOf(symbol), shareOf(bps)]),
    );
    for (const theme of ['dark', 'light'] as const) {
      await inTheme(page, theme);
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        const wide = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(wide, `${theme}, ${width}px: no sideways scroll`).toBeLessThanOrEqual(width);
        // every leg lies inside the bar, and can be seen
        const box = await bar.boundingBox();
        const legs = await bar
          .locator('> *')
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
        for (const leg of legs) {
          expect(leg.left).toBeGreaterThanOrEqual((box?.x ?? 0) - 0.5);
          expect(leg.right).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
          expect(leg.width).toBeGreaterThanOrEqual(2);
        }
        if (SHOTS) {
          // a window tall enough for the whole card: the pane scrolls on a desk
          await page.setViewportSize({ width, height: 2400 });
          await strategy
            .locator('[data-ui="card"]')
            .screenshot({ path: `${SHOTS}/card-${name}-${width}-${theme}.png` });
        }
      }
      await page.setViewportSize({ width: 375, height: 812 });
      await page.mouse.move(0, 0);
      await axe(page, theme);
    }
  });

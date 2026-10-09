import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// The proposed strategy on /goal, drawn as a joint (plan-leg.md, "The mix joint"): how a draft comes,
// how the next one changes it, and what the card shows while a reply is on its way. The stub answers
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
const ONE: Mix = [['USDC', 10_000]];
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

/** 90% and ten lines of 1%: each small one is drawn at 3%, wider than it is. */
const SMALL: Mix = [
  ['SPY', 9000],
  ...Array.from({ length: 10 }, (_, i) => [`S${i}`, 100] as const),
];

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

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const shareOf = (_lang: 'en', bps: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(bps / 10_000);
/** Every row's name and share, as the card shows them now. */
const shownShares = (page: Page) =>
  page
    .locator('[data-ui="goal-strategy"] tbody tr')
    .evaluateAll((rows) =>
      rows.map((row) => [
        row.getAttribute('data-row'),
        row.querySelector('[data-part="share"]')?.textContent,
      ]),
    );
/** Stops the card's motion at one moment of it, so a frame of it can be looked at. */
const freezeAt = (page: Page, ms: number) =>
  page.evaluate((at) => {
    for (const a of document.getAnimations()) {
      const name = (a as CSSAnimation).animationName ?? '';
      if (!/^(joint-|fade|pin-drop)/.test(name)) continue;
      a.pause();
      a.currentTime = at;
    }
  }, ms);
const resume = (page: Page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.finish();
  });

test('a draft arrives as a joint tied to its rows, and the next one moves only what changed', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const strategy = page.locator('[data-ui="goal-strategy"]');
  const joint = strategy.locator('[data-ui="mix-joint"]');

  // while the first reply is on its way the card says it is being worked on
  let release = () => {};
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(strategy.locator('[data-ui="goal-working"]')).toHaveText(en.goal.explore.working);
  await expect(strategy.locator('[data-ui="lattice-loader"]')).toBeVisible();
  await shot(page, 'pending-first-1440');
  release();

  // it assembles: every figure is the proposal's own from the first frame, and nothing moves the card
  await expect(joint).toHaveAttribute('data-motion', 'arrive');
  await freezeAt(page, 330);
  const final = SIX.map(([symbol, bps]) => [idOf(symbol), shareOf('en', bps)]);
  expect(await shownShares(page)).toEqual(final);
  const midway = await strategy.locator('[data-ui="card"]').boundingBox();
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();
  await shot(page, 'arrival-midway-1440');
  // the whole arrival is over within 1.2s
  const ends = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => /^(joint-|fade|pin-drop)/.test((a as CSSAnimation).animationName ?? ''))
      .map((a) => Number(a.effect?.getComputedTiming().endTime)),
  );
  expect(ends.length).toBeGreaterThan(SIX.length);
  expect(Math.max(...ends)).toBeLessThanOrEqual(1200);
  await resume(page);
  expect(await strategy.locator('[data-ui="card"]').boundingBox()).toEqual(midway);
  expect(await shownShares(page)).toEqual(final);
  await shot(page, 'settled-1440');

  // a piece is one asset, named with the share its row shows, and as wide as that share
  const pieces = joint.locator('[data-part="piece"]');
  await expect(pieces).toHaveCount(SIX.length);
  for (const [i, [symbol, bps]] of SIX.entries())
    await expect(pieces.nth(i)).toHaveAccessibleName(`${symbol}, ${shareOf('en', bps)}`);
  const beam = await joint.getByRole('toolbar').boundingBox();
  const first = await pieces.first().boundingBox();
  expect((first?.width ?? 0) / (beam?.width ?? 1)).toBeCloseTo(0.1667, 2);
  // and it carries its row's colour
  const colours = (selector: string) =>
    strategy
      .locator(selector)
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(await colours('tbody [data-part="swatch"]')).toEqual(
    await colours('[data-part="piece"] [data-part="fill"]'),
  );

  // a mouse on a piece lights its row, and on a row its piece
  const row = (symbol: string) => strategy.locator(`tr[data-row="${idOf(symbol)}"]`);
  const piece = (symbol: string) => joint.locator(`[data-asset="${idOf(symbol)}"]`);
  await piece('NVDA').hover();
  await expect(row('NVDA')).toHaveAttribute('data-lit', 'true');
  await expect(joint.locator('[data-ui="mix-joint-readout"]')).toContainText('NVDA');
  await shot(page, 'lit-1440');
  await row('Gold').hover();
  await expect(piece('Gold')).toHaveAttribute('data-lit', 'true');
  await expect(piece('NVDA')).toHaveAttribute('data-lit', 'false');
  await page.mouse.move(0, 0);
  // the keyboard: the beam is one stop, the arrows walk its pieces
  await piece('SPY').focus();
  await expect(row('SPY')).toHaveAttribute('data-lit', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(piece('QQQ')).toBeFocused();
  await expect(row('QQQ')).toHaveAttribute('data-lit', 'true');
  await page.keyboard.press('Escape');
  await expect(row('QQQ')).toHaveAttribute('data-lit', 'false');

  // the next turn: the draft stays, marked as the one before, and cannot be used meanwhile
  await answerWith(page, CHANGED, new Promise<void>((done) => (release = done)));
  await say(page, 'More of the broad fund, and swap one stock');
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(
    en.shared.vault.conversation.reworking,
  );
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(pieces).toHaveCount(SIX.length);
  await shot(page, 'pending-next-1440');
  // the keyboard stands on a piece the next draft will drop
  await piece('AAPL').focus();
  release();

  // then only the difference moves: what stayed slides and resizes, the new piece seats, the old fades
  await expect(joint).toHaveAttribute('data-motion', 'change');
  await freezeAt(page, 120);
  expect(await shownShares(page)).toEqual(
    CHANGED.map(([symbol, bps]) => [idOf(symbol), shareOf('en', bps)]),
  );
  await expect(joint.locator('[data-part="ghost"]')).toHaveCount(1);
  await expect(piece('SPY').locator('.tf-joint-size')).toHaveCount(1);
  await expect(piece('TSLA').locator('.tf-joint-arrive')).toHaveCount(1);
  // a piece neither moved nor resized stands still
  await expect(piece('SPY').locator('[data-part="body"]')).not.toHaveClass(/tf-joint-move/);
  await expect(piece('USDC').locator('[data-part="body"]')).toHaveClass(/tf-joint-move/);
  // the piece that had the keyboard is gone: the beam has it, and nothing is left lit or dimmed
  await expect(joint.getByRole('toolbar')).toBeFocused();
  await expect(joint.locator('[data-lit="true"]')).toHaveCount(0);
  await shot(page, 'changed-midway-1440');
  await resume(page);
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText('');
  await expect(strategy.getByRole('button', { name: en.mix.preview.deposit })).toBeEnabled();
  await shot(page, 'changed-settled-1440');

  // a wait can be long: every word and figure on the waiting card stays readable, in both themes
  await answerWith(page, SIX, new Promise<void>((done) => (release = done)));
  await say(page, 'Back to the first one');
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(
    en.shared.vault.conversation.reworking,
  );
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    await axe(page, `pending, ${theme}`);
    await shot(page, `pending-next-${theme}-1440`);
  }
  release();
  await expect(pieces).toHaveCount(SIX.length);
});

test('with reduced motion a draft is simply there, and the next one too', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const joint = page.locator('[data-ui="goal-strategy"] [data-ui="mix-joint"]');
  const moving = () =>
    page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => /^(joint-|fade|pin-drop)/.test((a as CSSAnimation).animationName ?? ''))
          .length,
    );
  await answerWith(page, SIX);
  await say(page, 'Technology stocks, with some gold and cash');
  await expect(joint).toHaveAttribute('data-motion', 'still');
  expect(await moving()).toBe(0);
  await shot(page, 'reduced-motion-1440');
  await answerWith(page, CHANGED);
  await say(page, 'More of the broad fund, and swap one stock');
  await expect(joint.locator('[data-asset="solana:tsla"]')).toBeVisible();
  await expect(joint).toHaveAttribute('data-motion', 'still');
  await expect(joint.locator('[data-part="ghost"]')).toHaveCount(0);
  expect(await moving()).toBe(0);
  // lighting a piece changes its colour only: it does not lift
  await joint.locator('[data-asset="solana:spy"]').hover();
  expect(
    await joint
      .locator('[data-asset="solana:spy"] [data-part="body"]')
      .evaluate((el) => getComputedStyle(el).translate),
  ).toMatch(/^(none|0px)/);
});

for (const [name, mix] of [
  ['one', ONE],
  ['many', MANY],
  ['small', SMALL],
] as const)
  test(`a draft of ${name} asset${mix.length > 1 ? 's' : ''} fits a phone and a desk`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    const strategy = page.locator('[data-ui="goal-strategy"]');
    const joint = strategy.locator('[data-ui="mix-joint"]');
    await answerWith(page, mix);
    await say(page, 'A mix to look at');
    await expect(joint.locator('[data-part="piece"]')).toHaveCount(mix.length);
    // a finger: a tap on a piece lights its row, and a tap elsewhere lets it go
    const last = mix[mix.length - 1]?.[0] ?? '';
    const piece = joint.locator(`[data-asset="${idOf(last)}"]`);
    const row = strategy.locator(`tr[data-row="${idOf(last)}"]`);
    await piece.dispatchEvent('pointerup', { pointerType: 'touch' });
    await expect(row).toHaveAttribute('data-lit', 'true');
    await strategy.locator('h3').first().dispatchEvent('pointerdown', { pointerType: 'touch' });
    await expect(row).toHaveAttribute('data-lit', 'false');
    await row.dispatchEvent('pointerup', { pointerType: 'touch' });
    await expect(piece).toHaveAttribute('data-lit', 'true');
    await strategy.locator('h3').first().dispatchEvent('pointerdown', { pointerType: 'touch' });

    // the words under the beam say what it draws: exact widths, or small shares drawn wider
    await expect(joint.locator('[data-part="hint"]')).toHaveText(
      mix.some(([, bps]) => bps < 300)
        ? en.shared.vault.conversation.jointHintWidened
        : en.shared.vault.conversation.jointHint,
    );
    // lighting a piece does not move what is under the beam, however many lines the hint takes
    const table = () => strategy.locator('table').boundingBox();
    const rest = await table();
    await piece.dispatchEvent('pointerup', { pointerType: 'touch' });
    await expect(joint.locator('[data-part="lit"]')).toBeVisible();
    expect(await table()).toEqual(rest);
    await strategy.locator('h3').first().dispatchEvent('pointerdown', { pointerType: 'touch' });

    // The app is English only (ENGLISH-ONLY): the card was checked in English and Portuguese, and is
    // now checked in English, its names included.
    for (const lang of ['en'] as const) {
      await expect(joint.getByRole('toolbar')).toHaveAccessibleName(
        mix.some(([, bps]) => bps < 300)
          ? en.shared.vault.conversation.jointLabelWidened
          : en.shared.vault.conversation.jointLabel,
      );
      for (const [i, [symbol, bps]] of mix.entries())
        await expect(joint.locator('[data-part="piece"]').nth(i)).toHaveAccessibleName(
          `${symbol}, ${shareOf(lang, bps)}`,
        );
      for (const theme of ['dark', 'light'] as const) {
        await inTheme(page, theme);
        for (const width of [375, 1440]) {
          await page.setViewportSize({ width, height: 812 });
          const wide = await page.evaluate(() => document.documentElement.scrollWidth);
          expect(wide, `${lang}, ${theme}, ${width}px: no sideways scroll`).toBeLessThanOrEqual(
            width,
          );
          // every piece lies inside the beam
          const beam = await joint.getByRole('toolbar').boundingBox();
          const boxes = await joint
            .locator('[data-part="piece"]')
            .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
          for (const box of boxes) {
            expect(box.left).toBeGreaterThanOrEqual((beam?.x ?? 0) - 0.5);
            expect(box.right).toBeLessThanOrEqual((beam?.x ?? 0) + (beam?.width ?? 0) + 0.5);
            expect(box.width).toBeGreaterThan(4);
          }
          // a piece carries its asset's mark where it is 36px wide or more on this screen, and
          // only there: a tenth of a desk's beam has it, a tenth of a phone's does not
          const marks = await joint.locator('[data-part="piece"]').evaluateAll((els) =>
            els.map((el) => {
              const mark = el.querySelector('[data-part="mark"]');
              return [
                el.getBoundingClientRect().width >= 36,
                mark !== null && getComputedStyle(mark).display !== 'none',
              ];
            }),
          );
          for (const [wide, marked] of marks) expect(marked).toBe(wide);
          if (name === 'many')
            expect(marks.filter(([, marked]) => marked)).toHaveLength(width === 1440 ? 7 : 2);
          await shot(page, `${name}-${lang}-${theme}-${width}`);
        }
        await page.setViewportSize({ width: 375, height: 812 });
        // the pointer rests on nothing: a lit piece dims the others, which is not the card at rest
        await page.mouse.move(0, 0);
        await axe(page, `${lang}, ${theme}`);
      }
    }
  });

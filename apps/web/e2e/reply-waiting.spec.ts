import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// Waiting, on /goal: for a reply in the conversation, for a first draft, for the one after it, and on
// the deposit step for the server's check and the stored plan. A reply can take many seconds, so each
// of these is held open here and looked at: what it says, that nothing on the page moves between
// waiting and settled, that the sent message and the row under it are in view, and axe in both themes
// at a phone's width and a desk's. The stub answers; a spec holds its answer back. No model is called.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const talk = en.shared.vault.conversation;

async function axe(page: Page, name: string) {
  // the pointer rests on nothing: a lit piece dims the others, which is not the card at rest
  await page.mouse.move(0, 0);
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      result.violations.flatMap((v) =>
        v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
      ),
      `${name}, ${theme}`,
    ).toEqual([]);
    const { width } = page.viewportSize() ?? { width: 0 };
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `${name}, ${theme}: no sideways scroll`,
    ).toBeLessThanOrEqual(width);
    // what a person sees at a glance: the window as it is, not the whole page
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png` });
  }
  await inTheme(page, 'dark');
}

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}

/** Holds the next replies back until `release`, then serves the stub's own, changed by `change`. */
async function hold(
  page: Page,
  change: (body: Record<string, unknown>) => Record<string, unknown> | number = (body) => body,
) {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.unroute('**/v1/conversations/*/goal/reply');
  await page.route('**/v1/conversations/*/goal/reply', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await gate;
    const next = change(body);
    if (typeof next === 'number') await route.fulfill({ status: next, json: {} });
    else await route.fulfill({ response, json: next });
  });
  return release;
}

async function say(page: Page, words: string) {
  const box = page.locator('textarea');
  await box.fill(words);
  await box.press('Enter');
}

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not on the page');
  return box;
};
/**
 * Where the parts of the card are, from the card's own corner: none of them may move between waiting
 * and settled. (On a phone the card sits under the chat, which a sent message makes taller, so the
 * card itself is measured for its size and, on a desk, for its place.)
 */
const cardLayout = async (strategy: Locator, placed: boolean) => {
  const card = await boxOf(strategy.locator('[data-ui="card"]'));
  const within = async (part: Locator) => {
    const box = await boxOf(part);
    return { ...box, x: box.x - card.x, y: box.y - card.y };
  };
  return {
    card: placed ? card : { width: card.width, height: card.height },
    // the banner's place: the line that carries the note on the draft, or the banner
    banner: await within(strategy.locator('[data-ui="preview-pending"]').locator('..')),
    bar: await within(strategy.locator('[data-ui="plan-legs-bar"]')),
    table: await within(strategy.locator('table')),
    action: await within(strategy.locator('[data-action="deposit"]')),
  };
};
/** The lattice is the brand's loader: it assembles, or under reduced motion stands still. */
const assembling = (scope: Locator) =>
  scope
    .locator('[data-ui="lattice-loader"]')
    .first()
    .evaluate((el) => el.getAnimations({ subtree: true }).length);

for (const width of [1440, 375] as const)
  test(`waiting for a reply is plain in the chat and on the card, and moves nothing, at ${width}px`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await signIn(page);
    const chat = page.locator('[data-ui="goal-chat"]');
    const transcript = chat.locator('[data-ui="goal-transcript"]');
    const strategy = page.locator('[data-ui="goal-strategy"]');
    const pending = transcript.locator('[data-ui="reply-pending"]');
    const announcer = chat.locator('[data-ui="reply-announcer"]');
    const composer = chat.locator('[data-ui="composer"]');
    const send = composer.locator('[data-ui="composer-send"]');
    /** The message just sent, the row under it and the box are whole in the window, in that order. */
    const inView = async (after: Locator) => {
      const mine = transcript.locator('li[data-who="person"]').last();
      await expect(mine).toBeInViewport({ ratio: 1 });
      await expect(after).toBeInViewport({ ratio: 1 });
      await expect(composer.locator('[data-ui="composer-box"]')).toBeInViewport({ ratio: 1 });
      const [m, a, c, list] = await Promise.all([
        boxOf(mine),
        boxOf(after),
        boxOf(composer),
        boxOf(transcript),
      ]);
      expect(m.y + m.height).toBeLessThanOrEqual(a.y);
      expect(a.y + a.height).toBeLessThanOrEqual(c.y + 0.5);
      // never cut off by the transcript's own edge either
      expect(m.y).toBeGreaterThanOrEqual(list.y - 0.5);
      expect(a.y + a.height).toBeLessThanOrEqual(list.y + list.height + 0.5);
    };

    // 1. The first message: the pending row under it, and the card building its first draft.
    const hintSize = async () => {
      const { width: w, height: h } = await boxOf(composer.locator('[data-ui="composer-hint"]'));
      return [w, h];
    };
    const settledHint = await hintSize();
    let release = await hold(page);
    await say(page, 'A broad fund and some gold, to grow, at medium risk');
    await expect(pending).toHaveText(`${en.talk.me}: ${en.goal.explore.pendingLines[0]}`);
    await expect(announcer).toHaveText(talk.reading);
    await expect(pending.locator('[data-ui="lattice-loader"]')).toBeVisible();
    await expect(send.locator('[data-ui="lattice-loader"]')).toBeVisible();
    expect(await assembling(pending)).toBeGreaterThan(0);
    await inView(pending);
    // the box takes the next thought and says that sending waits, in a place as tall as it was
    await expect(composer.locator('[data-ui="composer-hint"]')).toContainText(talk.busyHint);
    expect(await hintSize()).toEqual(settledHint);
    await page.locator('textarea').fill('and keep some cash');
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await page.locator('textarea').fill('');
    const building = strategy.locator('[data-ui="draft-building"]');
    await expect(building.locator('h2')).toHaveText(en.goal.explore.building);
    await expect(building).toContainText(en.goal.explore.working);
    await expect(building.locator('[data-ui="lattice-loader"]')).toBeVisible();
    await expect(
      building.locator('[data-ui="draft-skeleton"] [data-ui="skeleton"]'),
    ).not.toHaveCount(0);
    // nothing is shown before the server sent it
    await expect(strategy.locator('[data-ui="holding-legs"], [data-part="share"]')).toHaveCount(0);
    await expect(strategy).not.toContainText('%');
    const buildingCard = await boxOf(strategy.locator('[data-ui="goal-empty-preview"]'));
    const pendingRow = await boxOf(pending);
    const scrolled = await transcript.evaluate((el) => el.scrollTop);
    const pageScrolled = await page.evaluate(() => window.scrollY);
    await axe(page, 'first-draft-building');

    // the wait goes on: the line changes, and is not read out again
    await expect(pending).toHaveText(`${en.talk.me}: ${en.goal.explore.pendingLines[1]}`, {
      timeout: 10_000,
    });
    await expect(announcer).toHaveText(talk.reading);
    release();

    // the reply is where the pending row was, and the draft where the building card was
    const reply = transcript.locator('li[data-who="app"]').first();
    await expect(pending).toHaveCount(0);
    await expect(reply).toBeVisible();
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(scrolled);
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScrolled);
    const replyBox = await boxOf(reply);
    expect([replyBox.x, replyBox.y]).toEqual([pendingRow.x, pendingRow.y]);
    await expect(announcer).toContainText(talk.draftArrived);
    // (on a phone the card sits under the chat, which the reply makes taller)
    const card = await boxOf(strategy.locator('[data-ui="card"]'));
    expect([card.x, card.width]).toEqual([buildingCard.x, buildingCard.width]);
    if (width === 1440) expect(card.y).toBe(buildingCard.y);
    await expect(strategy.locator('[data-ui="holding-legs"]')).toBeVisible();
    await expect(page.locator('textarea')).toBeFocused();
    // the arrival has played out before the card is measured
    await page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
    );
    await page.mouse.move(0, 0);
    const settled = await cardLayout(strategy, width === 1440);
    await axe(page, 'reply-landed');

    // 2. The next message, answered with a question: the draft on the card is the one from before.
    release = await hold(page, (body) => ({
      ...body,
      message: 'I need one thing first.',
      question: 'For how long?',
      proposal: null,
      weightNotes: [],
    }));
    await say(page, 'Make it a little safer');
    await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(talk.reworking);
    await expect(
      strategy.locator('[data-ui="preview-pending"] [data-ui="lattice-loader"]'),
    ).toBeVisible();
    const action = strategy.locator('[data-action="deposit"]');
    await expect(action).toHaveAttribute('aria-disabled', 'true');
    await expect(action).toContainText(talk.waitingAction);
    await expect(action.locator('[data-ui="lattice-loader"]')).toBeVisible();
    await expect(strategy.locator('[data-set-back]')).toBeVisible();
    await expect(pending).toBeVisible();
    await inView(pending);
    // waiting moved nothing on the card, and its ink is still the muted token's: not faded text
    expect(await cardLayout(strategy, width === 1440)).toEqual(settled);
    const ink = await strategy
      .locator('[data-set-back] tbody th')
      .first()
      .evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--muted-foreground)';
        document.body.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return [getComputedStyle(el).color === muted, getComputedStyle(el).opacity];
      });
    expect(ink).toEqual([true, '1']);
    await axe(page, 'later-draft-pending');
    release();
    await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText('');
    await expect(action).toBeEnabled();
    await expect(strategy.locator('[data-set-back]')).toHaveCount(0);
    expect(await cardLayout(strategy, width === 1440)).toEqual(settled);
    await expect(transcript).toContainText('For how long?');

    // 3. A reply that does not come: the row becomes the failure, with the way to ask again.
    release = await hold(page, () => 500);
    await say(page, 'Never mind, more gold');
    await expect(pending).toBeVisible();
    release();
    const failed = transcript.locator('[data-ui="goal-unanswered"]');
    await expect(failed.getByRole('alert')).toHaveText(en.goal.explore.failed);
    await expect(failed.getByRole('button', { name: en.goal.explore.retry })).toBeVisible();
    await expect(pending).toHaveCount(0);
    // the draft is the person's again, where it was
    await expect(action).toBeEnabled();
    expect(await cardLayout(strategy, width === 1440)).toEqual(settled);
    await axe(page, 'reply-failed');
  });

test('in a full transcript a landed reply is read from its first line, a failure shows its actions, and a person who scrolled up is left there', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const transcript = page.locator('[data-ui="goal-transcript"]');
  const pending = transcript.locator('[data-ui="reply-pending"]');
  const edges = async (part: Locator) => {
    const [box, list] = await Promise.all([boxOf(part), boxOf(transcript)]);
    return { top: box.y - list.y, bottom: list.y + list.height - (box.y + box.height) };
  };
  const scrolled = () => transcript.evaluate((el) => el.scrollTop);
  // enough turns for the transcript to scroll
  for (const words of ['A broad fund and gold', 'A little safer', 'And some cash', 'Less gold']) {
    const before = await transcript.locator('li[data-who="app"]').count();
    await say(page, `${words}, and this message runs long enough to take two lines in the column`);
    await expect(pending).toHaveCount(0);
    await expect(transcript.locator('li[data-who="app"]')).not.toHaveCount(before);
  }
  expect(await transcript.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);

  // a reply longer than the transcript is tall: it starts at the top of the transcript
  const long = Array.from({ length: 40 }, (_, i) => `Sample: line ${i + 1} of a long reply.`).join(
    '\n',
  );
  let release = await hold(page, (body) => ({
    ...body,
    message: long,
    question: null,
    proposal: null,
    weightNotes: [],
  }));
  await say(page, 'Tell me everything');
  await expect(pending).toBeInViewport({ ratio: 1 });
  await page.locator('textarea').focus();
  release();
  const reply = transcript.locator('li[data-who="app"]', { hasText: 'line 1 of a long reply' });
  await expect(reply).toBeVisible();
  await expect.poll(async () => Math.abs((await edges(reply)).top)).toBeLessThanOrEqual(1);
  await expect(page.locator('textarea')).toBeFocused();

  // a reply that does not come: the failure and both of its actions are inside the transcript's edge
  release = await hold(page, () => 500);
  await say(page, 'And again');
  await expect(pending).toBeVisible();
  release();
  const failed = transcript.locator('[data-ui="goal-unanswered"]');
  await expect(failed.getByRole('alert')).toBeVisible();
  for (const part of [
    failed.getByRole('alert'),
    failed.getByRole('button', { name: en.goal.explore.retry }),
    failed.getByRole('link', { name: en.goal.explore.elsewhere }),
  ]) {
    await expect(part).toBeInViewport({ ratio: 1 });
    expect((await edges(part)).bottom).toBeGreaterThanOrEqual(0);
    expect((await edges(part)).top).toBeGreaterThanOrEqual(0);
  }
  await expect(page.locator('textarea')).toBeFocused();

  // the person scrolls up to read while the next reply is on its way: it lands without a jump
  release = await hold(page);
  await failed.getByRole('button', { name: en.goal.explore.retry }).click();
  await expect(pending).toBeVisible();
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => transcript.getAttribute('data-following')).toBe('false');
  release();
  await expect(pending).toHaveCount(0);
  await expect(failed).toHaveCount(0);
  expect(await scrolled()).toBe(0);
  // and the reply is there when they come back down
  await transcript.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(transcript.locator('li').last()).toBeInViewport();
});

test('with reduced motion the same words stand beside a still mark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const pending = page.locator('[data-ui="reply-pending"]');
  const strategy = page.locator('[data-ui="goal-strategy"]');
  let release = await hold(page);
  await say(page, 'A broad fund and some gold');
  await expect(pending).toContainText(en.goal.explore.pendingLines[0]);
  await expect(pending.locator('[data-ui="lattice-loader"]')).toBeVisible();
  await expect(strategy.locator('[data-ui="draft-building"] h2')).toHaveText(
    en.goal.explore.building,
  );
  expect(await assembling(pending)).toBe(0);
  expect(await assembling(strategy)).toBe(0);
  expect(await assembling(page.locator('[data-ui="composer-send"]'))).toBe(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reduced-motion-pending-1440-dark.png` });
  release();
  await expect(strategy.locator('[data-ui="holding-legs"]')).toBeVisible();
  release = await hold(page);
  await say(page, 'A little safer');
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText(talk.reworking);
  await expect(strategy.locator('[data-action="deposit"]')).toContainText(talk.waitingAction);
  expect(await assembling(strategy)).toBe(0);
  release();
  await expect(strategy.locator('[data-ui="preview-pending"]')).toHaveText('');
});

for (const width of [1440, 375] as const)
  test(`the deposit step says what each press is waiting for, at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await signIn(page);
    await say(page, 'A broad fund and some gold, to grow, at medium risk');
    const strategy = page.locator('[data-ui="goal-strategy"]');
    await strategy.getByRole('button', { name: en.mix.preview.deposit, exact: true }).click();
    const step = page.locator('[data-ui="deposit-step"]');
    await expect(step).toBeVisible();

    // every answer of the server's check is held back until let through
    let let1 = () => {};
    let held = new Promise<void>((done) => {
      let1 = done;
    });
    const sent: boolean[] = [];
    await page.route('**/v1/conversations/*/goal/accept', async (route) => {
      sent.push(Boolean(route.request().postDataJSON()?.confirm));
      const gate = held;
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    const next = () => {
      const open = let1;
      held = new Promise<void>((done) => {
        let1 = done;
      });
      open();
    };

    // the press before the amount's own check has answered: it asks, and says what it asks
    await page.getByLabel(en.buy.amount.label, { exact: true }).fill('100');
    const review = step.locator('[data-action="deposit-review"]');
    await review.scrollIntoViewIfNeeded();
    const resting = await boxOf(review);
    await review.click();
    await expect(review).toContainText(en.mix.deposit.reviewing);
    await expect(review).toHaveAttribute('aria-busy', 'true');
    await expect(review.locator('[data-ui="lattice-loader"]')).toBeVisible();
    await expect(review).toBeFocused();
    // the button keeps its place and its width; no dollars are shown before the server sent them
    expect(await boxOf(review)).toEqual(resting);
    await expect(step.locator('[data-asset="solana:spy"] [data-ui="mix-line-amount"]')).toHaveText(
      `—${en.mix.deposit.unchecked}`,
    );
    await axe(page, 'deposit-checking');
    // let through: the debounced check of the same amount, then the press's own
    next();
    next();

    const lines = page.locator('[data-ui="mix-review-lines"]');
    await expect(lines).toContainText('SPY');
    const boxes = page.locator('[data-ui="mix-review-warnings"] input[type="checkbox"]');
    for (let i = 0; i < (await boxes.count()); i += 1) await boxes.nth(i).check();
    const confirm = page.locator('[data-action="mix-confirm"]');
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    await confirm.scrollIntoViewIfNeeded();
    const confirmAt = await boxOf(confirm);
    const before = sent.length;
    await confirm.click();
    await expect(confirm).toContainText(en.mix.goal.confirming);
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(confirm.locator('[data-ui="lattice-loader"]')).toBeVisible();
    await expect(confirm).toBeFocused();
    expect(await boxOf(confirm)).toEqual(confirmAt);
    expect(sent.slice(before)).toEqual([true]);
    await axe(page, 'deposit-saving');
    next();
    // stored: the steps to sign take the review's place in the same pane, at the amount typed, with
    // no dead screen on the way and no other page (gate DEPOSIT-IN-PLACE)
    await expect(page).toHaveURL(/\/goal$/);
    const pane = page.locator('[data-ui="deposit-sign"]');
    await expect(pane.locator('[data-ui="deposit-sign-amount"]')).toContainText('$100');
    await expect(page.locator('[data-action="mix-confirm"]')).toHaveCount(0);
  });

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;

// The new default has a real conversation endpoint, but an unopened strategy has no financial data.
// This check does not stub a model reply or produce a funded plan.
test('new-goal exploration opens a responsive preview-only workbench', async ({ page }) => {
  const financialPosts: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/(orders|baskets|goals|conversation.*reply)/.test(request.url())
    )
      financialPosts.push(request.url());
  });
  await page.goto('/goal');
  // The one picker over the conversation chooses a conversation (GOAL-CHAT-PORT), never a guided
  // mode: this one, or a new one.
  await expect(page.locator('[data-ui="goal-mode"]')).toHaveCount(0);
  const picker = page.locator('[data-ui="goal-picker"]');
  await expect(picker).toHaveValue('current');
  expect(
    await picker
      .locator('option')
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value)),
  ).toEqual(['current', 'new']);
  await expect(page.locator('[data-ui="goal-conversation"]')).toBeVisible();
  // The chain of the plan is chosen here, beside the box (gate CHAIN-AT-THE-PLAN): two options, one
  // group, moved with the arrow keys.
  const chains = page.getByRole('group', { name: en.chain.choice.legend }).getByRole('radio');
  await expect(chains).toHaveCount(2);
  await expect(chains.first()).toBeChecked();
  await chains.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(chains.nth(1)).toBeChecked();
  await expect(chains.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(chains.first()).toBeChecked();
  await expect(page.locator('[data-ui="goal-empty-preview"]')).toContainText(
    en.goal.explore.previewOnly,
  );
  await expect(
    page.locator(
      '[data-ui="holdings-bar"], [data-ui="holding-legs"], [data-ui="invest-card"], [data-ui="order-step"], [data-ui="plan-invest"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('[data-ui="invest-screen"]')).toHaveCount(0);
  for (const theme of ['light', 'dark'] as const) {
    await inTheme(page, theme);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const chat = await page.locator('[data-ui="goal-chat"]').boundingBox();
      const strategy = await page.locator('[data-ui="goal-strategy"]').boundingBox();
      expect(chat).not.toBeNull();
      expect(strategy).not.toBeNull();
      if (chat && strategy) {
        if (width === 1280) {
          expect(strategy.x).toBeGreaterThan(chat.x);
          expect(strategy.width).toBeGreaterThan(chat.width);
        } else expect(strategy.y).toBeGreaterThanOrEqual(chat.y + chat.height);
      }
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html}`))).toEqual([]);
  }
  expect(financialPosts).toEqual([]);
});

// An address no route has (gate WORDS-ONE-NAME, row 1 of its audit): 404, in the product's shell and
// in its words, never the first structurer's page.
test('an unknown address answers 404 in the product’s shell, with one way on', async ({ page }) => {
  for (const path of ['/no-such-page', '/a/b/c']) {
    const answer = await page.goto(path);
    expect(answer?.status(), path).toBe(404);
    const missing = page.locator('[data-ui="not-found"]');
    await expect(missing.getByRole('heading', { level: 1 })).toHaveText(en.shell.missing.title);
    await expect(page).toHaveTitle(`${en.shell.missing.title} · tenonfi`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // the product's own bar, and nothing of the first shell
    await expect(page.locator('header a[href="/goal"]').first()).toBeAttached();
    await expect(page.getByText('Select Wallet')).toHaveCount(0);
    await expect(page.getByText('Structurer')).toHaveCount(0);
    await expect(missing.getByRole('link', { name: en.shell.missing.action })).toHaveAttribute(
      'href',
      '/goal',
    );
  }
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
});

// Thom, Oct 9: a conversation is named by its person's first request, shortened, in the picker; the
// name is read from the turns this browser keeps, and a long one never pushes the page sideways. (A
// reload is in the events test: the test wallet does not keep its sign-in across one.)
test('the picker names a conversation by its first request', async ({ page }) => {
  // signed in, as a person who can send is; the stub answers, no model is called
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
  const picker = page.locator('[data-ui="goal-picker"]');
  const shown = () => picker.locator('option:checked');
  await expect(picker).toHaveValue('current');
  await expect(shown()).toHaveText(en.goal.explore.picker.current);
  const send = async (words: string) => {
    await page.locator('[data-ui="goal-chat"] textarea').fill(words);
    await page.locator('[data-ui="composer-send"]').click();
  };
  await send("I want to explore technology stocks with low risk for my daughter's college fund");
  const title = 'I want to explore technology stocks with low…';
  await expect(shown()).toHaveText(title);
  await expect(page.getByLabel(en.goal.explore.picker.label)).toHaveValue('current');
  // a second one: the first is saved under its name, with its chain as text
  await picker.selectOption('new');
  await expect(shown()).toHaveText(en.goal.explore.picker.current);
  await expect(picker.locator('optgroup option')).toHaveText([
    /^I want to explore technology stocks with low… · \S/,
  ]);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await picker.selectOption({ index: 2 });
    await expect(shown()).toHaveText(title);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    const box = await picker.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(width);
    await picker.selectOption('new');
  }
});

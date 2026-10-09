import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

const en = dictionary('en');

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
  // group, moved with the arrow keys, and the bar's own switch says the same.
  const chains = page.getByRole('group', { name: en.chain.choice.legend }).getByRole('radio');
  await expect(chains).toHaveCount(2);
  await expect(chains.first()).toBeChecked();
  await chains.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(chains.nth(1)).toBeChecked();
  await expect(chains.nth(1)).toBeFocused();
  await expect(page.locator('[data-ui="chain-switch"] > button')).toHaveAttribute(
    'data-chain',
    'robinhood',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(chains.first()).toBeChecked();
  await expect(page.locator('[data-ui="goal-empty-preview"]')).toContainText(
    en.goal.explore.previewOnly,
  );
  await expect(
    page.locator(
      '[data-ui="holdings-bar"], [data-ui="mix-joint"], [data-ui="invest-card"], [data-ui="order-step"], [data-ui="plan-invest"]',
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

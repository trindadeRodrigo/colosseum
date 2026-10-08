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
  await expect(page.locator('[data-ui="goal-mode"]')).toHaveValue('explore');
  await expect(page.locator('[data-ui="goal-conversation"]')).toBeVisible();
  await expect(page.locator('[data-ui="goal-empty-preview"]')).toContainText(
    en.goal.explore.previewOnly,
  );
  await expect(
    page.locator(
      '[data-ui="holdings-bar"], [data-ui="invest-card"], [data-ui="order-step"], [data-ui="plan-invest"]',
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

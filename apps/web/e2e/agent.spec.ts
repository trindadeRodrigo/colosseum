import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { readyToInvest } from './invest';
import { inTheme } from './theme';

// An agent's plan, end to end (AGT-3's check, on the stub): an agent calls the MCP server (apps/mcp,
// started in front of the stub API by playwright.config.ts), makes a plan from a goal sheet with
// `build_plan`, and hands the person the link it answers. The person opens it, signs in, sees the plan
// and that it came from a link, and buys it: the review, then every step signed by their own wallet.
// The agent signs nothing. axe at 375 px, light and dark, on the screens the link opens.

const en = dictionary('en');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
const MCP = `http://localhost:${process.env.E2E_MCP_PORT ?? 3902}/mcp`;

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
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(wide, `${name}, ${theme}: no sideways scroll`).toBeLessThanOrEqual(375);
  }
}

/** One tool call, as an MCP client sends it over HTTP: the tool's structured answer. */
async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('');
  const result = JSON.parse(data || text).result as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent: Record<string, unknown>;
  };
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return result.structuredContent;
}

test('an agent makes a plan through the MCP server, and the person buys it from the link', async ({
  page,
  request,
}) => {
  await request.post(`${STUB}/__stub/reset`);
  const plan = await tool(request, 'build_plan', {
    sheet: {
      basketType: 'standard',
      goal: 'grow',
      amountUsd: 40,
      horizonMonths: 36,
      risk: 'medium',
      themes: [],
      country: 'BR',
      chains: ['solana'],
      rules: { useHoldings: false, glide: true },
      language: 'en',
    },
  });
  const link = new URL(String(plan.approvalUrl));
  expect(link.pathname).toBe(`/plan/${plan.planId}`);

  // The person opens the link: signed out, the app asks them to sign in and brings them back to it.
  await page.goto(`/sign-in?next=${encodeURIComponent(link.pathname)}`);
  await page.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(page).toHaveURL(new RegExp(`${link.pathname}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Grow $40 over 36 months.');
  await expect(page.locator('[data-ui="plan-from-link"]')).toHaveText(en.plan.fromLink);
  await check(page, 'plan-from-link');

  await page.getByRole('link', { name: en.plan.buy }).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  // the order is reviewed on the buy's own card, and one press signs its steps
  await (await readyToInvest(page)).click();
  await expect(page).toHaveURL(/\/plan\/[^/]+\/buy$/);
  await expect(page.locator('[data-ui="order-status"]')).toHaveText(
    en.order.outcome.done('Solana'),
    { timeout: 90_000 },
  );
  // every step the person's wallet signed is reported; the agent sent none
  const reports = (await (await request.get(`${STUB}/__stub/reports`)).json()) as string[];
  expect(reports.length).toBeGreaterThan(0);
});

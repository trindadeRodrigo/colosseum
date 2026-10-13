import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';

// The partner embed in a browser (embed-shell.md, guidelines.html section 08): its page carries no bar,
// no wallet, no font of ours and no wood colour; only this app and named partners may frame it, and
// no other page may be framed at all; in each skin axe finds nothing at 375 px; and in a host's frame
// it sizes itself by the height it posts.

const en = dictionary('en');
const SHOTS = process.env.SCREENSHOTS_DIR;
const SAMPLE =
  'scheme=light&fg=%231E1E1E&bg=%23FFFFFF&muted=%236A6A6A&border=%23E4E4E4&accent=%231E1E1E&radius=14px&button=pill&font=system-ui';
const SAMPLE_DARK =
  'scheme=dark&fg=%23EEEEEE&bg=%2317171A&muted=%23A0A0A0&border=%232C2C30&accent=%23EEEEEE&radius=14px&button=pill&font=system-ui';
const SKINS = {
  light: 'scheme=light',
  dark: 'scheme=dark',
  partner: SAMPLE,
  'partner-dark': SAMPLE_DARK,
} as const;

async function axe(page: Page, name: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const found = result.violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)} ${n.failureSummary ?? ''}`),
  );
  expect(found, name).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()?.width ?? 375,
  );
}

test('the embed’s page has a bare root: no bar, no wallet, no face or wood of ours', async ({
  page,
}) => {
  const answer = await page.goto(`/embed?${SAMPLE}`);
  expect(answer?.headers()['content-security-policy']).toMatch(/^frame-ancestors 'self'/);
  const html = await page.content();
  for (const banned of ['wallet-adapter', 'Inter Tight', 'interTight', '#F5A83A'])
    expect(html, banned).not.toContain(banned);
  // the product's base class, with its faces and ground, is not on the embed's body
  expect(await page.locator('body').getAttribute('class')).toBeNull();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('main')).toHaveCount(0);
  await expect(page.getByRole('region', { name: en.embed.label })).toBeVisible();
  // the product's pages may not be framed by anybody, nor an address under /embed, or spelled like
  // it, that is not the embed (it falls to a page with a wallet button)
  for (const path of ['/goal', '/embed/x', '/embed/a/b/c', '/Embed', '/EMBED/solana/abc']) {
    const answer = await page.request.get(path);
    expect(answer.headers()['content-security-policy'], path).toBe("frame-ancestors 'none'");
    expect(answer.headers()['x-frame-options'], path).toBe('DENY');
  }
});

for (const [skin, query] of Object.entries(SKINS))
  test(`the embed in the ${skin} skin passes axe at 375 px, before and after a goal is read`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: skin.includes('dark') ? 'dark' : 'light' });
    await page.goto(`/embed?${query}`);
    await axe(page, `${skin}, empty`);
    await page.getByLabel(en.embed.box).fill('Grow $2,000 for ten years, high risk');
    await page.getByRole('button', { name: en.embed.read }).click();
    await expect(page.getByRole('link', { name: en.embed.build })).toBeVisible();
    await axe(page, `${skin}, read`);
    if (SHOTS)
      for (const width of [375, 1280]) {
        // the dev server's own badge is not the embed's
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        await page.setViewportSize({ width, height: 812 });
        await page.screenshot({ path: `${SHOTS}/embed-${skin}-${width}.png`, fullPage: true });
      }
  });

test('a host frames it and the frame takes the height it posts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/dev/embed');
  const frame = page.locator('iframe').first();
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => (await frame.boundingBox())?.height ?? 0, { timeout: 20_000 })
    .not.toBe(320);
  const inside = page.frameLocator('iframe').first();
  await expect(inside.getByRole('region', { name: en.embed.label })).toBeVisible();
  if (SHOTS) {
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/embed-host-1280.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dev/embed?width=375');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/embed-host-375.png`, fullPage: true });
  }
});

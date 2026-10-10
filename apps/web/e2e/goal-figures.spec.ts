import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { dictionary } from '../i18n';
import { inTheme } from './theme';

// A measured figure in a reply on /goal (gate RELAXED-INTAKE as amended, FIGURES-BY-REFERENCE): drawn
// in the sentence with its pin, hatched where it is not live, its source one press away. Reopening a
// kept conversation is in goal-figures.events.test.ts. The stub answers and the spec writes the
// figures into its reply, as our server would. No model is called.

const en = dictionary('en');
test.skip(process.env.E2E_CHAIN === 'robinhood', 'the stub runs Robinhood Chain');
const STUB = `http://localhost:${process.env.E2E_API_PORT ?? 3901}`;
/** Screenshots are taken only for a run that names a folder for them (SCREENSHOTS_DIR). */
const SHOTS = process.env.SCREENSHOTS_DIR;
const ref = (id: string) => `{{fact:${id}}}`;
const pin = {
  assetId: 'solana:tslax',
  source: 'Bearing fact sheet',
  method: 'hourly quotes (facts-0.1)',
  fetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  provenance: 'sandbox',
  staleAgeSec: null,
};
const facts = [
  {
    ...pin,
    id: 'capacity:solana:tslax',
    label: 'Largest sale within the cost tolerance, worst regime of the exit window',
    text: '$42,000.00',
    value: 42_000,
    unit: 'USD',
  },
  {
    ...pin,
    id: 'exit:solana:tslax:worst',
    label: 'Exit cost at the reference size, worst measured regime (weekday off-hours)',
    text: '0.4%',
    value: 0.004,
    unit: 'fraction',
  },
  {
    id: 'weekend:solana:tslax',
    assetId: 'solana:tslax',
    label: 'Weekend ÷ market-hours exit capacity',
    text: 'not measured (no samples in that regime yet)',
    value: null,
    reason: 'no_samples_in_regime',
  },
];
const words = (figure: (id: string) => string) =>
  `For Tesla, the largest sale within the cost tolerance is ${figure('capacity:solana:tslax')}. Selling Tesla at the reference size costs about ${figure('exit:solana:tslax:worst')} in the worst measured regime. Weekend exit capacity for Tesla is ${figure('weekend:solana:tslax')}.`;
const text = (id: string) => facts.find((fact) => fact.id === id)?.text ?? '';

async function signIn(page: Page) {
  await page.request.post(`${STUB}/__stub/reset`);
  await page.goto('/goal');
  await page.locator('header a[href^="/sign-in"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: en.signIn.passkey.continue }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/goal$/);
}
async function say(page: Page, said: string) {
  const box = page.locator('textarea');
  await box.fill(said);
  await box.press('Enter');
}

for (const width of [1440, 375] as const)
  test(`a reply's figures on /goal carry their pins, at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await signIn(page);
    const transcript = page.locator('[data-ui="goal-transcript"]');
    await say(page, 'I want to put my money in Tesla');
    await expect(transcript.locator('li[data-who="app"]').first()).toBeVisible();
    // the next reply states figures: the same words with the values in, and each figure's place
    const sent: { messages: { who: string; text: string }[] }[] = [];
    await page.route('**/v1/conversations/*/goal/reply', async (route) => {
      sent.push(route.request().postDataJSON());
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          message: words(text),
          question: null,
          proposal: null,
          warnings: [],
          weightNotes: [],
          figures: { prose: { message: words(ref), question: null, proposal: null }, facts },
        },
      });
    });
    await say(page, 'and about their liquidity? how deep are their pools?');
    const figures = transcript.locator('[data-ui="figure"]');
    await expect(figures).toHaveCount(2);
    await expect(figures.nth(0).locator('.tf-figure')).toHaveText('$42,000.00');
    await expect(figures.nth(1).locator('.tf-figure')).toHaveText('0.4%');
    // a test network's figure: the hatched pin, and its age once it is an hour old
    await expect(figures.nth(1)).toHaveAttribute('data-state', 'mock');
    await expect(transcript.locator('[data-ui="figure-age"]').first()).toContainText('2 hours old');
    await expect(transcript.locator('[data-ui="figure-missing"]')).toHaveText(
      'not measured (no samples in that regime yet)',
    );
    await expect(transcript).not.toContainText('{{');
    await page.mouse.move(0, 0);
    for (const theme of ['light', 'dark'] as const) {
      await inTheme(page, theme);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)}`)),
        theme,
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      if (SHOTS)
        await page.screenshot({ path: `${SHOTS}/goal-figures-reply-${width}-${theme}.png` });
    }
    await inTheme(page, 'dark');
    // the source, the time and the method, one press away
    await figures.nth(1).locator('[data-ui="pin"]').click();
    const popover = figures.nth(1).locator('[data-ui="pin-popover"]');
    await expect(popover).toContainText('Exit cost at the reference size, worst measured regime');
    await expect(popover).toContainText('Test network, not live');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/goal-figures-pin-open-${width}-dark.png` });
    await page.keyboard.press('Escape');
    // the next message sends the reply back with its places, never its values
    await say(page, 'thanks');
    await expect.poll(() => sent.length).toBe(2);
    const resent = sent[1]?.messages.find((m) => m.who === 'app' && m.text.includes('Tesla, the'));
    expect(resent?.text).toBe(words(ref));
  });

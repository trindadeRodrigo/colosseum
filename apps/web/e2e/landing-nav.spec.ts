import { expect, type Page, test } from '@playwright/test';

// The landing's compact bar floats over the page (compact-nav.md, hero-3d.html). Scrolling into the
// showcase, its intro line passed under the bar, readable behind and beside it. No line of copy may
// show in the band the bar sits in: at 1440 and 390, light and dark, with each section's opening line
// brought to the top of the window and stopped a little way down it, as a person scrolling stops.

const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
/** How far below the top of the window a section's first line is stopped: under the bar and around it. */
const STOPS = [0, 20, 40, 60, 80] as const;

/** Every line of copy whose ink shows anywhere in the band from the top of the window to the bar's foot. */
function copyInTheBand(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-ui="compact-nav-bar"]')?.getBoundingClientRect();
    if (!bar) return ['no bar'];
    const header = document.querySelector('[data-ui="compact-nav"]');
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (!owner || !node.textContent?.trim() || header?.contains(owner)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1 || r.top >= bar.bottom || r.bottom <= 0) continue;
        // Shows where the line itself is the topmost thing: sampled along its middle, within the band.
        const y = Math.min(
          (Math.max(r.top, 0) + Math.min(r.bottom, bar.bottom)) / 2,
          bar.bottom - 1,
        );
        for (let i = 1; i < 8; i += 1) {
          const x = r.left + (r.width * i) / 8;
          if (x < 0 || x >= window.innerWidth) continue;
          const top = document.elementFromPoint(x, y);
          if (top && (top === owner || owner.contains(top))) {
            found.push(
              `"${node.textContent.trim().slice(0, 60)}" at ${Math.round(x)},${Math.round(y)}`,
            );
            break;
          }
        }
      }
    }
    return found;
  });
}

for (const size of SIZES)
  for (const theme of ['dark', 'light'] as const)
    test(`no copy shows in the bar's band at ${size.width}, ${theme}`, async ({
      page,
      context,
      baseURL,
    }) => {
      await page.setViewportSize(size);
      // The landing is dark unless the visitor chose light (features/landing/theme.ts).
      if (theme === 'light')
        await context.addCookies([{ name: 'tf-theme', value: 'light', url: baseURL ?? '' }]);
      await page.goto('/');
      await expect(page.locator('#showcase h2')).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const sections = ['#showcase', '#simulate', '#updates'];
      for (const id of sections) {
        for (const stop of STOPS) {
          await page.evaluate(
            ([id, stop]) => {
              const section = document.querySelector(id as string);
              const first = section?.querySelector('h2, p');
              if (!first) throw new Error(`${id} has no opening line`);
              const y = first.getBoundingClientRect().top + window.scrollY - (stop as number);
              window.scrollTo({ top: y, behavior: 'instant' });
            },
            [id, stop] as const,
          );
          await expect(page.locator('[data-ui="compact-nav"]')).toHaveAttribute(
            'data-compact',
            'true',
          );
          await page.waitForTimeout(150);
          expect(await copyInTheBand(page), `${id}, first line ${stop}px down`).toEqual([]);
        }
        // and where "Products" or "Invest" lands a person: the section's own top
        await page.evaluate((id) => document.querySelector(id)?.scrollIntoView(), id);
        await page.waitForTimeout(150);
        expect(await copyInTheBand(page), `${id}, at its anchor`).toEqual([]);
      }
    });

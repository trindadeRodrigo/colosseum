import type { Page } from '@playwright/test';

// How a spec puts a page in one theme before axe reads its colours. The app eases colours from one
// theme to the other (160ms on a button), and a spec that swapped the class and then slept could still
// catch a chip in the old theme's ink on the new theme's ground when the runner was slow to draw. So
// the easing is switched off for the page, and the spec goes on only once the page says it is in the
// theme: the class is on the root, nothing is still easing, and the ink of the foot's chips is the
// theme's own. No sleep.

/** Puts the page in `theme` and waits until its colours are that theme's. */
export async function inTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    if (!document.getElementById('e2e-no-easing')) {
      const still = document.createElement('style');
      still.id = 'e2e-no-easing';
      still.textContent =
        '*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.append(still);
    }
    const html = document.documentElement;
    html.classList.remove('light', 'dark', 'tf-auto');
    html.classList.add(t);
  }, theme);
  await page.waitForFunction((t) => {
    if (!document.documentElement.classList.contains(t)) return false;
    if (document.getAnimations().some((a) => a.playState === 'running')) return false;
    // the theme's ink, as the page's own tokens resolve it now
    const probe = document.createElement('span');
    probe.style.color = 'var(--foreground)';
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    const chips = document.querySelectorAll(
      '[data-ui="language-switch"] button[aria-pressed="false"]',
    );
    return [...chips].every((chip) => getComputedStyle(chip).color === ink);
  }, theme);
}

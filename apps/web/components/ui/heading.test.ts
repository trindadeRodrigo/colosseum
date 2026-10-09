import { describe, expect, it } from 'vitest';
import { PAGE_TITLE, WORKSPACE_TITLE } from './heading';
import { read, sourceFiles } from './test/css';

// One register per level across the product: a page's title is set by `PAGE_TITLE` (Inter Tight 600
// at −2%, IDENTITY-2; no serif), in its gated states as in its loaded one. Three titles are their own,
// by their specs: the landing's hero, Bearing's analytics (Rodrigo's productive scale) and the
// sans heading over goal cards, whose sentences are the display face there (goal-card.md): the
// monitor's, and the portfolio section's overview, which switches the same way on its `vaults.length`.

const OWN = new Set([
  'features/landing/Landing.tsx',
  'features/bearing/BearingShell.tsx',
  'features/wallet/dev/DevWallet.tsx',
]);

const WORKSPACES = new Set([
  'features/invest/InvestScreen.tsx',
  'features/goal-conversation/GoalConversation.tsx',
]);

/** Every <h1 …> in a file whose class is not the page title's. */
export function otherTitles(text: string, file?: string): string[] {
  return [...text.matchAll(/<h1\b[^>]*>/gs)]
    .map((m) => m[0])
    .filter((tag) => !/className=\{(`\$\{)?PAGE_TITLE/.test(tag) && !/vaults\.length/.test(tag))
    .filter((tag) => !(file && WORKSPACES.has(file) && /className=\{WORKSPACE_TITLE\}/.test(tag)));
}

describe('a page’s title', () => {
  it('is the display-face h1 of PAGE_TITLE on every product page, gated or loaded', () => {
    const files = [...sourceFiles()].filter(
      (f) => /^features\/.+\.tsx$/.test(f) && !f.includes('.test.') && !OWN.has(f),
    );
    const found = files.flatMap((f) => otherTitles(read(f), f).map((tag) => `${f}: ${tag}`));
    expect(found).toEqual([]);
    expect(PAGE_TITLE.split(' ')).toEqual(
      expect.arrayContaining(['font-display', 'text-h1', 'font-semibold', 'tracking-[-0.02em]']),
    );
    expect(PAGE_TITLE.split(' ')).not.toEqual(expect.arrayContaining(['font-normal']));
  });

  it('permits only the exact shared workspace title in the two Invest workspaces', () => {
    expect(WORKSPACE_TITLE).toBe('text-body-lg font-semibold');
    const title = '<h1 className={WORKSPACE_TITLE}>Invest</h1>';
    for (const file of WORKSPACES) {
      expect(otherTitles(title, file)).toEqual([]);
      expect(
        otherTitles('<h1 className="text-body-lg font-semibold">Invest</h1>', file),
      ).toHaveLength(1);
      expect(
        otherTitles('<h1 className={WORKSPACE_TITLE + " text-h1"}>Invest</h1>', file),
      ).toHaveLength(1);
      expect(otherTitles('<h1 className="text-h2">Another title</h1>', file)).toHaveLength(1);
    }
    expect(otherTitles(title, 'features/shared/VaultScreen.tsx')).toHaveLength(1);
    expect(otherTitles(title)).toHaveLength(1);
  });

  it('bites: a gated state titled in another register is found', () => {
    expect(otherTitles('<h1 className="font-sans text-h2 font-semibold">x</h1>')).toHaveLength(1);
    expect(otherTitles('<h1 id={a} className={PAGE_TITLE}>x</h1>')).toHaveLength(0);
  });
});

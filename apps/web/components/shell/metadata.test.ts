import { describe, expect, it, vi } from 'vitest';
import * as goalPage from '../../app/(app)/goal/page';
import * as signInPage from '../../app/(app)/sign-in/page';
import { dictionary, type Lang } from '../../i18n';
import { read } from '../ui/test/css';
import { goalMetadata, shellMetadata, signInMetadata } from './metadata';

// What a browser tab, a bookmark and a link preview say about each product page: its own title and
// its own description, in the language of the view.

const preference = vi.hoisted(() => ({ lang: 'en' as 'en' | 'pt' }));
vi.mock('../../i18n/server', () => ({
  readPreferences: async () => ({ lang: preference.lang, theme: 'auto' }),
}));
vi.mock('next/navigation', () => import('../../features/wallet/test/mock-next'));

describe('the title and description of each product page', () => {
  it.each(['en', 'pt'] as Lang[])('are its own, in %s', async (lang) => {
    preference.lang = lang;
    const t = dictionary(lang);
    const [onGoal, onSignIn, fallback] = await Promise.all([
      goalMetadata(),
      signInMetadata(),
      shellMetadata(),
    ]);
    expect(onGoal).toEqual({ title: t.goal.composer.label, description: t.goal.title });
    expect(onSignIn).toEqual({ title: t.shell.signIn, description: t.signIn.title });
    // two pages, two titles, and sign-in does not carry the goal's description
    expect(onSignIn.title).not.toBe(onGoal.title);
    expect(onSignIn.description).not.toBe(onGoal.description);
    // the product's name follows each title, and stands alone where a page names none
    expect(fallback.title).toEqual({ template: '%s · tenonfi', default: 'tenonfi' });
  });

  it('are what each page file hands Next', async () => {
    preference.lang = 'pt';
    expect(await goalPage.generateMetadata()).toEqual(await goalMetadata());
    expect(await signInPage.generateMetadata()).toEqual(await signInMetadata());
    // the layout loads the fonts, which a test cannot: its lines are read as written
    expect(read('app/(app)/layout.tsx')).toMatch(
      /export function generateMetadata\(\) \{\s+return shellMetadata\(\);\s+\}/,
    );
  });
});

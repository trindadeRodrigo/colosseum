import { describe, expect, it, vi } from 'vitest';
import * as monitorPage from '../../app/(app)/monitor/page';
import * as homePage from '../../app/(app)/page';
import * as signInPage from '../../app/(app)/sign-in/page';
import { dictionary, type Lang } from '../../i18n';
import { read } from '../ui/test/css';
import { goalMetadata, monitorMetadata, shellMetadata, signInMetadata } from './metadata';

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
    const [onGoal, onSignIn, onMonitor, fallback] = await Promise.all([
      goalMetadata(),
      signInMetadata(),
      monitorMetadata(),
      shellMetadata(),
    ]);
    expect(onGoal).toEqual({ title: t.goal.composer.label, description: t.goal.title });
    expect(onSignIn).toEqual({ title: t.shell.signIn, description: t.signIn.title });
    expect(onMonitor).toEqual({ title: t.shell.portfolio, description: t.portfolio.lead });
    // three pages, three titles, and none carries another's description
    expect(new Set([onGoal.title, onSignIn.title, onMonitor.title]).size).toBe(3);
    expect(new Set([onGoal.description, onSignIn.description, onMonitor.description]).size).toBe(3);
    // the product's name follows each title, and stands alone where a page names none
    expect(fallback.title).toEqual({ template: '%s · tenonfi', default: 'tenonfi' });
  });

  it('are what each page file hands Next', async () => {
    preference.lang = 'pt';
    // home is the goal
    expect(await homePage.generateMetadata()).toEqual(await goalMetadata());
    expect(await monitorPage.generateMetadata()).toEqual(await monitorMetadata());
    expect(await signInPage.generateMetadata()).toEqual(await signInMetadata());
    // the layout loads the fonts, which a test cannot: its lines are read as written
    expect(read('app/(app)/layout.tsx')).toMatch(
      /export function generateMetadata\(\) \{\s+return shellMetadata\(\);\s+\}/,
    );
  });
});

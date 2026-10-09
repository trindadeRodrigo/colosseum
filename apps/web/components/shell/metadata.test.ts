import { describe, expect, it, vi } from 'vitest';
import * as goalPage from '../../app/(app)/goal/page';
import * as monitorPage from '../../app/(app)/monitor/page';
import * as orderPage from '../../app/(app)/orders/[id]/page';
import * as buyPage from '../../app/(app)/plan/[id]/buy/page';
import * as planPage from '../../app/(app)/plan/[id]/page';
import * as signInPage from '../../app/(app)/sign-in/page';
import { dictionary, type Lang } from '../../i18n';
import { read } from '../ui/test/css';
import {
  buyMetadata,
  goalMetadata,
  monitorMetadata,
  orderMetadata,
  planMetadata,
  shellMetadata,
  signInMetadata,
} from './metadata';

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
    expect(onGoal).toEqual({ title: t.shell.invest, description: t.goal.title });
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
    expect(await goalPage.generateMetadata()).toEqual(await goalMetadata());
    expect(await monitorPage.generateMetadata()).toEqual(await monitorMetadata());
    expect(await signInPage.generateMetadata()).toEqual(await signInMetadata());
    // the layout loads the fonts, which a test cannot: its lines are read as written
    expect(read('app/(app)/layout.tsx')).toMatch(
      /export function generateMetadata\(\) \{\s+return shellMetadata\(\);\s+\}/,
    );
  });

  it.each(['en', 'pt'] as Lang[])(
    'are their own on the plan, buy and order pages, in %s',
    async (lang) => {
      preference.lang = lang;
      const t = dictionary(lang);
      const pages = [await planMetadata(), await buyMetadata(), await orderMetadata()];
      expect(pages).toEqual([
        { title: t.plan.title, description: t.plan.buy },
        { title: t.buy.title, description: t.buy.funding.title },
        { title: t.order.title, description: t.order.review.title },
      ]);
      expect(new Set(pages.map((p) => p.title)).size).toBe(3);
      expect(await planPage.generateMetadata()).toEqual(pages[0]);
      expect(await buyPage.generateMetadata()).toEqual(pages[1]);
      expect(await orderPage.generateMetadata()).toEqual(pages[2]);
    },
  );
});

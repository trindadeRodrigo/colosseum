'use client';
import { useEffect, useState } from 'react';
import { Mark } from '../../components/shell/Mark';
import { CompactNav } from '../../components/ui/CompactNav';
import { useT } from '../../i18n/I18nProvider';
import { STEP_IDS } from './JointStage';

// His landing header (compact-nav.md): the mark and the wordmark alone over the hero, then, from step
// 03, a solid centred bar with the menu and the one call to action. With reduced motion the stage is
// not pinned, so the bar is compact from the start. His items: Products and Invest are the page's own
// showcase and typing box, and Analytics is Bearing, its methodology in its side menu (no Resources
// item: Thom, Oct 6); the product's bar has the same items on its routes
// (components/shell/AppNav.tsx). The action is "Sign in" for a visitor, and "Open the app" for a
// person signed in on this browser, in the same filled style (app/(marketing)/page.tsx reads the hint).

/** Where a signed-in person goes back into the app: the goal, where sign-in leads. */
export const APP_HOME = '/goal';

export function LandingNav({ signedIn = false }: { signedIn?: boolean }) {
  const t = useT().landing.nav;
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);
  return (
    <CompactNav
      symbol={<Mark size={24} />}
      wordmark="tenonfi"
      homeLabel={t.home}
      homeHref="/"
      contentId="content"
      links={[
        { label: t.products, href: '#showcase' },
        { label: t.invest, href: '#simulate' },
        { label: t.analytics, href: '/analytics/stocks' },
      ]}
      cta={
        signedIn
          ? { label: t.openApp, href: APP_HOME }
          : { label: t.cta, href: '/sign-in?next=/goal' }
      }
      stage={{ compactAt: STEP_IDS[2], releaseAbove: STEP_IDS[1] }}
      compact={still ? true : undefined}
      labels={{ skip: t.skip, main: t.main, menu: t.menu }}
    />
  );
}

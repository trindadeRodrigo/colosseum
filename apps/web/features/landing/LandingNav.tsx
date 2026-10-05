'use client';
import { useEffect, useState } from 'react';
import { Mark } from '../../components/shell/Mark';
import { CompactNav } from '../../components/ui/CompactNav';
import { useT } from '../../i18n/I18nProvider';
import { STEP_IDS } from './JointStage';

// His landing header (compact-nav.md): the mark and the wordmark alone over the hero, then, from step
// 03, a solid centred bar with the menu and the one call to action. With reduced motion the stage is
// not pinned, so the bar is compact from the start. A person signed in on this browser never sees
// this page: `/` sends them to their goal (app/(marketing)/page.tsx), so the action is "Sign in".

export function LandingNav() {
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
        { label: t.resources, href: '#resources' },
      ]}
      cta={{ label: t.cta, href: '/sign-in?next=/goal' }}
      stage={{ compactAt: STEP_IDS[2], releaseAbove: STEP_IDS[1] }}
      compact={still ? true : undefined}
      labels={{ skip: t.skip, main: t.main, menu: t.menu }}
    />
  );
}

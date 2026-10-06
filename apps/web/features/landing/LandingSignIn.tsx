'use client';
import { type ComponentType, useCallback, useEffect, useState } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { LatticeStatus } from '../../components/ui/Lattice';
import { useT } from '../../i18n/I18nProvider';
import { nextOf, SignInFrame, signInLink } from '../account/sign-in-frame';

// The landing's "Sign in" (Thom, Oct 6): the same sign-in dialog as the product, over the landing,
// with the URL left at `/`. The landing is its own document with no wallet, so the wallet, the account
// and the panel are loaded on the first press only, in the browser (`next/dynamic`, no server
// rendering, a dynamic import): the landing's first load stays as light as it was. Until they are there the dialog's
// frame is drawn at once, with its title and a quiet loading line, not a blank. A link opened in a new
// tab, and `/sign-in` loaded as a page, still get the page.

type PanelProps = { titleId: string; next: string | null; onClose: () => void };

function Loading({ titleId, failed }: { titleId: string; failed: boolean }) {
  const t = useT();
  return (
    <div data-ui="sign-in-loading" className="mx-auto flex w-full max-w-[860px] flex-col gap-6">
      <h2 id={titleId} className="max-w-(--tf-measure-display) font-display text-h2 font-normal">
        {t.signIn.title}
      </h2>
      {/* The panel's code did not arrive (offline, or a deploy moved it): the page still works. */}
      {failed ? (
        <p role="alert" className="max-w-(--tf-measure-body) text-body">
          {t.signIn.notLoaded}{' '}
          <a href="/sign-in" data-sign-in-page="" className={buttonClass({ variant: 'link' })}>
            {t.signIn.openPage}
          </a>
        </p>
      ) : (
        <LatticeStatus label={t.signIn.loading} />
      )}
    </div>
  );
}

type Opened = { next: string | null; trigger: HTMLElement | null };

export function LandingSignIn() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [failed, setFailed] = useState(false);
  const close = useCallback(() => setOpened(null), []);
  // The wallet, the account and the panel arrive with the first press, and are kept for the next.
  useEffect(() => {
    if (!opened || Panel) return;
    let live = true;
    setFailed(false);
    import('./landing-sign-in-panel').then(
      (module) => {
        if (live) setPanel(() => module.default);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [opened, Panel]);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = signInLink(event);
      if (!anchor) return;
      event.preventDefault();
      setOpened({ next: nextOf(anchor), trigger: anchor });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  if (!opened) return null;
  return (
    <SignInFrame trigger={opened.trigger} onClose={close}>
      {(titleId) =>
        Panel ? (
          <Panel titleId={titleId} next={opened.next} onClose={close} />
        ) : (
          <Loading titleId={titleId} failed={failed} />
        )
      }
    </SignInFrame>
  );
}

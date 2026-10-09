'use client';
import { type ComponentType, useCallback, useEffect, useRef, useState } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { LatticeStatus } from '../../components/ui/Lattice';
import { useT } from '../../i18n/I18nProvider';
import {
  AccountControlFrame,
  AccountPlaceholder,
  SignInButton,
  signInHref,
} from '../account/account-control-parts';
import { nextOf, SignInFrame, signInLink } from '../account/sign-in-frame';
import type { LandingAccountLiveProps } from './landing-account-live';

// The landing's account control (Thom, Oct 9): the same control as the product's bar, in the same
// three states (features/account/account-control-parts.tsx). The landing is its own document with no
// wallet, and a visitor's first load stays as light as it was:
//
//   a visitor              "Sign in", drawn at once from the parts that need no wallet. The first
//                          press opens the sign-in dialog over the landing (Thom, Oct 6), its frame
//                          at once with a quiet loading line, and loads the wallet, the account and
//                          the panel into it (`next/dynamic` is not needed: a dynamic import)
//   a person signed in     on this browser (the hint): the placeholder, and the wallet is loaded at
//                          once, so the bar shows their account chip, as in the product
//
// Once loaded, the live control takes the static one's place for good: signing in on the landing
// shows the chip with no reload, and signing out shows "Sign in" again. A link opened in a new tab,
// and `/sign-in` loaded as a page, still get the page.

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
type Slot = { el: HTMLElement; titleId: string };

/** Where the live panel is drawn inside the frame: handed up once it is in the page. */
function PanelSlot({ titleId, onSlot }: { titleId: string; onSlot: (slot: Slot | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) onSlot({ el: ref.current, titleId });
    return () => onSlot(null);
  }, [titleId, onSlot]);
  return <div ref={ref} className="contents" />;
}

export function LandingAccount({ hinted = false }: { hinted?: boolean }) {
  const t = useT();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [Live, setLive] = useState<ComponentType<LandingAccountLiveProps> | null>(null);
  const [failed, setFailed] = useState(false);
  // Where the live panel is drawn, inside the frame, and the title that names the dialog.
  const [panel, setPanel] = useState<Slot | null>(null);
  const close = useCallback(() => setOpened(null), []);
  // The wallet, the account and the panel arrive with the first press, or at once for a person the
  // hint names, and are kept from then on.
  const wanted = hinted || opened !== null;
  useEffect(() => {
    if (!wanted || Live) return;
    let live = true;
    setFailed(false);
    import('./landing-account-live').then(
      (module) => {
        if (live) setLive(() => module.default);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [wanted, Live]);
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
  return (
    <div data-ui="landing-account" className="flex items-center">
      {Live ? (
        <Live
          hinted={hinted}
          panel={opened ? (panel?.el ?? null) : null}
          titleId={panel?.titleId ?? null}
          next={opened?.next ?? null}
          onClose={close}
        />
      ) : hinted && !failed ? (
        // Signed in on this browser, and the wallet's code is on its way: the chip's still box.
        <AccountControlFrame state="loading" said="">
          <AccountPlaceholder expected />
        </AccountControlFrame>
      ) : (
        <AccountControlFrame state="signed-out" said="">
          <SignInButton href={signInHref('/')} label={t.shell.signIn} quiet />
        </AccountControlFrame>
      )}
      {opened && (
        <SignInFrame trigger={opened.trigger} onClose={close}>
          {(titleId) =>
            Live ? (
              <PanelSlot titleId={titleId} onSlot={setPanel} />
            ) : (
              <Loading titleId={titleId} failed={failed} />
            )
          }
        </SignInFrame>
      )}
    </div>
  );
}

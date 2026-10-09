'use client';
import { Button } from '../../components/ui/Button';
import { useT } from '../../i18n/I18nProvider';
import type { SignOutState } from './AccountMenu';
import { useAccount } from './AccountProvider';

// Someone signed in who is still not ready after half a minute (AccountProvider, `slow`): the help
// under the bar's control, which keeps its loading look, and at the head of the phone's sheet. What
// is slow as far as it is known, "Try again", and "Sign out" where there is one. Plain text and
// links, nothing moves while they wait (STYLE.md); "Try again" keeps its place and its focus while
// it tries, with its label changed (button.md, busy).

export function SlowSignIn({ out, className }: { out?: SignOutState; className?: string }) {
  const t = useT();
  const { slow, again } = useAccount();
  if (!slow) return null;
  return (
    <div data-ui="sign-in-slow" data-side={slow.side} className={className}>
      <p className="text-body-sm text-foreground">
        <strong className="font-medium">{t.shell.slow.title}.</strong> {t.shell.slow[slow.side]}
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm">
        <Button
          variant="link"
          data-act="sign-in-again"
          busy={slow.trying}
          busyLabel={t.shell.slow.trying}
          onClick={again}
        >
          {t.shell.slow.again}
        </Button>
        {out && (
          <Button
            variant="link"
            data-act="sign-out"
            busy={out.busy}
            busyLabel={t.shell.signingOut}
            onClick={out.signOut}
          >
            {t.shell.signOut}
          </Button>
        )}
      </p>
      {slow.held && (
        <p role="alert" data-ui="sign-in-held" className="text-body-sm text-foreground">
          {t.shell.slow.held}
        </p>
      )}
      {out?.failed && (
        <p role="alert" className="text-body-sm text-destructive">
          {t.shell.signOutFailed}
        </p>
      )}
    </div>
  );
}

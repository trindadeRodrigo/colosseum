'use client';
import { Button } from '../../components/ui/Button';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from './AccountProvider';

// Someone signed in who is still not ready (AccountProvider, `slow`): what is slow, and the two
// things they can do. Plain text and links: nothing moves while they wait (STYLE.md).

export function SlowSignIn({
  onSignOut,
  className,
}: {
  /** "Sign out", where it is not already beside this (the account menu has its own). */
  onSignOut?: () => void;
  className?: string;
}) {
  const t = useT();
  const { slow, again } = useAccount();
  if (!slow) return null;
  return (
    <div data-ui="sign-in-slow" data-side={slow.side} className={className}>
      <p className="text-body-sm text-foreground">
        <strong className="font-medium">{t.shell.slow.title}.</strong> {t.shell.slow[slow.side]}
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm">
        {slow.trying ? (
          <span data-ui="sign-in-trying" className="text-muted-foreground">
            {t.shell.slow.trying}
          </span>
        ) : (
          <Button variant="link" data-act="sign-in-again" onClick={again}>
            {t.shell.slow.again}
          </Button>
        )}
        {onSignOut && (
          <Button variant="link" data-act="sign-in-leave" onClick={onSignOut}>
            {t.shell.signOut}
          </Button>
        )}
      </p>
      {slow.held && (
        <p role="alert" data-ui="sign-in-held" className="text-body-sm text-foreground">
          {t.shell.slow.held}
        </p>
      )}
    </div>
  );
}

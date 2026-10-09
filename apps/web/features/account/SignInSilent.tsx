'use client';
import { Button } from '../../components/ui/Button';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from './AccountProvider';

// The sign-in screen when the sign-in service has not loaded (AccountProvider, `stalled`): the bar
// offers "Sign in" anyway, so the screen it opens is never a wait with no end. It says the service has
// not answered, the reason where this app can tell one, and one button that starts the wallet
// provider again with no reload. Plain text: nothing moves while the person waits (STYLE.md).

export function SignInSilent() {
  const t = useT();
  const { slow, again } = useAccount();
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <div data-ui="sign-in-silent" role="status" className="flex flex-col items-start gap-3">
      <p className="max-w-(--tf-measure-body) text-body">{t.signIn.silent.body}</p>
      <p data-ui="sign-in-silent-why" className="max-w-(--tf-measure-body) text-body-sm">
        {offline ? t.signIn.silent.offline : t.signIn.silent.blocked}
      </p>
      {slow?.trying ? (
        <p data-ui="sign-in-trying" className="text-body-sm text-muted-foreground">
          {t.shell.slow.trying}
        </p>
      ) : (
        <Button variant="primary" data-act="sign-in-again" onClick={again}>
          {t.shell.slow.again}
        </Button>
      )}
      {slow?.held && (
        <p role="alert" data-ui="sign-in-held" className="text-body-sm">
          {t.shell.slow.held}
        </p>
      )}
    </div>
  );
}

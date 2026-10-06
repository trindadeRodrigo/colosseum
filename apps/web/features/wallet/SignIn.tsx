'use client';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { LatticeStatus } from '../../components/ui/Lattice';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { type SignInAttempt, type SignInFailure, signInFailure } from './sign-in-view';
import { useWalletPort } from './WalletProvider';

// The two ways in, on the primitives (GATES, SIGN-IN): a passkey, made here or already had, or a
// wallet the person uses. Nothing of the wallet provider's is drawn: its hooks run behind `signIn()`
// of the wallet port. Square corners, no spinner: a busy button changes its label. A failure is a
// sentence that says what to do, never what the wallet or the provider threw.

/** Which button is running: the two passkey buttons, or a wallet by its id. */
type Busy = 'create' | 'use' | `wallet:${string}` | null;

export type SignInProps = {
  /** A way in was pressed: the screen may be about to change under the person. */
  onAttempt?: () => void;
  /** It did not work, and the panel says why. */
  onFailed?: () => void;
  onSignedIn?: () => void;
};

/**
 * The buttons of a card, at its foot: one column, or two of equal width where the card is wide enough
 * for their labels (the passkey's are long; a wallet's are short). Each fills its cell.
 */
const BUTTONS = 'mt-auto grid w-full grid-cols-1 gap-3';

export function SignIn({ onAttempt, onFailed, onSignedIn }: SignInProps) {
  const t = useT();
  const port = useWalletPort();
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const passkeyId = useId();
  const walletId = useId();

  async function run(
    what: Exclude<Busy, null>,
    attempt: SignInAttempt,
    action: () => Promise<void>,
  ) {
    if (busy) return;
    setBusy(what);
    setFailure(null);
    onAttempt?.();
    try {
      await action();
      onSignedIn?.();
    } catch (e) {
      setFailure(signInFailure(e, attempt));
      onFailed?.();
    } finally {
      setBusy(null);
    }
  }

  // Sign-in is off, and the screen says why in words a person can use. The detail is for the team,
  // and is shown by the development server only.
  if (port.problem !== null)
    return (
      <div data-ui="sign-in" data-state="off" role="status" className="flex flex-col gap-2">
        <p className="max-w-(--tf-measure-body) text-body">
          {port.problemKind === 'api' ? t.signIn.off.api : t.signIn.off.setup}
        </p>
        {process.env.NODE_ENV !== 'production' && (
          <p className="font-mono text-source text-muted-foreground">
            {t.signIn.off.detail}: {port.problem}
          </p>
        )}
      </div>
    );

  if (port.status !== 'signed-out')
    return (
      <div data-ui="sign-in" data-state="loading">
        <LatticeStatus label={t.signIn.loading} />
      </div>
    );

  const resting = (what: Exclude<Busy, null>) => busy !== null && busy !== what;
  // The two cards are as tall as each other, their buttons at the foot of each on one line. The mock
  // card of the throwaway wallet keeps its band and body in a row: its body column is the one that
  // stretches, with the MOCK plate at its top right.
  const column = port.test
    ? '[&>div]:flex [&>div]:flex-col [&>div>[data-ui=mock-plate]]:self-end'
    : 'flex flex-col';
  const body = '@container flex flex-1 flex-col gap-4';
  // What a screen reader hears after MOCK, in the language of the view.
  const mockLabels = { announce: t.shell.mockAnnounce };
  return (
    <div data-ui="sign-in" data-state="ready" className="flex flex-col gap-4">
      <div className="grid gap-6 min-[820px]:grid-cols-2">
        <Card
          as="section"
          aria-labelledby={passkeyId}
          mock={port.test}
          mockLabels={mockLabels}
          className={column}
        >
          <CardHeader title={t.signIn.passkey.title} level={2} id={passkeyId} />
          <CardBody className={body}>
            <p className="text-body">{t.signIn.passkey.body}</p>
            <div data-ui="sign-in-buttons" className={cn(BUTTONS, '@md:grid-cols-2')}>
              <Button
                variant="primary"
                busy={busy === 'create'}
                busyLabel={t.signIn.passkey.waiting}
                disabled={resting('create')}
                onClick={() =>
                  run('create', 'passkey-create', () => port.signIn('passkey', { create: true }))
                }
                className="w-full"
              >
                {t.signIn.passkey.create}
              </Button>
              <Button
                busy={busy === 'use'}
                busyLabel={t.signIn.passkey.waiting}
                disabled={resting('use')}
                onClick={() => run('use', 'passkey-use', () => port.signIn('passkey'))}
                className="w-full"
              >
                {t.signIn.passkey.use}
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card
          as="section"
          aria-labelledby={walletId}
          mock={port.test}
          mockLabels={mockLabels}
          className={column}
        >
          <CardHeader title={t.signIn.wallet.title} level={2} id={walletId} />
          <CardBody className={body}>
            <p className="text-body">{t.signIn.wallet.body}</p>
            {port.found.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">{t.signIn.wallet.none}</p>
            ) : (
              <ul
                aria-label={t.signIn.wallet.found}
                data-ui="sign-in-buttons"
                className={cn(BUTTONS, '@xs:grid-cols-2')}
              >
                {port.found.map((wallet) => {
                  const what = `wallet:${wallet.id}` as const;
                  return (
                    <li key={wallet.id}>
                      <Button
                        busy={busy === what}
                        busyLabel={t.signIn.wallet.waiting}
                        disabled={resting(what)}
                        onClick={() =>
                          run(what, 'wallet', () => port.signIn('wallet', { wallet: wallet.id }))
                        }
                        className="w-full"
                      >
                        {wallet.name} · {t.signIn.wallet.family[wallet.family]}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
      {failure && (
        <p
          role="alert"
          data-ui="sign-in-failure"
          className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
        >
          <StatusMark status="off-track" size={12} className="mt-1.5" />
          <span>{t.signIn.failure[failure]}</span>
        </p>
      )}
    </div>
  );
}

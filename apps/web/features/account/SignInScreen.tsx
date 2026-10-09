'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { LatticeStatus } from '../../components/ui/Lattice';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { SignIn } from '../wallet/SignIn';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { ChainName } from './ChainName';
import { AFTER_SIGN_IN } from './next-path';
import { SignInSilent } from './SignInSilent';

// Sign-in as a product screen: the two ways in. Nobody is asked for a chain here (gate CHAIN-SWITCH): a
// person who connected a wallet starts on its chain, one who made their wallets here on the chain they
// were looking at, and either switches from the bar. Once the chain is known the person goes on to
// where they were headed.

/**
 * What the screen is showing. It changes because of something the person did here (signed in, chose,
 * asked again, signed out), and each time the button they pressed is gone: focus goes to what took
 * its place, and the change is said to a screen reader.
 */
type Stage = 'out' | 'making' | 'reading' | 'unknown' | 'no-wallet' | 'ready';
/** The stages a person waits through. Focus rests on the heading until one of the others comes. */
const PASSING: readonly Stage[] = ['making', 'reading'];

export type SignInScreenProps = {
  /** Where the person goes once the chain is known, when this is the page at `/sign-in`. */
  next?: string;
  /**
   * In the sign-in dialog: called once the chain is known, in place of going to `next`, and the
   * title is the dialog's (an h2 with this id) rather than the page's h1.
   */
  onDone?: () => void;
  titleId?: string;
};

export function SignInScreen({ next = AFTER_SIGN_IN, onDone, titleId }: SignInScreenProps) {
  const t = useT();
  const port = useWalletPort();
  const { account, retry, stalled } = useAccount();
  const router = useRouter();
  // Signed in on this page, in this visit: only then does the screen move the person on by itself.
  const [arrived, setArrived] = useState(false);
  const [making, setMaking] = useState(false);
  const [notMade, setNotMade] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [stillIn, setStillIn] = useState(false);
  const [said, setSaid] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The person did something on this screen, and what they pressed is about to go.
  const acted = useRef(false);

  const settled = account.status === 'ready';
  const gone = useRef(false);
  useEffect(() => {
    if (!arrived || !settled || gone.current) return;
    gone.current = true;
    if (onDone) onDone();
    else router.replace(next);
  }, [arrived, settled, next, router, onDone]);
  // In the dialog, anything the person does here that ends with their chain known closes it: the
  // sign-in, the chain question, making the wallet, asking again. On the page only a sign-in does;
  // someone who came to the page signed in asked to see it.
  const moved = () => {
    acted.current = true;
    if (onDone) setArrived(true);
  };

  async function makeWallet() {
    moved();
    setMaking(true);
    setNotMade(false);
    try {
      await port.ensureWallets();
      // The API is asked again either way: the wallet may have been there and only its answer late.
      retry();
    } catch {
      setNotMade(true);
    } finally {
      setMaking(false);
    }
  }

  async function signOut() {
    acted.current = true;
    setLeaving(true);
    setStillIn(false);
    try {
      await port.signOut();
    } catch {
      setStillIn(true);
    } finally {
      setLeaving(false);
    }
  }

  function askAgain() {
    moved();
    retry();
  }

  // A passkey sign-in owes the person a wallet of each family. Until both are there the person is
  // signed in and not ready: the chain is never asked for with one wallet.
  const owed = port.walletsOwed;
  const signedIn = port.status === 'ready' || owed !== null;
  const noWallet = owed === 'failed' || (port.status === 'ready' && account.status === 'no-wallet');
  const labels = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure };
  const chainName = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];

  // After a sign-in the port loads once more while the wallets of a passkey are made.
  const stage: Stage =
    owed === 'making' || (!signedIn && arrived && port.status === 'loading')
      ? 'making'
      : noWallet
        ? 'no-wallet'
        : !signedIn
          ? 'out'
          : account.status === 'unknown'
            ? 'unknown'
            : account.status === 'ready'
              ? 'ready'
              : 'reading';

  const unknownSentence =
    account.status !== 'unknown'
      ? ''
      : account.why === 'signed_out'
        ? t.chain.unknown.signedOut
        : account.why === 'no_identity'
          ? t.chain.unknown.noIdentity
          : account.why === 'busy'
            ? t.shell.slowDown
            : account.why === 'off'
              ? t.chain.unknown.off
              : account.why === 'refused'
                ? t.chain.unknown.refused
                : t.chain.unknown.body;
  const readySentence =
    account.status !== 'ready' ? '' : t.chain.is[account.source](chainName(account.chain));
  const noWalletSentence = owed === 'failed' ? t.signIn.failure.walletNotMade : t.chain.noWallet;

  // What a screen reader is told when the stage changes: where the person is now.
  const sentence: Record<Stage, string> = {
    out: t.shell.signedOut,
    making: `${t.signIn.done.title} ${t.signIn.passkey.making}`,
    reading: `${t.signIn.done.title} ${t.chain.reading}`,
    unknown: unknownSentence,
    'no-wallet': noWalletSentence,
    ready: readySentence,
  };
  const now = sentence[stage];

  const shown = useRef(stage);
  useEffect(() => {
    if (shown.current === stage) return;
    shown.current = stage;
    // A change the person did not bring about here (the page loading, the bar's own sign-out) moves
    // no focus: theirs is where they left it.
    if (!acted.current) return;
    const passing = PASSING.includes(stage);
    (passing || stage === 'out' ? heading.current : card.current)?.focus();
    setSaid(now);
    if (!passing) acted.current = false;
  }, [stage, now]);

  return (
    // One centred column, as wide as the bar can grow (compact-nav.md: max 860px): the headline, the
    // lead, the cards and, by the shell's rule for a centred page, the foot share its left edge.
    <div
      data-ui="sign-in-screen"
      data-column="centred"
      data-account={account.status}
      className="mx-auto flex w-full max-w-[860px] flex-col gap-8"
    >
      <header className="flex flex-col gap-3">
        {onDone ? (
          <h2
            ref={heading}
            id={titleId}
            tabIndex={-1}
            className="max-w-(--tf-measure-display) font-display text-h2 font-semibold"
          >
            {signedIn ? t.signIn.done.title : t.signIn.title}
          </h2>
        ) : (
          <h1 ref={heading} tabIndex={-1} className={PAGE_TITLE}>
            {signedIn ? t.signIn.done.title : t.signIn.title}
          </h1>
        )}
        {!signedIn && (
          <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{t.signIn.lead}</p>
        )}
      </header>

      {/* Said once, when the screen changes under the person: where they are now. */}
      <p role="status" data-ui="sign-in-said" className="sr-only">
        {said}
      </p>

      {stage === 'out' && (
        <SignIn
          onAttempt={() => {
            acted.current = true;
          }}
          onFailed={() => {
            acted.current = false;
          }}
          onSignedIn={() => setArrived(true)}
          silent={stalled ? <SignInSilent /> : undefined}
        />
      )}
      {stage === 'making' && <LatticeStatus label={t.signIn.passkey.making} />}
      {stage === 'reading' && <LatticeStatus label={t.chain.reading} />}

      {/* What took the place of the button the person pressed: focus comes here. */}
      <div ref={card} tabIndex={-1} data-ui="sign-in-stage" className="empty:hidden">
        {stage === 'unknown' && account.status === 'unknown' && (
          <Card as="section">
            <CardBody className="flex flex-col items-start gap-4">
              <p className="max-w-(--tf-measure-body) text-body">{unknownSentence}</p>
              {/* Asking again does not help a sign-in the server no longer knows, or a chain it refused: the way on is out. */}
              {account.why === 'signed_out' || account.why === 'refused' ? (
                <Button
                  variant="primary"
                  busy={leaving}
                  busyLabel={t.shell.signingOut}
                  onClick={signOut}
                >
                  {t.shell.signOut}
                </Button>
              ) : (
                <Button variant="primary" onClick={askAgain}>
                  {t.chain.unknown.retry}
                </Button>
              )}
              {stillIn && <Problem>{t.shell.signOutFailed}</Problem>}
            </CardBody>
          </Card>
        )}

        {/* The way forward when a wallet could not be made: make it again, or sign out. */}
        {stage === 'no-wallet' && (
          <Card as="section">
            <CardBody className="flex flex-col items-start gap-4">
              {/* Said again, as an alert, when making it failed once more. */}
              <p
                role={owed === 'failed' && notMade ? 'alert' : undefined}
                className="max-w-(--tf-measure-body) text-body"
              >
                {noWalletSentence}
              </p>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="primary"
                  busy={making}
                  busyLabel={t.signIn.passkey.making}
                  disabled={leaving}
                  onClick={makeWallet}
                >
                  {t.signIn.done.retryWallet}
                </Button>
                <Button
                  busy={leaving}
                  busyLabel={t.shell.signingOut}
                  disabled={making}
                  onClick={signOut}
                >
                  {t.shell.signOut}
                </Button>
              </div>
              {notMade && owed !== 'failed' && <Problem>{t.signIn.failure.walletNotMade}</Problem>}
              {stillIn && <Problem>{t.shell.signOutFailed}</Problem>}
            </CardBody>
          </Card>
        )}

        {stage === 'ready' && account.status === 'ready' && (
          <Card as="section" mock={port.test} mockLabels={{ announce: t.shell.mockAnnounce }}>
            <CardBody className="flex flex-col items-start gap-3">
              <p className="max-w-(--tf-measure-body) text-body">{readySentence}</p>
              {/* The wallet of that chain alone: the other family's is never shown or used. */}
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
                {port.test ? (
                  <span>{chainName(account.chain)}</span>
                ) : (
                  <ChainName
                    name={chainName(account.chain)}
                    provenance={port.network(account.chain)?.provenance ?? 'mock'}
                    labels={labels}
                  />
                )}
                <span className="font-mono text-source break-all text-muted-foreground">
                  {port.active(chainFamily(account.chain))?.address ?? t.signIn.done.noWallet}
                </span>
              </p>
              {/* In the dialog the way on is the dialog's: it closes, and the action carries on. */}
              {onDone ? (
                <Button variant="link" onClick={onDone}>
                  {t.signIn.done.next}
                </Button>
              ) : (
                <Button variant="link" href={next}>
                  {t.signIn.done.next}
                </Button>
              )}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

/** A thing that went wrong, said as an alert: the mark, and the sentence. */
function Problem({ children }: { children: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
      <StatusMark status="off-track" size={12} className="mt-1.5" />
      <span>{children}</span>
    </p>
  );
}

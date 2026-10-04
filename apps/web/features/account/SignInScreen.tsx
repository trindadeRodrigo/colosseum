'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { LatticeStatus } from '../../components/ui/Lattice';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import { SignIn } from '../wallet/SignIn';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { ChainName } from './ChainName';
import { ChainPick } from './ChainPick';

// Sign-in as a product screen: the two ways in, then, for a person who made their wallet here, the one
// question of where their plan lives. A person who connected a wallet is not asked: the chain is that
// wallet's. Once the chain is known the person goes on to where they were headed.

export function SignInScreen({ next = '/goal' }: { next?: string }) {
  const t = useT();
  const port = useWalletPort();
  const { account, retry, overruled } = useAccount();
  const router = useRouter();
  // Signed in on this page, in this visit: only then does the screen move the person on by itself.
  const [arrived, setArrived] = useState(false);
  const [making, setMaking] = useState(false);
  const [notMade, setNotMade] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // A person whose choice was not kept is not moved on by the page: they read why first.
  const settled = account.status === 'ready' && overruled === null;
  useEffect(() => {
    if (arrived && settled) router.replace(next);
  }, [arrived, settled, next, router]);

  async function makeWallet() {
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
    setLeaving(true);
    try {
      await port.signOut();
    } catch {
      // The bar says when signing out failed (AppNav); here the button comes back to rest.
    } finally {
      setLeaving(false);
    }
  }

  // A passkey sign-in owes the person a wallet of each family. Until both are there the person is
  // signed in and not ready: the chain is never asked for with one wallet.
  const owed = port.walletsOwed;
  const signedIn = port.status === 'ready' || owed !== null;
  const noWallet = owed === 'failed' || (port.status === 'ready' && account.status === 'no-wallet');
  const labels = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.mockAnnounce };
  const chainName = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];
  return (
    <div data-ui="sign-in-screen" data-account={account.status} className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="max-w-(--tf-measure-display) font-display text-h1 font-normal">
          {signedIn ? t.signIn.done.title : t.signIn.title}
        </h1>
        {!signedIn && (
          <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{t.signIn.lead}</p>
        )}
      </header>

      {/* After a sign-in the port loads once more while the wallets of a passkey are made. */}
      {owed === 'making' || (!signedIn && arrived && port.status === 'loading') ? (
        <LatticeStatus label={t.signIn.passkey.making} />
      ) : !signedIn ? (
        <SignIn onSignedIn={() => setArrived(true)} />
      ) : null}

      {port.status === 'ready' && account.status === 'loading' && (
        <LatticeStatus label={t.chain.reading} />
      )}

      {signedIn && account.status === 'needs-chain' && <ChainPick options={account.options} />}

      {signedIn && account.status === 'unknown' && (
        <Card as="section">
          <CardBody className="flex flex-col items-start gap-4">
            {overruled && (
              <p role="alert" className="max-w-(--tf-measure-body) text-body">
                {t.chain.failure.takenUnknown(chainName(overruled))}
              </p>
            )}
            <p className="max-w-(--tf-measure-body) text-body">
              {account.why === 'signed_out'
                ? t.chain.unknown.signedOut
                : account.why === 'busy'
                  ? t.shell.slowDown
                  : t.chain.unknown.body}
            </p>
            {/* Asking again does not help a sign-in the server no longer knows: the way on is out. */}
            {account.why === 'signed_out' ? (
              <Button
                variant="primary"
                busy={leaving}
                busyLabel={t.shell.signingOut}
                onClick={signOut}
              >
                {t.shell.signOut}
              </Button>
            ) : (
              <Button variant="primary" onClick={retry}>
                {t.chain.unknown.retry}
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      {/* The way forward when a wallet could not be made: make it again, or sign out. */}
      {noWallet && (
        <Card as="section">
          <CardBody className="flex flex-col items-start gap-4">
            {/* Said again, as an alert, when making it failed once more. */}
            <p
              role={owed === 'failed' && notMade ? 'alert' : undefined}
              className="max-w-(--tf-measure-body) text-body"
            >
              {owed === 'failed' ? t.signIn.failure.walletNotMade : t.chain.noWallet}
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
            {notMade && owed !== 'failed' && (
              <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
                <StatusMark status="off-track" size={12} className="mt-1.5" />
                <span>{t.signIn.failure.walletNotMade}</span>
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {signedIn && account.status === 'ready' && (
        <Card as="section" mock={port.test}>
          <CardBody className="flex flex-col items-start gap-3">
            {/* Chosen first on another device or tab: where the plan lives, and what was not kept. */}
            {overruled && overruled !== account.chain ? (
              <p role="alert" className="max-w-(--tf-measure-body) text-body">
                {t.chain.failure.taken(chainName(account.chain), chainName(overruled))}
              </p>
            ) : (
              <p className="max-w-(--tf-measure-body) text-body">
                {t.chain.is[account.source](chainName(account.chain))}
              </p>
            )}
            {/* The wallet of that chain alone: the other family's is never shown or used. */}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
              {port.test ? (
                <span>{port.network(account.chain)?.name ?? t.chain.names[account.chain]}</span>
              ) : (
                <ChainName
                  name={port.network(account.chain)?.name ?? t.chain.names[account.chain]}
                  provenance={port.network(account.chain)?.provenance ?? 'mock'}
                  labels={labels}
                />
              )}
              <span className="font-mono text-source break-all text-muted-foreground">
                {port.active(chainFamily(account.chain))?.address ?? t.signIn.done.noWallet}
              </span>
            </p>
            <Button variant="link" href={next}>
              {t.signIn.done.next}
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

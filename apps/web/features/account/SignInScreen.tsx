'use client';
import { chainFamily } from '@colosseum/schemas';
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
  const { account, retry } = useAccount();
  const router = useRouter();
  // Signed in on this page, in this visit: only then does the screen move the person on by itself.
  const [arrived, setArrived] = useState(false);
  const [making, setMaking] = useState(false);
  const [notMade, setNotMade] = useState(false);

  const settled = account.status === 'ready';
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

  const signedIn = port.status === 'ready';
  const labels = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.mockAnnounce };
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

      {/* After a sign-in the port loads once more while the wallet of a passkey is made. */}
      {!signedIn && arrived && port.status === 'loading' ? (
        <LatticeStatus label={t.signIn.passkey.making} />
      ) : !signedIn ? (
        <SignIn onSignedIn={() => setArrived(true)} />
      ) : null}

      {signedIn && account.status === 'loading' && <LatticeStatus label={t.chain.reading} />}

      {signedIn && account.status === 'needs-chain' && <ChainPick options={account.options} />}

      {signedIn && account.status === 'unknown' && (
        <Card as="section">
          <CardBody className="flex flex-col items-start gap-4">
            <p className="max-w-(--tf-measure-body) text-body">{t.chain.unknown.body}</p>
            <Button variant="primary" onClick={retry}>
              {t.chain.unknown.retry}
            </Button>
          </CardBody>
        </Card>
      )}

      {signedIn && account.status === 'no-wallet' && (
        <Card as="section">
          <CardBody className="flex flex-col items-start gap-4">
            <p className="max-w-(--tf-measure-body) text-body">{t.chain.noWallet}</p>
            <Button
              variant="primary"
              busy={making}
              busyLabel={t.signIn.passkey.making}
              onClick={makeWallet}
            >
              {t.signIn.done.retryWallet}
            </Button>
            {notMade && (
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
            <p className="max-w-(--tf-measure-body) text-body">
              {t.chain.is[account.source](
                port.network(account.chain)?.name ?? t.chain.names[account.chain],
              )}
            </p>
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

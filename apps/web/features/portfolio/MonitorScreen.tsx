'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty, CardLoading } from '../../components/ui/Card';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { Status } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { ChainName } from '../account/ChainName';
import { useWalletPort } from '../wallet/WalletProvider';
import { usePortfolio } from './use-portfolio';
import { VaultPanel } from './VaultPanel';

// The monitor (/monitor): the person's vaults on the one chain their plan lives on, read from the API
// each time the page opens (GET /v1/portfolio). One serif line, then the chain, then a panel per vault,
// then the disclaimer under them (disclaimer-block.md: "Monitor, under the plan summary card"). Where
// the API cannot say, a sentence says why and what to do; no holding is ever drawn in its place.
// Nothing here signs: there is no primary button, and the vault's switches are not offered.

const SIGN_IN = '/sign-in?next=/monitor';

export function MonitorScreen() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { account, retry, mock } = useAccount();
  const { state, again, busy } = usePortfolio();
  const words = t.portfolio;
  const link = buttonClass({ variant: 'link' });
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.mockAnnounce };

  const chain = state.kind === 'reading' || state.kind === 'answered' ? state.chain : null;
  const network = chain ? port.network(chain) : null;
  const chainName = chain ? (network?.name ?? t.chain.names[chain]) : '';
  const read =
    state.kind === 'answered' && state.outcome.kind === 'read' ? state.outcome.chain : null;
  const vaults = read?.vaults ?? [];
  // How the chain is run: the API's word on the chain it read, or else the wallet's.
  const chainLabel = read?.provenance ?? network?.provenance ?? 'mock';

  const readAgain = (
    <Button
      variant="secondary"
      size="dense"
      busy={busy}
      busyLabel={words.againBusy}
      onClick={again}
    >
      {words.again}
    </Button>
  );
  /** A card that says one thing, and offers one thing to do. */
  const say = (sentence: string, action?: ReactNode) => (
    <Card>
      <CardEmpty sentence={sentence} action={action} />
    </Card>
  );

  let body: ReactNode;
  if (state.kind === 'loading' || state.kind === 'reading')
    body = (
      <Card>
        <CardLoading label={words.reading} />
      </Card>
    );
  else if (state.kind === 'signed-out')
    body = say(
      words.signedOut,
      <Link href={SIGN_IN} className={link}>
        {t.shell.signIn}
      </Link>,
    );
  else if (state.kind === 'no-account-chain')
    body =
      account.status === 'unknown'
        ? say(
            t.chain.unknown.body,
            <Button variant="link" onClick={retry}>
              {t.chain.unknown.retry}
            </Button>,
          )
        : account.status === 'no-wallet'
          ? say(t.chain.noWallet)
          : say(
              words.noChain,
              <Link href={SIGN_IN} className={link}>
                {words.chooseChain}
              </Link>,
            );
  else {
    const { outcome } = state;
    switch (outcome.kind) {
      case 'read':
        body =
          vaults.length === 0
            ? say(
                words.empty(chainName),
                <Link href="/" className={link}>
                  {words.startGoal}
                </Link>,
              )
            : vaults.map((vault) => (
                <VaultPanel key={vault.address} chain={outcome.chain} vault={vault} />
              ));
        break;
      case 'unavailable':
        body = say(
          words.unavailable,
          <Link href="/" className={link}>
            {words.startGoal}
          </Link>,
        );
        break;
      case 'chain-down':
        body = (
          <Card>
            <CardBody className="flex flex-col items-start gap-3">
              <Status status="watch">{words.down.word}</Status>
              <p className="max-w-(--tf-measure-body) text-body-sm">{words.down.body(chainName)}</p>
              {readAgain}
            </CardBody>
          </Card>
        );
        break;
      // The throwaway wallet of development has no account on a real API: that is why, not the
      // sign-in. A stand-in API that answers it is read like any other.
      case 'signed-out':
        body = say(mock ? words.throwaway : words.signInAgain);
        break;
      case 'no-identity':
        body = mock ? say(words.throwaway) : say(words.noIdentity, readAgain);
        break;
      case 'no-chain':
        body = say(
          words.noChain,
          <Link href={SIGN_IN} className={link}>
            {words.chooseChain}
          </Link>,
        );
        break;
      case 'busy':
        body = say(t.shell.slowDown, readAgain);
        break;
      case 'unreachable':
        body = say(words.unreachable, readAgain);
        break;
      case 'unreadable':
        body = say(words.unreadable, readAgain);
        break;
    }
  }

  return (
    <div data-ui="monitor-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="max-w-(--tf-measure-display) font-display text-display font-normal">
          {words.title(vaults.length)}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{words.lead}</p>
        {chain && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
            <span className="text-caption text-muted-foreground">{words.chain}</span>
            <ChainName name={chainName} provenance={chainLabel} labels={marks} />
          </p>
        )}
      </header>
      <p role="status" className="sr-only">
        {busy ? words.reading : ''}
      </p>
      <div aria-busy={busy} className="flex flex-col gap-6">
        {body}
      </div>
      {vaults.length > 0 && <Disclaimer lang={lang} label={t.shell.disclaimer} />}
    </div>
  );
}

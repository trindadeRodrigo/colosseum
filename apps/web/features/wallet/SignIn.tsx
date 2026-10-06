'use client';
import type { ChainId } from '@colosseum/schemas';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { LatticeStatus } from '../../components/ui/Lattice';
import { StatusMark } from '../../components/ui/StatusMark';
import { useT } from '../../i18n/I18nProvider';
import {
  makeOneInstead,
  type SignInAttempt,
  type SignInFailure,
  signInFailure,
  type WalletChoice,
  walletChoices,
} from './sign-in-view';
import { useWalletPort } from './WalletProvider';

// The two ways in, on the primitives (GATES, SIGN-IN, SIGN-IN-FLOW): one button for a passkey and one
// for a wallet. "Continue with a passkey" uses the passkey this device has for the site, and makes one
// when it has none (a closed prompt, or a passkey unknown here, means none). "Connect a wallet" opens
// our own list of the wallets found in this browser, one entry per wallet with its own name and icon;
// a wallet that signs on both families asks first which chain the plan lives on, since that is the
// family it signs in with, and a wallet of one family is that family's. Nothing of the wallet
// provider's is drawn: its hooks run behind `signIn()` of the wallet port. Square corners, no spinner:
// a busy button changes its label. A failure is a sentence that says what to do, never what the wallet
// or the provider threw.

/** Which button is running: the passkey, or a wallet by its id. */
type Busy = 'passkey' | `wallet:${string}` | null;

/** The chain of each family, as the plan lives on it (one EVM chain while Base is not deployed). */
const CHAIN_OF: Record<'solana' | 'evm', ChainId> = { solana: 'solana', evm: 'robinhood' };

export type SignInProps = {
  /** A way in was pressed: the screen may be about to change under the person. */
  onAttempt?: () => void;
  /** It did not work, and the panel says why. */
  onFailed?: () => void;
  onSignedIn?: () => void;
};

/** The button of a card, at its foot, as wide as the card: the two cards' on one line. */
const BUTTONS = 'mt-auto grid w-full grid-cols-1 gap-3';

export function SignIn({ onAttempt, onFailed, onSignedIn }: SignInProps) {
  const t = useT();
  const port = useWalletPort();
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const passkeyId = useId();
  const walletId = useId();
  const listId = useId();
  const [listing, setListing] = useState(false);
  // The wallet that signs on both families, while the person chooses which.
  const [asking, setAsking] = useState<WalletChoice | null>(null);

  async function run(
    what: Exclude<Busy, null>,
    attempt: SignInAttempt,
    action: () => Promise<void>,
  ) {
    if (busy) return;
    setBusy(what);
    setFailure(null);
    onAttempt?.();
    // The attempt a failure is said for: making a passkey, once using one has turned out to mean that.
    let said = attempt;
    try {
      await action().catch(async (e: unknown) => {
        if (what !== 'passkey' || !makeOneInstead(e)) throw e;
        said = 'passkey-create';
        await port.signIn('passkey', { create: true });
      });
      onSignedIn?.();
    } catch (e) {
      setFailure(signInFailure(e, said));
      onFailed?.();
    } finally {
      setBusy(null);
    }
  }

  /** Signs in with one family of a wallet. */
  const connect = (id: string) =>
    run(`wallet:${id}`, 'wallet', () => port.signIn('wallet', { wallet: id }));

  /** The families of a wallet the server has a chain on for: a family whose chain is off is not offered. */
  const families = (choice: WalletChoice) =>
    (['solana', 'evm'] as const).filter(
      (family) => choice.ids[family] && port.network(CHAIN_OF[family])?.on !== false,
    );

  /** A wallet pressed in the list: its one family, or the question of which. */
  const choose = (choice: WalletChoice) => {
    const open = families(choice);
    if (open.length > 1) {
      setAsking(choice);
      return;
    }
    const id = open[0] ? choice.ids[open[0]] : undefined;
    if (id) void connect(id);
  };

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
  const body = 'flex flex-1 flex-col gap-4';
  // What a screen reader hears after MOCK, in the language of the view.
  const mockLabels = { announce: t.shell.mockAnnounce };
  const choices = walletChoices(port.found);
  const chainName = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];
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
            <div data-ui="sign-in-buttons" className={BUTTONS}>
              <Button
                variant="primary"
                busy={busy === 'passkey'}
                busyLabel={t.signIn.passkey.waiting}
                disabled={resting('passkey')}
                onClick={() => run('passkey', 'passkey-use', () => port.signIn('passkey'))}
                className="w-full"
              >
                {t.signIn.passkey.continue}
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
            {listing &&
              (choices.length === 0 ? (
                <p id={listId} data-ui="wallet-none" className="text-body-sm text-muted-foreground">
                  {t.signIn.wallet.none}
                </p>
              ) : asking ? (
                // biome-ignore lint/a11y/useSemanticElements: two buttons are the group; a fieldset is for form controls
                <div
                  id={listId}
                  role="group"
                  aria-label={t.signIn.wallet.chains}
                  data-ui="wallet-chains"
                  className="flex flex-col gap-3"
                >
                  <p className="text-body-sm">{t.signIn.wallet.both(asking.name)}</p>
                  <div className="grid w-full grid-cols-1 gap-3 min-[480px]:grid-cols-2">
                    {families(asking).map((family) => {
                      const id = asking.ids[family] as string;
                      return (
                        <Button
                          key={family}
                          busy={busy === `wallet:${id}`}
                          busyLabel={t.signIn.wallet.waiting}
                          disabled={resting(`wallet:${id}`)}
                          onClick={() => void connect(id)}
                          className="w-full"
                        >
                          {chainName(CHAIN_OF[family])}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <ul
                  id={listId}
                  aria-label={t.signIn.wallet.found}
                  data-ui="wallet-list"
                  className="flex flex-col gap-2"
                >
                  {choices.map((choice) => {
                    const only = families(choice);
                    const id = only.length === 1 && only[0] ? choice.ids[only[0]] : undefined;
                    return (
                      <li key={choice.key}>
                        <Button
                          busy={id !== undefined && busy === `wallet:${id}`}
                          busyLabel={t.signIn.wallet.waiting}
                          disabled={only.length === 0 || (busy !== null && busy !== `wallet:${id}`)}
                          onClick={() => choose(choice)}
                          className="w-full justify-start gap-3"
                        >
                          <WalletIcon icon={choice.icon} />
                          {choice.name}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ))}
            <div data-ui="sign-in-buttons" className={BUTTONS}>
              <Button
                aria-expanded={listing}
                aria-controls={listing ? listId : undefined}
                disabled={busy !== null}
                onClick={() => {
                  setListing((open) => !open);
                  setAsking(null);
                }}
                className="w-full"
              >
                {t.signIn.wallet.connect}
              </Button>
            </div>
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

/** A wallet's own icon, square, beside its name; a plain square where it gave none. */
function WalletIcon({ icon }: { icon?: string }) {
  return icon ? (
    // biome-ignore lint/performance/noImgElement: a wallet's icon is a data: URL it hands the page, not a file to optimise
    <img src={icon} alt="" width={20} height={20} className="size-5 shrink-0" />
  ) : (
    <span aria-hidden="true" className="size-5 shrink-0 border border-input" />
  );
}

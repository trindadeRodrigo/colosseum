'use client';
import type { ChainId } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { LatticeStatus } from '../../components/ui/Lattice';
import { LatticeLoader } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { useWaitPhase } from '../../components/ui/wait';
import { useT } from '../../i18n/I18nProvider';
import {
  isCalm,
  keepPasskeySeen,
  passkeySeenHere,
  passkeysUsable,
  type SignInAttempt,
  type SignInFailure,
  signInFailure,
  twinMark,
  type WalletChoice,
  walletChoices,
  withoutPrompt,
} from './sign-in-view';
import { useWalletPort } from './WalletProvider';

// The ways in, on the primitives (GATES, SIGN-IN, SIGN-IN-FLOW, SIGN-IN-PAIR): a passkey or a wallet.
//
// The passkey side opens with a pair of equal standing (Thom, Oct 9): "Create a passkey" for someone
// new and "Use my passkey" for someone who has one, a short line under each. What a new passkey is (a
// new account with a new, empty wallet, not a way into one the person has) is the line under the button
// that makes one, there before it is pressed. Neither is made or used by the other: each is its own
// press, so the browser has a gesture for it. The one this browser can vouch for leads: once a passkey
// has signed in here, "Use my passkey" is the primary; until then nothing is known and they are equals.
//
// A prompt that the person closed, or that found no passkey, is no failure: it is said calmly, as a
// note about finding the passkey they have, and never about making one (that is the button above,
// with its warning). Red is kept for what went wrong, a refusal with no prompt behind it included.
// Where passkeys cannot be used at all the pair is off, with the reason said once.
//
// The wallet side is the list of the wallets found in this browser, one entry per wallet with its own
// name and icon and, under the name, where a plan made with it lives; under it a quiet disclosure
// says what to do about a wallet that is not listed (it connects nothing, and is not drawn as one). A wallet that signs on both families asks first which chain
// the plan lives on, since that is the family it signs in with. Nothing of the wallet provider's is
// drawn: its hooks run behind `signIn()` of the wallet port. No spinner: a busy button changes its
// label, and a wait over 400ms shows the loader with its words. A failure is a sentence that says what
// to do, never what the wallet or the provider threw.

/** Which button is running: the passkey, a new passkey asked for, or a wallet by its id. */
type Busy = 'passkey' | 'create' | `wallet:${string}` | null;

/** The chain of each family, as the plan lives on it (one EVM chain while Base is not deployed). */
const CHAIN_OF: Record<'solana' | 'evm', ChainId> = { solana: 'solana', evm: 'robinhood' };

export type SignInProps = {
  /** A way in was pressed: the screen may be about to change under the person. */
  onAttempt?: () => void;
  /** It did not work, and the panel says why. */
  onFailed?: () => void;
  onSignedIn?: () => void;
  /**
   * What stands in place of "Loading sign-in…" once the sign-in service has taken too long to load:
   * the sentence that says so, with the way to try again (features/account/SignInSilent.tsx).
   */
  silent?: ReactNode;
};

/** A choice and the line under it. */
const CHOICE = 'flex flex-col gap-1.5';
const NOTE = 'text-body-sm text-muted-foreground';
/** A wallet's row: its icon, its name, and under the name where a plan made with it lives. */
const ROW = 'h-auto min-h-12 w-full justify-start py-2 text-left';

type Said = { failure: SignInFailure; side: 'passkey' | 'wallet'; calm: boolean };

export function SignIn({ onAttempt, onFailed, onSignedIn, silent }: SignInProps) {
  const t = useT();
  const port = useWalletPort();
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<Said | null>(null);
  const passkeyId = useId();
  const walletId = useId();
  const createNoteId = useId();
  const continueNoteId = useId();
  // A passkey has signed in on this browser before: the one thing known about this device.
  const [seen] = useState(passkeySeenHere);
  // Whether this browser, in this frame, can use passkeys at all.
  const [usable] = useState(() => passkeysUsable());
  // The wallet that signs on both families, while the person chooses which.
  const [asking, setAsking] = useState<WalletChoice | null>(null);
  // The question takes the place of the wallet that was pressed: focus goes to it, not to the page.
  const chains = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asking) chains.current?.focus();
  }, [asking]);
  // The panel is gone (the dialog was closed with a prompt open): a refusal the prompt answers later
  // is not drawn and is told to nobody.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  // A wait over 400ms shows the loader with its words, beside the button whose label changed.
  const waited = useWaitPhase(busy !== null) !== 'quiet';

  async function run(
    what: Exclude<Busy, null>,
    attempt: SignInAttempt,
    action: () => Promise<void>,
  ) {
    if (busy) return;
    setBusy(what);
    setSaid(null);
    onAttempt?.();
    const opened = Date.now();
    try {
      await action();
      if (attempt !== 'wallet') keepPasskeySeen();
      // Told even when this panel is gone: signing in is what takes it away.
      onSignedIn?.();
    } catch (e) {
      if (!here.current) return;
      const failure = signInFailure(e, attempt);
      // Calm only for a prompt a person had time to close; a refusal with none behind it is said
      // as what it is, not as "the prompt was closed".
      const calm = isCalm(failure, { usable, openMs: Date.now() - opened });
      setSaid({
        failure: attempt === 'wallet' || calm ? failure : withoutPrompt(failure),
        side: attempt === 'wallet' ? 'wallet' : 'passkey',
        calm,
      });
      onFailed?.();
    } finally {
      if (here.current) setBusy(null);
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
      <div data-ui="sign-in" data-state={silent ? 'silent' : 'loading'}>
        {silent ?? <LatticeStatus label={t.signIn.loading} />}
      </div>
    );

  const resting = (what: Exclude<Busy, null>) => busy !== null && busy !== what;
  // The two cards are as tall as each other. The mock card of the throwaway wallet keeps its band and
  // body in a row: its body column is the one that stretches.
  const column = port.test
    ? '[&>div]:flex [&>div]:flex-col [&>div>[data-ui=mock-plate]]:self-end'
    : 'flex flex-col';
  const body = 'flex flex-1 flex-col gap-4';
  // What a screen reader hears after MOCK, in the language of the view.
  const mockLabels = { announce: t.shell.mockAnnounce };
  const choices = walletChoices(port.found);
  const chainName = (chain: ChainId) => port.network(chain)?.name ?? t.chain.names[chain];
  /** Where a plan made with a wallet lives, from the families it signs on that are on here. */
  const lives = (open: readonly ('solana' | 'evm')[]) =>
    open.length > 1
      ? t.signIn.wallet.livesEither(chainName(CHAIN_OF.solana), chainName(CHAIN_OF.evm))
      : open[0]
        ? t.signIn.wallet.lives(chainName(CHAIN_OF[open[0]]))
        : null;
  const passkeyBusy = busy === 'passkey' || busy === 'create';
  /** What went wrong on a side, as an alert. A closed prompt is not one: it is the note below. */
  const outcome = (side: Said['side']) =>
    said?.side === side &&
    !said.calm && (
      <p
        role="alert"
        data-ui="sign-in-failure"
        className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
      >
        <StatusMark status="off-track" size={12} className="mt-1.5" />
        <span>{t.signIn.failure[said.failure]}</span>
      </p>
    );
  /** The loader and its words, once the wait of this side is over 400ms. */
  const waiting = (on: boolean, label: string) =>
    on &&
    waited && (
      <p
        role="status"
        data-ui="sign-in-waiting"
        className="flex items-center gap-3 text-body-sm text-muted-foreground"
      >
        <LatticeLoader />
        <span>{label}</span>
      </p>
    );
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
            {/* The pair: someone new first, then someone who has one. Equal, unless this browser has
                seen a passkey sign in: then the one who has it leads. */}
            <div
              data-ui="passkey-pair"
              data-leads={seen ? 'continue' : 'neither'}
              className="flex flex-col gap-4"
            >
              <div className={CHOICE}>
                <Button
                  data-act="passkey-create"
                  aria-describedby={createNoteId}
                  busy={busy === 'create'}
                  busyLabel={t.signIn.passkey.waiting}
                  disabled={!usable || resting('create')}
                  onClick={() =>
                    run('create', 'passkey-create', () => port.signIn('passkey', { create: true }))
                  }
                  className="w-full"
                >
                  {t.signIn.passkey.create}
                </Button>
                {/* Said before one is made by mistake: a new passkey is a new, empty wallet. */}
                <p id={createNoteId} data-ui="passkey-create-note" className={NOTE}>
                  {t.signIn.passkey.createNote}
                </p>
              </div>
              <div className={CHOICE}>
                <Button
                  data-act="passkey-continue"
                  variant={seen && usable ? 'primary' : 'secondary'}
                  aria-describedby={continueNoteId}
                  busy={busy === 'passkey'}
                  busyLabel={t.signIn.passkey.waiting}
                  disabled={!usable || resting('passkey')}
                  onClick={() => run('passkey', 'passkey-use', () => port.signIn('passkey'))}
                  className="w-full"
                >
                  {t.signIn.passkey.continue}
                </Button>
                <p id={continueNoteId} className={NOTE}>
                  {t.signIn.passkey.continueNote}
                </p>
              </div>
            </div>
            {/* Passkeys cannot be used here: the two buttons are off, and why is said once. */}
            {!usable && (
              <p data-ui="passkey-unavailable" className="text-body-sm text-foreground">
                {t.signIn.passkey.unavailable}
              </p>
            )}
            {waiting(passkeyBusy, t.signIn.passkey.waiting)}
            {/* The calm note of a closed prompt. The region is on the page from the start, empty,
                and filled when there is something to say: a screen reader hears a region change,
                where it may pass over one that arrives already filled. */}
            <p
              role="status"
              data-ui="sign-in-note"
              className="max-w-(--tf-measure-body) text-body-sm text-foreground empty:absolute"
            >
              {said?.side === 'passkey' && said.calm ? t.signIn.failure[said.failure] : null}
            </p>
            {outcome('passkey')}
            <details data-ui="passkey-what" className="mt-auto text-body-sm">
              <summary className="cursor-pointer rounded-sm text-foreground underline decoration-1 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {t.signIn.passkey.what}
              </summary>
              <p className="mt-2 max-w-(--tf-measure-body) text-muted-foreground">
                {t.signIn.passkey.body}
              </p>
            </details>
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
            {asking ? (
              // biome-ignore lint/a11y/useSemanticElements: two buttons are the group; a fieldset is for form controls
              <div
                ref={chains}
                role="group"
                tabIndex={-1}
                aria-label={t.signIn.wallet.chains}
                data-ui="wallet-chains"
                className="flex flex-col gap-3 outline-none"
              >
                <p className="text-body-sm">
                  {t.signIn.wallet.both(asking.name)} {t.signIn.wallet.before}
                </p>
                <div className="grid w-full grid-cols-1 gap-3">
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
                <Button
                  variant="link"
                  data-act="wallet-back"
                  disabled={busy !== null}
                  onClick={() => setAsking(null)}
                  className="self-start text-body-sm"
                >
                  {t.signIn.wallet.back}
                </Button>
              </div>
            ) : (
              <>
                {choices.length === 0 && (
                  <p data-ui="wallet-none" className={NOTE}>
                    {t.signIn.wallet.none}
                  </p>
                )}
                <ul
                  aria-label={t.signIn.wallet.found}
                  data-ui="wallet-list"
                  className="flex flex-col gap-2"
                >
                  {choices.map((choice) => {
                    const open = families(choice);
                    const id = open.length === 1 && open[0] ? choice.ids[open[0]] : undefined;
                    // Every chain it signs on is switched off on our server: it is shown, with why.
                    const off = open.length === 0;
                    const twin = twinMark(choice, choices);
                    return (
                      <li key={choice.key} className="flex flex-col gap-1">
                        <Button
                          data-wallet={choice.key}
                          busy={id !== undefined && busy === `wallet:${id}`}
                          busyLabel={t.signIn.wallet.waiting}
                          disabled={off || (busy !== null && busy !== `wallet:${id}`)}
                          onClick={() => choose(choice)}
                          className={ROW}
                        >
                          <span className="inline-flex items-center gap-3">
                            <WalletIcon icon={choice.icon} />
                            <span className="flex flex-col">
                              <span>
                                <span data-ui="wallet-name">{choice.name}</span>
                                {twin && (
                                  <span
                                    data-ui="wallet-twin"
                                    className="ml-2 font-mono text-source font-normal text-muted-foreground"
                                  >
                                    {twin}
                                  </span>
                                )}
                              </span>
                              {!off && (
                                <span
                                  data-ui="wallet-lives"
                                  className="text-caption font-normal text-muted-foreground"
                                >
                                  {lives(open)}
                                </span>
                              )}
                            </span>
                          </span>
                        </Button>
                        {off && (
                          <p data-ui="wallet-off" className="text-caption text-muted-foreground">
                            {t.signIn.wallet.off(choice.name)}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* A wallet that is not listed: what to do about it, as words. Not a wallet's row:
                    it connects nothing. */}
                <details data-ui="wallet-other" className="text-body-sm">
                  <summary className="cursor-pointer rounded-sm text-foreground underline decoration-1 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {t.signIn.wallet.other}
                  </summary>
                  <p
                    data-ui="wallet-other-body"
                    className="mt-2 max-w-(--tf-measure-body) text-muted-foreground"
                  >
                    {t.signIn.wallet.otherBody}
                  </p>
                </details>
              </>
            )}
            {waiting(busy?.startsWith('wallet:') === true, t.signIn.wallet.waiting)}
            {outcome('wallet')}
          </CardBody>
        </Card>
      </div>
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

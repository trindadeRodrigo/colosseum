'use client';
import type { BasketSheet, SharedFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Composer } from '../../components/ui/Composer';
import { cn } from '../../components/ui/cn';
import { GoalCard } from '../../components/ui/GoalCard';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { rememberChoice, rememberPlan } from '../order/plan-store';
import { readShelf } from '../shared/shared-api';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type BuildOutcome, buildPlan, planProvenance } from './build-plan';
import { GOAL_DRAFT, GOAL_HANDOFF } from './draft';
import { IntakeCard } from './IntakeCard';
import {
  type IntakeAnswers,
  type IntakeOutcome,
  type IntakeReading,
  type IntakeRequest,
  readIntake,
} from './intake';
import { GOAL_TEXT } from './read-goal';
import { dollars } from './sheet';

// The goal screen (gate GUIDED-INTAKE): the person says what their money needs to do; I read it,
// ask what it leaves open, and say back what I understood; the person answers, in the form or in their
// own words, until nothing is left to ask, and only on their confirm is a plan built, from the sheet the
// server said back. The goal comes first: there is no shelf here and no figure. Until the API has the
// routes that read a goal and build a plan, the screen says so and shows nothing in their place.

/** Where the reading sits in the page: "Edit limits" leads here. */
const LIMITS = 'limits';
const STORE = GOAL_DRAFT;
const SIGN_IN = '/sign-in?next=/goal';

type Build =
  | { kind: 'idle' }
  | { kind: 'solving' }
  | Exclude<BuildOutcome, { kind: 'built' }>
  /** The candidates, kept in the tab under `key`, which the plan screen opens on. */
  | (Extract<BuildOutcome, { kind: 'built' }> & { key: string });

/** What was sent to the intake: the goal's text, the person's later words, and their answers. */
type Turn = Omit<IntakeRequest, 'language'>;
type Failure = Exclude<IntakeOutcome, { kind: 'read' }>['kind'];

/** What a tab kept, if it still reads: the text in the box and the last turn sent. */
function restoreTurn(raw: string | null): { text: string; turn: Turn | null } | null {
  try {
    const v = JSON.parse(raw ?? 'null') as { text?: unknown; turn?: Partial<Turn> | null } | null;
    if (!v || typeof v.text !== 'string' || v.text.length > GOAL_TEXT.max) return null;
    const t = v.turn;
    const turn =
      t &&
      typeof t.text === 'string' &&
      Array.isArray(t.followUps) &&
      t.followUps.every((f) => typeof f === 'string') &&
      typeof t.answers === 'object' &&
      t.answers !== null
        ? { text: t.text, followUps: t.followUps, answers: t.answers as IntakeAnswers }
        : null;
    return { text: v.text, turn };
  } catch {
    return null;
  }
}

export function GoalScreen() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account, retry } = useAccount();
  const [text, setText] = useState('');
  const [turn, setTurn] = useState<Turn | null>(null);
  const [reading, setReading] = useState<IntakeReading | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [shelf, setShelf] = useState<SharedFamily[]>([]);
  const [build, setBuild] = useState<Build>({ kind: 'idle' });
  const composer = useRef<HTMLDivElement>(null);
  const outcomeId = useId();
  const hintId = useId();
  // Which request for a plan is still wanted. An answer is shown only for the reading it was asked
  // for: when the goal is read again, or the person changes, the number moves on and an answer on its
  // way is dropped. The same for a reading: only the last turn sent is shown.
  const wanted = useRef(0);
  const asking = useRef(0);
  const solving = build.kind === 'solving';
  const signedIn = port.status === 'ready' && port.userId !== null;

  // What was typed and sent is kept in the tab, so signing in and coming back loses nothing. It is
  // read back once, and only after that is anything written.
  const [restored, setRestored] = useState(false);
  const asked = useRef(false);
  /** A turn to send as soon as someone is signed in: kept from before, or a goal handed over. */
  const pending = useRef<Turn | null>(null);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    try {
      const stored = restoreTurn(window.sessionStorage.getItem(STORE));
      if (stored) {
        setText(stored.text);
        setTurn(stored.turn);
        pending.current = stored.turn;
      }
      // A goal handed over by the landing page (in the tab), or by a partner's embed, whose frame
      // shares no storage with this tab: in the fragment of the address, which no server sees. The
      // fragment is taken out of the address once read. Any site can link here with a goal of its
      // own: it is only text in the box, read for the person once they are signed in, and nothing is
      // built or signed until they confirm.
      const fragment = /^#goal=(.*)$/.exec(window.location.hash)?.[1];
      let typed = window.sessionStorage.getItem(GOAL_HANDOFF);
      window.sessionStorage.removeItem(GOAL_HANDOFF);
      if (fragment !== undefined) {
        try {
          typed = decodeURIComponent(fragment);
        } catch {
          typed = null;
        }
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      if (typed !== null && typed.trim() !== '' && typed.length <= GOAL_TEXT.max) {
        setText(typed.trim());
        setTurn(null);
        pending.current = { text: typed.trim(), followUps: [], answers: {} };
      }
    } catch {
      // No storage in this browser: the screen works without it.
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(STORE, JSON.stringify({ text, turn }));
    } catch {
      // As above.
    }
  }, [restored, text, turn]);

  const chain = account.status === 'ready' ? account.chain : null;

  // A plan is one person's, on their chain: an answer for someone else, or for another chain, is not
  // shown to whoever is here now. While the chain is being read again it is not known to have
  // changed, so nothing is forgotten until it is read.
  const who = port.userId ?? '';
  const where = account.status === 'loading' ? null : (chain ?? '');
  const whose = useRef({ who, where: where ?? '' });
  useEffect(() => {
    const last = whose.current;
    if (last.who === who && (where === null || last.where === where)) return;
    whose.current = { who, where: where ?? last.where };
    wanted.current += 1;
    setBuild({ kind: 'idle' });
    // The goal on the page was the person's who was here: when they sign out, or another person
    // signs in, it goes with them. Someone who was signed out and signs in keeps what they typed.
    if (last.who !== '' && last.who !== who) {
      asking.current += 1;
      setText('');
      setTurn(null);
      setReading(null);
      setFailure(null);
      pending.current = null;
    }
  }, [who, where]);

  /** Sends a turn to the intake. Signed out, nothing is sent: the person is asked to sign in. */
  async function send(next: Turn) {
    wanted.current += 1;
    setBuild({ kind: 'idle' });
    setFailure(null);
    // What the reader does not take is said at once, signed in or not.
    const words = [next.text, ...next.followUps].map((w) => w.trim());
    if (next.text.trim().length < GOAL_TEXT.min || words.some((w) => w === ''))
      return setFailure('too_short');
    if (words.some((w) => w.length > GOAL_TEXT.max)) return setFailure('too_long');
    if (!signedIn) {
      pending.current = next;
      setFailure('signed-out');
      return;
    }
    asking.current += 1;
    const mine = asking.current;
    setSending(true);
    const outcome = await readIntake(apiFetch, { ...next, language: lang });
    if (asking.current !== mine) return;
    setSending(false);
    if (outcome.kind !== 'read') return setFailure(outcome.kind);
    setTurn(next);
    setReading(outcome.reading);
  }

  // A turn kept from before, or a goal handed over, is sent once someone is signed in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sent once, when the screen has opened and someone is signed in; `send` is this render's
  useEffect(() => {
    if (!restored || !signedIn || pending.current === null) return;
    const next = pending.current;
    pending.current = null;
    void send(next);
  }, [restored, signedIn]);

  // A question about themes is answered from the shared portfolios on the person's chain.
  const themesAsked = reading?.questions.some((q) => q.field === 'themes') ?? false;
  useEffect(() => {
    if (!themesAsked || !chain) return;
    let mine = true;
    void readShelf(apiFetch, chain).then((read) => {
      if (mine && read.kind === 'read') setShelf(read.value.families);
    });
    return () => {
      mine = false;
    };
  }, [themesAsked, chain, apiFetch]);

  /** The box: the goal, the first time; after that the person's own words, added to it. */
  function submit(typed: string) {
    if (turn === null) return void send({ text: typed, followUps: [], answers: {} });
    void send({ ...turn, followUps: [...turn.followUps, typed] }).then(() => setText(''));
  }

  /** Only the sheet the server said back gets here: confirmed, it is sent as it came. */
  async function buildFrom(valid: BasketSheet) {
    wanted.current += 1;
    const mine = wanted.current;
    setBuild({ kind: 'solving' });
    const outcome = await buildPlan(apiFetch, valid);
    if (wanted.current !== mine) return;
    // The plan screen reads the plans from the tab: the API has no route that reads one back. Each
    // candidate is kept under its own id, which a buy names, and the choice of them under a key.
    if (outcome.kind === 'built') {
      const key = crypto.randomUUID();
      if (port.userId) {
        for (const c of outcome.candidates)
          rememberPlan({
            id: c.id,
            userId: port.userId,
            proposal: c.proposal,
            rollUp: c.rollUp,
            candidate: {
              name: c.candidate,
              scorecard: c.scorecard,
              ...(c.status ? { status: c.status } : {}),
            },
          });
        rememberChoice({
          key,
          userId: port.userId,
          ids: outcome.candidates.map((c) => c.id),
          notShown: outcome.notShown,
        });
      }
      setBuild({ ...outcome, key });
    } else setBuild(outcome);
    // The server has no chain for this person, whatever this page had read: it is asked again.
    if (outcome.kind === 'no-chain') retry();
  }

  function fillWith(example: string) {
    setText(example);
    // The chip fills the box and hands it over: the person reads it, changes it, and sends it.
    composer.current?.querySelector('textarea')?.focus();
  }

  const network = chain ? port.network(chain) : null;
  const chainName = chain ? (network?.name ?? t.chain.names[chain]) : '';
  // Our server has the person's chain switched off: nothing can be built there for now.
  const chainOff = network?.on === false;
  const link = buttonClass({ variant: 'link' });
  // Why the API did not say which chain: it did not answer, it no longer knows this sign-in, it was
  // sent no identity token, or it asked for fewer requests. Each is a different thing for the person
  // to do.
  const unknownWhy =
    account.status !== 'unknown' || account.why === 'unreachable'
      ? t.chain.unknown.body
      : account.why === 'signed_out'
        ? t.chain.unknown.signedOut
        : account.why === 'no_identity'
          ? t.chain.unknown.noIdentity
          : t.shell.slowDown;

  // What stands between the confirmed sheet and a plan: who is asking, and on which chain.
  const blocked = [
    ...(account.status === 'signed-out' ? [t.goal.blocked.signedOut] : []),
    ...(account.status === 'needs-chain' ? [t.goal.blocked.chainNotChosen] : []),
    ...(account.status === 'no-wallet' ? [t.chain.noWallet] : []),
    ...(account.status === 'unknown'
      ? [account.why === 'unreachable' ? t.goal.blocked.chainUnknown : unknownWhy]
      : []),
    ...(chainOff ? [t.goal.blocked.chainOff(chainName)] : []),
    ...(build.kind === 'signed-out' ? [t.goal.blocked.signInAgain] : []),
    ...(build.kind === 'no-identity' ? [t.goal.blocked.noIdentity] : []),
    // Said once: the account says the same when it has read that no chain is chosen.
    ...(build.kind === 'no-chain' && account.status !== 'needs-chain'
      ? [t.goal.blocked.chainNotChosen]
      : []),
    ...(build.kind === 'refused' ? [t.goal.blocked.refused] : []),
  ];

  const f = t.goal.intake.failure;
  const readSentence =
    failure === null
      ? undefined
      : failure === 'busy'
        ? t.shell.slowDown
        : failure === 'too_short'
          ? t.goal.readFailure.tooShort
          : failure === 'too_long'
            ? t.goal.readFailure.tooLong
            : failure === 'signed-out'
              ? f.signedOut
              : failure === 'no-identity'
                ? t.goal.blocked.noIdentity
                : failure === 'refused'
                  ? f.refused
                  : failure === 'unavailable'
                    ? f.unavailable
                    : t.goal.readFailure[failure];
  const buildSentence =
    build.kind === 'busy'
      ? t.shell.slowDown
      : build.kind === 'unreachable' || build.kind === 'unreadable'
        ? t.goal.built[build.kind]
        : build.kind === 'no-plan'
          ? t.goal.sheet.noPlan
          : null;

  // A built plan is named by its own chain and labelled by its own figures, not by this page's.
  // The candidates share the goal's limits and chain; any of them not live makes the card say so.
  const plans = build.kind === 'built' ? build.candidates.map((c) => c.proposal) : [];
  const plan = plans[0] ?? null;
  const labels = plans.map(planProvenance);
  const planLabel = labels.includes('mock')
    ? 'mock'
    : labels.includes('sandbox')
      ? 'sandbox'
      : 'live';
  const planChain = plan?.sheet.chains[0];
  const planChainName = planChain
    ? (port.network(planChain)?.name ?? t.chain.names[planChain])
    : chainName;

  const sheet = reading?.sheet ?? null;
  const sentence = sheet
    ? sheet.horizonOpen
      ? t.goal.card.sentenceOpen[sheet.goal](dollars(sheet.amountUsd, lang))
      : t.goal.card.sentence[sheet.goal](
          dollars(sheet.amountUsd, lang),
          t.goal.card.months(sheet.horizonMonths),
        )
    : t.goal.card.unfinished;

  return (
    <div data-ui="goal-screen" className="flex flex-col gap-8">
      {/* Before a goal is read, a wide screen sets the question beside the typing box, as his home
          screen does (hero-3d.html, "Tell us what your money needs to do"); a phone stacks them. */}
      <div
        className={cn(
          'flex flex-col gap-8',
          !reading && 'lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-12',
        )}
      >
        {reading ? (
          // Once the goal is read it is the heading of the page, in the person's terms. A draft: the
          // status of a goal comes from the engine, and there is no plan for it to speak of yet.
          <GoalCard
            variant="header"
            state="draft"
            sentence={sentence}
            note={sheet ? t.goal.card.draftSet : t.goal.card.draftOpen}
            action={{ label: t.goal.card.edit, href: `#${LIMITS}` }}
          />
        ) : (
          <header className="flex flex-col gap-3 lg:col-span-5">
            {/* Beside the box the question is set a step smaller, so it holds two lines, as his is. */}
            <h1 className="max-w-(--tf-measure-display) font-display text-h2 font-normal">
              {t.goal.title}
            </h1>
            <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
              {t.goal.lead}
            </p>
          </header>
        )}

        <div
          ref={composer}
          className={cn(
            'flex max-w-(--tf-measure-docs) flex-col gap-3',
            !reading && 'lg:col-span-7',
          )}
        >
          <Composer
            label={reading ? t.goal.intake.followUp.label : t.goal.composer.label}
            // The question above names the box (composer.md): its label is for a screen reader only.
            labelHidden={!reading}
            value={text}
            onChange={setText}
            onSubmit={submit}
            placeholder={reading ? t.goal.intake.followUp.placeholder : t.goal.composer.placeholder}
            maxLength={GOAL_TEXT.max}
            // The hint is under the chips, in the mono face, as his simulator has it.
            describedBy={hintId}
            busy={sending}
            // While a plan is being built the reading stands as it was confirmed.
            disabled={solving}
            error={readSentence}
            lang={LOCALE[lang]}
            labels={{
              submit: reading ? t.goal.intake.followUp.submit : t.goal.composer.submit,
              busy: t.goal.composer.busy,
            }}
          />
          {!reading && (
            <ul aria-label={t.goal.examples.label} className="flex flex-wrap gap-2">
              {t.goal.examples.list.map((example) => (
                <li key={example}>
                  <Button
                    variant="chip"
                    className="h-auto! min-h-8 py-1"
                    disabled={sending || solving}
                    onClick={() => fillWith(example)}
                  >
                    {example}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p id={hintId} className="font-mono text-source text-muted-foreground">
            {t.goal.composer.hint}
          </p>
          {/* A visitor is told where the plan comes from, as his simulator's last line does. */}
          {!reading && account.status === 'signed-out' && (
            <p className="text-body-sm text-muted-foreground">
              {t.goal.visitor.before}{' '}
              <Link href={SIGN_IN} className={link}>
                {t.goal.visitor.link}
              </Link>{' '}
              {t.goal.visitor.after}
            </p>
          )}
        </div>
      </div>

      {reading && turn && (
        <IntakeCard
          // A new reading starts its form from what it read and what was answered.
          key={JSON.stringify([turn, reading.questions.map((q) => q.field)])}
          id={LIMITS}
          goalText={turn.text}
          followUps={turn.followUps}
          reading={reading}
          answers={turn.answers}
          shelf={shelf}
          sending={sending}
          building={solving}
          blocked={blocked}
          onAnswer={(answers) => void send({ ...turn, answers })}
          onConfirm={() => sheet && void buildFrom(sheet)}
        />
      )}

      <div aria-live="polite" className="flex flex-col gap-4">
        {build.kind === 'unavailable' && (
          <Card as="section" aria-labelledby={outcomeId}>
            <CardHeader title={t.goal.built.unavailable.title} level={2} id={outcomeId} />
            <CardBody>
              <p className="max-w-(--tf-measure-body) text-body">{t.goal.built.unavailable.body}</p>
            </CardBody>
          </Card>
        )}
        {plan && (
          <Card
            as="section"
            aria-labelledby={outcomeId}
            // A plan built on anything that is not live says so, whatever else it says: the plate,
            // and for a test network the words too.
            mock={planLabel !== 'live'}
            mockLabels={{
              announce: t.shell.mockAnnounce,
              note: planLabel === 'sandbox' ? t.shell.testNetwork : undefined,
            }}
          >
            <CardHeader title={t.goal.built.done.title} level={2} id={outcomeId} />
            <CardBody>
              <p className="max-w-(--tf-measure-body) text-body">
                {t.goal.built.done.body(plans.length, planChainName)}
              </p>
              {build.kind === 'built' && (
                <Link
                  href={`/plan/${encodeURIComponent(build.key)}`}
                  className={buttonClass({ variant: 'link' })}
                >
                  {t.goal.built.done.see(plans.length)}
                </Link>
              )}
            </CardBody>
          </Card>
        )}
        {buildSentence && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{buildSentence}</span>
          </p>
        )}
      </div>
    </div>
  );
}

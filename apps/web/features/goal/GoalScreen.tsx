'use client';
import type { BasketSheet, BasketSheetDraft } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { Composer } from '../../components/ui/Composer';
import { ConstraintSheet, type SheetFact } from '../../components/ui/ConstraintSheet';
import { cn } from '../../components/ui/cn';
import { GoalCard } from '../../components/ui/GoalCard';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Skeleton, SkeletonText } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { ChainBadgeMarked } from '../account/ChainName';
import { rememberPlan } from '../order/plan-store';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type BuildOutcome, buildPlan, planProvenance } from './build-plan';
import { GOAL_DRAFT, GOAL_HANDOFF } from './draft';
import { exampleDraft } from './examples';
import { browserCountry, fillFromWords, preRead } from './pre-read';
import { GOAL_TEXT, type ReadFailure, ReadGoalError, readGoal } from './read-goal';
import {
  checkSheet,
  fieldOfId,
  fieldsOfDraft,
  goalSentence,
  notFound,
  type ReadSheet,
  restoreGoal,
  sheetGroups,
} from './sheet';

// The goal screen: the person says what their money needs to do, reads how it was read as limits they
// can change, and only then asks for a plan. The goal comes first: there is no shelf here and no
// figure. Nothing is built from limits the shared schema did not parse, and until the API has the
// route that builds a plan the screen says so and shows nothing in its place.

/** Where the limits sit in the page: "Edit limits" leads here. */
const LIMITS = 'limits';
const STORE = GOAL_DRAFT;
const SIGN_IN = '/sign-in?next=/goal';
/** The fields the reader may answer with a start of its own, by their name in the draft and here. */
const ASSUMABLE = [
  ['goal', 'goal'],
  ['risk', 'risk'],
  ['horizonMonths', 'horizon'],
] as const;

type Build = { kind: 'idle' } | { kind: 'solving' } | BuildOutcome;

export function GoalScreen() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { account, retry } = useAccount();
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [readFailure, setReadFailure] = useState<ReadFailure | null>(null);
  const [sheet, setSheet] = useState<ReadSheet | null>(null);
  const [build, setBuild] = useState<Build>({ kind: 'idle' });
  const builtCard = useRef<HTMLDivElement>(null);
  const outcomeId = useId();
  const hintId = useId();
  // Which request for a plan is still wanted. An answer is shown only for the limits it was asked
  // for: when the limits change, are read again, or the person changes, the number moves on and an
  // answer on its way is dropped.
  const wanted = useRef(0);
  const solving = build.kind === 'solving';

  // What was typed and read is kept in the tab, so signing in and coming back loses nothing. It is
  // read back once, and only after that is anything written.
  const [restored, setRestored] = useState(false);
  const asked = useRef(false);
  /** A goal the landing page handed over, to be read once the screen has opened. */
  const handed = useRef<string | null>(null);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    try {
      const stored = restoreGoal(window.sessionStorage.getItem(STORE));
      if (stored) {
        setText(stored.text);
        setSheet(stored.sheet);
      }
      // A goal handed over by the landing page (in the tab), or by a partner's embed, whose frame
      // shares no storage with this tab: in the fragment of the address, which no server sees. The
      // fragment is taken out of the address once read. Any site can link here with a goal of its
      // own: it is only text in the box, read by the public reader (`POST /goals`), and nothing is
      // built or signed until the person asks.
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
        handed.current = typed.trim();
        setText(handed.current);
      }
    } catch {
      // No storage in this browser: the screen works without it.
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(STORE, JSON.stringify({ text, sheet }));
    } catch {
      // As above.
    }
  }, [restored, text, sheet]);

  const chain = account.status === 'ready' ? account.chain : null;
  const check = sheet ? checkSheet(sheet.fields, chain) : null;
  const fits = check !== null && Object.keys(check.errors).length === 0;

  /** The limits on the page are no longer the ones a plan was asked for. */
  function forget() {
    wanted.current += 1;
    setBuild({ kind: 'idle' });
  }

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
      setText('');
      setSheet(null);
      setReadFailure(null);
    }
  }, [who, where]);

  /**
   * The country a sheet starts with: the one the reading gave, else the one the browser's language
   * names, which the sheet says it took from there (the schema needs one: BasketSheet.country).
   */
  function withCountry(draft: BasketSheetDraft) {
    const guess = draft.country
      ? null
      : browserCountry(navigator.languages ?? [navigator.language]);
    return {
      draft: guess ? { ...draft, country: guess } : draft,
      countryFromBrowser: guess !== null,
    };
  }

  async function read(typed: string) {
    setReading(true);
    setReadFailure(null);
    forget();
    // One of this page's own examples, sent as it is: its limits are known here (examples.ts).
    const known = exampleDraft(typed, t.goal.examples.list, lang);
    if (known) {
      const { draft, countryFromBrowser } = withCountry(known);
      const fields = fieldsOfDraft(draft, lang);
      setSheet({
        goalText: typed.trim(),
        source: {
          method: 'example',
          fetchedAt: new Date().toISOString(),
          provenance: 'live',
        },
        firstReader: false,
        read: fields,
        fields,
        countryFromBrowser,
      });
      setReading(false);
      return;
    }
    // What the words say, read here before the text is sent: they fill what the reader leaves.
    const words = preRead(typed);
    try {
      const reading = await readGoal(apiFetch, typed, lang);
      const filled = fillFromWords(reading.draft, reading.guessed, words);
      const { draft, countryFromBrowser } = withCountry(filled.draft);
      const fields = fieldsOfDraft(draft, lang);
      setSheet({
        goalText: typed,
        source: reading.source,
        firstReader: reading.firstReader,
        read: fields,
        fields,
        countryFromBrowser,
        // What the reader answered with a start of its own, and the words did not say either.
        assumed: ASSUMABLE.filter(
          ([word, key]) => reading.guessed.has(word) && words[word] == null && fields[key] !== '',
        ).map(([, key]) => key),
      });
    } catch (e) {
      // The text stays in the box, and a sheet read before stays as it was.
      setReadFailure(e instanceof ReadGoalError ? e.kind : 'unreachable');
    } finally {
      setReading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when the screen has opened; `read` is this render's
  useEffect(() => {
    if (!restored || handed.current === null) return;
    const typed = handed.current;
    handed.current = null;
    void read(typed);
  }, [restored]);

  function change(fieldId: string, value: string) {
    const key = fieldOfId(fieldId);
    if (!key) return;
    setSheet((now) => (now ? { ...now, fields: { ...now.fields, [key]: value } } : now));
    // The answer to the limits as they were says nothing about the limits as they are.
    forget();
  }

  /** Only a sheet the schema parsed gets here: the sheet's own check, and this function's type. */
  async function buildFrom(valid: BasketSheet) {
    wanted.current += 1;
    const mine = wanted.current;
    setBuild({ kind: 'solving' });
    const outcome = await buildPlan(apiFetch, valid);
    if (wanted.current !== mine) return;
    // The plan screen reads the plan from the tab: the API has no route that reads one back.
    if (outcome.kind === 'built' && port.userId)
      rememberPlan({
        id: outcome.id,
        userId: port.userId,
        proposal: outcome.proposal,
        rollUp: outcome.rollUp,
      });
    setBuild(outcome);
    // The server has no chain for this person, whatever this page had read: it is asked again.
    if (outcome.kind === 'no-chain') retry();
  }

  /** A chip is a goal said in one click: it fills the box and is read at once. */
  function fillWith(example: string) {
    setText(example);
    void read(example);
  }

  // The plan lands below the limits: the page goes to it, and so does the keyboard.
  const builtId = build.kind === 'built' ? build.id : null;
  useEffect(() => {
    if (builtId === null) return;
    builtCard.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    builtCard.current?.focus({ preventScroll: true });
  }, [builtId]);

  const network = chain ? port.network(chain) : null;
  const chainName = chain ? (network?.name ?? t.chain.names[chain]) : '';
  // Our server has the person's chain switched off: nothing can be built there for now.
  const chainOff = network?.on === false;
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure };
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
          : account.why === 'off'
            ? t.chain.unknown.off
            : account.why === 'refused'
              ? t.chain.unknown.refused
              : t.shell.slowDown;
  const chainFact: SheetFact =
    account.status === 'ready'
      ? {
          label: t.goal.chain.label,
          value: (
            <ChainBadgeMarked
              chain={account.chain}
              provenance={network?.provenance ?? 'mock'}
              labels={marks}
            />
          ),
          note: t.goal.chain.note,
        }
      : account.status === 'loading'
        ? { label: t.goal.chain.label, value: t.chain.reading }
        : account.status === 'unknown'
          ? {
              label: t.goal.chain.label,
              value: (
                <span className="inline-flex flex-wrap items-center gap-x-3">
                  <span>{t.goal.chain.unknown}</span>
                  {/* Asking again does not help a sign-in the server no longer knows. */}
                  {account.why !== 'signed_out' && (
                    <Button variant="link" onClick={retry}>
                      {t.chain.unknown.retry}
                    </Button>
                  )}
                </span>
              ),
              note: unknownWhy,
            }
          : {
              label: t.goal.chain.label,
              value: (
                <span className="inline-flex flex-wrap items-center gap-x-3">
                  <span>{t.goal.chain.unset}</span>
                  <Link href={SIGN_IN} className={link}>
                    {account.status === 'signed-out' ? t.shell.signIn : t.goal.chain.choose}
                  </Link>
                </span>
              ),
              note: t.goal.chain.unsetNote,
            };

  // What stands between valid limits and a plan, besides the fields: who is asking, and on which chain.
  const blocked = [
    ...(account.status === 'no-wallet' ? [t.chain.noWallet] : []),
    ...(account.status === 'unknown'
      ? [account.why === 'unreachable' ? t.goal.blocked.chainUnknown : unknownWhy]
      : []),
    ...(chainOff ? [t.goal.blocked.chainOff(chainName)] : []),
    ...(build.kind === 'signed-out' ? [t.goal.blocked.signInAgain] : []),
    ...(build.kind === 'no-identity' ? [t.goal.blocked.noIdentity] : []),
    ...(build.kind === 'no-chain' ? [t.goal.blocked.chainNotChosen] : []),
    ...(build.kind === 'refused' ? [t.goal.blocked.refused] : []),
    ...(build.kind === 'currency' ? [t.goal.blocked.currency] : []),
  ];

  const readSentence =
    readFailure === null
      ? undefined
      : readFailure === 'busy'
        ? t.shell.slowDown
        : readFailure === 'too_short'
          ? t.goal.readFailure.tooShort
          : readFailure === 'too_long'
            ? t.goal.readFailure.tooLong
            : t.goal.readFailure[readFailure];
  const buildSentence =
    build.kind === 'busy'
      ? t.shell.slowDown
      : build.kind === 'unreachable' || build.kind === 'unreadable'
        ? t.goal.built[build.kind]
        : null;

  // A built plan is named by its own chain and labelled by its own figures, not by this page's.
  const plan = build.kind === 'built' ? build.proposal : null;
  // What the reading left empty, named in one line for the person to fill in.
  const missed = sheet ? notFound(sheet.fields, sheet.read).map((key) => t.goal.fields[key]) : [];
  const readerNote =
    missed.length > 0
      ? t.goal.readerMissed(
          new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(missed),
        )
      : null;
  const planLabel = plan ? planProvenance(plan) : 'live';
  const planChain = plan?.sheet.chains[0];
  const planChainName = planChain
    ? (port.network(planChain)?.name ?? t.chain.names[planChain])
    : chainName;

  // The sentences of what does not fit are said in the language of the sheet itself.
  const drawn =
    sheet && check
      ? sheetGroups(
          sheet.fields,
          sheet.read,
          check.errors,
          t,
          dictionary(sheet.fields.language),
          lang,
          sheet.countryFromBrowser,
          sheet.assumed,
        )
      : null;

  return (
    <div data-ui="goal-screen" className="flex flex-col gap-8">
      {/* Before a goal is read, a wide screen sets the question beside the typing box, as his home
          screen does (hero-3d.html, "Tell us what your money needs to do"); a phone stacks them. */}
      <div
        className={cn(
          'flex flex-col gap-8',
          !sheet && 'lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-12',
        )}
      >
        {sheet ? (
          // Once the goal is read it is the heading of the page, in the person's terms. A draft: the
          // status of a goal comes from the engine, and there is no plan for it to speak of yet.
          <GoalCard
            variant="header"
            state="draft"
            sentence={goalSentence(sheet.fields, t, lang) ?? t.goal.card.unfinished}
            note={fits ? t.goal.card.draftSet : t.goal.card.draftOpen}
            action={{ label: t.goal.card.edit, href: `#${LIMITS}` }}
          />
        ) : (
          <header className="flex flex-col gap-3 lg:col-span-5">
            {/* Beside the box the question is set a step smaller, so it holds two lines, as his is. */}
            <h1 className={PAGE_TITLE}>{t.goal.title}</h1>
            <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
              {t.goal.lead}
            </p>
          </header>
        )}

        <div
          className={cn('flex max-w-(--tf-measure-docs) flex-col gap-3', !sheet && 'lg:col-span-7')}
        >
          <Composer
            label={t.goal.composer.label}
            // The question above names the box (composer.md): its label is for a screen reader only.
            labelHidden={!sheet}
            value={text}
            onChange={setText}
            onSubmit={read}
            placeholder={t.goal.composer.placeholder}
            maxLength={GOAL_TEXT.max}
            // The hint is under the chips, in the mono face, as his simulator has it.
            describedBy={hintId}
            busy={reading}
            // While a plan is being built the limits stand as they were sent: no other goal is read.
            disabled={solving}
            error={readSentence}
            lang={LOCALE[lang]}
            labels={{ submit: t.goal.composer.submit, busy: t.goal.composer.busy }}
          />
          <ul aria-label={t.goal.examples.label} className="flex flex-wrap gap-2">
            {t.goal.examples.list.map((example) => (
              <li key={example}>
                <Button
                  variant="chip"
                  className="h-auto! min-h-8 py-1"
                  disabled={reading || solving}
                  onClick={() => fillWith(example)}
                >
                  {example}
                </Button>
              </li>
            ))}
          </ul>
          <p id={hintId} className="font-mono text-source text-muted-foreground">
            {t.goal.composer.hint}
          </p>
          {/* A visitor is told where the plan comes from, as his simulator's last line does. */}
          {!sheet && account.status === 'signed-out' && (
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

      {readerNote && (
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">{readerNote}</p>
      )}

      {sheet && check && drawn ? (
        <ConstraintSheet<BasketSheet>
          id={LIMITS}
          level={2}
          className="scroll-mt-6"
          goalText={sheet.goalText}
          facts={[chainFact]}
          groups={drawn.groups}
          more={{ label: t.goal.sheet.more, groups: drawn.more }}
          // A visitor's next step is to sign in: a button where the build button is, not an error.
          next={
            account.status === 'signed-out'
              ? { label: t.goal.sheet.signInToBuild, href: SIGN_IN }
              : undefined
          }
          capital={drawn.amount}
          state={
            build.kind === 'solving' ? 'solving' : build.kind === 'no-plan' ? 'no-plan' : 'idle'
          }
          valid={check.sheet}
          otherIssues={blocked}
          onChange={change}
          onBuild={buildFrom}
          labels={{ ...t.goal.sheet, mockAnnounce: t.shell.sampleFigure }}
        />
      ) : reading ? (
        <ConstraintSheet<BasketSheet>
          id={LIMITS}
          level={2}
          state="parsing"
          groups={[]}
          valid={null}
          onChange={change}
          onBuild={buildFrom}
          labels={{ ...t.goal.sheet, mockAnnounce: t.shell.sampleFigure }}
        />
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-4">
        {/* While the plan is built: the card it comes in, in its own shape, and the wait in words. The
            hosted API may be waking; after a minute the wait gives up and asks to build again. */}
        {solving && (
          <Card as="section" aria-label={t.goal.sheet.building}>
            <CardWait
              label={t.goal.sheet.building}
              skeleton={
                <span aria-hidden="true" className="flex flex-col gap-3">
                  <Skeleton className="h-6 w-1/2" />
                  <SkeletonText lines={2} />
                  <Skeleton className="h-4 w-32" />
                </span>
              }
              onRetry={forget}
            />
          </Card>
        )}
        {build.kind === 'unavailable' && (
          <Card as="section" aria-labelledby={outcomeId}>
            <CardHeader title={t.goal.built.unavailable.title} level={2} id={outcomeId} />
            <CardBody>
              <p className="max-w-(--tf-measure-body) text-body">{t.goal.built.unavailable.body}</p>
            </CardBody>
          </Card>
        )}
        {plan && (
          <div
            ref={builtCard}
            tabIndex={-1}
            data-ui="built-plan"
            className="scroll-mt-6 outline-none"
          >
            <Card
              as="section"
              aria-labelledby={outcomeId}
              // A plan built on anything that is not live says so, whatever else it says: the plate,
              // and for a test network the words too.
              mock={planLabel !== 'live'}
              mockLabels={{
                announce: planLabel === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
              }}
            >
              <CardHeader
                title={t.goal.built.done.title}
                level={2}
                id={outcomeId}
                meta={planChain ? <ChainBadge chain={planChain} /> : undefined}
              />
              <CardBody>
                <p className="max-w-(--tf-measure-body) text-body">
                  {t.goal.built.done.body(plan.lines.length, planChainName)}
                </p>
                {build.kind === 'built' && (
                  <Link
                    href={`/plan/${encodeURIComponent(build.id)}`}
                    className={buttonClass({ variant: 'link' })}
                  >
                    {t.goal.built.done.see}
                  </Link>
                )}
              </CardBody>
            </Card>
          </div>
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

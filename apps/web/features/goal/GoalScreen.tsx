'use client';
import type { BasketSheet } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Composer } from '../../components/ui/Composer';
import { ConstraintSheet, type SheetFact } from '../../components/ui/ConstraintSheet';
import { GoalCard } from '../../components/ui/GoalCard';
import { StatusMark } from '../../components/ui/StatusMark';
import { dictionary, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { ChainName } from '../account/ChainName';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { type BuildOutcome, buildPlan } from './build-plan';
import { type ReadFailure, ReadGoalError, readGoal } from './read-goal';
import {
  checkSheet,
  fieldOfId,
  fieldsOfDraft,
  goalSentence,
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
const STORE = 'tf-goal';
const SIGN_IN = '/sign-in?next=/goal';

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
  const composer = useRef<HTMLDivElement>(null);
  const outcomeId = useId();

  // What was typed and read is kept in the tab, so signing in and coming back loses nothing. It is
  // read back once, and only after that is anything written.
  const [restored, setRestored] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    try {
      const stored = restoreGoal(window.sessionStorage.getItem(STORE));
      if (stored) {
        setText(stored.text);
        setSheet(stored.sheet);
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

  async function read(typed: string) {
    setReading(true);
    setReadFailure(null);
    setBuild({ kind: 'idle' });
    try {
      const reading = await readGoal(apiFetch, typed, lang);
      const fields = fieldsOfDraft(reading.draft, lang);
      setSheet({
        goalText: typed,
        source: reading.source,
        firstReader: reading.firstReader,
        read: fields,
        fields,
      });
    } catch (e) {
      // The text stays in the box, and a sheet read before stays as it was.
      setReadFailure(e instanceof ReadGoalError ? e.kind : 'unreachable');
    } finally {
      setReading(false);
    }
  }

  function change(fieldId: string, value: string) {
    const key = fieldOfId(fieldId);
    if (!key) return;
    setSheet((now) => (now ? { ...now, fields: { ...now.fields, [key]: value } } : now));
    // The answer to the limits as they were says nothing about the limits as they are.
    setBuild({ kind: 'idle' });
  }

  /** Only a sheet the schema parsed gets here: the sheet's own check, and this function's type. */
  async function buildFrom(valid: BasketSheet) {
    setBuild({ kind: 'solving' });
    setBuild(await buildPlan(apiFetch, valid));
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
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.mockAnnounce };
  const link = buttonClass({ variant: 'link' });
  // Why the API did not say which chain: it did not answer, it no longer knows this sign-in, or it
  // asked for fewer requests. Each is a different thing for the person to do.
  const unknownWhy =
    account.status !== 'unknown' || account.why === 'unreachable'
      ? t.chain.unknown.body
      : account.why === 'signed_out'
        ? t.chain.unknown.signedOut
        : t.shell.slowDown;
  const chainFact: SheetFact =
    account.status === 'ready'
      ? {
          label: t.goal.chain.label,
          value: (
            <ChainName name={chainName} provenance={network?.provenance ?? 'mock'} labels={marks} />
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
    ...(account.status === 'signed-out' ? [t.goal.blocked.signedOut] : []),
    ...(account.status === 'needs-chain' ? [t.goal.blocked.chainNotChosen] : []),
    ...(account.status === 'no-wallet' ? [t.chain.noWallet] : []),
    ...(account.status === 'unknown'
      ? [account.why === 'unreachable' ? t.goal.blocked.chainUnknown : unknownWhy]
      : []),
    ...(chainOff ? [t.goal.blocked.chainOff(chainName)] : []),
    ...(build.kind === 'refused' ? [t.goal.blocked.refused] : []),
  ];

  const readSentence =
    readFailure === null
      ? undefined
      : readFailure === 'busy'
        ? t.shell.slowDown
        : readFailure === 'too_short'
          ? t.goal.readFailure.tooShort
          : t.goal.readFailure[readFailure];
  const buildSentence =
    build.kind === 'busy'
      ? t.shell.slowDown
      : build.kind === 'unreachable' || build.kind === 'unreadable'
        ? t.goal.built[build.kind]
        : null;

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
        )
      : null;

  return (
    <div data-ui="goal-screen" className="flex flex-col gap-8">
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
        <header className="flex flex-col gap-3">
          <h1 className="max-w-(--tf-measure-display) font-display text-display font-normal">
            {t.goal.title}
          </h1>
          <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{t.goal.lead}</p>
        </header>
      )}

      <div ref={composer} className="flex max-w-(--tf-measure-docs) flex-col gap-3">
        <Composer
          label={t.goal.composer.label}
          value={text}
          onChange={setText}
          onSubmit={read}
          placeholder={t.goal.composer.placeholder}
          hint={t.goal.composer.hint}
          busy={reading}
          error={readSentence}
          lang={LOCALE[lang]}
          labels={{ send: t.goal.composer.send, busy: t.goal.composer.busy }}
        />
        <ul aria-label={t.goal.examples.label} className="flex flex-wrap gap-2">
          {t.goal.examples.list.map((example) => (
            <li key={example}>
              <Button
                variant="chip"
                className="h-auto! min-h-8 py-1"
                disabled={reading}
                onClick={() => fillWith(example)}
              >
                {example}
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {sheet?.firstReader && (
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {t.goal.readerNote}
        </p>
      )}

      {sheet && check && drawn ? (
        <ConstraintSheet<BasketSheet>
          id={LIMITS}
          className="scroll-mt-6"
          goalText={sheet.goalText}
          source={sheet.source}
          facts={[chainFact]}
          groups={drawn.groups}
          capital={drawn.amount}
          state={
            build.kind === 'solving' ? 'solving' : build.kind === 'no-plan' ? 'no-plan' : 'idle'
          }
          valid={chainOff ? null : check.sheet}
          otherIssues={blocked}
          onChange={change}
          onBuild={buildFrom}
          labels={{ ...t.goal.sheet, mockAnnounce: t.shell.mockAnnounce }}
        />
      ) : reading ? (
        <ConstraintSheet<BasketSheet>
          id={LIMITS}
          state="parsing"
          groups={[]}
          valid={null}
          onChange={change}
          onBuild={buildFrom}
          labels={{ ...t.goal.sheet, mockAnnounce: t.shell.mockAnnounce }}
        />
      ) : null}

      <div aria-live="polite" className="flex flex-col gap-4">
        {build.kind === 'unavailable' && (
          <Card as="section" aria-labelledby={outcomeId}>
            <CardHeader title={t.goal.built.unavailable.title} level={2} id={outcomeId} />
            <CardBody>
              <p className="max-w-(--tf-measure-body) text-body">{t.goal.built.unavailable.body}</p>
            </CardBody>
          </Card>
        )}
        {build.kind === 'built' && (
          <Card
            as="section"
            aria-labelledby={outcomeId}
            // A plan built on anything that is not live says so, whatever else it says.
            mock={build.proposal.observations.some((o) => o.provenance !== 'live')}
          >
            <CardHeader title={t.goal.built.done.title} level={2} id={outcomeId} />
            <CardBody>
              <p className="max-w-(--tf-measure-body) text-body">
                {t.goal.built.done.body(build.proposal.lines.length, chainName)}
              </p>
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

'use client';
import type { ChainId, Network, Provenance } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Composer } from '../../components/ui/Composer';
import { WORKSPACE_TITLE } from '../../components/ui/heading';
import { LatticeGlyph } from '../../components/ui/Lattice';
import { dictionary } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { UseGoalMix } from '../mix/UseGoalMix';
import { share } from '../portfolio/figures';
import { VaultAgentError, type VaultAgentReply } from '../vault-conversation/agent';
import { StrategyPreview, WeightNotes } from '../vault-conversation/StrategyPreview';
import {
  conversationNetwork,
  readLocal,
  type Turn,
  transcriptOf,
  writeLocal,
} from '../vault-conversation/storage';
import { useApiFetch } from '../wallet/WalletProvider';
import { goalAgent } from './agent';
import { consumeGoalHandoff, readGoalHandoff } from './handoff';

export const goalConversationKey = (
  userId: string,
  chain: ChainId,
  provenance: Provenance,
  network: Network | null = conversationNetwork(chain),
) =>
  `tf-goal-conversation:2:${encodeURIComponent(userId)}:${chain}:${network ?? 'unconfigured'}:${provenance}`;

/** Plain browser history is never restored as a proposal, confirmation or executable order. */
export function GoalConversation({
  userId,
  chain,
  ready,
  provenance,
}: {
  userId: string | null;
  chain: ChainId | null;
  ready: boolean;
  provenance: Provenance | null;
}) {
  const t = useT();
  const lang = useLang();
  const copy = t.goal.explore;
  const api = useApiFetch();
  const key = userId && chain && provenance ? goalConversationKey(userId, chain, provenance) : null;
  const context = `${key}:${ready}`;
  const current = useRef(context);
  current.current = context;
  const generation = useRef(0);
  const requestApi = useRef(api);
  const cancel = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const held = useRef<Turn[]>([]);
  const prefill = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reply, setReply] = useState<VaultAgentReply | null>(null);
  // The preview the person chose to use: the flow stays only while that preview is the one shown.
  const [using, setUsing] = useState<VaultAgentReply | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    ++generation.current;
    requestApi.current = api;
    current.current = context;
    cancel.current?.abort();
    held.current = key ? readLocal(key).transcript : [];
    setTurns(held.current);
    setReply(null);
    setBusy(false);
    sending.current = false;
    prefill.current = readGoalHandoff(userId, ready);
    setText(prefill.current ?? '');
    setError(undefined);
    setLoaded(true);
    return () => {
      ++generation.current;
      cancel.current?.abort();
    };
  }, [api, key, context, userId, ready]);

  function persist(next: Turn[]) {
    if (!key) return false;
    const saved = writeLocal(key, { revision: 0, transcript: next });
    if (!saved) setError(copy.notSaved);
    return saved;
  }
  function startOver() {
    if (sending.current) return;
    ++generation.current;
    held.current = [];
    setTurns([]);
    setText('');
    setReply(null);
    setError(undefined);
    persist([]);
  }
  async function send(words: string) {
    if (!ready || !chain || !key || !loaded || sending.current) return;
    // Words that got no reply are sent again as the turn they already are, never as a second copy.
    const last = held.current.at(-1);
    const next =
      last?.who === 'person' && last.text === words
        ? held.current
        : [...held.current, { id: crypto.randomUUID(), who: 'person' as const, text: words }];
    if (!transcriptOf({ revision: 0, transcript: next })) {
      setError(copy.capacity);
      return;
    }
    const run = generation.current;
    const expected = context;
    const active = () => generation.current === run && current.current === expected;
    sending.current = true;
    setBusy(true);
    setError(undefined);
    setText('');
    setReply(null);
    held.current = next;
    setTurns(next);
    if (persist(next) && prefill.current && userId) {
      consumeGoalHandoff(prefill.current, userId);
      prefill.current = null;
    }
    const controller = new AbortController();
    cancel.current = controller;
    try {
      const result = await goalAgent(requestApi.current, chain, lang, next, controller.signal);
      if (!active()) return;
      const completed = [
        ...next,
        {
          id: crypto.randomUUID(),
          who: 'app' as const,
          text: [result.message, result.question].filter(Boolean).join('\n\n'),
        },
      ];
      if (result.proposal) {
        let chunk = t.shared.vault.conversation.draftIntro;
        for (const line of [
          result.proposal.objective,
          ...result.proposal.allocations.map(
            (row) =>
              `${row.symbol ?? row.assetId} (${row.assetId}): ${share(lang, row.weightBps)} — ${row.why} [${row.evidenceIds.join(', ')}]`,
          ),
        ]) {
          if (chunk.length + line.length + 1 > 8000) {
            completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
            chunk = t.shared.vault.conversation.draftIntro;
          }
          chunk += `\n${line}`;
        }
        completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
      }
      if (!transcriptOf({ revision: 0, transcript: completed })) {
        setError(copy.capacity);
        return;
      }
      held.current = completed;
      setTurns(completed);
      setReply(result);
      persist(completed);
    } catch (cause) {
      if (active()) {
        // their words go back in the box, unless they have typed something else meanwhile
        setText((now) => (now === '' ? words : now));
        setError(
          cause instanceof VaultAgentError && cause.kind === 'unavailable'
            ? cause.reason === 'timeout'
              ? copy.timeout
              : cause.reason === 'budget'
                ? copy.budget
                : cause.reason === 'invalid'
                  ? copy.invalid
                  : copy.unavailable
            : copy.failed,
        );
      }
    } finally {
      if (active()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  // The person's last words with no reply after them: a failed reply, or one a reload cut short.
  const unanswered = !busy && ready && loaded ? turns.at(-1) : undefined;
  return (
    <section
      data-ui="goal-conversation"
      className="grid min-w-0 gap-4 lg:grid-cols-12 lg:items-start"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 lg:col-span-12">
        <h1 className={WORKSPACE_TITLE}>{t.talk.workbench.title}</h1>
        {turns.length > 0 && (
          <Button variant="link" disabled={busy} onClick={startOver}>
            {t.talk.startOver}
          </Button>
        )}
      </header>
      <div
        ref={box}
        data-ui="goal-chat"
        className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:col-span-5 lg:max-h-[calc(100dvh-8rem)]"
      >
        {turns.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="font-display text-[1.25rem]/7">{copy.invitation}</p>
            <p className="text-body-sm text-muted-foreground">{copy.lead}</p>
          </div>
        )}
        <p className="text-caption text-muted-foreground">{copy.local}</p>
        <ol
          data-ui="goal-transcript"
          aria-live="polite"
          className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto"
        >
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${turn.who === 'person' ? 'border-l-2 border-primary pl-3' : ''}`}
            >
              <span className="sr-only">{turn.who === 'person' ? t.talk.you : t.talk.me}: </span>
              {['en', 'pt'].some(
                (language) =>
                  turn.who === 'app' &&
                  turn.text.startsWith(
                    dictionary(language as 'en' | 'pt').shared.vault.conversation.draftIntro,
                  ),
              ) ? (
                <details data-ui="goal-draft-record">
                  <summary className="cursor-pointer text-body-sm">
                    {t.shared.vault.conversation.proposed}
                  </summary>
                  <p className="pt-2 text-caption">{turn.text}</p>
                </details>
              ) : (
                turn.text
              )}
            </li>
          ))}
        </ol>
        {!ready && (
          <p className="text-body-sm text-muted-foreground">
            {userId ? copy.readingAccount : copy.signIn}
          </p>
        )}
        {!userId && (
          <Link href="/sign-in?next=/goal" className="text-body-sm underline">
            {t.shell.signIn}
          </Link>
        )}
        <Composer
          label={copy.invitation}
          labelHidden
          value={text}
          onChange={setText}
          onSubmit={send}
          maxLength={2000}
          placeholder={copy.placeholder}
          busy={busy}
          disabled={!ready || !loaded}
          error={error}
          lang={lang}
          labels={{
            submit: t.shared.vault.conversation.submitMessage,
            busy: t.shared.vault.conversation.reading,
          }}
        />
        {unanswered?.who === 'person' && (
          <p
            data-ui="goal-retry"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm"
          >
            <Button variant="link" data-act="goal-retry" onClick={() => send(unanswered.text)}>
              {copy.retry}
            </Button>
            <Link href="/shelf" className="underline">
              {copy.elsewhere}
            </Link>
          </p>
        )}
        {loaded && turns.length === 0 && (
          <ul
            data-ui="goal-starters"
            aria-label={t.goal.examples.label}
            className="flex flex-wrap gap-2"
          >
            {copy.starters.map((starter) => (
              <li key={starter}>
                <Button
                  variant="chip"
                  className="h-auto! min-h-8 py-1"
                  disabled={!ready || !key || busy}
                  onClick={() => {
                    setText(starter);
                    box.current?.querySelector('textarea')?.focus();
                  }}
                >
                  {starter}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div data-ui="goal-strategy" className="flex min-w-0 flex-col gap-4 lg:col-span-7">
        {reply?.proposal ? (
          <>
            <StrategyPreview
              proposal={reply.proposal}
              previewOnly={copy.draftNote}
              {...(chain && userId && using !== reply
                ? { use: { label: t.mix.preview.use, onUse: () => setUsing(reply) } }
                : {})}
            />
            {chain && userId && using === reply && (
              <UseGoalMix
                chain={chain}
                userId={userId}
                allocations={reply.proposal.allocations}
                onClose={() => setUsing(null)}
              />
            )}
          </>
        ) : (
          <div
            data-ui="goal-empty-preview"
            className="flex min-w-0 flex-col items-start justify-center gap-3 rounded-md border border-border bg-card p-4 sm:min-h-60"
          >
            <LatticeGlyph size={32} />
            <h2 className="text-body-lg font-medium">{t.talk.workbench.strategy}</h2>
            <p className="max-w-[48ch] text-body-sm text-muted-foreground">{copy.empty}</p>
            <p className="text-caption text-muted-foreground">{copy.previewOnly}</p>
            {reply?.notes && <WeightNotes notes={reply.notes} />}
          </div>
        )}
      </div>
    </section>
  );
}

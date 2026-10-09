'use client';
import type { VaultResponse } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Composer } from '../../components/ui/Composer';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { dictionary } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { VaultMixFlow } from '../mix/VaultMixFlow';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { dollars, share } from '../portfolio/figures';
import { holdingsOf, unpriced, vaultValueSource } from '../portfolio/portfolio';
import { HoldingsBar } from '../shared/HoldingsBar';
import { DraftBuilding, PendingReply, ReplyAnnouncer, useChatScroll } from '../shared/ReplyPending';
import { useApiFetch } from '../wallet/WalletProvider';
import {
  agentReplyOf,
  replyText,
  type VaultAgent,
  VaultAgentError,
  type VaultAgentReply,
  vaultAgent,
} from './agent';
import { StrategyPreview, WeightNotes } from './StrategyPreview';
import {
  conversationKey,
  conversationNetwork,
  plainText,
  readLocal,
  serverConversation,
  type Turn,
  transcriptOf,
  writeLocal,
} from './storage';

/**
 * Owner-only caller keys this component by the complete current identity/context. Laid out (Rodrigo,
 * Oct 8) as the invest page is, the chat on one side and the plan on the other, so the owner comes
 * back to a plan where it was made; `heading` is the page's own header, `aside` what follows the plan.
 */
export function VaultConversation({
  read,
  userId,
  agent,
  showValue = true,
  heading,
  aside,
}: {
  read: VaultResponse;
  userId: string;
  agent?: VaultAgent;
  showValue?: boolean;
  heading?: ReactNode;
  aside?: ReactNode;
}) {
  const t = useT();
  const copy = t.shared.vault.conversation;
  const language = useLang();
  const api = useApiFetch();
  const id = useId();
  const composer = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const network = conversationNetwork(read.chain);
  const key = conversationKey(userId, read.chain, read.vault.address, read.provenance, network);
  const context = `${key}:${read.vault.observedAt}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // The transcript opens at its end, a sent message is kept in view, and a reply lands in place.
  useChatScroll(transcript, composer, busy, `${context}:${loading}`);
  const [storage, setStorage] = useState<'local' | 'server' | 'conflict'>('local');
  const [error, setError] = useState<string>();
  // The reply did not come: said in the transcript, where the reply would have been.
  const [failure, setFailure] = useState<string>();
  // What a screen reader hears, once each: that a reply is being fetched, then the reply.
  const [announced, setAnnounced] = useState('');
  const [reply, setReply] = useState<VaultAgentReply | null>(null);
  // The preview the person chose to apply: its editor stays only while that preview is the one shown.
  const [applying, setApplying] = useState<VaultAgentReply | null>(null);
  // The chat folds away so the plan can take the whole width, as on the invest page.
  const [chatOpen, setChatOpen] = useState(true);
  const generation = useRef(0);
  const sending = useRef(false);
  const revision = useRef(0);
  const heldTurns = useRef<Turn[]>([]);
  const serverReady = useRef(false);
  const cancellation = useRef<AbortController | null>(null);
  const remote = useRef(
    serverConversation(api, read.chain, read.vault.address, read.provenance, network),
  );
  const localKey = useRef(key);
  localKey.current = context;

  // A reply under way when the vault is read again was asked of the read before: it is set aside, and
  // said so. One under way for another person, vault or network is that conversation's, and goes quietly.
  const shownKey = useRef(key);
  const said = useRef(copy);
  said.current = copy;
  useEffect(() => {
    const interrupted = sending.current && shownKey.current === key;
    shownKey.current = key;
    const run = ++generation.current;
    const local = readLocal(key);
    heldTurns.current = local.transcript;
    setTurns(local.transcript);
    setReply(null);
    setBusy(false);
    sending.current = false;
    setError(interrupted ? said.current.reread : undefined);
    setFailure(undefined);
    setAnnounced('');
    setStorage('local');
    setLoading(true);
    revision.current = 0;
    serverReady.current = false;
    const cancel = new AbortController();
    cancellation.current = cancel;
    const store = serverConversation(
      api,
      read.chain,
      read.vault.address,
      read.provenance,
      network,
      cancel.signal,
    );
    remote.current = store;
    store.read().then((value) => {
      if (generation.current !== run || localKey.current !== context) return;
      if (value) {
        serverReady.current = true;
        revision.current = value.revision;
        // Do not silently replace words kept offline with an older/competing server transcript.
        const prefix = (a: Turn[], b: Turn[]) =>
          a.every((turn, index) => JSON.stringify(turn) === JSON.stringify(b[index]));
        const compatible =
          prefix(local.transcript, value.transcript) || prefix(value.transcript, local.transcript);
        if (!compatible) setStorage('conflict');
        else {
          const transcript =
            value.transcript.length >= local.transcript.length
              ? value.transcript
              : local.transcript;
          heldTurns.current = transcript;
          setTurns(transcript);
          writeLocal(key, { revision: value.revision, transcript });
          setStorage(transcript.length > value.transcript.length ? 'local' : 'server');
        }
      }
      setLoading(false);
    });
    return () => {
      cancel.abort();
      ++generation.current;
    };
  }, [api, key, read.chain, read.vault.address, read.provenance, network, context]);

  async function save(transcript: Turn[], run: number) {
    if (generation.current !== run) return false;
    if (!writeLocal(key, { revision: revision.current, transcript })) setError(copy.notSaved);
    if (!serverReady.current) return true;
    const outcome = await remote.current.write({ revision: revision.current, transcript });
    if (generation.current !== run) return false;
    if (outcome === 'conflict') {
      setStorage('conflict');
      setError(copy.conflict);
      return false;
    }
    if (outcome === 'saved') {
      revision.current += 1;
      setStorage('server');
      writeLocal(key, { revision: revision.current, transcript });
    } else {
      serverReady.current = false;
      setStorage('local');
    }
    return true;
  }

  async function send(typed: string) {
    if (sending.current || busy || loading || storage === 'conflict') return;
    // every message is kept as our server keeps it: one character it refuses would block later saves
    const words = plainText(typed);
    if (!words.trim()) return;
    const next = [
      ...heldTurns.current,
      { id: crypto.randomUUID(), who: 'person' as const, text: words },
    ];
    if (!transcriptOf({ revision: revision.current, transcript: next })) {
      setError(copy.capacity);
      return;
    }
    const run = generation.current;
    sending.current = true;
    heldTurns.current = next;
    setTurns(next);
    setText('');
    setReply(null);
    setError(undefined);
    setFailure(undefined);
    setAnnounced(copy.reading);
    setBusy(true);
    const saved = await save(next, run);
    if (generation.current !== run) return;
    if (!saved) {
      sending.current = false;
      setAnnounced('');
      setBusy(false);
      return;
    }
    try {
      const result = agentReplyOf(
        await (agent ?? vaultAgent(api, read.chain, read.vault.address))({
          vault: read,
          transcript: next,
          language,
          signal: cancellation.current?.signal,
        }),
        read,
      );
      if (generation.current !== run) return;
      if (!result) {
        setAnnounced('');
        setFailure(copy.failed);
        return;
      }
      // compared as they will be kept: a character our server refuses must not hide a repeat
      const message = replyText(
        plainText(result.message),
        result.question ? plainText(result.question) : undefined,
      );
      const completed = [...next, { id: crypto.randomUUID(), who: 'app' as const, text: message }];
      if (result.proposal) {
        const lines = [
          result.proposal.objective,
          ...result.proposal.allocations.map(
            (line) =>
              `${line.symbol ?? line.assetId} (${line.assetId}): ${share(language, line.weightBps)} [${line.evidenceIds.join(', ')}]`,
          ),
        ].map(plainText);
        let chunk = copy.draftIntro;
        for (const line of lines) {
          if (chunk.length + line.length + 1 > 8000) {
            completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
            chunk = copy.draftIntro;
          }
          chunk += `\n${line}`;
        }
        completed.push({ id: crypto.randomUUID(), who: 'app', text: chunk });
      }
      if (!transcriptOf({ revision: revision.current, transcript: completed })) {
        setAnnounced('');
        setError(copy.capacity);
        return;
      }
      heldTurns.current = completed;
      setTurns(completed);
      setReply(result);
      setAnnounced(
        [`${copy.agent}: ${message}`, ...(result.proposal ? [copy.draftArrived] : [])].join(' '),
      );
      await save(completed, run);
    } catch (cause) {
      if (generation.current === run) {
        setAnnounced('');
        setFailure(
          cause instanceof VaultAgentError && cause.kind === 'unavailable'
            ? copy.unavailable
            : copy.failed,
        );
      }
    } finally {
      if (generation.current === run) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  const rows = holdingsOf(read.vault).filter((row) => !/^0+$/.test(row.raw));
  const shares = rows.filter((row) => row.valueUsd !== null && row.weightBps > 0);
  const targets = holdingsOf(read.vault).filter((row) => row.targetBps > 0);
  const proposal = reply?.proposal;
  const draftMessage = (message: string) => {
    setText(message);
    composer.current?.querySelector('textarea')?.focus();
  };
  return (
    <section
      data-ui="vault-conversation"
      id="vault-conversation"
      tabIndex={-1}
      data-workbench
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 gap-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-0 md:flex-1 md:grid-cols-12 md:grid-rows-[auto_minmax(0,1fr)] md:items-stretch"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 md:col-span-12">
        <div className="flex min-w-0 flex-col gap-2">{heading}</div>
        <Button
          variant="link"
          aria-expanded={chatOpen}
          aria-controls={`${id}-chat`}
          data-ui="vault-chat-toggle"
          onClick={() => setChatOpen((open) => !open)}
        >
          {chatOpen ? t.talk.hideChat : t.talk.showChat}
        </Button>
      </header>
      <div
        id={`${id}-chat`}
        data-ui="vault-chat"
        hidden={!chatOpen}
        className={`${chatOpen ? 'flex' : 'hidden'} min-w-0 flex-col gap-4 md:col-span-5 md:min-h-0`}
      >
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="text-body font-medium">
            {copy.title}
          </h2>
          <p className="text-caption text-muted-foreground" role="status">
            {loading
              ? copy.loading
              : storage === 'server'
                ? copy.saved
                : storage === 'conflict'
                  ? copy.conflict
                  : copy.local}
          </p>
        </div>
        <ReplyAnnouncer text={announced} />
        {turns.length === 0 ? (
          <div className="flex flex-col items-start gap-4 py-4">
            <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
              {copy.empty}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="dense"
                disabled={loading || storage === 'conflict'}
                onClick={() => draftMessage(copy.explainPrompt)}
              >
                {copy.explain}
              </Button>
              <Button
                variant="secondary"
                size="dense"
                disabled={loading || storage === 'conflict'}
                onClick={() => draftMessage(copy.changePrompt)}
              >
                {copy.considerChange}
              </Button>
            </div>
          </div>
        ) : (
          <ol
            data-ui="vault-transcript"
            ref={transcript}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable transcript needs keyboard focus so arrow keys can read earlier messages.
            tabIndex={0}
            className="tf-scroll-thin flex max-h-[55vh] min-h-0 min-w-0 flex-col gap-5 overflow-y-auto pr-2 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:max-h-none md:flex-1"
            aria-label={copy.history}
          >
            {turns.map((turn) => (
              <li
                key={turn.id}
                className={`min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] ${turn.who === 'person' ? 'max-w-[85%] self-end rounded-lg bg-honey-tint bg-glow px-4 py-3' : ''}`}
              >
                <span className="sr-only">{turn.who === 'person' ? copy.you : copy.agent}: </span>
                {[
                  dictionary('en').shared.vault.conversation.draftIntro,
                  dictionary('pt').shared.vault.conversation.draftIntro,
                ].some((prefix) => turn.who === 'app' && turn.text.startsWith(prefix)) ? (
                  <details data-ui="vault-draft-record">
                    <summary className="cursor-pointer text-body-sm">{copy.proposed}</summary>
                    <p className="pt-2 text-caption">{turn.text}</p>
                  </details>
                ) : (
                  turn.text
                )}
              </li>
            ))}
            {/* The reply's place, under the words it answers: the wait, then the reply itself, or
                why it did not come. */}
            {busy && <PendingReply speaker={copy.agent} lines={copy.pendingLines} />}
            {!busy && failure && (
              <li data-ui="vault-unanswered" className="min-w-0">
                <p role="alert" className="flex items-start gap-1.5 text-body-sm text-destructive">
                  <StatusMark status="off-track" size={12} className="mt-1.5" />
                  <span>{failure}</span>
                </p>
              </li>
            )}
          </ol>
        )}
        <div ref={composer} className="min-w-0 border-t border-border pt-4">
          <Composer
            label={copy.title}
            labelHidden
            value={text}
            onChange={setText}
            onSubmit={send}
            maxLength={2000}
            placeholder={copy.placeholder}
            busy={busy}
            // the next thought can be typed while a reply is on its way; only sending waits
            typeWhileBusy
            hint={copy.hint}
            busyHint={copy.busyHint}
            disabled={loading || storage === 'conflict'}
            error={error}
            lang={language}
            labels={{ submit: copy.submitMessage, busy: '' }}
          />
        </div>
      </div>
      <div
        data-ui="vault-plan"
        aria-busy={busy}
        className={`tf-scroll-thin flex min-w-0 flex-col gap-4 md:min-h-0 md:overflow-y-auto md:pr-2 ${chatOpen ? 'md:col-span-7' : 'md:col-span-12'}`}
      >
        {/* The proposal leads when there is one: it is what the person is working on. */}
        {reply?.notes && !proposal && <WeightNotes notes={reply.notes} />}
        {/* A reply is on its way and no draft is shown (a sent message clears the last one, on
            purpose): the place a draft would take says so. It promises none. */}
        {busy && !proposal && (
          <div data-ui="vault-building">
            <Card as="section" aria-label={copy.building}>
              <CardBody>
                <DraftBuilding title={copy.building} line={copy.buildingLine} />
              </CardBody>
            </Card>
          </div>
        )}
        {proposal && (
          <section data-ui="vault-proposal">
            <StrategyPreview
              proposal={proposal}
              targets={targets}
              onDiscuss={() => draftMessage(copy.discussPrompt)}
              {...(applying !== reply && reply
                ? { use: { label: t.mix.preview.apply, onUse: () => setApplying(reply) } }
                : {})}
            />
            {reply && applying === reply && (
              <div className="mt-4">
                <VaultMixFlow
                  chain={read.chain}
                  vault={read.vault}
                  seed={proposal.allocations}
                  from="model"
                  provenance={read.provenance}
                  names={Object.fromEntries(
                    proposal.allocations.flatMap((line) =>
                      line.symbol ? [[line.assetId, line.symbol]] : [],
                    ),
                  )}
                  onClose={() => setApplying(null)}
                />
              </div>
            )}
          </section>
        )}
        <Card
          as="section"
          aria-labelledby={`${id}-held`}
          mock={read.provenance !== 'live'}
          mockLabels={{
            announce:
              read.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
          }}
        >
          <CardHeader id={`${id}-held`} title={copy.current} />
          <CardBody className="flex min-w-0 flex-col gap-4">
            {showValue && (
              <ProvenancePin
                value={dollars(language, read.vault.valueUsd)}
                obs={vaultValueSource(
                  { ...read, vaults: [read.vault] },
                  read.vault,
                  t.portfolio.vault.valueMethod,
                )}
                labels={t.pin}
              />
            )}
            {unpriced(read.vault) > 0 && (
              <p className="text-caption text-muted-foreground">
                {t.portfolio.vault.unpriced(unpriced(read.vault))}
              </p>
            )}
            {shares.length > 0 && (
              <HoldingsBar
                shares={shares.map((row) => ({ key: row.asset, shareBps: row.weightBps }))}
              />
            )}
            {rows.length === 0 ? (
              <p>{copy.noHoldings}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <li key={row.asset} className="flex min-w-0 items-center gap-2 text-body-sm">
                    <AssetMark asset={row.asset} />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {displayName(row.asset, t.plan)}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {row.valueUsd === null ? '—' : share(language, row.weightBps)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {copy.targets}
              </summary>
              <div className="flex flex-col gap-2 pt-3">
                <p className="text-caption text-muted-foreground">{copy.targetsNote}</p>
                <ul className="flex flex-col gap-1 text-body-sm">
                  {targets.map((row) => (
                    <li key={row.asset} className="flex min-w-0 gap-2">
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {displayName(row.asset, t.plan)}
                      </span>
                      <span className="tabular-nums">{share(language, row.targetBps)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </CardBody>
        </Card>
        {aside}
      </div>
    </section>
  );
}

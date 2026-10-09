'use client';
import type { ChainId } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Select } from '../../components/ui/Field';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import type { PortfolioState } from '../portfolio/use-portfolio';
import { shortAddress } from '../shared/use-person';
import { readLocal } from '../vault-conversation/storage';
import { useWalletPort } from '../wallet/WalletProvider';
import {
  type ConversationIndex,
  conversationStoreKey,
  newConversationId,
  readIndex,
  type SavedConversation,
  touch,
  writeIndex,
} from './conversations';
import { GoalChain, plannable } from './GoalChain';
import { GoalConversation, goalConversationKey } from './GoalConversation';

const NONE: ConversationIndex = { current: 'main', items: [] };

/**
 * `/goal` is the strategy conversation, keyed to the person, the chain of the plan and its network. A
 * picker above it (Rodrigo, Oct 8) holds the conversation on screen, a new one, the person's saved
 * conversations in this browser and their vaults, each with its chain as text: the list mixes chains
 * (gate CHAIN-AT-THE-PLAN). A vault opens its own page, where its owner-only conversation is
 * (VaultScreen). The chain of a new plan is chosen beside the box (GoalChain). Guided investing is not
 * offered here (staging #195).
 */
export function GoalEntry({ portfolio }: { portfolio: PortfolioState }) {
  const t = useT();
  const w = t.goal.explore.picker;
  const pickerId = useId();
  const router = useRouter();
  const { account, chain, choose } = useAccount();
  const port = useWalletPort();
  const network = chain ? port.network(chain) : null;
  const userId = port.userId;
  /** Where this browser keeps the person's conversations of one chain and its network. */
  const baseOf = (on: ChainId) => {
    const provenance = port.network(on)?.provenance;
    return userId && provenance ? goalConversationKey(userId, on, provenance) : null;
  };
  const base = chain ? baseOf(chain) : null;
  // The other chains a plan of theirs can start on: their saved conversations are listed too.
  const others = plannable(account, port).filter((on) => on !== chain);
  const otherBases = others.map((on) => `${on}=${baseOf(on) ?? ''}`).join('|');
  // The index is the one of the chain on screen from the first render on that chain: a conversation of
  // the chain before is never drawn on this one, not even for a frame.
  const [held, setHeld] = useState<{ base: string | null; index: ConversationIndex }>({
    base: null,
    index: NONE,
  });
  const index = held.base === base ? held.index : base ? readIndex(base) : NONE;
  const setIndex = (next: ConversationIndex) => setHeld({ base, index: next });
  const [elsewhere, setElsewhere] = useState<{ chain: ChainId; item: SavedConversation }[]>([]);
  useEffect(() => {
    setHeld({ base, index: base ? readIndex(base) : NONE });
    setElsewhere(
      otherBases.split('|').flatMap((pair) => {
        const [on, key] = pair.split('=') as [ChainId, string | undefined];
        return key ? readIndex(key).items.map((item) => ({ chain: on, item })) : [];
      }),
    );
  }, [base, otherBases]);
  const saved = [
    ...(chain
      ? index.items.filter((item) => item.id !== index.current).map((item) => ({ chain, item }))
      : []),
    ...elsewhere,
  ];
  const vaults =
    portfolio.kind === 'answered' && portfolio.outcome.kind === 'read'
      ? portfolio.outcome.chains.flatMap((entry) => entry.vaults)
      : [];
  // The chain was moved from the control beside the box: focus goes back to it once it is drawn again.
  const refocus = useRef(false);
  const [said, setSaid] = useState('');
  const nameOf = (on: ChainId) => port.network(on)?.name ?? t.chain.names[on];

  /** A new plan on `next`: the chain is stored, and an empty conversation opens there. */
  async function startOn(next: ChainId) {
    const there = baseOf(next);
    if (there) {
      const kept = readIndex(there);
      // The conversation last open there has words: it stays saved, and a new one takes its place.
      if (readLocal(conversationStoreKey(there, kept.current)).transcript.length > 0)
        writeIndex(there, { ...kept, current: newConversationId() });
    }
    refocus.current = true;
    await choose(next);
    setSaid(t.chain.choice.done(nameOf(next)));
  }

  function pick(value: string) {
    if (value === 'new' && base) {
      // The conversation on screen stays in the saved list; a new, empty one takes its place.
      const next = { ...index, current: newConversationId() };
      writeIndex(base, next);
      setIndex(next);
      return;
    }
    if (value.startsWith('conversation:')) {
      const [, on, id] = value.split(':') as [string, ChainId, string];
      const there = baseOf(on);
      if (!there || !id) return;
      if (on === chain) {
        const next = { ...index, current: id };
        writeIndex(there, next);
        setIndex(next);
        return;
      }
      // A conversation of another chain is opened on its chain: a plan never changes chain.
      writeIndex(there, { ...readIndex(there), current: id });
      choose(on).then(
        () => setSaid(t.chain.choice.done(nameOf(on))),
        () => {},
      );
      return;
    }
    if (value.startsWith('vault:')) {
      const [, vaultChain, address] = value.split(':');
      if (vaultChain && address)
        router.push(`/vaults/${encodeURIComponent(vaultChain)}/${encodeURIComponent(address)}`);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4 md:min-h-0 md:flex-1">
      <span role="status" data-ui="goal-chain-said" className="sr-only">
        {said}
      </span>
      {/* On a phone the picker gives way, so the row never pushes the page sideways. */}
      <div className="flex max-w-full items-center gap-3 self-start">
        <label htmlFor={pickerId} className="shrink-0 text-caption text-muted-foreground">
          {w.label}
        </label>
        <Select
          id={pickerId}
          data-ui="goal-picker"
          value="current"
          width="22ch"
          className="min-w-0"
          onChange={(event) => pick(event.target.value)}
        >
          <option value="current">{w.current}</option>
          <option value="new">{w.fresh}</option>
          {saved.length > 0 && (
            <optgroup label={w.saved}>
              {saved.map(({ chain: on, item }) => (
                <option key={`${on}:${item.id}`} value={`conversation:${on}:${item.id}`}>
                  {`${item.title || w.untitled} · ${t.chain.names[on]}`}
                </option>
              ))}
            </optgroup>
          )}
          {vaults.length > 0 && (
            <optgroup label={w.vaults}>
              {vaults.map((vault) => (
                <option
                  key={`${vault.chain}:${vault.address}`}
                  value={`vault:${vault.chain}:${vault.address}`}
                >
                  {`${vault.name ?? t.shared.vaults.address(shortAddress(vault.address))} · ${t.chain.names[vault.chain]}`}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      <GoalConversation
        key={`${port.userId}:${chain}:${network?.provenance}:${index.current}`}
        userId={port.userId}
        chain={chain}
        provenance={network?.provenance ?? null}
        ready={port.status === 'ready' && account.status === 'ready' && network?.on === true}
        conversationId={index.current}
        onSaved={(title) => {
          if (!base) return;
          setHeld((now) => {
            const was = now.base === base ? now.index : readIndex(base);
            return { base, index: touch(base, was, was.current, title) };
          });
        }}
        chainControl={(state) => <GoalChain {...state} refocus={refocus} onChoose={startOn} />}
      />
    </div>
  );
}

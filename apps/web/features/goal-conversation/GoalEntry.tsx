'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Select } from '../../components/ui/Field';
import { useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import type { PortfolioState } from '../portfolio/use-portfolio';
import { shortAddress } from '../shared/use-person';
import { useWalletPort } from '../wallet/WalletProvider';
import {
  type ConversationIndex,
  newConversationId,
  readIndex,
  touch,
  writeIndex,
} from './conversations';
import { GoalConversation, goalConversationKey } from './GoalConversation';

/**
 * `/goal` is the strategy conversation, keyed to the person, their chain and its network. A picker
 * above it (Rodrigo, Oct 8) holds the conversation on screen, a new one, the person's saved
 * conversations in this browser and their vaults: a vault opens its own page, where its owner-only
 * conversation is (VaultScreen). Guided investing is not offered here (staging #195).
 */
export function GoalEntry({ portfolio }: { portfolio: PortfolioState }) {
  const t = useT();
  const w = t.goal.explore.picker;
  const pickerId = useId();
  const router = useRouter();
  const { account, chain } = useAccount();
  const port = useWalletPort();
  const network = chain ? port.network(chain) : null;
  // The conversations kept in this browser for this person, chain and network.
  const base =
    port.userId && chain && network?.provenance
      ? goalConversationKey(port.userId, chain, network.provenance)
      : null;
  const [index, setIndex] = useState<ConversationIndex>({ current: 'main', items: [] });
  useEffect(() => {
    setIndex(base ? readIndex(base) : { current: 'main', items: [] });
  }, [base]);
  const others = index.items.filter((item) => item.id !== index.current);
  const vaults =
    portfolio.kind === 'answered' && portfolio.outcome.kind === 'read'
      ? portfolio.outcome.chains.flatMap((entry) => entry.vaults)
      : [];
  function choose(value: string) {
    if (value === 'new' && base) {
      // The conversation on screen stays in the saved list; a new, empty one takes its place.
      const next = { ...index, current: newConversationId() };
      writeIndex(base, next);
      setIndex(next);
      return;
    }
    if (value.startsWith('conversation:') && base) {
      const next = { ...index, current: value.slice('conversation:'.length) };
      writeIndex(base, next);
      setIndex(next);
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
      {/* On a phone the picker gives way, so the row never pushes the page sideways. */}
      <div className="flex max-w-full items-center gap-3 self-start">
        <label htmlFor={pickerId} className="shrink-0 text-caption text-muted-foreground">
          {w.label}
        </label>
        <Select
          id={pickerId}
          data-ui="goal-mode"
          value="current"
          width="22ch"
          className="min-w-0"
          onChange={(event) => choose(event.target.value)}
        >
          <option value="current">{w.current}</option>
          <option value="new">{w.fresh}</option>
          {others.length > 0 && (
            <optgroup label={w.saved}>
              {others.map((item) => (
                <option key={item.id} value={`conversation:${item.id}`}>
                  {item.title || w.untitled}
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
                  {vault.name ?? t.shared.vaults.address(shortAddress(vault.address))}
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
          if (base) setIndex((now) => touch(base, now, now.current, title));
        }}
      />
    </div>
  );
}

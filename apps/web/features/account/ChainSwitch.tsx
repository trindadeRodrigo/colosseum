'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { ChainMark } from './ChainName';
import { SWITCHABLE } from './chain-choice';
import { PersonError } from './person';

// The bar's chain switcher (gate CHAIN-SWITCH): the chain a screen shows and a new plan is built on.
// Signed out, it is the chain someone is looking at, kept in this browser. Signed in, it is the
// person's current chain, stored by the API; plans already made stay on their own chains. A chain no
// wallet of theirs signs on (an EVM wallet alone, on Solana) or one our server has switched off stays
// in the list, not chosen, with the reason under it.

export function ChainSwitch() {
  const t = useT();
  const port = useWalletPort();
  const { account, chain, choose } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ChainId | null>(null);
  const [problem, setProblem] = useState('');
  const [said, setSaid] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Closed by Escape, which gives focus back to the button, and by a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  if (!chain) return null;
  const signedIn = account.status === 'ready';
  const nameOf = (id: ChainId) => port.network(id)?.name ?? t.chain.names[id];
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.mockAnnounce };

  /** Why a chain cannot be chosen, or null when it can. */
  const why = (id: ChainId): string | null => {
    if (port.network(id)?.on === false) return t.chain.switch.off(nameOf(id));
    if (signedIn && !account.options.includes(id)) return t.chain.switch.noWallet(nameOf(id));
    return null;
  };

  const failure = (e: unknown, name: string): string => {
    const kind = e instanceof PersonError ? e.kind : 'unreachable';
    if (kind === 'no_wallet') return t.chain.failure.noWallet(name);
    if (kind === 'not_offered') return t.chain.failure.notOffered;
    if (kind === 'signed_out') return t.chain.failure.signedOut;
    if (kind === 'no_identity') return t.chain.failure.noIdentity;
    if (kind === 'busy') return t.shell.slowDown;
    return t.chain.failure.unreachable;
  };

  async function pick(next: ChainId) {
    if (busy) return;
    if (next === chain) {
      setOpen(false);
      button.current?.focus();
      return;
    }
    setBusy(next);
    setProblem('');
    try {
      await choose(next);
      setOpen(false);
      setSaid(t.chain.switch.done(nameOf(next)));
      button.current?.focus();
    } catch (e) {
      setProblem(failure(e, nameOf(next)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={root} data-ui="chain-switch" className="relative">
      <span role="status" className="sr-only">
        {said}
      </span>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t.chain.switch.current(nameOf(chain))}
        data-chain={chain}
        onClick={() => {
          setProblem('');
          setOpen((now) => !now);
        }}
        className="inline-flex h-10 items-center gap-1.5 rounded-md px-2 text-[0.875rem]/5 font-medium whitespace-nowrap text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span>{nameOf(chain)}</span>
        <Icon name="ChevronDown" size={16} />
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: toggle buttons are the group; a fieldset is for form controls
        <div
          id={panelId}
          role="group"
          aria-label={t.chain.switch.group}
          data-ui="chain-switch-panel"
          className="absolute top-full right-0 z-50 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground"
        >
          <ul className="flex flex-col gap-1">
            {SWITCHABLE.map((id) => {
              const reason = why(id);
              const reasonId = `${panelId}-${id}`;
              return (
                <li key={id} className="flex flex-col">
                  <button
                    type="button"
                    aria-pressed={id === chain}
                    aria-disabled={reason ? true : undefined}
                    aria-describedby={reason ? reasonId : undefined}
                    data-chain={id}
                    onClick={() => {
                      if (!reason) void pick(id);
                    }}
                    className="flex min-h-10 items-center justify-between gap-3 rounded-md px-2 text-left text-body-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent"
                  >
                    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>{busy === id ? t.chain.switch.saving : nameOf(id)}</span>
                      <ChainMark
                        provenance={port.network(id)?.provenance ?? 'mock'}
                        labels={marks}
                        announce={false}
                      />
                    </span>
                    {id === chain && <Icon name="Check" size={16} />}
                  </button>
                  {reason && (
                    <p id={reasonId} className="px-2 pb-1 text-caption text-muted-foreground">
                      {reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-border px-2 pt-2 text-caption text-muted-foreground">
            {signedIn ? t.chain.switch.plansStay : t.chain.switch.browsing}
          </p>
          {problem && (
            <p role="alert" className="px-2 text-caption text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

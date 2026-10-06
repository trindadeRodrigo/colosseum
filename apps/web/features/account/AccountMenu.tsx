'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useEffect, useId, useRef, useState } from 'react';
import { shorten } from '../../components/ui/format';
import { Icon } from '../../components/ui/Icon';
import { MockPlate } from '../../components/ui/MockPlate';
import { useT } from '../../i18n/I18nProvider';
import { explorerAddressUrlFor, onMock } from '../order/readiness';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { ChainOptions, usePopover } from './ChainSwitch';

// The bar's account control for someone signed in (Thom, Oct 6): one compact button with the current
// chain and the short address, opening what was spread along the bar: the chain switch, the address
// with "Copy address" and its page on the explorer, and "Sign out" as a plain last item. The same
// block heads the phone's sheet. It is a disclosure, not a menu of commands: the chains in it are
// toggle buttons with their reasons, as in the switcher someone signed out gets. Square, like the
// rest: a hairline and 2px corners (STYLE.md).

export type SignOutState = {
  signOut: () => void;
  busy: boolean;
  /** Signing out did not work: the person is still in, and is told. */
  failed: boolean;
};

const ITEM =
  'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-body-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** What the menu holds, and the phone's sheet under its own heading: chains, address, sign out. */
export function AccountBlock({
  out,
  onPicked,
  className,
}: {
  out: SignOutState;
  /** A chain was chosen in it: the one stored, or the current one pressed again. */
  onPicked?: (chain: ChainId, changed: boolean) => void;
  className?: string;
}) {
  const t = useT();
  const port = useWalletPort();
  const { account } = useAccount();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const chain = account.status === 'ready' ? account.chain : null;
  // Only the wallet of the current chain: the one a new plan is built with.
  const wallet = chain ? port.active(chainFamily(chain)) : null;
  const explorer =
    chain && wallet ? explorerAddressUrlFor(chain, wallet.address, onMock(port, chain)) : null;

  async function copy() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
    } catch {
      return; // no clipboard here: say nothing rather than claim a copy
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div data-ui="account-block" className={className}>
      {chain && <ChainOptions className="flex flex-col gap-1" onPicked={onPicked} />}
      {wallet && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-caption text-muted-foreground">
            <span>{t.shell.address}</span>
            {port.test && <MockPlate labels={{ figure: t.shell.sampleFigure }} />}
          </p>
          <p data-ui="account-address" className="px-2 font-mono text-source break-all">
            {wallet.address}
          </p>
          <button type="button" data-ui="copy-address" onClick={copy} className={ITEM}>
            <span>{copied ? t.shell.copied : t.shell.copyAddress}</span>
            <Icon name={copied ? 'Check' : 'Copy'} size={16} />
          </button>
          <span role="status" data-ui="copy-said" className="sr-only">
            {copied ? t.shell.copied : ''}
          </span>
          {explorer && chain && (
            <a
              href={explorer}
              target="_blank"
              rel="noopener"
              data-ui="account-explorer"
              className={ITEM}
            >
              <span>{t.shell.viewOn(t.chain.explorers[chain])}</span>
              <Icon name="ArrowUpRight" size={16} />
            </a>
          )}
        </div>
      )}
      <div className={chain || wallet ? 'border-t border-border pt-2' : undefined}>
        <button
          type="button"
          data-ui="sign-out"
          aria-disabled={out.busy || undefined}
          onClick={() => {
            if (!out.busy) out.signOut();
          }}
          className={ITEM}
        >
          {out.busy ? t.shell.signingOut : t.shell.signOut}
        </button>
        {out.failed && (
          <p role="alert" className="px-2 pt-1 text-caption text-destructive">
            {t.shell.signOutFailed}
          </p>
        )}
      </div>
    </div>
  );
}

export function AccountMenu({ out }: { out: SignOutState }) {
  const t = useT();
  const port = useWalletPort();
  const { account } = useAccount();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = usePopover(root, button);
  const [said, setSaid] = useState('');
  const panelId = useId();
  const chain = account.status === 'ready' ? account.chain : null;
  const wallet = chain ? port.active(chainFamily(chain)) : null;
  const name = chain ? (port.network(chain)?.name ?? t.chain.names[chain]) : null;

  return (
    <div ref={root} data-ui="account" className="relative flex items-center gap-2">
      <span role="status" data-ui="chain-said" className="sr-only">
        {said}
      </span>
      {/* The throwaway wallet of development is marked sample beside its address. */}
      {port.test && wallet && (
        <span className="max-[819px]:hidden">
          <MockPlate labels={{ figure: t.shell.sampleFigure }} />
        </span>
      )}
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-ui="account-menu-button"
        data-chain={chain ?? undefined}
        onClick={() => setOpen((now) => !now)}
        className="inline-flex h-10 max-w-full items-center gap-2 rounded-md border border-border px-3 text-[0.875rem]/5 font-medium whitespace-nowrap text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {/* Its name is what it shows, with the whole address in place of the short one. A person
            whose chain is not known yet (their wallets are being made, or could not be) still has
            the menu, and the way out in it. */}
        {chain && name ? (
          <>
            <span className="sr-only">{t.shell.account}: </span>
            <span className="max-[1023px]:hidden">{name}</span>
            <span className="min-[1024px]:hidden">{t.chain.short[chain]}</span>
            {wallet && (
              <span className="inline-flex items-center gap-2 max-[819px]:hidden">
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span
                  className="font-mono text-source text-muted-foreground"
                  title={wallet.address}
                >
                  <span aria-hidden="true">{shorten(wallet.address)}</span>
                  <span className="sr-only">{wallet.address}</span>
                </span>
              </span>
            )}
          </>
        ) : (
          <span>{t.shell.account}</span>
        )}
        <Icon name="ChevronDown" size={16} />
      </button>
      {open && (
        <div
          id={panelId}
          data-ui="account-menu"
          className="absolute top-full right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-2 text-popover-foreground"
        >
          <AccountBlock
            out={out}
            className="flex flex-col gap-2"
            onPicked={(next, changed) => {
              setOpen(false);
              if (changed)
                setSaid(t.chain.switch.done(port.network(next)?.name ?? t.chain.names[next]));
              button.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}

'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { useId, useRef } from 'react';
import { CopyButton } from '../../components/ui/CopyButton';
import { shorten } from '../../components/ui/format';
import { Icon } from '../../components/ui/Icon';
import { MockPlate } from '../../components/ui/MockPlate';
import { useT } from '../../i18n/I18nProvider';
import { explorerAddressUrlFor, onMock } from '../order/readiness';
import { useWalletPort } from '../wallet/WalletProvider';
import { useAccount } from './AccountProvider';
import { AccountBars, CHIP_BOX, LABEL_BOX } from './account-control-parts';
import { ChainLogo } from './ChainLogo';
import { ChainMark } from './ChainName';
import { usePopover } from './ChainSwitch';
import { useKeepInWindow } from './keep-in-window';

// The bar's account control for someone signed in. It shows the person, not a chain (Thom, Oct 9,
// gates CHAIN-AT-THE-PLAN and ONE-ACCOUNT-CONTROL): a wallet glyph and "Account", of one width so the
// bar never shifts, named "Your account". A chain is not a mode a person is in, and a person with a
// wallet on each chain has two addresses: showing one in the bar would say otherwise.
//
// Its menu lists the person's wallets, one row for each chain they have a wallet on: the chain's
// mark and name, how it is run where the rules ask (the sample glyph, "test network"), the short
// address with a copy icon beside it, and its page on the explorer. Then "Sign out" as a plain last
// item. The same block heads the phone's sheet. Nothing in it switches a chain: where a plan starts
// is chosen on /goal. It is a disclosure, not a menu of commands.

export type SignOutState = {
  signOut: () => void;
  busy: boolean;
  /** Signing out did not work: the person is still in, and is told. */
  failed: boolean;
};

const ITEM =
  'flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-body-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The chain a wallet of each family is on, in the order the rows are listed. */
const WALLET_CHAINS: readonly ChainId[] = ['solana', 'robinhood'];

/** What the menu holds, and the phone's sheet under its own heading: the wallets, then sign out. */
export function AccountBlock({ out, className }: { out: SignOutState; className?: string }) {
  const t = useT();
  const port = useWalletPort();
  // One row for each chain the person has a wallet on: the wallet of that chain's family.
  const wallets = WALLET_CHAINS.flatMap((chain) => {
    const wallet = port.active(chainFamily(chain));
    return wallet ? [{ chain, address: wallet.address }] : [];
  });
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure };

  return (
    <div data-ui="account-block" className={className}>
      {wallets.length > 0 && (
        <ul
          aria-label={t.shell.wallets}
          data-ui="account-wallets"
          className="flex flex-col gap-3 pt-2"
        >
          {wallets.map(({ chain, address }, index) => {
            const explorer = explorerAddressUrlFor(chain, address, onMock(port, chain));
            const name = port.network(chain)?.name ?? t.chain.names[chain];
            return (
              <li
                key={chain}
                data-ui="account-wallet"
                data-chain={chain}
                className="flex flex-col gap-1 px-2"
              >
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
                  <ChainLogo chain={chain} />
                  <span data-ui="account-wallet-chain">{name}</span>
                  {/* How the chain is run, where it is not live: the sample glyph, "test network".
                      The throwaway wallet of development is a sample whatever the chain. */}
                  {port.test ? (
                    <MockPlate labels={{ figure: t.shell.sampleFigure }} />
                  ) : (
                    <ChainMark
                      provenance={port.network(chain)?.provenance ?? 'mock'}
                      labels={marks}
                      announce={index === 0}
                    />
                  )}
                </p>
                {/* The short address with its copy beside it; the whole one is what is copied, what
                    a screen reader hears and what the pointer shows. */}
                <p className="flex min-h-10 flex-wrap items-center gap-x-1">
                  <span data-ui="account-address" title={address} className="font-mono text-source">
                    <span aria-hidden="true">{shorten(address)}</span>
                    <span className="sr-only">{address}</span>
                  </span>
                  <CopyButton
                    value={address}
                    title={`${t.shell.copyAddress}: ${address}`}
                    labels={{ copy: t.shell.copyAddress, copied: t.shell.copied }}
                  />
                  {explorer && (
                    <a
                      href={explorer}
                      target="_blank"
                      rel="noopener"
                      data-ui="account-explorer"
                      className="ml-auto inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-body-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span>{t.shell.viewOn(t.chain.explorers[chain])}</span>
                      <Icon name="ArrowUpRight" size={16} />
                    </a>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <div className={wallets.length > 0 ? 'border-t border-border pt-2' : undefined}>
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

export function AccountMenu({
  out,
  waiting = false,
}: {
  out: SignOutState;
  /**
   * Signed in, and the account is still being read: the button keeps the loading look (a still box
   * where its label will be), is named "Your account" all the same, and its menu holds the way out.
   */
  waiting?: boolean;
}) {
  const t = useT();
  const { account } = useAccount();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = usePopover(root, button);
  const panelId = useId();
  // Kept inside the window: on a phone the control sits left of where the menu would fit.
  const panel = useRef<HTMLDivElement>(null);
  const nudge = useKeepInWindow(open, root, panel);

  return (
    <div ref={root} data-ui="account" className="relative flex items-center gap-2">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t.shell.account}
        aria-busy={waiting || undefined}
        data-ui="account-menu-button"
        data-account-focus=""
        data-ready={account.status === 'ready' ? '' : undefined}
        onClick={() => setOpen((now) => !now)}
        className={`${CHIP_BOX} text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
      >
        <Icon name="Wallet" size={16} />
        {/* One width whatever it holds: the label, or the still box while the account is read. */}
        <span className={LABEL_BOX}>
          {waiting ? <AccountBars /> : <span data-ui="account-label">{t.shell.accountLabel}</span>}
        </span>
        <Icon name="ChevronDown" size={16} />
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          data-ui="account-menu"
          style={{ right: -nudge }}
          className="absolute top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-2 text-popover-foreground"
        >
          <AccountBlock out={out} className="flex flex-col gap-2" />
        </div>
      )}
    </div>
  );
}

'use client';
import {
  ChainId,
  chainFamily,
  isAddressOf,
  OWNER_REBALANCE_SLIPPAGE_BPS,
  ownerRebalanceOffered,
  type VaultResponse,
} from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { PAGE_TITLE, WORKSPACE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { type CallFailure, readOrder } from '../order/order-api';
import { stoppedShort } from '../order/order-check';
import { latestOf, recallOrder, recallOrders } from '../order/order-record';
import { explorerAddressUrlFor, explorerNameFor } from '../order/readiness';
import { dollars } from '../portfolio/figures';
import { vaultValueSource } from '../portfolio/portfolio';
import { OwnVaultActions } from '../portfolio/VaultActions';
import { closable } from '../portfolio/vault-lifetime';
import { sameAddress } from '../portfolio/vault-name';
import { conversationNetwork } from '../vault-conversation/storage';
import { VaultConversation } from '../vault-conversation/VaultConversation';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { MORE_ROW, MoreMenu } from './MoreMenu';
import { readVault } from './shared-api';
import { shortAddress } from './use-person';
import {
  type ActionKind,
  type ActionPhase,
  keepAction,
  type OpenAction,
  paneOf,
  recallAction,
  VaultAction,
} from './VaultAction';
import { CloseConfirm, ClosedNote } from './VaultClose';
import { VaultDetails, VaultHoldings } from './VaultHoldings';
import { VaultWait } from './waits';

// A vault, for anybody (DESIGN-VAULT section 11, the public vault page): its owner, what it
// follows, its value, and what it holds, cash included, each with its share now, planned share, the
// difference and its price, as its chain holds it now (GET /v1/vaults/{chain}/{address}). Its figures
// are written as the portfolio writes them (features/portfolio/figures.ts), so the two pages agree to
// the digit. Every price carries its pin (STYLE.md rule 1); a vault on the mock or a test network says
// so in its card's line. It leads back to the portfolio, and to the chain's explorer where there is one.

/**
 * How long a read of the vault may take before the page says it couldn't read it, with "Read it
 * again": past this a server or a node that hangs would leave "Reading the vault…" up for good.
 */
export const VAULT_READ_MS = 20_000;

type Load =
  | { kind: 'loading' }
  | { kind: 'read'; read: VaultResponse }
  | { kind: CallFailure; code?: string };

export function VaultScreen({ chain, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  const { account } = useAccount();
  // The vault is read once for an address, and again only when asked: the reader is kept in a ref,
  // so a change of the sign-in around it does not ask the server again (the flow audit, 35).
  const fetcher = useRef(apiFetch);
  fetcher.current = apiFetch;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const shown = useRef<string | null>(null);
  const titleId = useId();
  const known = ChainId.safeParse(chain);
  // Someone signed out has no portfolio to go back to: they came from Products, or from a link.
  // Until the wallet is known nobody is named either way: no "Back to Products" flashes by for a
  // person whose sign-in is still loading.
  const signedIn = port.status !== 'signed-out' && port.userId !== null;
  const backLink = (ui?: string) =>
    port.status === 'loading' ? (
      <span data-ui={ui && `${ui}-wait`} aria-hidden="true" className="inline-block h-5" />
    ) : signedIn ? (
      <Link href="/portfolio" data-ui={ui} className={buttonClass({ variant: 'link' })}>
        {v.back}
      </Link>
    ) : (
      <Link href="/products" data-ui={ui} className={buttonClass({ variant: 'link' })}>
        {v.backVisitor}
      </Link>
    );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the vault again
  useEffect(() => {
    if (!known.success) return setLoad({ kind: 'no-plan' });
    let mine = true;
    // The same vault read again (an action on its page is done) stays on the screen until the new
    // read is here; one that fails leaves the last read standing.
    const again = shown.current === `${chain}:${address}`;
    if (!again) setLoad({ kind: 'loading' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ kind: 'unreachable' }>((done) => {
      timer = setTimeout(() => done({ kind: 'unreachable' }), VAULT_READ_MS);
    });
    // A read that answers after its time is nobody's: the page already said it couldn't read it.
    Promise.race([readVault(fetcher.current, known.data, address), late]).then((read) => {
      clearTimeout(timer);
      if (!mine) return;
      if (read.kind === 'read') shown.current = `${chain}:${address}`;
      setLoad((before) =>
        read.kind === 'read'
          ? { kind: 'read', read: read.value }
          : again && before.kind === 'read'
            ? before
            : read,
      );
    });
    return () => {
      mine = false;
      clearTimeout(timer);
    };
  }, [chain, address, round]);

  if (
    load.kind === 'loading' ||
    (load.kind === 'read' &&
      (!known.success ||
        load.read.chain !== known.data ||
        !sameAddress(load.read.chain, load.read.vault.address, address)))
  )
    return <VaultWait visitor={port.status === 'signed-out'} />;
  if (load.kind !== 'read') {
    // An address that is not a vault (404), or not an address of the chain (400): said once, with
    // one way back. A chain switched off on the server is an answer, said as one, with nothing to
    // retry. A server that did not answer is asked again from here.
    const missing = load.kind === 'no-plan' || load.kind === 'refused';
    const off = load.code === 'CHAIN_UNAVAILABLE' && known.success;
    // An address of the other family (0x… on Solana's page, base58 on an EVM chain's) may be a vault
    // there: each running chain of that family is offered, by its own page.
    const family = known.success ? chainFamily(known.data) : null;
    const elsewhere =
      missing && family
        ? ChainId.options.filter(
            (c) =>
              chainFamily(c) !== family &&
              isAddressOf(chainFamily(c), address) &&
              port.network(c)?.on === true,
          )
        : [];
    return (
      <section
        data-ui="vault-unread"
        aria-labelledby={titleId}
        className="flex flex-col items-start gap-4"
      >
        <h1 id={titleId} className={PAGE_TITLE}>
          {missing ? v.missing : t.shared.vaults.address(shortAddress(address))}
        </h1>
        {elsewhere.length > 0 && (
          <p className="max-w-(--tf-measure-body) text-body">
            {known.success && v.otherFamily(t.chain.names[known.data])}
          </p>
        )}
        {elsewhere.map((c) => (
          <Link
            key={c}
            data-ui="vault-elsewhere"
            href={`/portfolio/vaults/${c}/${encodeURIComponent(address)}`}
            className={buttonClass({ variant: 'secondary' })}
          >
            {v.openOn(t.chain.names[c])}
          </Link>
        ))}
        {off && known.success && (
          <p className="max-w-(--tf-measure-body) text-body">
            {v.chainOff(t.chain.names[known.data])}
          </p>
        )}
        {!missing && !off && (
          <>
            <p className="max-w-(--tf-measure-body) text-body">
              {load.kind === 'busy'
                ? t.shell.slowDown
                : load.kind === 'unreadable'
                  ? t.shared.shelf.failure.unreadable
                  : v.unreachable}
            </p>
            <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
              {v.retry}
            </Button>
          </>
        )}
        {backLink('vault-back')}
      </section>
    );
  }

  const { read } = load;
  const { vault } = read;
  const explorer = explorerAddressUrlFor(read.chain, vault.address, read.provenance === 'mock');
  const wallet = port.active(chainFamily(read.chain));
  const mine =
    port.status === 'ready' &&
    port.userId !== null &&
    !!wallet &&
    sameAddress(read.chain, wallet.address, vault.owner);
  const chainName = port.network(read.chain)?.name ?? t.chain.names[read.chain];
  // The vault's value on its pin, with what kind of figure it is where it is not a live one. The
  // owner's head says the chain beside it; a visitor's says it once, by the title.
  const valueRow = (withChain: boolean) => (
    <p
      data-ui="vault-value"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm text-muted-foreground"
    >
      <span className="font-display text-h3 font-semibold text-foreground tabular-nums">
        <ProvenancePin
          value={dollars(lang, vault.valueUsd)}
          obs={vaultValueSource({ ...read, vaults: [vault] }, vault, t.portfolio.vault.valueMethod)}
          what={v.value}
          labels={t.pin}
        />
      </span>
      {withChain && <span data-ui="vault-chain">{chainName}</span>}
    </p>
  );
  const value = valueRow(true);
  /** The vault on its chain's explorer: a link in a visitor's head, a row in the owner's "More". */
  const explorerLinkAs = (className: string) =>
    explorer && (
      <a
        data-ui="vault-explorer"
        href={explorer}
        target="_blank"
        rel="noopener"
        className={className}
      >
        {v.explorer(explorerNameFor(read.chain, t.chain))}
        <Icon name="ArrowUpRight" size={16} />
      </a>
    );
  const explorerLink = explorerLinkAs(buttonClass({ variant: 'link' }));
  const explorerRow = explorerLinkAs(MORE_ROW);
  const back = backLink('vault-back');

  // The owner's vault is a workbench (Rodrigo, Oct 8), the conversation beside the vault, and the page
  // leads with what a person comes to do (gate VAULT-PAGE-ACTIONS, Thom, Oct 9): Deposit and Withdraw,
  // in place, in the right pane. Shown to the owner alone: a vault pays nobody else.
  if (mine && port.userId)
    return (
      <OwnVault
        // a new person, vault or network is another page; a new read of the same vault is the same one
        key={`${port.userId}:${read.chain}:${vault.address}`}
        read={read}
        userId={port.userId}
        // The owner's, on the vault's own chain: offered where a wallet of theirs signs on it,
        // whatever chain their new plans start on (gate CHAIN-AT-THE-PLAN).
        canShare={account.status === 'ready' && account.options.includes(read.chain)}
        shareHref={`/products/publish?vault=${encodeURIComponent(vault.address)}&chain=${read.chain}`}
        value={value}
        back={back}
        explorerLink={explorerRow}
        onReadAgain={() => setRound((n) => n + 1)}
      />
    );
  // Anybody else: the same read, with no owner's action and no conversation.
  return (
    <div data-ui="vault-screen" className="flex flex-col gap-6">
      <header className="flex flex-col items-start gap-3">
        <p>{back}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 id={titleId} className={PAGE_TITLE}>
            {t.shared.vaults.address(shortAddress(vault.address))}
          </h1>
          <ChainBadge chain={read.chain} />
        </div>
        {valueRow(false)}
        <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">{v.lead}</p>
        {explorerLink && <p>{explorerLink}</p>}
      </header>
      <VaultHoldings read={read} />
      <VaultDetails read={read} />
    </div>
  );
}

/**
 * Whether the vault is offered a rebalance (HANDOFF-VAULT, MVP item 6): it has a target, it is
 * outside the owner's band as the server reads it, with a trade of at least the smallest a rebalance
 * makes (`ownerRebalanceOffered`: what a rebalance leaves in cash for its slippage is not drift), and
 * auto-follow is off, so no keeper trades it. With a holding that has no price the shares
 * are not known and nothing is offered. The server decides again when asked.
 */
export function offTarget(
  vault: Pick<VaultResponse['vault'], 'autoFollow' | 'positions' | 'valueUsd'>,
): boolean {
  if (vault.autoFollow) return false;
  const held = vault.positions.filter((p) => !/^0+$/.test(p.raw));
  if (!vault.positions.some((p) => p.targetBps > 0) || held.some((p) => p.valueUsd === null))
    return false;
  const total = Number(vault.valueUsd);
  if (!(total > 0)) return false;
  const invested = vault.positions.reduce((n, p) => n + p.weightBps, 0);
  const planned = vault.positions.reduce((n, p) => n + p.targetBps, 0);
  // cash over its share is what the positions together are under theirs; the server's own rule
  return ownerRebalanceOffered(
    vault.positions,
    planned - invested,
    OWNER_REBALANCE_SLIPPAGE_BPS,
    total,
  );
}

/** The owner's page: the head, the pair of actions, and the workbench they act in. */
function OwnVault({
  read,
  userId,
  canShare,
  shareHref,
  value,
  back,
  explorerLink,
  onReadAgain,
}: {
  read: VaultResponse;
  userId: string;
  canShare: boolean;
  shareHref: string;
  value: ReactNode;
  back: ReactNode;
  explorerLink: ReactNode;
  onReadAgain: () => void;
}) {
  const t = useT();
  const v = t.shared.vault;
  const p = v.page;
  const titleId = useId();
  const { vault } = read;
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));
  const targeted = vault.positions.some((position) => position.targetBps > 0);
  const away = !empty && offTarget(vault);
  const deposit = (
    <Button
      variant="primary"
      data-action="vault-deposit"
      onClick={() => start('deposit', '[data-action="vault-deposit"]')}
    >
      {p.deposit}
    </Button>
  );
  // What has the right pane: nothing (the holdings), or one action, from its first choice to its last
  // signed step. One approved before the page was opened again is taken up from its order's record.
  const [open, setOpen] = useState<OpenAction | null>(null);
  const [phase, setPhase] = useState<ActionPhase>('open');
  // Closing the vault (gate VAULT-CLOSE-REUSE): asked once more before it is made. A closed vault's
  // owner is told so, with the way to open it again.
  const [closing, setClosing] = useState(false);
  // closed from this page just now: the note that says so takes the focus
  const [justClosed, setJustClosed] = useState(false);
  const closedAt = vault.closedAt ?? null;
  const where = { chain: read.chain, address: vault.address };
  // The pane as it is now, for an answer that comes back late: an order is taken only by the pane that
  // asked for it, and each opening of a pane is its own (`token`).
  const openNow = useRef(open);
  openNow.current = open;
  const tokens = useRef(0);
  const apiFetch = useApiFetch();
  // An action approved before the page was opened again. Its order is asked of our server first: one
  // that goes no further (done, failed, run out) is forgotten here and opens nothing, so a dead order
  // does not take the pane on every load. Where the server cannot be asked, the pane opens on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked once for a person and a vault
  useEffect(() => {
    const kept = recallAction(userId, read.chain, vault.address);
    if (!kept?.orderId) return;
    let mine = true;
    // where an order was made to finish it, that one says how the line stands
    const first = recallOrder(kept.orderId, userId);
    const asked = first ? latestOf(first, recallOrders(userId)).orderId : kept.orderId;
    const before = tokens.current;
    readOrder(apiFetch, asked).then((answer) => {
      if (!mine) return;
      // a pane was opened while this was asked, and maybe left again: the person chose since, and
      // what was kept is theirs to have dropped. Nothing is opened over that.
      if (tokens.current !== before) return;
      if (answer.kind === 'read' && (answer.order.status === 'done' || stoppedShort(answer.order)))
        return keepAction(userId, read.chain, vault.address, null);
      tokens.current += 1;
      const token = tokens.current;
      // never over a pane the person opened meanwhile
      setOpen((now) => now ?? { ...kept, token });
    });
    return () => {
      mine = false;
    };
  }, [userId, read.chain, vault.address]);
  const root = useRef<HTMLDivElement>(null);
  // The control that opened the pane gets the focus back when the pane goes.
  const opener = useRef<string | null>(null);
  const wasOpen = useRef(open !== null);
  useEffect(() => {
    if (wasOpen.current && !open)
      root.current
        ?.querySelector<HTMLElement>(opener.current ?? '[data-action="vault-deposit"]')
        ?.focus();
    wasOpen.current = open !== null;
  }, [open]);

  const start = (kind: ActionKind, from: string) => {
    opener.current = from;
    setPhase('open');
    // another start is another order: what was kept of the last is not taken up again
    keepAction(userId, read.chain, vault.address, null);
    tokens.current += 1;
    setOpen({ kind, orderId: null, token: tokens.current });
  };
  const leave = () => {
    keepAction(userId, read.chain, vault.address, null);
    setOpen(null);
    setPhase('open');
  };
  // Opened from a follow that is done (`?do=rebalance`, features/order/order-api.ts): the pane opens
  // on the rebalance once, where one is offered, as the press here would.
  const arrived = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when the page is first shown
  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    let asked = false;
    try {
      asked = new URLSearchParams(window.location.search).get('do') === 'rebalance';
    } catch {
      // no address to read: nothing is opened
    }
    if (asked && away && !openNow.current) start('rebalance', '[data-action="vault-rebalance"]');
  }, []);

  const action = open && {
    why:
      phase === 'signing'
        ? p.waits.signing
        : phase === 'done'
          ? p.waits.done
          : p.waits[paneOf(open.kind)],
    pane: (
      <VaultAction
        // each order, and each fresh start, is its own pane: nothing of the last is carried over
        key={`${open.token}:${open.kind}:${open.orderId && open.kind !== 'deposit' ? open.orderId : ''}`}
        read={read}
        userId={userId}
        open={open}
        phase={phase}
        onOrder={(orderId, approved) => {
          // An answer that comes back after its pane was left, or after another took its place, is
          // nobody's: it opens nothing and replaces nothing. Its order is left unsigned.
          const now = openNow.current;
          if (!now || now.token !== open.token) return;
          const next = { ...now, orderId };
          setOpen(next);
          // kept only from the press on: an order nobody approved is not taken up again
          if (approved) keepAction(userId, read.chain, vault.address, next);
        }}
        onPhase={(next) => {
          setPhase(next);
          // done: there is nothing left of it to take up again
          if (next === 'done') keepAction(userId, read.chain, vault.address, null);
        }}
        onRestart={() => (open.kind === 'apply' ? leave() : start(open.kind, opener.current ?? ''))}
        onLeave={leave}
        onFinished={() => {
          leave();
          onReadAgain();
        }}
        // Deposit | Withdraw on the amount card, where the vault holds something to withdraw.
        {...(!empty && (open.kind === 'deposit' || open.kind === 'withdraw')
          ? {
              onMode: (mode: 'deposit' | 'withdraw') =>
                start(
                  mode,
                  mode === 'deposit'
                    ? '[data-action="vault-deposit"]'
                    : '[data-action="vault-withdraw"]',
                ),
            }
          : {})}
      />
    ),
  };

  return (
    <div
      ref={root}
      data-ui="vault-screen"
      data-pane={open ? open.kind : 'holdings'}
      className="flex min-w-0 flex-col gap-4 md:min-h-0 md:flex-1"
    >
      <VaultConversation
        // another network or kind of figure is another conversation; a new read of the same vault is
        // the same one, which says so of a reply it set aside (VaultConversation.tsx)
        key={`${conversationNetwork(read.chain) ?? 'unconfigured'}:${read.provenance}`}
        read={read}
        userId={userId}
        action={action}
        starters={
          empty
            ? [
                { label: p.empty.choose, prompt: p.empty.choosePrompt },
                ...(targeted ? [{ label: p.empty.explain, prompt: p.empty.explainPrompt }] : []),
              ]
            : undefined
        }
        onOrder={(orderId) => {
          // only while the holdings have the pane: an order confirmed in the conversation that
          // answers after a deposit or a withdrawal was opened does not take its place
          if (openNow.current) return;
          opener.current = '[data-action="vault-deposit"]';
          setPhase('open');
          tokens.current += 1;
          setOpen({ kind: 'apply', orderId, token: tokens.current });
        }}
        heading={
          <>
            <p className="text-caption">{back}</p>
            <OwnVaultActions
              chain={read.chain}
              address={vault.address}
              headingLevel={1}
              page
              fallback={
                <h1 id={titleId} className={WORKSPACE_TITLE}>
                  {t.shared.vaults.address(shortAddress(vault.address))}
                </h1>
              }
              // The name (the person's own, or "Vault #N") comes with their portfolio, read once the
              // sign-in is here: until then the title waits, so no other one flashes by before it.
              pending={
                <h1
                  id={titleId}
                  className={WORKSPACE_TITLE}
                  data-ui="vault-name-wait"
                  aria-busy="true"
                >
                  <span className="sr-only">{v.loading}</span>
                  <span aria-hidden="true" className="inline-block h-6 w-40 rounded-md bg-muted" />
                </h1>
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              {value}
              {/* The pair a person comes for, and the rest behind "More". While one of them has the
                  pane its own press is the view's one primary, so the pair steps back. */}
              {!open && !closing && (
                <div
                  data-ui="vault-page-actions"
                  className="relative flex flex-wrap items-center gap-3"
                >
                  {/* an empty vault's one action is on its empty card, in the pane */}
                  {!empty && deposit}
                  {away && (
                    <Button
                      variant="secondary"
                      data-action="vault-rebalance"
                      onClick={() => start('rebalance', '[data-action="vault-rebalance"]')}
                    >
                      {p.rebalance}
                    </Button>
                  )}
                  {!empty && (
                    <Button
                      variant="secondary"
                      data-action="vault-withdraw"
                      onClick={() => start('withdraw', '[data-action="vault-withdraw"]')}
                    >
                      {t.withdraw.action}
                    </Button>
                  )}
                  <MoreMenu label={p.more} ui="vault-more">
                    <li>
                      <button
                        type="button"
                        className={MORE_ROW}
                        data-action="vault-edit-weights"
                        onClick={() => start('weights', '[data-ui="vault-more"]')}
                      >
                        {p.editWeights}
                      </button>
                    </li>
                    {/* a strategy is its targets: a vault with none has nothing to share */}
                    {canShare && targeted && (
                      <li>
                        <Link data-ui="vault-share-strategy" href={shareHref} className={MORE_ROW}>
                          {t.shared.publish.shareStrategy}
                        </Link>
                      </li>
                    )}
                    {explorerLink && <li>{explorerLink}</li>}
                    {!closedAt && (
                      <li>
                        <button
                          type="button"
                          className={MORE_ROW}
                          data-action="vault-close"
                          onClick={() => {
                            opener.current = '[data-ui="vault-more"]';
                            setClosing(true);
                          }}
                        >
                          {p.close.action}
                        </button>
                      </li>
                    )}
                  </MoreMenu>
                </div>
              )}
            </div>
          </>
        }
        current={
          <>
            {closing && !closedAt && (
              <CloseConfirm
                vault={where}
                empty={closable(vault)}
                onKeep={() => {
                  setClosing(false);
                  // back to the control that asked, once it is drawn again
                  requestAnimationFrame(() =>
                    root.current?.querySelector<HTMLElement>('[data-ui="vault-more"]')?.focus(),
                  );
                }}
                onWithdraw={() => {
                  setClosing(false);
                  start('withdraw', '[data-action="vault-withdraw"]');
                }}
                onClosed={() => {
                  setClosing(false);
                  setJustClosed(true);
                  onReadAgain();
                }}
              />
            )}
            {closedAt && (
              <ClosedNote
                vault={where}
                closedAt={closedAt}
                onReopened={onReadAgain}
                focus={justClosed}
              />
            )}
            {away && (
              <p
                data-ui="vault-off-target"
                className="max-w-(--tf-measure-body) border-l-2 border-primary pl-4 text-body-sm"
              >
                {p.offTarget}
              </p>
            )}
            {/* while the close is asked, its press is the view's one primary */}
            <VaultHoldings read={read} deposit={empty && !closing ? deposit : undefined} />
            {!empty && (
              <p data-ui="vault-change-hint" className="max-w-(--tf-measure-body) text-body-sm">
                {p.change}
              </p>
            )}
          </>
        }
        aside={<VaultDetails read={read} mine />}
      />
    </div>
  );
}

'use client';
import { ChainId, chainFamily, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { PAGE_TITLE, WORKSPACE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { type CallFailure, readOrder } from '../order/order-api';
import { stoppedShort } from '../order/order-check';
import { explorerAddressUrlFor } from '../order/readiness';
import { dollars } from '../portfolio/figures';
import { vaultValueSource } from '../portfolio/portfolio';
import { OwnVaultActions } from '../portfolio/VaultActions';
import { sameAddress } from '../portfolio/vault-name';
import { conversationNetwork } from '../vault-conversation/storage';
import { VaultConversation } from '../vault-conversation/VaultConversation';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { MoreMenu } from './MoreMenu';
import { readVault } from './shared-api';
import {
  type ActionKind,
  type ActionPhase,
  keepAction,
  type OpenAction,
  paneOf,
  recallAction,
  VaultAction,
} from './VaultAction';
import { VaultDetails, VaultHoldings } from './VaultHoldings';

// A vault, for anybody (DESIGN-VAULT section 11, the public vault page): its owner, what it
// follows, its value, and what it holds, cash included, each with its share now, planned share, the
// difference and its price, as its chain holds it now (GET /v1/vaults/{chain}/{address}). Its figures
// are written as the portfolio writes them (features/portfolio/figures.ts), so the two pages agree to
// the digit. Every price carries its pin (STYLE.md rule 1); a vault on the mock or a test network says
// so in its card's line. It leads back to the portfolio, and to the chain's explorer where there is one.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the vault again
  useEffect(() => {
    if (!known.success) return setLoad({ kind: 'no-plan' });
    let mine = true;
    // The same vault read again (an action on its page is done) stays on the screen until the new
    // read is here; one that fails leaves the last read standing.
    const again = shown.current === `${chain}:${address}`;
    if (!again) setLoad({ kind: 'loading' });
    readVault(fetcher.current, known.data, address).then((read) => {
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
    };
  }, [chain, address, round]);

  if (
    load.kind === 'loading' ||
    (load.kind === 'read' &&
      (!known.success ||
        load.read.chain !== known.data ||
        !sameAddress(load.read.chain, load.read.vault.address, address)))
  )
    return (
      <Card>
        <CardWait label={v.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (load.kind !== 'read')
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {load.kind === 'no-plan' || load.kind === 'refused' ? v.missing : v.title}
        </h1>
        {load.kind !== 'no-plan' && load.kind !== 'refused' && (
          <>
            <p className="max-w-(--tf-measure-body) text-body">
              {load.kind === 'busy' ? t.shell.slowDown : t.shared.shelf.failure.unreachable}
            </p>
            <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
              {t.shared.shelf.failure.retry}
            </Button>
          </>
        )}
        <Link href="/shelf" className={buttonClass({ variant: 'secondary' })}>
          {t.shared.family.backToShelf}
        </Link>
        <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
          {v.back}
        </Link>
      </section>
    );

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
  // The vault's value on its pin, with what kind of figure it is where it is not a live one.
  const value = (
    <p
      data-ui="vault-value"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm text-muted-foreground"
    >
      <span className="font-display text-h3 font-semibold text-foreground tabular-nums">
        <ProvenancePin
          value={dollars(lang, vault.valueUsd)}
          obs={vaultValueSource({ ...read, vaults: [vault] }, vault, t.portfolio.vault.valueMethod)}
          labels={t.pin}
        />
      </span>
      <span data-ui="vault-chain">{chainName}</span>
    </p>
  );
  const explorerLink = explorer && (
    <a
      data-ui="vault-explorer"
      href={explorer}
      target="_blank"
      rel="noopener"
      className={buttonClass({ variant: 'link' })}
    >
      {v.explorer(t.chain.explorers[read.chain])}
      <Icon name="ArrowUpRight" size={16} />
    </a>
  );
  const back = (
    <Link href="/monitor" data-ui="vault-back" className={buttonClass({ variant: 'link' })}>
      {v.back}
    </Link>
  );

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
        shareHref={`/publish?vault=${encodeURIComponent(vault.address)}&chain=${read.chain}`}
        value={value}
        back={back}
        explorerLink={explorerLink}
        onReadAgain={() => setRound((n) => n + 1)}
      />
    );
  // Anybody else: the same read, with no owner's action and no conversation.
  return (
    <div data-ui="vault-screen" className="flex flex-col gap-6">
      <header className="flex flex-col items-start gap-3">
        <p>{back}</p>
        <h1 id={titleId} className={PAGE_TITLE}>
          {v.title}
        </h1>
        {value}
        <p className="max-w-(--tf-measure-body) text-body text-muted-foreground">
          {v.lead(chainName)}
        </p>
        {explorerLink && <p>{explorerLink}</p>}
      </header>
      <VaultHoldings read={read} />
      <VaultDetails read={read} />
    </div>
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
    readOrder(apiFetch, kept.orderId).then((answer) => {
      if (!mine) return;
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
                  {v.title}
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
              {!open && (
                <div
                  data-ui="vault-page-actions"
                  className="relative flex flex-wrap items-center gap-3"
                >
                  {/* an empty vault's one action is on its empty card, in the pane */}
                  {!empty && deposit}
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
                      <Button
                        variant="link"
                        data-action="vault-edit-weights"
                        onClick={() => start('weights', '[data-ui="vault-more"]')}
                      >
                        {p.editWeights}
                      </Button>
                    </li>
                    {/* a strategy is its targets: a vault with none has nothing to share */}
                    {canShare && targeted && (
                      <li>
                        <Link
                          data-ui="vault-share-strategy"
                          href={shareHref}
                          className={buttonClass({ variant: 'link' })}
                        >
                          {t.shared.publish.shareStrategy}
                        </Link>
                      </li>
                    )}
                    {explorerLink && <li>{explorerLink}</li>}
                  </MoreMenu>
                </div>
              )}
            </div>
          </>
        }
        current={
          <>
            <VaultHoldings read={read} deposit={empty ? deposit : undefined} />
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

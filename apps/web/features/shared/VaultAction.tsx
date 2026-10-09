'use client';
import type { ChainId, VaultResponse } from '@colosseum/schemas';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { useLang, useT } from '../../i18n/I18nProvider';
import { parseNumber, dollars as whole } from '../goal/sheet';
import { VaultMixFlow } from '../mix/VaultMixFlow';
import { AmountField } from '../order/AmountField';
import type { OrderEmbed } from '../order/invest-words';
import { MAX_USD, MIN_USD } from '../order/limits';
import { OrderScreen } from '../order/OrderScreen';
import { latestOf, recallOrder, recallOrders } from '../order/order-record';
import { AddMoneyScreen } from '../portfolio/AddMoneyScreen';
import { sameAddress } from '../portfolio/vault-name';
import { SharedReview } from './SharedReview';
import type { SharedTerms } from './terms';
import { WithdrawScreen } from './WithdrawScreen';

// An action on the vault's own page, in its right pane (gate VAULT-PAGE-ACTIONS): a deposit, a
// withdrawal, or new weights, from the first choice to the last signed step, with no other page. Nothing
// that decides what is signed is here. The deposit is the card the add-money page mounts
// (AddMoneyScreen → InvestCard, gate INVEST-ONE-PRESS), with its test-network line or sample hatch, what
// the person is trusting, the wallet's check and the order as our server made it. The withdrawal is the
// withdrawal page's own choice and review (WithdrawScreen), and the weights the editor's own
// (VaultMixFlow); the order each makes is drawn by the order's own screen (OrderScreen), which checks it
// against what was reviewed, runs the guard on every step and never sends a reverted step again.
//
// The pane is laid out as the deposit on /goal is (features/mix/DepositSign.tsx): a heading that takes
// the focus, the amount as a fact once it is pressed, the end over the steps it sums up, and the way
// back whenever no step is being signed.

/** What can take the pane. `apply` is a change proposed in the conversation, once its order is made. */
export type ActionKind = 'deposit' | 'withdraw' | 'weights' | 'apply';
export type OpenAction = {
  kind: ActionKind;
  /** The order the action made, once there is one. */
  orderId: string | null;
  /** Approved before the page was opened again: taken up from the order's own record. */
  resumed?: boolean;
  /** Which opening of the pane this is: an answer for another opening is not this one's. */
  token?: number;
};
/** Where an open action stands: before the press, its steps being signed, stopped short, or done. */
export type ActionPhase = 'open' | 'signing' | 'stopped' | 'done';

const TERMS: Record<ActionKind, SharedTerms['kind']> = {
  deposit: 'vault',
  withdraw: 'withdraw',
  weights: 'retarget',
  apply: 'retarget',
};
/** The words of each action's pane: the weights, by hand or from the conversation, are one change. */
export const paneOf = (kind: ActionKind) =>
  kind === 'weights' || kind === 'apply' ? 'change' : kind;

const keyOf = (userId: string, chain: ChainId, address: string) =>
  `tf-vault-action:1:${encodeURIComponent(userId)}:${chain}:${address}`;

/**
 * The action the person approved on this page before it was opened again: only one whose order this
 * browser kept for this person, approved, for this vault and of that kind. Anything else is dropped.
 */
export function recallAction(userId: string, chain: ChainId, address: string): OpenAction | null {
  const key = keyOf(userId, chain, address);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const read = JSON.parse(raw) as Partial<OpenAction>;
    const record = typeof read.orderId === 'string' ? recallOrder(read.orderId, userId) : null;
    if (
      read.kind &&
      read.kind in TERMS &&
      record?.approved &&
      record.chain === chain &&
      record.terms?.kind === TERMS[read.kind] &&
      'vault' in record.terms &&
      sameAddress(chain, record.terms.vault, address)
    )
      return { kind: read.kind, orderId: record.orderId, resumed: true };
    localStorage.removeItem(key);
  } catch {
    // storage blocked or unreadable: nothing is taken up
  }
  return null;
}

/** Keeps the approved action's ids beside the vault, so a reload finds its order again; null forgets. */
export function keepAction(
  userId: string,
  chain: ChainId,
  address: string,
  open: OpenAction | null,
) {
  try {
    if (open?.orderId)
      localStorage.setItem(
        keyOf(userId, chain, address),
        JSON.stringify({ kind: open.kind, orderId: open.orderId }),
      );
    else localStorage.removeItem(keyOf(userId, chain, address));
  } catch {
    // storage full or blocked: the action is still on the pane for this visit
  }
}

export function VaultAction({
  read,
  userId,
  open,
  phase,
  onOrder,
  onPhase,
  onRestart,
  onLeave,
  onFinished,
}: {
  read: VaultResponse;
  userId: string;
  open: OpenAction;
  phase: ActionPhase;
  /** The action made its order, or the person approved one: kept from the press on. */
  onOrder: (orderId: string, approved: boolean) => void;
  onPhase: (phase: ActionPhase) => void;
  /** Back to the action's first choice, for another order. */
  onRestart: () => void;
  /** Back to the holdings, leaving what stopped where it is. */
  onLeave: () => void;
  /** Done, and the person goes back to the vault: it is read again. */
  onFinished: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const p = t.shared.vault.page;
  const words = p.panes[paneOf(open.kind)];
  const titleId = useId();
  const { chain, vault } = read;
  const [text, setText] = useState('');
  // The pane took the holdings' place: its heading takes the focus, so it is read from the top.
  useEffect(() => {
    document.getElementById(titleId)?.focus();
  }, [titleId]);

  const record = open.orderId ? recallOrder(open.orderId, userId) : null;
  const pressed = phase !== 'open';
  const parsed = parseNumber(text, lang);
  const typed =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;
  // A deposit taken up again is for the amount its order was made for, never one typed here.
  const amount = open.kind === 'deposit' && open.resumed ? (record?.amountUsd ?? null) : typed;

  // What the order's own screen tells this pane, whoever holds it.
  // An order that finishes a deposit that stopped took the card: it deposits nothing, so the amount
  // typed for the first one is not said of it, now or after a reload.
  const [followed, setFollowed] = useState(false);
  const finishes =
    followed || (record ? latestOf(record, recallOrders(userId)).continues !== undefined : false);
  const told = {
    onProgress: (progress: { orderId: string }) => {
      onOrder(progress.orderId, true);
      onPhase('signing');
    },
    // not approved yet: the pane is the person's again until they press
    onFollowUp: () => {
      setFollowed(true);
      onPhase('open');
    },
    onDone: () => onPhase('done'),
    onStopped: () => onPhase('stopped'),
  };

  let body: ReactNode;
  if (open.kind === 'deposit')
    body = (
      <>
        {pressed || open.resumed || finishes ? (
          amount !== null &&
          !finishes && (
            <p data-ui="vault-action-amount" className="text-body">
              {p.amount} <span className="font-medium tabular-nums">{whole(amount, lang)}</span>
            </p>
          )
        ) : (
          <AmountField
            text={text}
            onText={setText}
            hint={t.portfolio.add.amountHint}
            value={typed}
          />
        )}
        <AddMoneyScreen
          chain={chain}
          address={vault.address}
          embedded={{
            amount,
            hostEnds: true,
            // the page's own holdings are what this deposit goes into: not drawn a second time
            bare: true,
            ...(open.resumed && open.orderId ? { resumeOrder: open.orderId } : {}),
            onAmount: (next) => setText(String(next)),
            ...told,
          }}
        />
      </>
    );
  else if (!open.orderId)
    body =
      open.kind === 'withdraw' ? (
        <WithdrawScreen
          chain={chain}
          address={vault.address}
          embedded={{ onOrder: (orderId) => onOrder(orderId, false) }}
        />
      ) : (
        <VaultMixFlow
          chain={chain}
          vault={vault}
          seed={vault.positions
            .filter((position) => position.targetBps > 0)
            .map((position) => ({ assetId: position.asset, weightBps: position.targetBps }))}
          from="person"
          provenance={read.provenance}
          onClose={onLeave}
          onOrder={(orderId) => onOrder(orderId, false)}
        />
      );
  else {
    const embed: OrderEmbed = {
      blocked: [],
      onApprove: () => {
        if (open.orderId) onOrder(open.orderId, true);
        onPhase('signing');
      },
      onStarted: () => {},
      onAgain: onRestart,
      hostEnds: true,
      ...told,
    };
    body = (
      <>
        {/* what the order is held to, as its review showed it: the order's screen leaves it to its host */}
        {record?.terms && <SharedReview terms={record.terms} chain={chain} />}
        <Card
          as="section"
          aria-label={t.order.stepsTitle}
          mock={read.provenance === 'mock'}
          mockLabels={{ announce: t.shell.mockAnnounce }}
        >
          <CardBody className="flex flex-col gap-5">
            {read.provenance === 'sandbox' && (
              <p data-ui="data-note" className="text-caption text-muted-foreground">
                {t.buy.steps.note.testNetwork(t.chain.names[chain])}
              </p>
            )}
            <OrderScreen key={open.orderId} id={open.orderId} embed={embed} />
          </CardBody>
        </Card>
      </>
    );
  }

  const done = phase === 'done';
  return (
    <section
      data-ui="vault-action-pane"
      data-kind={open.kind}
      data-state={phase}
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className="flex min-w-0 flex-col gap-2">
        <h2 id={titleId} tabIndex={-1} className="font-display text-h4 font-semibold outline-none">
          {done ? p.ended : open.orderId || pressed ? words.signTitle : words.title}
        </h2>
        {!done && (
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {open.resumed ? words.resumed : words.lead}
          </p>
        )}
      </header>
      {/* The end, over the steps: the one way on is not under a long card. How it ended is the order's
          own sentence, below, which never says plainly done of a step that was skipped or a token that
          stayed (OrderScreen): nothing here says more than it does. */}
      {done && (
        <div data-ui="vault-action-done" className="flex flex-col items-start gap-3">
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {p.endedLead}
          </p>
          <Button variant="primary" data-action="back-to-vault" onClick={onFinished}>
            {p.backToVault}
          </Button>
        </div>
      )}
      {body}
      {/* the way back, whenever no step is being signed; what was sent stays sent */}
      {phase !== 'signing' && !done && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm">
          {phase === 'stopped' && <span className="text-muted-foreground">{words.stopped}</span>}
          <Button variant="link" data-action="leave-action" onClick={onLeave}>
            {p.backToHoldings}
          </Button>
        </p>
      )}
    </section>
  );
}

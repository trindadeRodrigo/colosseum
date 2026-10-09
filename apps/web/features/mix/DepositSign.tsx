'use client';
import type { ChainId } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { Invest } from '../order/Invest';
import { readOrder } from '../order/order-api';
import { depositLanded } from '../order/order-check';
import { useApiFetch } from '../wallet/WalletProvider';

// The deposit signed in place, on /goal (gate DEPOSIT-IN-PLACE): once the person has confirmed the
// review, this takes the pane with the steps to sign, their progress and the finished state. It draws
// nothing of its own that decides what is signed: the card is the one the plan's own page mounts
// (Invest, gate INVEST-ONE-PRESS), with its line for a test network or its sample hatch, what the
// person is trusting, the wallet's check, the order as our server made it and the one press. The
// amount is the one typed on the deposit step, shown as a fact.

/**
 * A deposit the person approved: its plan, its newest approved order and the amount. Only these ids
 * and `left` are kept in the browser. Whether it is done is never read from there: it is what the
 * order's own screen says, from our server, on this visit.
 */
export type OpenDeposit = {
  planId: string;
  orderId: string;
  amountUsd: number;
  /** Every step is confirmed, as our server says. `vault` is the vault's address where it could be read. */
  done?: { vault: string | null };
  /** The person left it unfinished: the pane is theirs again, and the deposit is said to be waiting. */
  left?: true;
};

/** What the conversation is told, so it can hold its box and keep the deposit across a reload. */
export type DepositHost = {
  /** The person pressed, or a step moved, or the deposit ended: what to keep. */
  onOpen: (open: OpenDeposit) => void;
  /** The person left a deposit that is not done: it is set aside, and said to be waiting. */
  onLeave: () => void;
  /** Steps are being signed now, or no longer are. */
  onRunning: (running: boolean) => void;
};

export function DepositSign({
  chain,
  planId,
  amountUsd,
  resume,
  waiting = false,
  onChange,
  onLeave,
  host,
}: {
  chain: ChainId;
  planId: string;
  amountUsd: number;
  /** A deposit approved before the page was reloaded: taken up again from its own order. */
  resume?: OpenDeposit;
  /** The conversation is working on a reply: the proposal may change, so nothing is pressed. */
  waiting?: boolean;
  /** Back to the deposit step, to type another amount. Offered until the person presses. */
  onChange?: () => void;
  /** Called after the host was told the deposit is left: back to the proposal. */
  onLeave?: () => void;
  host: DepositHost;
}) {
  const t = useT();
  const lang = useLang();
  const s = t.mix.deposit.signing;
  const titleId = useId();
  const [orderId, setOrderId] = useState<string | null>(resume?.orderId ?? null);
  const [running, setRunning] = useState(false);
  // Done is what the order's screen says on this visit, read from our server: never a kept flag.
  const [done, setDone] = useState<{ vault: string | null } | null>(null);
  // An order that finishes this one took the card: it adds no money, and is never said as a deposit
  // of the amount (the vault page says the same, VaultAction).
  const [finishes, setFinishes] = useState(false);
  const f = t.shared.vault.page.finish;
  const to = useRef(host);
  to.current = host;
  // The pane took the place of the review: its heading takes focus, so it is read from the top.
  useEffect(() => {
    const heading = document.getElementById(titleId);
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }, [titleId]);
  const run = (now: boolean) => {
    setRunning(now);
    to.current.onRunning(now);
  };
  const approved = orderId !== null;
  return (
    <section
      data-ui="deposit-sign"
      data-state={done ? 'done' : running ? 'signing' : approved ? 'approved' : 'ready'}
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4"
    >
      <header className="flex min-w-0 flex-col gap-2">
        <h2 id={titleId} className="font-display text-h4 font-semibold outline-none">
          {done ? s.doneTitle : finishes ? f.title : s.title}
        </h2>
        <p
          data-ui="deposit-sign-amount"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body"
        >
          <span>
            {s.amount} <span className="font-medium tabular-nums">{dollars(amountUsd, lang)}</span>
            {' · '}
            {t.chain.names[chain]}
          </span>
          {onChange && !approved && (
            <Button variant="link" aria-label={s.changeLabel} onClick={onChange}>
              {s.change}
            </Button>
          )}
        </p>
        {!done && (
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {finishes ? f.lead : resume ? s.resumed : s.lead}
          </p>
        )}
      </header>
      {/* the end, over the steps it sums up: the one way on is not under a long card */}
      {done && (
        <div data-ui="deposit-done" className="flex flex-col items-start gap-3">
          <p role="status" className="max-w-(--tf-measure-body) text-body">
            {s.done}
          </p>
          <Link
            href={
              done.vault
                ? `/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(done.vault)}`
                : '/portfolio'
            }
            data-action="open-vault"
            className={buttonClass({ variant: 'primary' })}
          >
            {done.vault ? s.openVault : t.order.outcome.seePortfolio}
          </Link>
        </div>
      )}
      {waiting && !approved && (
        <p role="status" data-ui="deposit-sign-waiting" className="text-body-sm">
          {t.mix.deposit.blocked.reply}
        </p>
      )}
      <div inert={waiting && !approved} className="min-w-0">
        <Invest
          of={{ plan: planId }}
          amount={amountUsd}
          hostEnds
          {...(resume ? { resumeOrder: resume.orderId } : {})}
          onProgress={(progress) => {
            // The first word is the press itself: from here the deposit is kept, and the box is held.
            if (progress.orderId !== orderId) setOrderId(progress.orderId);
            setDone(null);
            to.current.onOpen({ planId, orderId: progress.orderId, amountUsd });
            run(true);
          }}
          onDone={(ended) => {
            setDone({ vault: ended.vault });
            to.current.onOpen({
              planId,
              orderId: ended.orderId,
              amountUsd,
              done: { vault: ended.vault },
            });
            run(false);
          }}
          onStopped={() => run(false)}
          // an order that finishes this one took the card: it is to review, not running
          onFollowUp={() => {
            setFinishes(true);
            run(false);
          }}
        />
      </div>
      {approved && !running && !done && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm">
          <span className="text-muted-foreground">{s.leaveNote}</span>
          <Link href={`/orders/${encodeURIComponent(orderId ?? '')}`} className="underline">
            {s.orderPage}
          </Link>
          <Button
            variant="link"
            data-action="leave-deposit"
            onClick={() => {
              to.current.onLeave();
              onLeave?.();
            }}
          >
            {t.mix.deposit.backToProposal}
          </Button>
        </p>
      )}
    </section>
  );
}

/**
 * A deposit the person left unfinished, said over whatever the pane shows next: where its money is, as
 * our server has the order now, the way back to it, and that another deposit does not finish it.
 */
export function UnfinishedDeposit({
  orderId,
  amountUsd,
  onBack,
  onGone,
}: {
  orderId: string;
  amountUsd: number;
  /** Back to its steps, in the pane. */
  onBack: () => void;
  /** Our server says every step of it is confirmed: there is nothing left to say. */
  onGone: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const u = t.goal.explore.deposit.unfinished;
  const api = useApiFetch();
  const [landed, setLanded] = useState<boolean | null>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    let mine = true;
    void readOrder(api, orderId).then((read) => {
      if (!mine || read.kind !== 'read') return;
      if (read.order.status === 'done') return gone.current();
      setLanded(depositLanded(read.order));
    });
    return () => {
      mine = false;
    };
  }, [api, orderId]);
  const amount = dollars(amountUsd, lang);
  return (
    <div
      role="status"
      data-ui="deposit-unfinished"
      data-landed={landed === null ? undefined : String(landed)}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-body-sm"
    >
      <p className="max-w-(--tf-measure-body)">
        {landed === null ? u.unread(amount) : landed ? u.landed(amount) : u.none(amount)} {u.again}
      </p>
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <Button variant="link" data-action="back-to-deposit" onClick={onBack}>
          {u.back}
        </Button>
        <Link href={`/orders/${encodeURIComponent(orderId)}`} className="underline">
          {t.mix.deposit.signing.orderPage}
        </Link>
      </p>
    </div>
  );
}

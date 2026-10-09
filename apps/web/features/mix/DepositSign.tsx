'use client';
import type { ChainId } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { Invest } from '../order/Invest';

// The deposit signed in place, on /goal (gate DEPOSIT-IN-PLACE): once the person has confirmed the
// review, this takes the pane with the steps to sign, their progress and the finished state. It draws
// nothing of its own that decides what is signed: the card is the one the plan's own page mounts
// (Invest, gate INVEST-ONE-PRESS), with its line for a test network or its sample hatch, what the
// person is trusting, the wallet's check, the order as our server made it and the one press. The
// amount is the one typed on the deposit step, shown as a fact.

/** A deposit the person approved: its plan, its order and the amount, and where it ended. */
export type OpenDeposit = {
  planId: string;
  orderId: string;
  amountUsd: number;
  /** Every step is confirmed. `vault` is the vault's address where the portfolio could be read. */
  done?: { vault: string | null };
};

/** What the conversation is told, so it can hold its box and keep the deposit across a reload. */
export type DepositHost = {
  /** The person pressed, or a step moved, or the deposit ended: what to keep. Null: left. */
  onOpen: (open: OpenDeposit | null) => void;
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
  /** Back to the proposal, leaving a deposit that stopped where it is. */
  onLeave: () => void;
  host: DepositHost;
}) {
  const t = useT();
  const lang = useLang();
  const s = t.mix.deposit.signing;
  const titleId = useId();
  const [orderId, setOrderId] = useState<string | null>(resume?.orderId ?? null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<{ vault: string | null } | null>(resume?.done ?? null);
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
          {done ? s.doneTitle : s.title}
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
            {resume ? s.resumed : s.lead}
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
        />
      </div>
      {approved && !running && !done && (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm">
          <span className="text-muted-foreground">{s.leaveNote}</span>
          <Button variant="link" data-action="leave-deposit" onClick={onLeave}>
            {t.mix.deposit.backToProposal}
          </Button>
        </p>
      )}
    </section>
  );
}

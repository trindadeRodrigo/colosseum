'use client';
import { type ChainId, chainFamily } from '@colosseum/schemas';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { useT } from '../../i18n/I18nProvider';
import { type Account, useAccount } from '../account/AccountProvider';
import { ChainChoice } from '../account/ChainChoice';
import { ChainHow } from '../account/ChainName';
import { SWITCHABLE } from '../account/chain-choice';
import { switchFailure } from '../account/chain-failure';
import type { WebWalletPort } from '../wallet/port';
import { useWalletPort } from '../wallet/WalletProvider';

// The chain of a new plan, chosen on /goal where the plan starts (gate CHAIN-AT-THE-PLAN; ONE-CHAIN
// holds: one plan, one chain). Before the conversation has words it is a choice of two beside the box,
// starting on the person's last one (`account.chain`, which the choice stores: PUT /v1/me/chain). Once
// it has words the chain is a quiet badge with "Change": each chain has its own assets, so a change
// starts a new conversation on the other chain, after the person says yes; the one on screen stays
// among the saved ones. A person whose wallet signs on one chain sees that chain and why; one whose
// plans start on a chain that cannot take one sees why, and the way to a chain that can.

/** The chains a plan of this person can start on: a wallet of theirs signs there, and our server runs it. */
export function plannable(account: Account, port: Pick<WebWalletPort, 'network'>): ChainId[] {
  const held = account.status === 'ready' ? account.options : SWITCHABLE;
  return SWITCHABLE.filter((c) => held.includes(c) && port.network(c)?.on !== false);
}

export function GoalChain({
  started,
  busy,
  refocus,
  onChoose,
  on,
}: {
  /** The conversation has words: the chain is no longer a free choice. */
  started: boolean;
  /** A reply is being worked on, or the deposit step is open and may be signing: the chain is fixed. */
  busy: boolean;
  /** Set when this control moved the chain: the conversation is drawn again, and focus comes back here. */
  refocus: RefObject<boolean>;
  /** Moves a new plan to `chain`: stores it, and opens an empty conversation there. */
  onChoose: (chain: ChainId) => Promise<void>;
  /**
   * The chain of the conversation on screen, where it is not the account's: a deposit open on the pane
   * keeps its conversation on its own chain whatever moves the account's.
   */
  on?: ChainId | null;
}) {
  const t = useT();
  const c = t.chain.choice;
  const port = useWalletPort();
  const { account, chain: current } = useAccount();
  const chain = on ?? current;
  const root = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState<ChainId | null>(null);
  const sending = useRef(false);
  const [problem, setProblem] = useState('');
  const [asking, setAsking] = useState(false);
  const fixedId = useId();

  // The control moved the chain and was drawn again with the conversation: focus stays on it.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLElement>('input:checked, [data-act="chain-change"]')?.focus();
  }, [refocus]);
  // The question takes the focus when it opens, and gives it back to "Change" when it is not taken.
  const asked = useRef(false);
  useEffect(() => {
    if (asking === asked.current) return;
    asked.current = asking;
    root.current
      ?.querySelector<HTMLElement>(`[data-act="${asking ? 'chain-start' : 'chain-change'}"]`)
      ?.focus();
  }, [asking]);

  // The chain is fixed now: a question that was open is closed with it.
  useEffect(() => {
    if (busy) setAsking(false);
  }, [busy]);

  if (!chain) return null;
  const nameOf = (id: ChainId) => port.network(id)?.name ?? t.chain.names[id];
  const usable = plannable(account, port);
  const others = usable.filter((id) => id !== chain);
  const signedIn = account.status === 'ready';

  async function pick(next: ChainId) {
    if (sending.current || next === chain || busy) return;
    sending.current = true;
    setSaving(next);
    setProblem('');
    try {
      await onChoose(next);
    } catch (e) {
      refocus.current = false;
      setProblem(switchFailure(t, e, nameOf(next)));
    } finally {
      sending.current = false;
      setSaving(null);
    }
  }
  const stop = () => setAsking(false);

  const failed = problem && (
    <p role="alert" className="text-caption text-destructive">
      {problem}
    </p>
  );
  // words alone: the chain is named here and no figure is beside it (Thom, Oct 9)
  const mark = (
    <ChainHow
      provenance={port.network(chain)?.provenance ?? 'mock'}
      labels={{ testNetwork: t.shell.testNetworkLine, sample: t.shell.sample }}
    />
  );

  if (started) {
    const [other] = others;
    return (
      <div ref={root} data-ui="goal-chain" data-chain={chain} className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span>{c.on}</span>
          <ChainBadge chain={chain} />
          {mark}
          {other && !asking && (
            <Button
              variant="link"
              data-act="chain-change"
              aria-label={c.changeLabel}
              disabled={busy}
              aria-describedby={busy ? fixedId : undefined}
              onClick={() => setAsking(true)}
            >
              {c.change}
            </Button>
          )}
          {other && busy && (
            <span id={fixedId} className="sr-only">
              {c.fixed}
            </span>
          )}
        </p>
        {other && asking && !busy && (
          // biome-ignore lint/a11y/useSemanticElements: a question with its two answers, not form fields
          <div
            role="group"
            aria-label={c.changeLabel}
            data-ui="goal-chain-confirm"
            className="flex flex-col items-start gap-2 border-l-2 border-primary pl-3"
            onKeyDown={(event) => {
              if (event.key === 'Escape') stop();
            }}
          >
            <p className="max-w-(--tf-measure-body) text-body-sm">{c.confirm(nameOf(other))}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                variant="secondary"
                data-act="chain-start"
                busy={saving === other}
                busyLabel={t.chain.switch.saving}
                onClick={() => void pick(other)}
              >
                {c.start(nameOf(other))}
              </Button>
              <Button variant="link" data-act="chain-keep" onClick={stop}>
                {c.keep}
              </Button>
            </div>
          </div>
        )}
        {failed}
      </div>
    );
  }

  if (!usable.includes(chain)) {
    // New plans start on a chain that cannot take one: our server has it switched off, or no wallet
    // of theirs signs there. Said with why, and with the way to a chain that can: nothing else on
    // the page is a way off it (no first message can be sent there, so there is no "Change"; the
    // bar's list, which was the way out, is gone).
    const [to] = usable;
    return (
      <div ref={root} data-ui="goal-chain" data-chain={chain} className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span>
            {port.network(chain)?.on === false ? c.off(nameOf(chain)) : c.notYours(nameOf(chain))}
          </span>
        </p>
        {to && (
          <Button
            variant="secondary"
            data-act="chain-move"
            busy={saving === to}
            busyLabel={t.chain.switch.saving}
            disabled={busy}
            onClick={() => void pick(to)}
            className="self-start"
          >
            {c.start(nameOf(to))}
          </Button>
        )}
        {failed}
      </div>
    );
  }

  if (others.length === 0)
    // One chain our server runs for them: said plainly, with nothing to choose.
    return usable.includes(chain) ? (
      <p
        data-ui="goal-chain"
        data-chain={chain}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground"
      >
        <span>
          {signedIn && account.options.filter((id) => SWITCHABLE.includes(id)).length < 2
            ? c.onlyWallet(nameOf(chain))
            : c.onlyOn(nameOf(chain))}
        </span>
        {mark}
      </p>
    ) : null;

  return (
    <div ref={root} data-ui="goal-chain" data-chain={chain} className="flex flex-col gap-2">
      <ChainChoice
        legend={c.legend}
        hint={c.hint}
        value={chain}
        busy={saving}
        disabled={busy}
        onChange={(next) => void pick(next)}
        options={usable.map((id) => ({
          chain: id,
          name: nameOf(id),
          address: signedIn ? (port.active(chainFamily(id))?.address ?? null) : null,
          provenance: port.network(id)?.provenance ?? 'mock',
        }))}
        labels={{
          testNetwork: t.shell.testNetworkLine,
          sample: t.shell.sample,
          wallet: c.wallet,
          saving: t.chain.switch.saving,
        }}
      />
      {failed}
    </div>
  );
}

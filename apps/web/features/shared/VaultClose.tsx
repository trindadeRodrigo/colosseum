'use client';
import type { ChainId } from '@colosseum/schemas';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Panel, PanelBody } from '../../components/ui/Panel';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { closeVault, reopenVault } from '../portfolio/vault-lifetime';
import { useApiFetch } from '../wallet/WalletProvider';

// Closing an empty vault of the person's, and the closed vault's note with the way to open it again
// (gate VAULT-CLOSE-REUSE). A close is asked once more before it is made (Thom, Oct 14: a confirm, not
// an undo). Nothing here signs: the server keeps the close, and the chain is not touched.

type Vault = { chain: ChainId; address: string };

/**
 * The confirm: what closing does, then the press. A vault that still holds something is not offered
 * the press; it is told to withdraw first, with the way to.
 */
export function CloseConfirm({
  vault,
  empty,
  onKeep,
  onWithdraw,
  onClosed,
}: {
  vault: Vault;
  /** Worth under a cent, with no token it holds unpriced. */
  empty: boolean;
  onKeep: () => void;
  onWithdraw: () => void;
  onClosed: () => void;
}) {
  const t = useT();
  const c = t.shared.vault.page.close;
  const apiFetch = useApiFetch();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<'asking' | 'busy' | 'failed' | 'not-empty' | 'order-open'>(
    empty ? 'asking' : 'not-empty',
  );
  const said = useRef<HTMLParagraphElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Escape is "Keep it open", as a dialog's way out, from anywhere in the confirm; not while it closes.
  useEffect(() => {
    const el = box.current;
    if (!el || state === 'busy') return;
    const away = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onKeep();
    };
    el.addEventListener('keydown', away);
    return () => el.removeEventListener('keydown', away);
  }, [state, onKeep]);
  // The confirm takes the focus as it opens, so a keyboard is where the question is.
  useEffect(() => title.current?.focus(), []);
  // A close that did not go through says why, and the focus goes to the sentence that says it.
  useEffect(() => {
    if (state === 'failed' || state === 'order-open' || state === 'not-empty')
      said.current?.focus();
  }, [state]);
  const close = async () => {
    setState('busy');
    const done = await closeVault(apiFetch, vault);
    if (done.kind === 'done') return onClosed();
    setState(done.kind === 'not-empty' || done.kind === 'order-open' ? done.kind : 'failed');
  };
  return (
    <Panel as="section" aria-labelledby={titleId} data-ui="vault-close-confirm">
      <div ref={box}>
        <PanelBody>
          <h2
            ref={title}
            id={titleId}
            tabIndex={-1}
            className="text-body-lg font-semibold outline-none"
          >
            {c.title}
          </h2>
          <p
            ref={state === 'not-empty' ? said : undefined}
            tabIndex={-1}
            className="max-w-(--tf-measure-body) text-body-sm outline-none"
          >
            {state === 'not-empty' ? c.notEmpty : c.body}
          </p>
          {(state === 'failed' || state === 'order-open') && (
            <p
              ref={said}
              tabIndex={-1}
              role="alert"
              className="text-body-sm text-destructive outline-none"
            >
              {state === 'failed' ? c.failed : c.orderOpen}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {state === 'not-empty' ? (
              <Button variant="primary" data-action="vault-close-withdraw" onClick={onWithdraw}>
                {t.withdraw.action}
              </Button>
            ) : (
              <Button
                variant="primary"
                data-action="vault-close-confirm"
                busy={state === 'busy'}
                onClick={close}
              >
                {state === 'busy' ? c.closing : c.confirm}
              </Button>
            )}
            <Button variant="secondary" data-action="vault-close-keep" onClick={onKeep}>
              {c.keep}
            </Button>
          </div>
        </PanelBody>
      </div>
    </Panel>
  );
}

/** A closed vault's note on its own page, to its owner: when it was closed, and the way back. */
export function ClosedNote({
  vault,
  closedAt,
  onReopened,
  focus = false,
}: {
  vault: Vault;
  closedAt: string;
  onReopened: () => void;
  /** Just closed here: the focus goes to the note that says so. */
  focus?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const c = t.shared.vault.page.closed;
  const apiFetch = useApiFetch();
  const titleId = useId();
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const title = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the note first shows
  useEffect(() => {
    if (focus) title.current?.focus();
  }, []);
  const date = new Intl.DateTimeFormat(LOCALE[lang], { dateStyle: 'medium' }).format(
    new Date(closedAt),
  );
  const reopen = async () => {
    setState('busy');
    const done = await reopenVault(apiFetch, vault);
    if (done.kind === 'done') return onReopened();
    setState('failed');
  };
  return (
    <Panel as="section" aria-labelledby={titleId} data-ui="vault-closed">
      <PanelBody>
        <h2
          ref={title}
          id={titleId}
          tabIndex={-1}
          className="text-body-lg font-semibold outline-none"
        >
          {c.title}
        </h2>
        <p className="max-w-(--tf-measure-body) text-body-sm">{c.body(date)}</p>
        {state === 'failed' && (
          <p role="alert" className="text-body-sm text-destructive">
            {c.failed}
          </p>
        )}
        <div>
          <Button
            variant="secondary"
            data-action="vault-reopen"
            busy={state === 'busy'}
            onClick={reopen}
          >
            {state === 'busy' ? c.reopening : c.reopen}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

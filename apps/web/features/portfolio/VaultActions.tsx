'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Field, Input } from '../../components/ui/Field';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as whole } from '../goal/sheet';
import { addMoneyPath } from '../order/order-api';
import { goalLine } from '../order/plain';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import type { PortfolioChain, Vault } from './portfolio';
import { usePortfolio } from './use-portfolio';
import { useVaultHistory } from './use-vault-history';
import { goalOfVault, type VaultGoal } from './vault-goal';
import { ownVault, type RenameOutcome, readName, renameVault } from './vault-name';

// What a person can do with a vault of theirs, on its card and on its page: add money to it, and name
// it. The name is theirs alone and is shown as text. A vault with no name is called by the goal its
// plan was built for, and with neither by its chain. Adding money is a page of its own (AddMoneyScreen):
// nothing here signs.

const NAME_MAX = 60;

export function VaultActions({
  chain,
  vault,
  joined,
  onRenamed,
  level = 3,
}: {
  chain: PortfolioChain;
  vault: Vault;
  /** The goal the vault was bought for, when one is known: its sentence is the default name. */
  joined: VaultGoal | null;
  /** The name changed on the server: read the portfolio again. */
  onRenamed?: () => void;
  /** The heading level of the name: under a chain's heading it is one lower than under the page's. */
  level?: 2 | 3;
}) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const words = t.portfolio.actions;
  const heading = useId();
  // The name as last saved here, until the portfolio is read again and says the same.
  const [saved, setSaved] = useState<{ name: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Exclude<RenameOutcome['kind'], 'saved'> | null>(null);

  const name = saved ? saved.name : (vault.name ?? null);
  const chainName = port.network(chain.chain)?.name ?? t.chain.names[chain.chain];
  const fallback = joined
    ? goalLine(joined.goal.sheet, t, whole(joined.goal.sheet.amountUsd, lang), (usd) =>
        whole(usd, lang),
      )
    : words.unnamed(chainName);
  const typed = readName(text);
  const Name = level === 2 ? 'h2' : 'h3';

  function open() {
    setText(name ?? '');
    setFailure(null);
    setEditing(true);
  }

  async function save(next: string | null) {
    setBusy(true);
    setFailure(null);
    const outcome = await renameVault(apiFetch, vault, next);
    setBusy(false);
    if (outcome.kind !== 'saved') return setFailure(outcome.kind);
    setSaved({ name: outcome.name });
    setEditing(false);
    onRenamed?.();
  }

  const failureSentence =
    failure === null
      ? undefined
      : failure === 'busy'
        ? t.shell.slowDown
        : failure === 'invalid'
          ? words.failure.invalid
          : failure === 'signed-out'
            ? words.failure.signedOut
            : failure === 'not-yours'
              ? words.failure.notYours
              : words.failure.unreachable;

  return (
    <section
      data-ui="vault-actions"
      aria-labelledby={heading}
      className="flex flex-col items-start gap-3"
    >
      <div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {/* The person's own words, as text: never markup, never a link. */}
        <Name
          id={heading}
          data-ui="vault-name"
          data-named={name !== null}
          className="min-w-0 text-h4 font-semibold [overflow-wrap:anywhere]"
        >
          {name ?? fallback}
        </Name>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            data-ui="vault-add-money"
            href={addMoneyPath(vault.chain, vault.address)}
            className={buttonClass({ variant: 'secondary', size: 'dense' })}
          >
            {words.addMoney}
          </Link>
          {!editing && (
            <Button variant="link" data-action="rename" onClick={open}>
              {words.rename}
            </Button>
          )}
        </p>
      </div>
      {editing && (
        <form
          data-ui="vault-rename-form"
          className="flex flex-col items-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed !== null) void save(typed);
          }}
        >
          <Field
            label={words.nameLabel}
            hint={words.nameHint}
            error={
              failureSentence ?? (text.trim() && typed === null ? words.failure.invalid : undefined)
            }
            announce={failure !== null}
          >
            {(control) => (
              <Input
                {...control}
                width="32ch"
                className="max-w-full"
                maxLength={NAME_MAX}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
              />
            )}
          </Field>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              variant="primary"
              size="dense"
              type="submit"
              busy={busy}
              busyLabel={words.saving}
              disabled={typed === null || typed === name}
            >
              {words.save}
            </Button>
            {name !== null && (
              <Button variant="link" disabled={busy} onClick={() => void save(null)}>
                {words.clear}
              </Button>
            )}
            <Button variant="link" disabled={busy} onClick={() => setEditing(false)}>
              {words.cancel}
            </Button>
          </p>
        </form>
      )}
    </section>
  );
}

/**
 * The same, on a vault's own page, which anybody can open: shown only to the person the vault is of,
 * as their own portfolio lists it, and to nobody else.
 */
export function OwnVaultActions({ chain, address }: { chain: string; address: string }) {
  const { state, again } = usePortfolio();
  if (state.kind !== 'answered' || state.outcome.kind !== 'read') return null;
  const own = ownVault(state.outcome.chains, chain, address);
  return own ? <OwnActions chain={own.entry} vault={own.vault} onRenamed={again} /> : null;
}

/** Only for the owner: their orders are read to name the vault by its goal. */
function OwnActions(props: { chain: PortfolioChain; vault: Vault; onRenamed: () => void }) {
  const history = useVaultHistory();
  return <VaultActions {...props} joined={goalOfVault(props.vault, history.records)} level={2} />;
}

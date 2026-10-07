'use client';
import type { ChainId } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { Status } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { ChainBadgeMarked, ChainMark } from '../account/ChainName';
import { ActivityPanel } from '../order/ActivityPanel';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import {
  addDecimals,
  chainTotal,
  holdingsOf,
  type PortfolioChain,
  sumSource,
  type Vault,
} from './portfolio';
import { usePortfolio } from './use-portfolio';
import { useVaultHistory } from './use-vault-history';
import { VaultActions } from './VaultActions';
import { VaultGoalCard } from './VaultGoalCard';
import { PlanParts, VaultPanel } from './VaultPanel';
import { familyOfVault, goalOfVault, ordersOfVault, putInto, takenOut } from './vault-goal';

// The monitor (/monitor): the person's vaults, read from the API each time the page opens (GET
// /v1/portfolio). One serif line, then the chain, then a panel per vault with its chain's badge, then
// the disclaimer under them (disclaimer-block.md: "Monitor, under the plan summary card"). Vaults on
// more than one chain are grouped by chain, a heading and a total each, and the one figure that adds
// chains up says so (gate CHAIN-EVERYWHERE). Where
// the API cannot say, a sentence says why and what to do; no holding is ever drawn in its place.
// Nothing here signs: there is no primary button, and the vault's switches are not offered.

const SIGN_IN = '/sign-in?next=/monitor';

/** A vault's cash this far over its plan's share, after a stopped buy, is worth a word: 5 points. */
const CASH_FAR_ABOVE_BPS = 500;

export function MonitorScreen() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { account, retry, mock } = useAccount();
  const { state, again, busy } = usePortfolio();
  const history = useVaultHistory();
  const words = t.portfolio;
  const link = buttonClass({ variant: 'link' });
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure };
  const groupId = useId();

  const chain = state.kind === 'reading' || state.kind === 'answered' ? state.chain : null;
  const network = chain ? port.network(chain) : null;
  const chainName = chain ? (network?.name ?? t.chain.names[chain]) : '';
  const outcome = state.kind === 'answered' && state.outcome.kind === 'read' ? state.outcome : null;
  const chains = outcome?.chains ?? [];
  const vaults = chains.flatMap((entry) => entry.vaults);
  // The chains the person holds a vault on. On one, the page is that chain's; on more, it is grouped.
  const held = chains.filter((entry) => entry.vaults.length > 0);
  // The chain the bar is on was read and holds no vault, while another does: the page says so first,
  // and names the chain of each vault below, so the bar and the page agree (the flow audit, 36).
  const emptyHere =
    outcome?.current === 'read' &&
    chain !== null &&
    held.length > 0 &&
    !held.some((entry) => entry.chain === chain);
  const grouped = held.length > 1 || emptyHere;
  const read = held.length === 1 ? held[0] : chains[0];
  const shownChain = read?.chain ?? chain;
  const nameOf = (id: ChainId) => port.network(id)?.name ?? t.chain.names[id];
  // How the chain is run: the API's word on the chain it read, or else the wallet's.
  const chainLabel = read?.provenance ?? network?.provenance ?? 'mock';
  /** What a chain's vaults are worth together, with the pin of that sum. */
  const totalOf = (entry: PortfolioChain) =>
    chainTotal(
      entry,
      words.vault.valueMethod,
      words.group.method(entry.vaults.length, nameOf(entry.chain)),
    );

  // The answer has nothing of the chain the bar is on. "No wallet of this sign-in is on <chain>" is
  // said only where there is none: where the account lists a wallet there, the chain was simply not
  // read this time, and the page says that (the flow audit, finding 37).
  const notHeld = outcome?.current === 'not-held' && chain !== null;
  const hasWallet = account.status === 'ready' && chain !== null && account.options.includes(chain);

  /**
   * A vault whose cash is far above its plan because a buy stopped after its deposit: said over the
   * vault, with the way to finish the buy with that cash. The order's own page makes the new order,
   * so this page still signs nothing.
   */
  const unfinishedOf = (vault: Vault) => {
    const cash = holdingsOf(vault).find((row) => row.cash);
    const order = ordersOfVault(vault, history.records).find((r) => history.stopped.has(r.orderId));
    if (!order || !cash || cash.driftBps < CASH_FAR_ABOVE_BPS) return null;
    return (
      <div
        data-ui="vault-unfinished"
        className="flex flex-col items-start gap-2 rounded-md border border-border bg-card p-4"
      >
        <Status status="watch">{words.vault.unfinished}</Status>
        <Link
          href={`/orders/${encodeURIComponent(order.orderId)}`}
          className={buttonClass({ variant: 'secondary' })}
        >
          {t.order.outcome.finish}
        </Link>
      </div>
    );
  };

  /** One vault: his guide's "Goal card and plan" side by side, then what the vault holds. */
  const vaultBlock = (entry: PortfolioChain, vault: Vault) => (
    <div key={vault.address} data-ui="vault" className="flex flex-col gap-6">
      <VaultActions
        chain={entry}
        vault={vault}
        joined={goalOfVault(vault, history.records, history.deposited)}
        onRenamed={again}
        level={grouped ? 3 : 2}
      />
      {unfinishedOf(vault)}
      <div className="grid items-start gap-6 min-[980px]:grid-cols-2">
        <VaultGoalCard
          chain={entry}
          vault={vault}
          joined={goalOfVault(vault, history.records, history.deposited)}
          putIn={putInto(vault, history.records, history.deposited)}
          followed={familyOfVault(vault, history.records)}
          tookOut={takenOut(vault, history.withdrawals, words.vault.takenOutMethod) !== null}
        />
        <PlanParts vault={vault} />
      </div>
      <VaultPanel
        chain={entry}
        vault={vault}
        taken={takenOut(vault, history.withdrawals, words.vault.takenOutMethod)}
      />
    </div>
  );

  /** What a chain's vaults are worth together: one chain's own sum, never one across chains. */
  const chainWorth = (entry: PortfolioChain) => {
    const total = totalOf(entry);
    return (
      <p key={`total-${entry.chain}`} data-ui="chain-total" className="text-body">
        {words.group.worth(entry.vaults.length, nameOf(entry.chain))}{' '}
        <ProvenancePin value={dollars(lang, total.valueUsd)} obs={total.obs} labels={t.pin} />
      </p>
    );
  };

  /** A chain's vaults under its heading, with what they are worth together on that chain. */
  const chainGroup = (entry: PortfolioChain) => {
    const name = nameOf(entry.chain);
    return (
      <section
        key={entry.chain}
        data-ui="chain-group"
        data-chain={entry.chain}
        aria-labelledby={`${groupId}-${entry.chain}`}
        className="flex flex-col gap-6"
      >
        <header className="flex flex-col gap-1 border-b border-border pb-3">
          <h2
            id={`${groupId}-${entry.chain}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-h3 font-semibold"
          >
            <span>{name}</span>
            <ChainMark provenance={entry.provenance} labels={marks} announce={false} />
          </h2>
          {chainWorth(entry)}
        </header>
        {entry.vaults.map((vault) => vaultBlock(entry, vault))}
      </section>
    );
  };

  const readAgain = (
    <Button
      variant="secondary"
      size="dense"
      busy={busy}
      busyLabel={words.againBusy}
      onClick={again}
    >
      {words.again}
    </Button>
  );
  /** A card that says one thing, and offers one thing to do. */
  const say = (sentence: string, action?: ReactNode) => (
    <Card>
      <CardEmpty sentence={sentence} action={action} />
    </Card>
  );

  let body: ReactNode;
  if (state.kind === 'loading' || state.kind === 'reading')
    body = (
      <Card>
        <CardWait label={words.reading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  else if (state.kind === 'signed-out')
    body = say(
      words.signedOut,
      <Link href={SIGN_IN} className={link}>
        {t.shell.signIn}
      </Link>,
    );
  else if (state.kind === 'no-account-chain')
    body =
      account.status === 'unknown'
        ? say(
            t.chain.unknown.body,
            <Button variant="link" onClick={retry}>
              {t.chain.unknown.retry}
            </Button>,
          )
        : account.status === 'no-wallet'
          ? say(t.chain.noWallet)
          : say(
              words.noChain,
              <Link href={SIGN_IN} className={link}>
                {words.chooseChain}
              </Link>,
            );
  else {
    switch (state.outcome.kind) {
      case 'read':
        // Each chain that could not be read says so; the ones that were read are shown all the same.
        body = (
          <>
            {(state.outcome.unavailable.length > 0 || notHeld) && (
              <ul data-ui="chains-out" className="flex flex-col gap-1.5">
                {state.outcome.unavailable.map((u) => (
                  <li key={u.chain} data-chain={u.chain}>
                    <Status status="watch">
                      {u.retryable
                        ? words.chainOut(nameOf(u.chain))
                        : words.chainOff(nameOf(u.chain))}
                    </Status>
                  </li>
                ))}
                {notHeld && chain && (
                  <li data-chain={chain}>
                    <Status status="watch">
                      {(hasWallet ? words.chainOut : words.notHeld)(nameOf(chain))}
                    </Status>
                  </li>
                )}
              </ul>
            )}
            {/* a chain that may answer next time, or one a wallet is on that was not read, is asked again */}
            {(state.outcome.unavailable.some((u) => u.retryable) || (notHeld && hasWallet)) && (
              <div>{readAgain}</div>
            )}
            {/* "No vault on <chain> yet" is said only of a chain that was read, and only when every
                chain of theirs was: a chain that could not be read may hold one. */}
            {vaults.length === 0 &&
            state.outcome.current === 'read' &&
            state.outcome.unavailable.length === 0 ? (
              say(
                words.empty(chainName),
                <Link href="/goal" className={link}>
                  {words.startGoal}
                </Link>,
              )
            ) : vaults.length === 0 ? null : grouped ? (
              <>
                {emptyHere && (
                  <p data-ui="chain-empty" data-chain={chain ?? undefined} className="text-body">
                    {words.empty(chainName)}{' '}
                    <Link href="/goal" className={link}>
                      {words.startGoal}
                    </Link>
                  </p>
                )}
                {held.length > 1 && <AcrossChains totals={held.map(totalOf)} />}
                {held.map(chainGroup)}
              </>
            ) : (
              held.flatMap((entry) => [
                // Several vaults on the one chain: what they are worth together, on that chain.
                ...(entry.vaults.length > 1 ? [chainWorth(entry)] : []),
                ...entry.vaults.map((vault) => vaultBlock(entry, vault)),
              ])
            )}
          </>
        );
        break;
      case 'unavailable':
        body = say(
          words.unavailable,
          <Link href="/goal" className={link}>
            {words.startGoal}
          </Link>,
        );
        break;
      case 'chain-down':
        body = (
          <Card>
            <CardBody className="flex flex-col items-start gap-3">
              <Status status="watch">{words.down.word}</Status>
              <p className="max-w-(--tf-measure-body) text-body-sm">{words.down.body(chainName)}</p>
              {readAgain}
            </CardBody>
          </Card>
        );
        break;
      // The throwaway wallet of development has no account on a real API: that is why, not the
      // sign-in. A stand-in API that answers it is read like any other.
      case 'signed-out':
        body = say(mock ? words.throwaway : words.signInAgain);
        break;
      case 'no-identity':
        body = mock ? say(words.throwaway) : say(words.noIdentity, readAgain);
        break;
      case 'no-chain':
        body = say(
          words.noChain,
          <Link href={SIGN_IN} className={link}>
            {words.chooseChain}
          </Link>,
        );
        break;
      case 'busy':
        body = say(t.shell.slowDown, readAgain);
        break;
      case 'unreachable':
        body = say(words.unreachable, readAgain);
        break;
      case 'unreadable':
        body = say(words.unreadable, readAgain);
        break;
    }
  }

  return (
    <div data-ui="monitor-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {/* The serif answers once per screen: with goal cards below, their sentences are it, and the
            page heading is the sans face (goal-card.md). */}
        <h1 className={vaults.length > 0 ? 'font-sans text-h2 font-semibold' : PAGE_TITLE}>
          {words.title(vaults.length)}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{words.lead}</p>
        {/* Another plan is always on offer: each plan bought opens a vault of its own. */}
        {vaults.length > 0 && (
          <Link
            data-ui="new-plan"
            href="/goal"
            className={buttonClass({ variant: 'secondary', size: 'dense' })}
          >
            {words.actions.newPlan}
          </Link>
        )}
        {shownChain && !grouped && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm">
            <span className="text-caption text-muted-foreground">{words.chain}</span>
            <ChainBadgeMarked chain={shownChain} provenance={chainLabel} labels={marks} />
          </p>
        )}
      </header>
      <p role="status" className="sr-only">
        {busy ? words.reading : ''}
      </p>
      <div aria-busy={busy} className="flex flex-col gap-6">
        {body}
      </div>
      {/* His "Disclaimer and activity": the disclaimer under the plans, beside what reached the chain. */}
      {vaults.length > 0 && (
        <ActivityPanel
          groups={history.activity}
          empty={t.activity.noneVault}
          // one chain, named in the page's head: the lines do not repeat it. The list holds every
          // chain's orders, though: with a line on another chain, every line says its own.
          chainTags={
            grouped ||
            !shownChain ||
            history.activity.some((group) =>
              group.executions.some((e) => e.chain != null && e.chain !== shownChain),
            )
          }
        />
      )}
    </div>
  );
}

/**
 * The one figure that adds chains up, and says so: each chain's total, added, labelled as across
 * them. Each chain's own total stands under its heading.
 */
function AcrossChains({ totals }: { totals: ReturnType<typeof chainTotal>[] }) {
  const t = useT();
  const lang = useLang();
  const words = t.portfolio.group;
  return (
    <p data-ui="across-chains" className="text-body">
      {words.across(totals.length)}:{' '}
      <ProvenancePin
        value={dollars(lang, addDecimals(totals.map((total) => total.valueUsd)))}
        obs={sumSource(
          totals.map((total) => total.obs),
          words.acrossMethod(totals.length),
        )}
        labels={t.pin}
      />
    </p>
  );
}

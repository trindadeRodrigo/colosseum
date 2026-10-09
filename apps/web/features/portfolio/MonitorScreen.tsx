'use client';
import type { ChainId } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Status } from '../../components/ui/StatusMark';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { ChainBadgeMarked, ChainMark } from '../account/ChainName';
import { ActivityPanel } from '../order/ActivityPanel';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { HoldingsBar } from '../shared/HoldingsBar';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars, sharesOf } from './figures';
import { MonitorHeadWait, MonitorVaultsWait } from './MonitorWait';
import {
  addDecimals,
  chainTotal,
  holdingsOf,
  type PortfolioChain,
  sumSource,
  type Vault,
  vaultValueSource,
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

  const outcome = state.kind === 'answered' && state.outcome.kind === 'read' ? state.outcome : null;
  const chains = outcome?.chains ?? [];
  const vaults = chains.flatMap((entry) => entry.vaults);
  // The chains the person holds a vault on. On one, the page is that chain's; on more, it is grouped.
  const held = chains.filter((entry) => entry.vaults.length > 0);
  const grouped = held.length > 1;
  const read = held.length === 1 ? held[0] : chains[0];
  const shownChain = read?.chain ?? null;
  const nameOf = (id: ChainId) => port.network(id)?.name ?? t.chain.names[id];
  // How the chain is run: the API's word on the chain it read, or else the wallet's.
  const chainLabel =
    read?.provenance ?? (shownChain ? port.network(shownChain)?.provenance : null) ?? 'mock';
  /** What a chain's vaults are worth together, with the pin of that sum. */
  const totalOf = (entry: PortfolioChain) =>
    chainTotal(
      entry,
      words.vault.valueMethod,
      words.group.method(entry.vaults.length, nameOf(entry.chain)),
    );

  // The chains a wallet of theirs signs on, as the account lists them, and the ones among them the
  // answer says nothing of, read or unavailable: each was simply not read this time, and the page
  // says that of the chain by name (the flow audit, finding 37). No chain is "the current one" here.
  const mine = account.status === 'ready' ? account.options : [];
  const unread = outcome
    ? mine.filter(
        (id) =>
          !outcome.chains.some((entry) => entry.chain === id) &&
          !outcome.unavailable.some((u) => u.chain === id),
      )
    : [];
  const list = (names: string[]) =>
    new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(names);

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
        className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4"
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

  /** A current-holdings card; the existing full read and goal remain available under its fold. */
  const vaultBlock = (entry: PortfolioChain, vault: Vault) => {
    const rows = holdingsOf(vault).filter((row) => !/^0+$/.test(row.raw));
    const priced = rows.filter((row) => row.valueUsd !== null && row.weightBps > 0);
    const shares = sharesOf(
      lang,
      rows.map((row) => (row.valueUsd === null ? 0 : row.weightBps)),
    );
    const missing = rows.filter((row) => row.valueUsd === null).length;
    const valueSource = vaultValueSource(entry, vault, words.vault.valueMethod);
    const page = `/vaults/${encodeURIComponent(entry.chain)}/${encodeURIComponent(vault.address)}`;
    return (
      <section key={vault.address} data-ui="vault" className="flex min-w-0">
        <Card
          as="article"
          density="dense"
          className="h-full w-full min-w-0"
          mock={valueSource.provenance !== 'live'}
          mockLabels={{
            announce:
              valueSource.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
          }}
        >
          <CardBody density="dense" className="flex min-w-0 flex-col gap-4">
            <div data-ui="vault-summary" className="flex min-w-0 flex-col gap-4">
              <VaultActions
                chain={entry}
                vault={vault}
                joined={goalOfVault(vault, history.records, history.deposited)}
                onRenamed={again}
                level={grouped ? 3 : 2}
              />
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <ChainBadgeMarked
                  chain={entry.chain}
                  provenance={entry.provenance}
                  labels={marks}
                />
                <dl data-ui="vault-summary-value" className="text-end">
                  <dt className="text-caption text-muted-foreground">{words.vault.value}</dt>
                  <dd className="text-h3 tabular-nums">
                    <ProvenancePin
                      value={dollars(lang, vault.valueUsd)}
                      obs={valueSource}
                      labels={t.pin}
                    />
                  </dd>
                </dl>
              </div>
              {priced.length > 0 && (
                <HoldingsBar
                  shares={priced.map((row) => ({ key: row.asset, shareBps: row.weightBps }))}
                />
              )}
              {rows.length === 0 ? (
                <p className="text-body-sm text-muted-foreground">
                  {t.shared.vault.conversation.noHoldings}
                </p>
              ) : (
                <ul
                  data-ui="vault-summary-holdings"
                  className="grid gap-x-5 gap-y-2 sm:grid-cols-2"
                >
                  {rows.map((row, index) => (
                    <li key={row.asset} className="flex min-w-0 items-center gap-2 text-body-sm">
                      <AssetMark asset={row.asset} />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {displayName(row.asset, t.plan)}
                      </span>{' '}
                      <span className="shrink-0 tabular-nums">
                        {row.valueUsd === null ? '—' : shares[index]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {missing > 0 && (
                <p data-ui="vault-summary-unpriced" className="text-caption text-muted-foreground">
                  {words.vault.unpriced(missing)}
                </p>
              )}
              <nav
                aria-label={words.overview.actions}
                className="flex flex-wrap items-center gap-x-5 gap-y-2"
              >
                <Link href={page} className={buttonClass({ variant: 'link' })}>
                  {words.overview.open}
                </Link>
                <Link
                  href={`${page}#vault-conversation`}
                  className={buttonClass({ variant: 'link' })}
                >
                  {t.shared.vault.conversation.resume}
                </Link>
              </nav>
            </div>
            {unfinishedOf(vault)}
            <details data-ui="vault-read-details" className="border-t border-border pt-3">
              <summary className="cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {words.overview.details}
              </summary>
              <div className="flex min-w-0 flex-col gap-4 pt-4">
                <VaultPanel
                  chain={entry}
                  vault={vault}
                  taken={takenOut(vault, history.withdrawals, words.vault.takenOutMethod)}
                />
                <details>
                  <summary className="cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                    {words.planDetails}
                  </summary>
                  <div className="flex min-w-0 flex-col gap-4 pt-4">
                    <VaultGoalCard
                      chain={entry}
                      vault={vault}
                      joined={goalOfVault(vault, history.records, history.deposited)}
                      putIn={putInto(vault, history.records, history.deposited)}
                      followed={familyOfVault(vault, history.records)}
                      tookOut={
                        takenOut(vault, history.withdrawals, words.vault.takenOutMethod) !== null
                      }
                    />
                    <PlanParts vault={vault} />
                  </div>
                </details>
              </div>
            </details>
          </CardBody>
        </Card>
      </section>
    );
  };

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
        <div data-ui="vault-grid" className="grid items-start gap-5 lg:grid-cols-2">
          {entry.vaults.map((vault) => vaultBlock(entry, vault))}
        </div>
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
    body = <ScreenWait label={words.reading} skeleton={<MonitorVaultsWait />} onRetry={again} />;
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
            {(state.outcome.unavailable.length > 0 || unread.length > 0) && (
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
                {unread.map((id) => (
                  <li key={id} data-chain={id}>
                    <Status status="watch">{words.chainOut(nameOf(id))}</Status>
                  </li>
                ))}
              </ul>
            )}
            {/* a chain that may answer next time, or one a wallet is on that was not read, is asked again */}
            {(state.outcome.unavailable.some((u) => u.retryable) || unread.length > 0) && (
              <div>{readAgain}</div>
            )}
            {/* "You have no vault yet" is said only when every chain of theirs was read: a chain
                that could not be read may hold one. */}
            {vaults.length === 0 && unread.length === 0 && state.outcome.unavailable.length === 0
              ? say(
                  words.empty,
                  <Link href="/goal" className={link}>
                    {words.startGoal}
                  </Link>,
                )
              : vaults.length === 0
                ? null
                : grouped
                  ? held.map(chainGroup)
                  : held.map((entry) => (
                      <div key={entry.chain} className="flex min-w-0 flex-col gap-4">
                        {entry.vaults.length > 1 && chainWorth(entry)}
                        <div data-ui="vault-grid" className="grid items-start gap-5 lg:grid-cols-2">
                          {entry.vaults.map((vault) => vaultBlock(entry, vault))}
                        </div>
                      </div>
                    ))}
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
              <p className="max-w-(--tf-measure-body) text-body-sm">
                {words.down.body(list(mine.map(nameOf)))}
              </p>
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
        {/* The page names itself to a screen reader only: the goal cards below say what each vault is. */}
        <h1 className={vaults.length > 0 ? 'sr-only' : `${PAGE_TITLE} sr-only`}>
          {words.title(vaults.length)}
        </h1>
        {/* While the vaults are read, the sums and the way to a new plan keep their place. */}
        {(state.kind === 'loading' || state.kind === 'reading') && <MonitorHeadWait />}
        {held.length > 0 && outcome && (
          <PortfolioSummary
            totals={held.map(totalOf)}
            vaultCount={vaults.length}
            holdingCount={vaults.reduce(
              (count, vault) =>
                count + holdingsOf(vault).filter((row) => !/^0+$/.test(row.raw)).length,
              0,
            )}
            unpricedCount={vaults.reduce(
              (count, vault) =>
                count +
                holdingsOf(vault).filter((row) => !/^0+$/.test(row.raw) && row.valueUsd === null)
                  .length,
              0,
            )}
            partial={outcome.unavailable.length > 0 || unread.length > 0}
          />
        )}
        {/* Another plan is always on offer: each plan bought opens a vault of its own. */}
        {vaults.length > 0 && (
          <Link
            data-ui="new-plan"
            href="/goal"
            // Honey, so the way to a new plan stands out: a honey edge on its tint, ink text (IDENTITY-2).
            className="inline-flex h-8 items-center justify-center self-start rounded-md border border-primary bg-honey-tint px-3 text-body-sm font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
          foldActivity
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

/** A sum of the vaults actually read, with the same source policy as each chain's own total. */
function PortfolioSummary({
  totals,
  vaultCount,
  holdingCount,
  unpricedCount,
  partial,
}: {
  totals: ReturnType<typeof chainTotal>[];
  vaultCount: number;
  holdingCount: number;
  unpricedCount: number;
  partial: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.portfolio.overview;
  // This component is mounted only for held, non-empty chains; no unavailable read becomes zero.
  const only = totals[0];
  if (!only) return null;
  return (
    <section
      data-ui="portfolio-summary"
      aria-label={words.title}
      className="flex w-full min-w-0 flex-col gap-3 border-y border-border py-5"
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div
          data-ui={totals.length > 1 ? 'across-chains' : undefined}
          className="col-span-2 min-w-0 sm:col-span-1"
        >
          <dt className="text-caption text-muted-foreground">
            {partial ? words.partialValue : words.value}
          </dt>
          <dd data-ui="portfolio-total" className="text-h2 tabular-nums">
            <ProvenancePin
              value={dollars(lang, addDecimals(totals.map((total) => total.valueUsd)))}
              obs={
                totals.length === 1
                  ? only.obs
                  : sumSource(
                      totals.map((total) => total.obs),
                      t.portfolio.group.acrossMethod(totals.length),
                    )
              }
              labels={t.pin}
            />
            {totals.length > 1 && (
              <span className="block text-caption text-muted-foreground">
                {t.portfolio.group.across(totals.length)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-muted-foreground">{words.vaults}</dt>
          <dd data-ui="portfolio-vault-count" className="text-h2 tabular-nums">
            {vaultCount}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-muted-foreground">{words.holdings}</dt>
          <dd data-ui="portfolio-holding-count" className="text-h2 tabular-nums">
            {holdingCount}
          </dd>
        </div>
      </dl>
      {partial && (
        <p data-ui="portfolio-partial" className="text-caption text-muted-foreground">
          {words.partial}
        </p>
      )}
      {unpricedCount > 0 && (
        <p data-ui="portfolio-unpriced" className="text-caption text-muted-foreground">
          {t.portfolio.vault.unpriced(unpricedCount)}
        </p>
      )}
    </section>
  );
}

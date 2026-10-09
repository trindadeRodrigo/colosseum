'use client';
import Link from 'next/link';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody } from '../../components/ui/Card';
import { ExplorerLink } from '../../components/ui/ExplorerLink';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { explorerUrlFor, onMock } from '../order/readiness';
import { utc } from '../portfolio/figures';
import { useWalletPort } from '../wallet/WalletProvider';
import type { Plan, PlansChain, RebalancesAnswer, RebalancesChain } from './api';
import { REBALANCES_ASKED, type Reading } from './PortfolioProvider';
import { href } from './pages';
import { ChainsOut, sampleLine } from './parts';
import { leastLive } from './pins';
import { Block, BlockRead, sameVault } from './plan-blocks';
import { useWords } from './words';

// The latest steps that traded for a plan's vault, from the section's read of the rebalances narrowed
// to that vault: when, whose, what was traded and how it ended, and the way to the rebalancing page
// for all of them. Kept small: that page owns the list, with its quotes, prices and drifts.
//
// It says no more than the answer does (DESIGN-VAULT 3.3, "Rebalances"). A step of the person's is
// timed at when it was built, since nothing records when it confirmed; a trade of the keeper's is
// worked out from two snapshots, with no transaction to link. A transaction is linked on the explorer
// of the network this app signs for, never by the address the answer carries, and not at all on the
// mock, whose transactions are no network's.

/** How many of the vault's steps the page shows. */
const FEW = 3;

type Entry = RebalancesChain['entries'][number];

export function PlanTrades({
  chain,
  plan,
  read,
}: {
  chain: PlansChain;
  plan: Plan;
  read: Reading<RebalancesAnswer>;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const port = useWalletPort();
  const words = w.plan.trades;
  const name = (asset: string) => displayName(asset, t.plan);

  const what = (entry: Entry): string => {
    if (entry.trades.length > 0)
      return entry.trades.map((trade) => words.trade(name(trade.sell), name(trade.buy))).join(', ');
    if (entry.kind === 'accept_version' || entry.kind === 'adopt_version') return words.version;
    return entry.kind ? t.order.kind[entry.kind] : words.noTrade;
  };

  return (
    <Block ui="plan-trades" heading={words.heading} lead={words.lead}>
      <BlockRead read={read} label={words.reading} skeleton={<SkeletonRows rows={3} columns={3} />}>
        {(answer) => {
          const out = answer.unavailable.find((u) => u.chain === plan.chain);
          if (out) return <ChainsOut unavailable={[out]} />;
          const entry = answer.chains.find((c) => c.chain === plan.chain);
          const own = (entry?.entries ?? []).filter(
            (step) => step.vault !== null && sameVault(step.vault, plan.address),
          );
          const shown = own.slice(0, FEW);
          const label = leastLive(
            chain.provenance,
            plan.provenance,
            ...(entry ? [entry.provenance] : []),
          );
          // The mock's transactions are no network's: nothing to link.
          const mock = label === 'mock' || onMock(port, plan.chain);
          // The section asks for the newest steps of every vault: at its limit, an older step of this
          // one may not have come.
          const cut =
            answer.chains.reduce((n, c) => n + c.entries.length, 0) >= REBALANCES_ASKED &&
            own.length < FEW;
          const all = (
            <Link href={href('rebalancing')} className={buttonClass({ variant: 'link' })}>
              {words.all}
            </Link>
          );
          if (shown.length === 0)
            return (
              <div data-ui="trades-none" className="flex flex-col items-start gap-2">
                <p className="text-body-sm text-foreground">{words.none}</p>
                {cut && (
                  <p data-ui="trades-cut" className="text-caption text-muted-foreground">
                    {words.cut(REBALANCES_ASKED)}
                  </p>
                )}
                {all}
              </div>
            );
          return (
            <Card mock={label !== 'live'} mockLabels={{ announce: sampleLine(t.shell, label) }}>
              <CardBody className="flex flex-col items-start gap-3">
                <ul data-ui="trades-list" className="w-full list-none divide-y divide-border p-0">
                  {shown.map((step, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: two attempts of one step can share every field but their place in the list
                      key={`${step.at}:${step.txId ?? ''}:${i}`}
                      data-by={step.by}
                      data-outcome={step.outcome}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-body-sm first:pt-0 last:pb-0"
                    >
                      <span className="font-medium">{words.by[step.by]}</span>
                      <span aria-hidden="true">·</span>
                      <span data-ui="trade-what">{what(step)}</span>
                      <span aria-hidden="true">·</span>
                      {step.outcome === 'failed' ? (
                        <span
                          data-ui="trade-outcome"
                          className="inline-flex items-center gap-1.5 text-status-off"
                        >
                          <StatusMark status="off-track" />
                          <span>{t.activity.status.failed}</span>
                        </span>
                      ) : (
                        <span data-ui="trade-outcome">{t.activity.status.confirmed}</span>
                      )}
                      <span aria-hidden="true">·</span>
                      <time dateTime={step.at} className="tabular-nums text-muted-foreground">
                        {step.by === 'keeper'
                          ? words.traded(utc(lang, step.at))
                          : words.built(utc(lang, step.at))}
                      </time>
                      {step.derived && (
                        <span
                          data-ui="trade-derived"
                          className="text-caption text-muted-foreground"
                        >
                          {words.derived}
                        </span>
                      )}
                      {step.txId && (
                        <span className="ml-auto">
                          <ExplorerLink
                            signature={step.txId}
                            href={mock ? null : explorerUrlFor(step.chain, step.txId, false)}
                            explorer={t.chain.explorers[step.chain]}
                            labels={t.order.link}
                          />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {own.length > shown.length && (
                  <p data-ui="trades-more" className="text-caption text-muted-foreground">
                    {words.more(own.length - shown.length)}
                  </p>
                )}
                {cut && (
                  <p data-ui="trades-cut" className="text-caption text-muted-foreground">
                    {words.cut(REBALANCES_ASKED)}
                  </p>
                )}
                {all}
              </CardBody>
            </Card>
          );
        }}
      </BlockRead>
    </Block>
  );
}

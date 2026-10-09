'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as goalDollars } from '../goal/sheet';
import { tokenName } from '../order/amounts';
import { type OrderRecord, recallOrders } from '../order/order-record';
import { AssetMark } from '../order/PlanView';
import { goalLine } from '../order/plain';
import { SECTION } from '../portfolio-section/pages';
import { HoldingsBar } from '../shared/HoldingsBar';
import { shortAddress } from '../shared/use-person';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars, sharesOf } from './figures';
import { holdingsOf, unpriced, vaultValueSource } from './portfolio';
import { usePortfolio } from './use-portfolio';
import { goalOfVault } from './vault-goal';

// A collapsed vault switcher below the workbench: each read value has its own source and chain, never a sum.
// Names fall back to this browser's saved goal records, then the address. No history route is added.
export function PortfolioSummary() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { state } = usePortfolio();
  const heading = useId();
  const [history, setHistory] = useState<{ who: string | null; records: OrderRecord[] } | null>(
    null,
  );
  useEffect(
    () => setHistory({ who: port.userId, records: recallOrders(port.userId) }),
    [port.userId],
  );
  const records = history?.who === port.userId ? history.records : [];
  if (state.kind !== 'answered' || state.outcome.kind !== 'read') return null;
  const held = state.outcome.chains.flatMap((entry) =>
    entry.vaults.map((vault) => ({ entry, vault })),
  );
  if (held.length === 0) return null;
  return (
    <section
      data-ui="owned-vaults"
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex items-baseline justify-between gap-4">
        <details data-ui="vault-switcher" className="min-w-0 flex-1">
          <summary className="cursor-pointer text-body-sm">
            <h2 id={heading} className="inline text-body-sm font-medium">
              {t.portfolio.summary.title}
            </h2>
          </summary>
          <ul className="mt-3 flex min-w-0 flex-col gap-2">
            {held.map(({ entry, vault }) => {
              const goal = goalOfVault(vault, records)?.goal.sheet;
              const name =
                vault.name ??
                (goal
                  ? goalLine(goal, t, goalDollars(goal.amountUsd, lang), (usd) =>
                      goalDollars(usd, lang),
                    )
                  : t.shared.vaults.address(shortAddress(vault.address)));
              const source = vaultValueSource(entry, vault, t.portfolio.vault.valueMethod);
              const holdings = holdingsOf(vault).filter((row) => !/^0+$/.test(row.raw));
              const measured = holdings.filter((row) => row.valueUsd !== null && row.weightBps > 0);
              const shares = sharesOf(
                lang,
                holdings.map((row) => (row.valueUsd === null ? 0 : row.weightBps)),
              );
              const titleId = `${heading}-${vault.chain}-${vault.address}`;
              return (
                <li
                  key={`${vault.chain}:${vault.address}`}
                  data-ui="owned-vault"
                  className="min-w-0"
                >
                  <Card
                    as="article"
                    density="dense"
                    interactive
                    aria-labelledby={titleId}
                    mock={source.provenance !== 'live'}
                    mockLabels={{
                      announce:
                        source.provenance === 'sandbox'
                          ? t.shell.testNetworkLine
                          : t.shell.mockAnnounce,
                    }}
                  >
                    <div className="grid min-w-0 gap-x-4 gap-y-2 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        <h3
                          id={titleId}
                          className="min-w-0 text-body-sm font-semibold [overflow-wrap:anywhere]"
                        >
                          {name}
                        </h3>
                        <ChainBadge chain={vault.chain} />
                      </div>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="text-caption text-muted-foreground">
                          {t.portfolio.vault.value}
                        </span>
                        <ProvenancePin
                          value={dollars(lang, vault.valueUsd)}
                          obs={source}
                          labels={t.pin}
                        />
                      </div>
                      <div
                        data-ui="owned-vault-holdings"
                        className="flex w-full min-w-0 flex-col gap-1 sm:col-span-2"
                      >
                        <p className="text-caption text-muted-foreground">{t.plan.holds}</p>
                        {measured.length > 0 && (
                          <HoldingsBar
                            shares={measured.map((row) => ({
                              key: row.asset,
                              shareBps: row.weightBps,
                            }))}
                          />
                        )}
                        {holdings.length > 0 ? (
                          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 font-mono text-source">
                            {holdings.map((row, i) => (
                              <li
                                key={row.asset}
                                data-asset={row.asset}
                                className="inline-flex min-w-0 max-w-full items-center gap-1.5 [overflow-wrap:anywhere]"
                              >
                                <AssetMark asset={row.asset} className="size-5" />
                                <span className="min-w-0">
                                  {tokenName(row.asset)} {row.valueUsd === null ? '—' : shares[i]}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-body-sm text-muted-foreground">{t.withdraw.empty}</p>
                        )}
                      </div>
                      {unpriced(vault) > 0 && (
                        <p className="text-caption text-muted-foreground sm:col-span-2">
                          {t.portfolio.vault.unpriced(unpriced(vault))}
                        </p>
                      )}
                      <Link
                        href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
                        className={buttonClass({ variant: 'link' })}
                      >
                        {t.shared.vaults.open}
                      </Link>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </details>
        <Link
          data-ui="portfolio-link"
          href="/monitor"
          className={`${buttonClass({ variant: 'link' })} shrink-0 text-body-sm`}
        >
          {t.portfolio.summary.see}
        </Link>
        {/* The same plans over time: the portfolio section (PORT-3). A text link beside the first. */}
        <Link
          data-ui="plans-over-time"
          href={SECTION}
          className={`${buttonClass({ variant: 'link' })} shrink-0 text-body-sm`}
        >
          {t.portfolio.summary.overTime}
        </Link>
      </div>
    </section>
  );
}

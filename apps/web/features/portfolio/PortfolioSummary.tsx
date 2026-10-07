'use client';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as goalDollars } from '../goal/sheet';
import { type OrderRecord, recallOrders } from '../order/order-record';
import { goalLine } from '../order/plain';
import { shortAddress } from '../shared/use-person';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import { unpriced, vaultValueSource } from './portfolio';
import { usePortfolio } from './use-portfolio';
import { goalOfVault } from './vault-goal';

// Existing vaults below the conversation: each read value has its own source and chain, never a sum.
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
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id={heading} className="text-h4 font-semibold">
          {t.portfolio.summary.title}
        </h2>
        <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
          {t.portfolio.summary.see}
        </Link>
      </header>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          const titleId = `${heading}-${vault.chain}-${vault.address}`;
          return (
            <li key={`${vault.chain}:${vault.address}`} data-ui="owned-vault" className="min-w-0">
              <Card
                as="article"
                interactive
                aria-labelledby={titleId}
                className="h-full"
                mock={source.provenance !== 'live'}
                mockLabels={{
                  announce:
                    source.provenance === 'sandbox'
                      ? t.shell.testNetworkLine
                      : t.shell.mockAnnounce,
                }}
              >
                <div className="flex min-w-0 flex-col items-start gap-3 p-6">
                  <ChainBadge chain={vault.chain} />
                  <h3 id={titleId} className="w-full break-words text-body font-semibold">
                    {name}
                  </h3>
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
                  {unpriced(vault) > 0 && (
                    <p className="text-body-sm text-muted-foreground">
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
    </section>
  );
}

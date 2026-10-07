'use client';
import { ChainId, chainFamily, type Price, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { DataTable } from '../../components/ui/DataTable';
import { PAGE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import type { CallFailure } from '../order/order-api';
import { displayName } from '../order/plain';
import { explorerAddressUrlFor } from '../order/readiness';
import { dollars, drift, sharesOf, tokens } from '../portfolio/figures';
import { type HoldingRow, holdingsOf, vaultValueSource } from '../portfolio/portfolio';
import { OwnVaultActions } from '../portfolio/VaultActions';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { readVault } from './shared-api';

// A vault, for anybody (DESIGN-VAULT section 11, the public vault page): its owner, what it
// follows, its value, and what it holds, cash included, each with its share now, planned share, the
// difference and its price, as its chain holds it now (GET /v1/vaults/{chain}/{address}). Its figures
// are written as the portfolio writes them (features/portfolio/figures.ts), so the two pages agree to
// the digit. Every price carries its pin (STYLE.md rule 1); a vault on the mock or a test network says
// so in its card's line. It leads back to the portfolio, and to the chain's explorer where there is one.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };

export function VaultScreen({ chain, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  // The vault is read once for an address, and again only when asked: the reader is kept in a ref,
  // so a change of the sign-in around it does not ask the server again (the flow audit, 35).
  const fetcher = useRef(apiFetch);
  fetcher.current = apiFetch;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const titleId = useId();
  const known = ChainId.safeParse(chain);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the vault again
  useEffect(() => {
    if (!known.success) return setLoad({ kind: 'no-plan' });
    let mine = true;
    setLoad({ kind: 'loading' });
    readVault(fetcher.current, known.data, address).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', read: read.value } : read);
    });
    return () => {
      mine = false;
    };
  }, [chain, address, round]);

  if (load.kind === 'loading')
    return (
      <Card>
        <CardWait label={v.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (load.kind !== 'read')
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {load.kind === 'no-plan' || load.kind === 'refused' ? v.missing : v.title}
        </h1>
        {load.kind !== 'no-plan' && load.kind !== 'refused' && (
          <>
            <p className="max-w-(--tf-measure-body) text-body">
              {load.kind === 'busy' ? t.shell.slowDown : t.shared.shelf.failure.unreachable}
            </p>
            <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
              {t.shared.shelf.failure.retry}
            </Button>
          </>
        )}
        <Link href="/shelf" className={buttonClass({ variant: 'secondary' })}>
          {t.shared.family.backToShelf}
        </Link>
        <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
          {v.back}
        </Link>
      </section>
    );

  const { read } = load;
  const { vault } = read;
  const priceOf = (asset: string): Price | undefined => read.prices.find((p) => p.asset === asset);
  const follows = vault.recipeOnchainId;
  // The rows' shares, rounded together so they add up to the whole, as the portfolio writes them.
  const rows = holdingsOf(vault);
  const at = (asset: string) => rows.findIndex((r) => r.asset === asset);
  const now = sharesOf(
    lang,
    rows.map((r) => r.weightBps),
  );
  const planned = sharesOf(
    lang,
    rows.map((r) => r.targetBps),
  );
  const explorer = explorerAddressUrlFor(read.chain, vault.address, read.provenance === 'mock');
  const mine = port.active(chainFamily(read.chain))?.address === vault.owner;
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));
  return (
    <div data-ui="vault-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={read.chain} />
        <h1 id={titleId} className={PAGE_TITLE}>
          {v.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{v.lead(read.name)}</p>
        <p className="break-all font-mono text-source text-muted-foreground">{vault.address}</p>
        {/* the way back, and the vault on its chain's own explorer */}
        <p className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
            {v.back}
          </Link>
          {explorer && (
            <a
              data-ui="vault-explorer"
              href={explorer}
              target="_blank"
              rel="noopener"
              className={buttonClass({ variant: 'link' })}
            >
              {v.explorer(t.chain.explorers[read.chain])}
              <Icon name="ArrowUpRight" size={16} />
            </a>
          )}
        </p>
        {/* The owner's way out, shown to the owner alone: a vault pays nobody else. */}
        {mine &&
          (empty ? (
            <p data-ui="vault-empty" className="text-body">
              {t.withdraw.empty}
            </p>
          ) : (
            <Link
              data-ui="vault-withdraw"
              href={`/vaults/${encodeURIComponent(read.chain)}/${encodeURIComponent(vault.address)}/withdraw`}
              className={buttonClass({ variant: 'secondary' })}
            >
              {t.withdraw.action}
            </Link>
          ))}
        {/* Auto-follow is switched on where the vault's portfolio is: its page offers the switch. A
            withdrawal switches it off, and this is the way back. */}
        {mine && follows && !vault.autoFollow && (
          <p data-ui="vault-auto-follow-off" className="max-w-(--tf-measure-body) text-body-sm">
            {v.autoFollowOff}{' '}
            <Link href="/shelf" className={buttonClass({ variant: 'link' })}>
              {v.autoFollowWhere}
            </Link>
          </p>
        )}
      </header>

      {/* For the vault's owner alone: add money, and its name. */}
      <OwnVaultActions chain={read.chain} address={vault.address} />

      <Card
        as="section"
        aria-labelledby={`${titleId}-pane`}
        mock={read.provenance !== 'live'}
        mockLabels={{
          announce: read.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        <CardHeader title={read.name} level={2} id={`${titleId}-pane`} />
        <CardBody className="flex flex-col gap-5">
          <StatRow>
            <Stat label={v.value}>
              {/* The value stands on the prices and the read of the vault: its pin says so
                  (STYLE.md rule 1), as the monitor's does. */}
              <ProvenancePin
                value={dollars(lang, vault.valueUsd)}
                obs={vaultValueSource(
                  { ...read, vaults: [vault] },
                  vault,
                  t.portfolio.vault.valueMethod,
                )}
                labels={t.pin}
              />
            </Stat>
            <Stat label={v.autoFollow}>{vault.autoFollow ? v.on : v.off}</Stat>
          </StatRow>
          <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{v.owner}</dt>
            <dd className="break-all font-mono text-source">{vault.owner}</dd>
            <dt className="text-muted-foreground">{v.follows}</dt>
            <dd className="break-all">
              {follows ? (
                <span className="font-mono text-source">
                  {follows} · {v.version(vault.acceptedVersion)}
                </span>
              ) : (
                v.followsNothing
              )}
            </dd>
          </dl>
          <DataTable<HoldingRow>
            caption={read.name}
            captionHidden
            rows={rows}
            rowKey={(r) => r.asset}
            columns={[
              {
                key: 'asset',
                header: v.columns.asset,
                rowHeader: true,
                cell: (r) => displayName(r.asset, t.plan),
              },
              {
                key: 'held',
                header: v.columns.held,
                numeric: true,
                cell: (r) => tokens(lang, r.display),
              },
              {
                key: 'price',
                header: v.columns.price,
                numeric: true,
                cell: (r) => {
                  const price = priceOf(r.asset);
                  return price ? (
                    <ProvenancePin
                      value={dollars(lang, price.usdPerToken)}
                      obs={pinSourceOfPrice(price)}
                      labels={t.pin}
                    />
                  ) : (
                    '—'
                  );
                },
              },
              {
                key: 'weight',
                header: v.columns.weight,
                numeric: true,
                cell: (r) => now[at(r.asset)] ?? '',
              },
              {
                key: 'target',
                header: v.columns.target,
                numeric: true,
                cell: (r) => planned[at(r.asset)] ?? '',
              },
              {
                key: 'drift',
                header: v.columns.drift,
                numeric: true,
                cell: (r) => drift(lang, r.driftBps),
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

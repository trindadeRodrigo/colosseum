'use client';
import { ChainId, type Price, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { assetName, formatBps } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { vaultValueSource } from '../portfolio/portfolio';
import { useApiFetch } from '../wallet/WalletProvider';
import { readVault } from './shared-api';

// A vault, read-only, for anybody (DESIGN-VAULT section 11, the public vault page): its owner, what it
// follows, its value, and each position with its weight, target, drift and price, as its chain holds
// it now (GET /v1/vaults/{chain}/{address}). Every price carries its pin (STYLE.md rule 1); a vault on
// the mock or a test network carries the plate.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };
type Row = VaultResponse['vault']['positions'][number];

export function VaultScreen({ chain, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const apiFetch = useApiFetch();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const titleId = useId();
  const known = ChainId.safeParse(chain);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the vault again
  useEffect(() => {
    if (!known.success) return setLoad({ kind: 'no-plan' });
    let mine = true;
    setLoad({ kind: 'loading' });
    readVault(apiFetch, known.data, address).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', read: read.value } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, address, round]);

  if (load.kind === 'loading')
    return (
      <Card>
        <CardWait label={v.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (load.kind !== 'read')
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className="font-sans text-h2 font-semibold">
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
      </section>
    );

  const { read } = load;
  const { vault } = read;
  const locale = LOCALE[lang];
  const priceOf = (asset: string): Price | undefined => read.prices.find((p) => p.asset === asset);
  const follows = vault.recipeOnchainId;
  return (
    <div data-ui="vault-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 id={titleId} className="max-w-(--tf-measure-display) font-display text-h1 font-normal">
          {v.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{v.lead(read.name)}</p>
        <p className="break-all font-mono text-source text-muted-foreground">{vault.address}</p>
      </header>

      <Card
        as="section"
        aria-labelledby={`${titleId}-pane`}
        mock={read.provenance !== 'live'}
        mockLabels={{
          announce: t.shell.mockAnnounce,
          note: read.provenance === 'sandbox' ? t.shell.testNetwork : undefined,
        }}
      >
        <CardHeader title={read.name} level={2} id={`${titleId}-pane`} />
        <CardBody className="flex flex-col gap-5">
          <StatRow>
            <Stat label={v.value}>
              {/* The value stands on the prices and the read of the vault: its pin says so
                  (STYLE.md rule 1), as the monitor's does. */}
              <ProvenancePin
                value={dollars(Number(vault.valueUsd), lang)}
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
            <dt className="text-muted-foreground">{v.cash}</dt>
            <dd className="tabular-nums">{vault.cash.display}</dd>
          </dl>
          <DataTable<Row>
            caption={read.name}
            captionHidden
            rows={vault.positions}
            rowKey={(r) => r.asset}
            columns={[
              {
                key: 'asset',
                header: v.columns.asset,
                rowHeader: true,
                cell: (r) => assetName(r.asset).toUpperCase(),
              },
              { key: 'held', header: v.columns.held, numeric: true, cell: (r) => r.display },
              {
                key: 'price',
                header: v.columns.price,
                numeric: true,
                cell: (r) => {
                  const price = priceOf(r.asset);
                  return price ? (
                    <ProvenancePin
                      value={dollars(Number(price.usdPerToken), lang)}
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
                cell: (r) => formatBps(r.weightBps, locale),
              },
              {
                key: 'target',
                header: v.columns.target,
                numeric: true,
                cell: (r) => formatBps(r.targetBps, locale),
              },
              {
                key: 'drift',
                header: v.columns.drift,
                numeric: true,
                cell: (r) =>
                  `${r.driftBps < 0 ? '−' : r.driftBps > 0 ? '+' : ''}${formatBps(Math.abs(r.driftBps), locale)}`,
              },
            ]}
          />
        </CardBody>
      </Card>
    </div>
  );
}

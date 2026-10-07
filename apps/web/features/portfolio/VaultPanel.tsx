'use client';
import { DISCLAIMER_SHORT } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { Card, CardBody, CardFooter, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { shorten } from '../../components/ui/format';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { dollars, drift, share, tokens, utc } from './figures';
import {
  assetName,
  cashHolding,
  cashSource,
  type PortfolioChain,
  type Position,
  positionValueSource,
  priceOf,
  unpriced,
  type Vault,
  vaultValueSource,
  worst,
} from './portfolio';

// One vault, as the monitor shows it (DESIGN-VAULT section 11, "Monitor"): what it is worth, its cash,
// whether it follows its portfolio, what the keeper has lost of it this week, a version of the followed
// portfolio still to come, and each holding with its price, value, weight, target and drift. Every
// price and value carries its pin; a vault that is not on a live chain is a mocked card, with the
// words "test network" under the plate when it is on one. Read only: nothing here signs, and the
// switches of a vault (auto-follow, withdraw) are not offered on this page.

export function VaultPanel({ chain, vault }: { chain: PortfolioChain; vault: Vault }) {
  const t = useT();
  const lang = useLang();
  const words = t.portfolio.vault;
  const heading = useId();
  const live = vault.provenance === 'live';
  const missing = unpriced(vault);
  // Cash is a holding like the rest, the last row: with it the weights add up to the whole.
  const cash = cashHolding(vault);
  const rows: Position[] = [...vault.positions, cash];
  const isCash = (row: Position) => row === cash;
  // A card on a test network says that, in one line; a sample card says it is sample.
  const mockLabels =
    vault.provenance === 'sandbox'
      ? { announce: t.shell.testNetworkFigures }
      : { announce: t.shell.mockAnnounce };

  const columns: Column<Position>[] = [
    {
      key: 'asset',
      header: words.columns.asset,
      rowHeader: true,
      cell: (row) => (
        // the name a person reads, as the plan screen says it ("syrupUSDC (Maple)")
        <span className="font-mono">{displayName(row.asset, t.plan)}</span>
      ),
    },
    {
      key: 'amount',
      header: words.columns.amount,
      numeric: true,
      cell: (row) => tokens(lang, row.display),
    },
    {
      key: 'price',
      header: words.columns.price,
      numeric: true,
      cell: (row) => {
        if (isCash(row))
          return (
            <ProvenancePin
              value={dollars(lang, '1')}
              obs={cashSource(chain, vault, words.cashMethod)}
              labels={t.pin}
            />
          );
        const price = priceOf(chain, row.asset);
        return price ? (
          <ProvenancePin
            value={dollars(lang, price.usdPerToken)}
            obs={pinSourceOfPrice({
              ...price,
              provenance: worst(vault.provenance, price.provenance),
            })}
            labels={t.pin}
          />
        ) : (
          <span className="text-caption text-muted-foreground">{words.noPrice}</span>
        );
      },
    },
    {
      key: 'value',
      header: words.columns.value,
      numeric: true,
      cell: (row) => {
        if (isCash(row))
          return (
            <ProvenancePin
              value={dollars(lang, row.valueUsd ?? '0')}
              obs={cashSource(chain, vault, words.cashMethod)}
              labels={t.pin}
            />
          );
        const price = priceOf(chain, row.asset);
        return row.valueUsd !== null && price ? (
          <ProvenancePin
            value={dollars(lang, row.valueUsd)}
            obs={positionValueSource(vault, price, words.positionMethod)}
            labels={t.pin}
          />
        ) : (
          <span className="text-caption text-muted-foreground">{words.noPrice}</span>
        );
      },
    },
    {
      key: 'weight',
      header: words.columns.weight,
      numeric: true,
      cell: (row) => share(lang, row.weightBps),
    },
    {
      key: 'target',
      header: words.columns.target,
      numeric: true,
      cell: (row) => share(lang, row.targetBps),
    },
    {
      key: 'drift',
      header: words.columns.drift,
      numeric: true,
      cell: (row) => drift(lang, row.driftBps),
    },
  ];

  return (
    <Card
      as="section"
      aria-labelledby={heading}
      density="dense"
      mock={!live}
      mockLabels={mockLabels}
    >
      <CardHeader
        title={words.title}
        level={2}
        id={heading}
        density="dense"
        meta={
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <ChainBadge chain={vault.chain} />
            {/* the vault's own page: the same read, for anybody, with its explorer link */}
            <Link
              data-ui="vault-page-link"
              href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
              title={vault.address}
              aria-label={words.page(shorten(vault.address))}
              className="font-mono text-primary underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {shorten(vault.address)}
            </Link>
          </span>
        }
      />
      {/* Below the plate of a mocked card, so nothing in the body is narrowed by it. */}
      <CardBody density="dense" className="clear-right flex flex-col gap-3">
        {/* The value on a line of its own: with its pin and the plate it is wider than a cell of a
            phone's two columns. */}
        <dl data-ui="vault-value">
          <dt className="text-caption text-muted-foreground">{words.value}</dt>
          <dd className="font-mono text-[1.125rem]/7 font-medium tabular-nums">
            <ProvenancePin
              value={dollars(lang, vault.valueUsd)}
              obs={vaultValueSource(chain, vault, words.valueMethod)}
              labels={t.pin}
            />
          </dd>
        </dl>
        <StatRow>
          <Stat label={words.cash}>
            {tokens(lang, vault.cash.display)}{' '}
            <span className="text-caption text-muted-foreground">
              {assetName(vault.cash.asset)}
            </span>
          </Stat>
          {/* The keeper trades a vault only with auto-follow on: off, there is nothing of it to show. */}
          {vault.autoFollow && (
            <>
              <Stat label={words.autoFollow}>
                <span className="font-sans">{words.on}</span>
              </Stat>
              <Stat label={words.lossUsed}>{share(lang, vault.lossUsedBps)}</Stat>
            </>
          )}
        </StatRow>
        {missing > 0 && (
          <p className="text-body-sm text-muted-foreground">{words.unpriced(missing)}</p>
        )}
        {vault.pending && (
          <p className="max-w-(--tf-measure-body) text-body-sm">
            {words.pending(vault.pending.version, utc(lang, vault.pending.effectiveAt))}
            {vault.pending.newAssets.length > 0 &&
              ` ${words.pendingAssets(
                new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(
                  vault.pending.newAssets.map((asset) => displayName(asset, t.plan)),
                ),
              )}`}
          </p>
        )}
      </CardBody>
      <CardBody density="dense">
        {vault.positions.length === 0 && <p className="pb-3 text-body-sm">{words.onlyCash}</p>}
        <DataTable
          caption={words.holdings}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.asset}
          dense
        />
        {/* What the team reads, not the person: the address, the version followed, the switch. */}
        <details data-ui="vault-details" className="pt-3 text-body-sm">
          <summary className="cursor-pointer text-muted-foreground">{words.details.label}</summary>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-2">
            <dt className="text-muted-foreground">{words.address}</dt>
            <dd className="font-mono text-source break-all">{vault.address}</dd>
            {vault.recipeOnchainId !== null && (
              <>
                <dt className="text-muted-foreground">{words.details.version}</dt>
                <dd className="tabular-nums">{vault.acceptedVersion}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{words.autoFollow}</dt>
            <dd>{vault.autoFollow ? words.on : words.off}</dd>
          </dl>
        </details>
      </CardBody>
      <CardFooter
        density="dense"
        className="flex flex-wrap justify-between gap-3 font-mono text-[11px] text-muted-foreground"
      >
        <span>{words.observed(utc(lang, vault.observedAt))}</span>
        <span>{DISCLAIMER_SHORT[lang]}</span>
      </CardFooter>
    </Card>
  );
}

const FILL = ['bg-leg-1', 'bg-leg-2', 'bg-leg-3', 'bg-leg-4'] as const;

/**
 * "Your plan · 3 parts", as his guide draws it beside the goal card (guidelines.html, "Goal card and
 * plan"; plan-leg.md): one bar, a segment per holding by its weight now, cash the rest, then each part
 * named with its weight and its target. At most four parts go in a bar; a vault with more says so and
 * leaves them to the table.
 */
export function PlanParts({ vault }: { vault: Vault }) {
  const t = useT();
  const lang = useLang();
  const words = t.portfolio.vault;
  const heading = useId();
  const positions = [...vault.positions].sort((a, b) => b.weightBps - a.weightBps);
  const held = positions.reduce((sum, p) => sum + p.weightBps, 0);
  const targeted = positions.reduce((sum, p) => sum + p.targetBps, 0);
  // Cash is a part of the plan like any other: what the positions leave, named and counted.
  const cash =
    held < 10_000
      ? [
          {
            asset: vault.cash.asset,
            weightBps: 10_000 - held,
            targetBps: Math.max(0, 10_000 - targeted),
            fill: 'bg-muted border border-border',
          },
        ]
      : [];
  const parts = [...positions.map((p, i) => ({ ...p, fill: FILL[i] ?? '' })), ...cash].sort(
    (a, b) => b.weightBps - a.weightBps,
  );
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      density="dense"
      mock={vault.provenance !== 'live'}
      mockLabels={
        vault.provenance === 'sandbox'
          ? { announce: t.shell.testNetworkFigures }
          : { announce: t.shell.mockAnnounce }
      }
    >
      <CardHeader title={words.planTitle(parts.length)} level={3} id={heading} density="dense" />
      <CardBody density="dense" className="clear-right">
        {positions.length === 0 ? (
          <p className="text-body-sm">{words.onlyCash}</p>
        ) : positions.length > FILL.length ? (
          <p className="text-body-sm text-muted-foreground">{words.tooMany}</p>
        ) : (
          <div data-ui="vault-parts" className="flex flex-col gap-2">
            <div aria-hidden="true" className="flex h-3 gap-0.5">
              {parts.map((p) => (
                <span key={p.asset} className={p.fill} style={{ width: `${p.weightBps / 100}%` }} />
              ))}
            </div>
            <ul
              aria-label={words.parts}
              className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-1.5"
            >
              {parts.map((p) => (
                <li
                  key={p.asset}
                  className="grid grid-cols-[10px_1fr_auto] items-baseline gap-x-2 text-[13px]/5"
                >
                  <span aria-hidden="true" className={`size-2.5 translate-y-px ${p.fill}`} />
                  <span className="font-mono">{displayName(p.asset, t.plan)}</span>
                  <span className="font-mono text-[12px] font-medium tabular-nums">
                    {share(lang, p.weightBps)}
                  </span>
                  <span className="col-start-2 col-end-4 -mt-0.5 text-[12px]/4 text-muted-foreground">
                    {words.target(share(lang, p.targetBps))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

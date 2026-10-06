'use client';
import { DISCLAIMER_SHORT } from '@colosseum/schemas';
import { useId } from 'react';
import { Card, CardBody, CardFooter, CardHeader, Stat, StatRow } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { shorten } from '../../components/ui/format';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, drift, share, tokens, utc } from './figures';
import {
  assetName,
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

  const columns: Column<Position>[] = [
    {
      key: 'asset',
      header: words.columns.asset,
      rowHeader: true,
      cell: (row) => (
        <span className="font-mono" title={row.asset}>
          {assetName(row.asset)}
        </span>
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
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: vault.provenance === 'sandbox' ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader
        title={words.title}
        level={2}
        id={heading}
        density="dense"
        meta={
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <ChainBadge chain={vault.chain} />
            <span className="font-mono" title={vault.address}>
              <span className="sr-only">{words.address}: </span>
              {shorten(vault.address)}
            </span>
          </span>
        }
      />
      {/* Below the plate of a mocked card, so nothing in the body is narrowed by it. */}
      <CardBody density="dense" className="clear-right flex flex-col gap-3">
        {/* The vault's facts as chips, as his case states its limits. */}
        <ul aria-label={words.chips.label} className="flex flex-wrap gap-1.5">
          {[
            [words.chips.address, shorten(vault.address)],
            [words.chips.version, String(vault.acceptedVersion)],
            [words.chips.follow, (vault.autoFollow ? words.on : words.off).toLowerCase()],
          ].map(([key, value]) => (
            <li
              key={key}
              className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[12px]"
            >
              {key}: {value}
            </li>
          ))}
        </ul>
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
          <Stat label={words.autoFollow}>
            <span className="font-sans">{vault.autoFollow ? words.on : words.off}</span>
          </Stat>
          <Stat label={words.lossUsed}>{share(lang, vault.lossUsedBps)}</Stat>
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
                  vault.pending.newAssets.map(assetName),
                ),
              )}`}
          </p>
        )}
      </CardBody>
      <CardBody density="dense">
        {vault.positions.length > 0 ? (
          <DataTable
            caption={words.holdings}
            columns={columns}
            rows={vault.positions}
            rowKey={(row) => row.asset}
            dense
          />
        ) : (
          <p className="text-body-sm">{words.onlyCash}</p>
        )}
      </CardBody>
      <CardFooter
        density="dense"
        className="flex flex-wrap justify-between gap-3 font-mono text-[12px] text-muted-foreground"
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
  const parts = [...vault.positions].sort((a, b) => b.weightBps - a.weightBps);
  const held = parts.reduce((sum, p) => sum + p.weightBps, 0);
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      density="dense"
      mock={vault.provenance !== 'live'}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: vault.provenance === 'sandbox' ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader title={words.planTitle(parts.length)} level={3} id={heading} density="dense" />
      <CardBody density="dense" className="clear-right">
        {parts.length === 0 ? (
          <p className="text-body-sm">{words.onlyCash}</p>
        ) : parts.length > FILL.length ? (
          <p className="text-body-sm text-muted-foreground">{words.tooMany}</p>
        ) : (
          <div data-ui="vault-parts" className="flex flex-col gap-2">
            <div aria-hidden="true" className="flex h-3 gap-0.5">
              {parts.map((p, i) => (
                <span
                  key={p.asset}
                  className={FILL[i]}
                  style={{ width: `${p.weightBps / 100}%` }}
                />
              ))}
              {held < 10_000 && (
                <span className="bg-muted" style={{ width: `${(10_000 - held) / 100}%` }} />
              )}
            </div>
            <ul
              aria-label={words.parts}
              className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-1.5"
            >
              {parts.map((p, i) => (
                <li
                  key={p.asset}
                  className="grid grid-cols-[10px_1fr_auto] items-baseline gap-x-2 text-[13px]/5"
                >
                  <span aria-hidden="true" className={`size-2.5 translate-y-px ${FILL[i]}`} />
                  <span className="font-mono">{assetName(p.asset)}</span>
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

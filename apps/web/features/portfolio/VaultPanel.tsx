'use client';
import { chainFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { shorten } from '../../components/ui/format';
import { Hint } from '../../components/ui/Hint';
import { MarketNote } from '../../components/ui/MarketNote';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { planHref } from '../portfolio-section/pages';
import { dollars, drift, share, shareExact, sharesOf, shareTenths, tokens, utc } from './figures';
import {
  type HoldingRow,
  holdingsOf,
  type PortfolioChain,
  positionValueSource,
  priceOf,
  unpriced,
  type Vault,
  vaultValueSource,
  worst,
} from './portfolio';
import type { TakenOut } from './vault-goal';

// One vault, as the monitor shows it (DESIGN-VAULT section 11, "Monitor"): what it is worth, a version
// of the followed portfolio still to come, and what it holds, cash included, each with its price, value,
// share now, planned share and the difference, so the shares add up to the whole. Its own facts (the
// address, the version it follows, auto-follow, what the keeper has lost of it this week) are behind
// "Details": they are not what a person opens the page for (the flow audit, finding 31). Every price
// and value carries its pin; a vault that is not on a live chain is a mocked card, and one on a test
// network says "Test network". Nothing here signs: a vault that holds something links to its withdrawal
// (features/shared/WithdrawScreen.tsx), one that holds nothing says so, and what confirmed withdrawals
// took out is said with its pin. The auto-follow switch is not offered on this page.

export function VaultPanel({
  chain,
  vault,
  taken = null,
}: {
  chain: PortfolioChain;
  vault: Vault;
  /** What confirmed withdrawals took out of this vault (vault-goal.ts, `takenOut`), or null. */
  taken?: TakenOut | null;
}) {
  const t = useT();
  const lang = useLang();
  const words = t.portfolio.vault;
  const heading = useId();
  const live = vault.provenance === 'live';
  const missing = unpriced(vault);
  // Nothing held, of cash or of any token: a vault a withdrawal emptied, or one never funded.
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));

  const page = `/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`;
  // The rows' shares, rounded together so they add up to the whole (figures.ts, `sharesOf`).
  const rows = holdingsOf(vault);
  const nowTenths = shareTenths(rows.map((r) => r.weightBps));
  const plannedTenths = shareTenths(rows.map((r) => r.targetBps));
  const at = (asset: string) => rows.findIndex((r) => r.asset === asset);
  const now = (asset: string) => share(lang, (nowTenths[at(asset)] ?? 0) * 10);
  const planned = (asset: string) => share(lang, (plannedTenths[at(asset)] ?? 0) * 10);
  // The difference is the one between the two shares as written, so 33.4% beside 33.3% is +0.1%.
  const difference = (asset: string) =>
    drift(lang, ((nowTenths[at(asset)] ?? 0) - (plannedTenths[at(asset)] ?? 0)) * 10);
  const columns: Column<HoldingRow>[] = [
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
        const price = priceOf(chain, row.asset);
        // cash is counted at one dollar, which the pin of its value says: it has no price to show
        if (row.cash && !price) return '—';
        return price ? (
          <>
            <ProvenancePin
              value={dollars(lang, price.usdPerToken)}
              obs={pinSourceOfPrice({
                ...price,
                provenance: worst(vault.provenance, price.provenance),
              })}
              what={words.columns.price}
              labels={t.pin}
            />
            <MarketNote market={price.market} label={t.shell.marketClosed} />
          </>
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
        if (row.cash && !price)
          return (
            <ProvenancePin
              value={dollars(lang, row.valueUsd ?? '0')}
              obs={vaultValueSource(chain, vault, words.valueMethod)}
              what={words.value}
              labels={t.pin}
            />
          );
        return row.valueUsd !== null && price ? (
          <ProvenancePin
            value={dollars(lang, row.valueUsd)}
            obs={positionValueSource(vault, price, words.positionMethod)}
            what={words.columns.value}
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
      cell: (row) => now(row.asset),
    },
    {
      key: 'target',
      header: words.columns.target,
      numeric: true,
      cell: (row) => planned(row.asset),
    },
    {
      key: 'drift',
      header: words.columns.drift,
      numeric: true,
      cell: (row) => difference(row.asset),
    },
  ];

  return (
    <Card
      as="section"
      aria-labelledby={heading}
      density="dense"
      mock={!live}
      mockLabels={{
        announce: vault.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
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
            {/* the vault's own page: the same read, for anybody, with its explorer link */}
            <Hint tip={<span className="font-mono text-source break-all">{vault.address}</span>}>
              <Link
                data-ui="vault-page-link"
                href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
                aria-label={words.page(shorten(vault.address))}
                className="font-mono text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {shorten(vault.address)}
              </Link>
            </Hint>
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
              what={words.value}
              labels={t.pin}
            />
          </dd>
        </dl>
        {taken && (
          <dl data-ui="vault-taken-out">
            <dt className="text-caption text-muted-foreground">{words.takenOut}</dt>
            <dd className="font-mono tabular-nums">
              {taken.usd !== null && (
                <ProvenancePin value={dollars(lang, taken.usd)} obs={taken.obs} labels={t.pin} />
              )}
              {/* An EVM vault's withdraw-all passes over a token it cannot move and the order cannot
                  tell, so there the sum is what was ordered, and says so. */}
              {chainFamily(vault.chain) === 'evm' && (
                <span
                  data-ui="vault-taken-ordered"
                  className="block font-sans text-body-sm text-muted-foreground"
                >
                  {words.takenOrdered}
                </span>
              )}
              {taken.unvalued > 0 && (
                <span className="block font-sans text-body-sm text-muted-foreground">
                  {words.takenUnvalued(taken.unvalued)}
                </span>
              )}
            </dd>
          </dl>
        )}
        {/* The same vault over time: its page in the portfolio section (PORT-3). A text link, so the
            page still has no primary button. */}
        <Link
          data-ui="vault-over-time"
          href={planHref(vault.chain, vault.address)}
          aria-label={words.overTimeOf(shorten(vault.address))}
          className={`self-start ${buttonClass({ variant: 'link' })}`}
        >
          {words.overTime}
        </Link>
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
      </CardBody>
      <CardBody density="dense">
        <details data-ui="vault-details">
          <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
            {words.details}
          </summary>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{words.address}</dt>
            <dd className="break-all font-mono text-source">{vault.address}</dd>
            {(vault.recipeOnchainId !== null || vault.acceptedVersion > 0) && (
              <>
                <dt className="text-muted-foreground">{words.version}</dt>
                <dd className="tabular-nums">{vault.acceptedVersion}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{words.autoFollow}</dt>
            <dd>{vault.autoFollow ? words.on : words.off}</dd>
            {/* The keeper trades only a vault with auto-follow on: its losses are said only then. */}
            {vault.autoFollow && (
              <>
                <dt className="text-muted-foreground">{words.lossUsed}</dt>
                <dd className="tabular-nums">{shareExact(lang, vault.lossUsedBps)}</dd>
              </>
            )}
          </dl>
          {vault.recipeOnchainId === null && !vault.autoFollow && (
            <p className="mt-2 text-body-sm">{words.followsNothing}</p>
          )}
          <p className="mt-3">
            <Link href={page} className={buttonClass({ variant: 'link' })}>
              {words.openPage}
            </Link>
          </p>
        </details>
      </CardBody>
      <CardBody density="dense" className="flex flex-col items-start gap-2">
        {empty ? (
          <p data-ui="vault-empty" className="text-body-sm">
            {t.withdraw.empty}
          </p>
        ) : (
          <Link
            data-ui="vault-withdraw"
            href={`/vaults/${encodeURIComponent(vault.chain)}/${encodeURIComponent(vault.address)}/withdraw`}
            className={buttonClass({ variant: 'secondary', size: 'dense' })}
          >
            {t.withdraw.action}
          </Link>
        )}
      </CardBody>
      <CardFooter
        density="dense"
        className="flex flex-wrap justify-between gap-3 font-mono text-[11px] text-muted-foreground"
      >
        <span>{words.observed(utc(lang, vault.observedAt))}</span>
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
  // Cash is a part of the plan like any other: what the positions leave, named and counted.
  const fills = new Map(positions.map((p, i) => [p.asset, FILL[i] ?? '']));
  const all = holdingsOf(vault);
  const nowOf = sharesOf(
    lang,
    all.map((r) => r.weightBps),
  );
  const plannedOf = sharesOf(
    lang,
    all.map((r) => r.targetBps),
  );
  const parts = all
    .map((row, i) => ({ ...row, now: nowOf[i] ?? '', planned: plannedOf[i] ?? '' }))
    .filter((row) => !row.cash || row.weightBps > 0)
    .map((row) => ({
      ...row,
      fill: row.cash ? 'bg-muted border border-border' : (fills.get(row.asset) ?? ''),
    }))
    .sort((a, b) => b.weightBps - a.weightBps);
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      density="dense"
      mock={vault.provenance !== 'live'}
      mockLabels={{
        announce: vault.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
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
                  <span className="font-mono text-[12px] font-medium tabular-nums">{p.now}</span>
                  <span className="col-start-2 col-end-4 -mt-0.5 text-[12px]/4 text-muted-foreground">
                    {words.target(p.planned)}
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

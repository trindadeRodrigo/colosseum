'use client';
import type { Price, VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { type ReactNode, useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { CopyButton } from '../../components/ui/CopyButton';
import { cn } from '../../components/ui/cn';
import { DataTable } from '../../components/ui/DataTable';
import { shorten } from '../../components/ui/format';
import { Hint } from '../../components/ui/Hint';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { explorerAddressTemplateFor } from '../order/readiness';
import { dollars, drift, share, shareTenths, tokens, utc } from '../portfolio/figures';
import { type HoldingRow, holdingsOf, unpriced } from '../portfolio/portfolio';
import { HoldingLegs } from './HoldingLegs';

// What a vault holds, the centre of its page (gate VAULT-PAGE-ACTIONS): the plan bar (plan-leg.md,
// through HoldingLegs) over one table of every holding, cash included, with its amount, its price on
// its pin, the planned share and the share now. How far a share is from its plan is the signed delta
// under it, coloured by direction and said in words for a screen reader (data-table.md). The figures
// are written as the portfolio writes them (features/portfolio/figures.ts): the shares rounded together
// so they add up to the whole, the difference the one between the two shares as written.

export function VaultHoldings({
  read,
  deposit,
}: {
  read: VaultResponse;
  /** The owner's way to fund an empty vault: the empty card's one action. */
  deposit?: ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const titleId = useId();
  const { vault } = read;
  const priceOf = (asset: string): Price | undefined => read.prices.find((p) => p.asset === asset);
  const addressPage = explorerAddressTemplateFor(read.chain, read.provenance === 'mock');
  const rows = holdingsOf(vault);
  const at = (asset: string) => rows.findIndex((r) => r.asset === asset);
  const nowTenths = shareTenths(rows.map((r) => r.weightBps));
  const plannedTenths = shareTenths(rows.map((r) => r.targetBps));
  // The bar draws what is held and priced: a holding with no price has no share that was worked out.
  const held = rows
    .filter((row) => row.valueUsd !== null && row.weightBps > 0)
    .map((row) => ({
      key: row.asset,
      name: displayName(row.asset, t.plan),
      bps: row.weightBps,
    }));
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));
  const missing = unpriced(vault);
  // A vault with no target has no plan to be over or under: no difference is drawn under a share.
  const planned = vault.positions.some((position) => position.targetBps > 0);
  const mockLabels = {
    announce: read.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
  };

  // Nothing held: said once, with what a deposit would go into where the vault has targets, in place of
  // a bar and a table of zeros.
  if (empty) {
    const planned = rows.filter((row) => row.targetBps > 0);
    const targeted = vault.positions.some((position) => position.targetBps > 0);
    const tenths = shareTenths(planned.map((row) => row.targetBps));
    return (
      <Card
        as="section"
        aria-labelledby={titleId}
        mock={read.provenance !== 'live'}
        mockLabels={mockLabels}
      >
        <CardHeader id={titleId} title={v.page.empty.title} level={2} />
        <CardBody className="flex min-w-0 flex-col items-start gap-5">
          <p data-ui="vault-empty" className="max-w-(--tf-measure-body) text-body">
            {deposit
              ? targeted
                ? v.page.empty.withTargets
                : v.page.empty.noTargets
              : t.withdraw.empty}
          </p>
          {targeted && (
            <div data-ui="vault-empty-targets" className="flex w-full min-w-0 flex-col gap-4">
              <HoldingLegs
                shares={planned.map((row) => ({
                  key: row.asset,
                  name: displayName(row.asset, t.plan),
                  bps: row.targetBps,
                }))}
                share={(bps) => share(lang, bps)}
                others={v.page.others}
              />
              <DataTable<HoldingRow>
                caption={v.page.empty.targets}
                captionHidden
                rows={planned}
                rowKey={(r) => r.asset}
                columns={[
                  {
                    key: 'asset',
                    header: v.columns.asset,
                    rowHeader: true,
                    cell: (r) => (
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <AssetMark asset={r.asset} />
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {displayName(r.asset, t.plan)}
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'target',
                    header: v.columns.target,
                    numeric: true,
                    cell: (r) => share(lang, (tenths[planned.indexOf(r)] ?? 0) * 10),
                  },
                ]}
              />
            </div>
          )}
          {deposit}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      mock={read.provenance !== 'live'}
      mockLabels={mockLabels}
    >
      <CardHeader id={titleId} title={v.page.holdings} level={2} />
      <CardBody className="flex min-w-0 flex-col gap-5">
        {missing > 0 && (
          // The value leaves out what has no price: said beside the holdings it leaves out.
          <p data-ui="vault-unpriced" className="text-caption text-muted-foreground">
            {t.portfolio.vault.unpriced(missing)}
          </p>
        )}
        {held.length > 0 && (
          <HoldingLegs shares={held} share={(bps) => share(lang, bps)} others={v.page.others} />
        )}
        <DataTable<HoldingRow>
          caption={v.page.holdings}
          captionHidden
          rows={rows}
          rowKey={(r) => r.asset}
          columns={[
            {
              key: 'asset',
              header: v.columns.asset,
              rowHeader: true,
              cell: (r) => (
                <span className="inline-flex min-w-0 items-center gap-2">
                  <AssetMark asset={r.asset} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {displayName(r.asset, t.plan)}
                  </span>
                </span>
              ),
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
                    // each address in the price's details links to this network's explorer
                    obs={{ ...pinSourceOfPrice(price), explorer: addressPage }}
                    what={v.columns.price}
                    labels={t.pin}
                  />
                ) : (
                  // a missing price says why, one hover, focus or tap away
                  <Hint tip={t.portfolio.vault.noPriceWhy} label={t.portfolio.vault.noPrice}>
                    —
                  </Hint>
                );
              },
            },
            {
              key: 'target',
              header: v.columns.target,
              numeric: true,
              cell: (r) => share(lang, (plannedTenths[at(r.asset)] ?? 0) * 10),
            },
            {
              key: 'weight',
              header: v.columns.weight,
              numeric: true,
              cell: (r) => {
                // a holding with no price has no share that was worked out: never drawn as 0%
                if (r.valueUsd === null) return '—';
                const now = nowTenths[at(r.asset)] ?? 0;
                // from the two shares as written, so they and their difference agree
                const off = (now - (plannedTenths[at(r.asset)] ?? 0)) * 10;
                return (
                  <span className="inline-flex flex-col items-end">
                    <span>{share(lang, now * 10)}</span>
                    {planned && (
                      <span
                        data-ui="holding-drift"
                        data-direction={off > 0 ? 'over' : off < 0 ? 'under' : 'on'}
                        className={cn(
                          'text-b-delta font-medium',
                          off > 0 ? 'text-leaf' : off < 0 ? 'text-madder' : 'text-muted-foreground',
                        )}
                      >
                        <span aria-hidden="true">
                          {off === 0 ? v.page.onPlan : drift(lang, off)}
                        </span>
                        <span className="sr-only">
                          {off === 0 ? v.page.onPlan : v.page.against(drift(lang, off))}
                        </span>
                      </span>
                    )}
                  </span>
                );
              },
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** A long address, shortened, with the whole of it to copy and in its title. */
function Address({ value, what }: { value: string; what: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {/* the whole address one hover, focus or tap away, as every tooltip is (Hint) */}
      <Hint tip={value} label={what}>
        <span className="font-mono text-source">{shorten(value, 6, 6)}</span>
      </Hint>
      <CopyButton value={value} what={what} />
    </span>
  );
}

/**
 * The vault's own facts, behind one fold at the foot of its page: its address, its owner, what it
 * follows, auto-follow, when it was read and where its prices come from.
 */
export function VaultDetails({ read, mine = false }: { read: VaultResponse; mine?: boolean }) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vault;
  const { vault } = read;
  const follows = vault.recipeOnchainId;
  const sources = [...new Set(read.prices.map((price) => price.source))];
  return (
    <details data-ui="vault-details" className="border-t border-border pt-4">
      <summary className="w-fit cursor-pointer text-body-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {v.page.details}
      </summary>
      <dl className="grid gap-x-6 gap-y-2 pt-3 text-body-sm sm:grid-cols-[auto_1fr] sm:items-center">
        <dt className="text-muted-foreground">{v.address}</dt>
        <dd data-ui="vault-address">
          <Address value={vault.address} what={v.page.copyVault} />
        </dd>
        <dt className="text-muted-foreground">{v.owner}</dt>
        <dd data-ui="vault-owner">
          <Address value={vault.owner} what={v.page.copyOwner} />
        </dd>
        <dt className="text-muted-foreground">{v.follows}</dt>
        <dd className="[overflow-wrap:anywhere]">
          {follows ? (
            <span className="font-mono text-source" title={follows}>
              {shorten(follows, 6, 6)} · {v.version(vault.acceptedVersion)}
            </span>
          ) : (
            v.followsNothing
          )}
        </dd>
        <dt className="text-muted-foreground">{v.autoFollow}</dt>
        <dd data-ui="vault-auto-follow" className="flex flex-col gap-1">
          <span>{vault.autoFollow ? v.on : v.off}</span>
          {/* Auto-follow is switched on where the vault's portfolio is: its page offers the switch. A
              withdrawal switches it off, and this is the way back. Said to the owner, beside the setting. */}
          {mine && follows && !vault.autoFollow && (
            <span
              data-ui="vault-auto-follow-off"
              className="max-w-(--tf-measure-body) text-muted-foreground"
            >
              {v.autoFollowOff}{' '}
              <Link href="/shelf" className={buttonClass({ variant: 'link' })}>
                {v.autoFollowWhere}
              </Link>
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">{v.page.read}</dt>
        <dd>
          <time dateTime={vault.observedAt}>{utc(lang, vault.observedAt)}</time>
        </dd>
        {sources.length > 0 && (
          <>
            <dt className="text-muted-foreground">{v.page.priceSources}</dt>
            <dd className="font-mono text-source [overflow-wrap:anywhere]">
              {new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(sources)}
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

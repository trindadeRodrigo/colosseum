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
import { Hint } from '../../components/ui/Hint';
import { PAGE_TITLE, WORKSPACE_TITLE } from '../../components/ui/heading';
import { Icon } from '../../components/ui/Icon';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinSourceOfPrice } from '../../components/ui/price-source';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import type { CallFailure } from '../order/order-api';
import { displayName } from '../order/plain';
import { explorerAddressTemplateFor, explorerAddressUrlFor } from '../order/readiness';
import { dollars, drift, share, shareTenths, tokens } from '../portfolio/figures';
import { type HoldingRow, holdingsOf, unpriced, vaultValueSource } from '../portfolio/portfolio';
import { OwnVaultActions } from '../portfolio/VaultActions';
import { sameAddress } from '../portfolio/vault-name';
import { conversationNetwork } from '../vault-conversation/storage';
import { VaultConversation } from '../vault-conversation/VaultConversation';
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
  const { account } = useAccount();
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

  if (
    load.kind === 'loading' ||
    (load.kind === 'read' &&
      (!known.success ||
        load.read.chain !== known.data ||
        !sameAddress(load.read.chain, load.read.vault.address, address)))
  )
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
  const nowTenths = shareTenths(rows.map((r) => r.weightBps));
  const plannedTenths = shareTenths(rows.map((r) => r.targetBps));
  const now = nowTenths.map((t) => share(lang, t * 10));
  const planned = plannedTenths.map((t) => share(lang, t * 10));
  const explorer = explorerAddressUrlFor(read.chain, vault.address, read.provenance === 'mock');
  const addressPage = explorerAddressTemplateFor(read.chain, read.provenance === 'mock');
  const wallet = port.active(chainFamily(read.chain));
  const mine =
    port.status === 'ready' &&
    port.userId !== null &&
    !!wallet &&
    sameAddress(read.chain, wallet.address, vault.owner);
  const empty = [vault.cash, ...vault.positions].every((h) => /^0+$/.test(h.raw));
  const weightsHref = `/vaults/${encodeURIComponent(read.chain)}/${encodeURIComponent(vault.address)}/targets`;
  const withdrawHref = `/vaults/${encodeURIComponent(read.chain)}/${encodeURIComponent(vault.address)}/withdraw`;
  // The way back, the explorer, and the owner's own ways in and out.
  const links = (
    <>
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
      {/* The owner's, on the vault's own chain: offered where a wallet of theirs signs on it,
          whatever chain their new plans start on (gate CHAIN-AT-THE-PLAN). */}
      {mine && account.status === 'ready' && account.options.includes(read.chain) && (
        <Link
          data-ui="vault-share-strategy"
          href={`/publish?vault=${encodeURIComponent(vault.address)}&chain=${read.chain}`}
          className={buttonClass({ variant: 'secondary' })}
        >
          {t.shared.publish.shareStrategy}
        </Link>
      )}
      {/* The owner's way out, shown to the owner alone: a vault pays nobody else. */}
      {mine &&
        (empty ? (
          <p data-ui="vault-empty" className="text-body">
            {t.withdraw.empty}
          </p>
        ) : (
          <>
            <Link
              data-ui="vault-edit-weights"
              href={weightsHref}
              className={buttonClass({ variant: 'secondary' })}
            >
              {t.mix.editor.edit}
            </Link>
            <Link
              data-ui="vault-withdraw"
              href={withdrawHref}
              className={buttonClass({ variant: 'secondary' })}
            >
              {t.withdraw.action}
            </Link>
          </>
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
    </>
  );
  const details = (
    <details open={!mine} data-ui="vault-details">
      <summary className={mine ? 'cursor-pointer text-body-sm' : 'hidden'}>
        {v.conversation.details}
      </summary>
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
                what={v.value}
                labels={t.pin}
              />
            </Stat>
            <Stat label={v.autoFollow}>{vault.autoFollow ? v.on : v.off}</Stat>
          </StatRow>
          {!mine && unpriced(vault) > 0 && (
            // The value leaves out what has no price: said here as on the owner's card above.
            <p data-ui="vault-unpriced" className="text-caption text-muted-foreground">
              {t.portfolio.vault.unpriced(unpriced(vault))}
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{v.address}</dt>
            <dd className="break-all font-mono text-source">{vault.address}</dd>
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
                key: 'weight',
                header: v.columns.weight,
                numeric: true,
                // a holding with no price has no share that was worked out: never drawn as 0%
                cell: (r) => (r.valueUsd === null ? '—' : (now[at(r.asset)] ?? '')),
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
                // from the two shares as written, so they and their difference agree
                cell: (r) =>
                  r.valueUsd === null
                    ? '—'
                    : drift(
                        lang,
                        ((nowTenths[at(r.asset)] ?? 0) - (plannedTenths[at(r.asset)] ?? 0)) * 10,
                      ),
              },
            ]}
          />
        </CardBody>
      </Card>
    </details>
  );
  // The owner's vault opens as the invest page does (Rodrigo, Oct 8): the chat beside the plan, so
  // edits and rebalancing pick up where the plan was made.
  if (mine && port.userId)
    return (
      <div data-ui="vault-screen" className="flex min-w-0 flex-col gap-4 md:min-h-0 md:flex-1">
        <VaultConversation
          // a new person, vault or network is another conversation; a new read of the same vault is
          // the same one, which says so of a reply it set aside (VaultConversation.tsx)
          key={`${port.userId}:${read.chain}:${conversationNetwork(read.chain) ?? 'unconfigured'}:${vault.address}:${read.provenance}`}
          read={read}
          userId={port.userId}
          showValue={false}
          heading={
            <>
              <div className="flex flex-wrap items-center gap-3">
                <OwnVaultActions
                  chain={read.chain}
                  address={vault.address}
                  headingLevel={1}
                  primaryAddMoney
                  fallback={
                    <h1 id={titleId} className={WORKSPACE_TITLE}>
                      {v.title}
                    </h1>
                  }
                />
                <ChainBadge chain={read.chain} />
              </div>
              <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
                {v.workspaceLead(read.name)}
              </p>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">{links}</div>
            </>
          }
          aside={
            <>
              <Card
                density="dense"
                mock={read.provenance !== 'live'}
                mockLabels={{
                  announce:
                    read.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
                }}
              >
                <CardBody density="dense" className="flex flex-col gap-3">
                  <StatRow>
                    <Stat label={v.value}>
                      <ProvenancePin
                        value={dollars(lang, vault.valueUsd)}
                        obs={vaultValueSource(
                          { ...read, vaults: [vault] },
                          vault,
                          t.portfolio.vault.valueMethod,
                        )}
                        what={v.value}
                        labels={t.pin}
                      />
                    </Stat>
                    <Stat label={v.conversation.holdings}>
                      {rows.filter((row) => !/^0+$/.test(row.raw)).length}
                    </Stat>
                    <Stat label={v.autoFollow}>{vault.autoFollow ? v.on : v.off}</Stat>
                  </StatRow>
                  {unpriced(vault) > 0 && (
                    <p className="text-caption text-muted-foreground">
                      {t.portfolio.vault.unpriced(unpriced(vault))}
                    </p>
                  )}
                </CardBody>
              </Card>
              {details}
            </>
          }
        />
      </div>
    );
  return (
    <div data-ui="vault-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={read.chain} />
        <h1 id={titleId} className={PAGE_TITLE}>
          {v.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg text-muted-foreground">
          {v.lead(read.name)}
        </p>
        {links}
      </header>
      {details}
    </div>
  );
}

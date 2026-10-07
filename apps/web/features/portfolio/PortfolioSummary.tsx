'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { ChainBadges } from '../../components/ui/ChainBadge';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import { type PortfolioChain, vaultValueSource } from './portfolio';
import { usePortfolio } from './use-portfolio';

// On the home page, under the goal: where the person's money already is, in one line, and the way to
// the monitor. It shows only once a vault has been read for a signed-in person; before that, and for
// anyone with no vault, the home page is the goal alone. One vault is named with its value and pin;
// more than one are counted, since adding values up is the API's to do, not this page's, and vaults
// on several chains are counted with the chains named, never added across them.

export function PortfolioSummary() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { state } = usePortfolio();
  const heading = useId();
  if (state.kind !== 'answered' || state.outcome.kind !== 'read') return null;
  const held = state.outcome.chains.filter((entry) => entry.vaults.length > 0);
  const [read] = held;
  const vaults = held.flatMap((entry) => entry.vaults);
  const [first, ...rest] = vaults;
  if (!read || !first) return null;
  const words = t.portfolio.summary;
  const nameOf = (entry: PortfolioChain) =>
    port.network(entry.chain)?.name ?? t.chain.names[entry.chain];
  const name = nameOf(read);
  const notLive = vaults.find((vault) => vault.provenance !== 'live');
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      className="max-w-(--tf-measure-docs)"
      mock={notLive !== undefined}
      mockLabels={{
        announce:
          notLive?.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
      }}
    >
      <CardHeader
        title={words.title}
        level={2}
        id={heading}
        meta={<ChainBadges chains={held.map((entry) => entry.chain)} />}
      />
      <CardBody>
        <p className="text-body">
          {rest.length === 0 ? (
            <>
              {words.worth(name)}{' '}
              <ProvenancePin
                value={dollars(lang, first.valueUsd)}
                obs={vaultValueSource(read, first, t.portfolio.vault.valueMethod)}
                labels={t.pin}
              />
              .
            </>
          ) : held.length > 1 ? (
            words.manyChains(
              vaults.length,
              new Intl.ListFormat(LOCALE[lang], { type: 'conjunction' }).format(held.map(nameOf)),
            )
          ) : (
            words.many(vaults.length, name)
          )}
        </p>
      </CardBody>
      <CardFooter>
        <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
          {words.see}
        </Link>
      </CardFooter>
    </Card>
  );
}

'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import { vaultValueSource } from './portfolio';
import { usePortfolio } from './use-portfolio';

// On the home page, under the goal: where the person's money already is, in one line, and the way to
// the monitor. It shows only once a vault has been read for a signed-in person; before that, and for
// anyone with no vault, the home page is the goal alone. One vault is named with its value and pin;
// more than one are counted, since adding values up is the API's to do, not this page's.

export function PortfolioSummary() {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const { state } = usePortfolio();
  const heading = useId();
  if (state.kind !== 'answered' || state.outcome.kind !== 'read') return null;
  const read = state.outcome.chain;
  const [first, ...rest] = read.vaults;
  if (!first) return null;
  const words = t.portfolio.summary;
  const name = port.network(read.chain)?.name ?? t.chain.names[read.chain];
  const notLive = read.vaults.find((vault) => vault.provenance !== 'live');
  return (
    <Card
      as="section"
      aria-labelledby={heading}
      className="max-w-(--tf-measure-docs)"
      mock={notLive !== undefined}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: notLive?.provenance === 'sandbox' ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader title={words.title} level={2} id={heading} />
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
          ) : (
            words.many(read.vaults.length, name)
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

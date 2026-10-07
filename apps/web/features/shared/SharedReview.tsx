'use client';
import type { ChainId, Target } from '@colosseum/schemas';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps, tokenName } from '../order/amounts';
import { onMock } from '../order/readiness';
import { useWalletPort } from '../wallet/WalletProvider';
import { SourceMark } from './SourceMark';
import type { SharedTerms } from './terms';

// What an order about a shared portfolio is held to, on the review, as its screen showed it: the
// form's text and weights for a publish, the portfolio and version read for a follow, the vault and
// its targets for more money into one. Never the order the API answered. The creator's words are shown as text, never as markup or a link.

export function SharedReview({ terms, chain }: { terms: SharedTerms; chain: ChainId }) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const mock = onMock(port, chain);
  const s = t.order.shared;
  const share = (bps: number) => formatBps(bps, LOCALE[lang]);
  const weights = (rows: Target[]) => (
    <DataTable<Target>
      caption={s.weights}
      rows={rows}
      rowKey={(r) => r.asset}
      columns={[
        {
          key: 'asset',
          header: t.plan.columns.asset,
          rowHeader: true,
          cell: (r) => tokenName(r.asset),
        },
        {
          key: 'share',
          header: t.plan.columns.share,
          numeric: true,
          cell: (r) => share(r.weightBps),
        },
      ]}
    />
  );
  if (terms.kind === 'publish')
    return (
      <Card as="section" aria-label={s.publishTitle}>
        <CardHeader title={s.publishTitle} level={2} meta={t.chain.names[chain]} />
        <CardBody className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{s.name}</dt>
            <dd className="[overflow-wrap:anywhere]">{terms.text.name}</dd>
            <dt className="text-muted-foreground">{s.slug}</dt>
            <dd className="font-mono text-source">{terms.text.slug}</dd>
            <dt className="text-muted-foreground">{s.copy}</dt>
            <dd className="whitespace-pre-line [overflow-wrap:anywhere]">
              {terms.text.copy || s.noCopy}
            </dd>
            <dt className="text-muted-foreground">{s.version}</dt>
            <dd>{terms.action === 'publish' ? s.first : s.next(terms.version)}</dd>
            <dt className="text-muted-foreground">{s.familyId}</dt>
            <dd className="break-all font-mono text-source">{terms.familyId}</dd>
          </dl>
          {weights(terms.components)}
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {s.publishNote}
          </p>
        </CardBody>
      </Card>
    );
  if (terms.kind === 'vault')
    return (
      <Card as="section" aria-label={s.addTitle}>
        <CardHeader title={s.addTitle} level={2} meta={t.chain.names[chain]} />
        <CardBody className="flex flex-col gap-4">
          <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{s.vault}</dt>
            <dd className="break-all font-mono text-source">{terms.vault}</dd>
          </dl>
          <p
            data-ui="source-mark"
            data-source={terms.source}
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
          >
            <StatusMark
              status={terms.source === 'chain' ? 'on-track' : 'watch'}
              className="mt-1.5"
            />
            <span>
              <span className="font-medium">
                {terms.source === 'chain' ? t.shared.check.verified : t.shared.check.notChecked}.
              </span>{' '}
              {terms.source === 'chain'
                ? t.portfolio.add.source.read(t.chain.names[chain])
                : mock
                  ? t.portfolio.add.source.mock
                  : t.portfolio.add.source.notRead(t.chain.names[chain])}
            </span>
          </p>
          {terms.targets.length > 0 && weights(terms.targets)}
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {terms.keeper
              ? t.portfolio.add.keeper
              : terms.targets.length > 0
                ? s.addNote
                : s.addCashNote}
          </p>
        </CardBody>
      </Card>
    );
  const follow = terms.follow;
  return (
    <Card as="section" aria-label={s.followTitle}>
      <CardHeader title={s.followTitle} level={2} meta={t.chain.names[chain]} />
      <CardBody className="flex flex-col gap-4">
        <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{s.slug}</dt>
          <dd className="font-mono text-source">{terms.slug}</dd>
          {follow && (
            <>
              <dt className="text-muted-foreground">{s.version}</dt>
              <dd>{s.versionN(follow.version)}</dd>
              <dt className="text-muted-foreground">{s.onchain}</dt>
              <dd className="break-all font-mono text-source">{follow.recipeOnchainId}</dd>
            </>
          )}
          {terms.kind === 'follow' && (
            <>
              <dt className="text-muted-foreground">{s.vault}</dt>
              <dd className="break-all font-mono text-source">{terms.vault}</dd>
              <dt className="text-muted-foreground">{s.autoFollow}</dt>
              <dd>{terms.autoFollow ? s.on : s.off}</dd>
            </>
          )}
        </dl>
        <SourceMark source={terms.source} chain={chain} mock={mock} />
        {terms.kind === 'family' && weights(terms.targets)}
      </CardBody>
    </Card>
  );
}

'use client';
import { ChainId, chainFamily, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import type { CallFailure } from '../order/order-api';
import { readVault } from '../shared/shared-api';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { VaultMixFlow } from './VaultMixFlow';

// The weights of a vault the person owns, set by their own hand (gate ANY-COMPOSITION, #191): the
// vault's current targets to start from, any asset of the chain's list added or removed (at most 16
// besides cash, never the cash token), whole percents or basis points, and what is left shown as cash.
// The review and the order are the same as for a preview from the vault conversation.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };

export function TargetsScreen({ chain: chainText, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const e = t.mix.editor;
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const known = ChainId.safeParse(chainText);
  const chain = known.success ? known.data : null;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const titleId = useId();

  useEffect(() => {
    if (!chain) return setLoad({ kind: 'no-plan' });
    let mine = true;
    setLoad({ kind: 'loading' });
    readVault(apiFetch, chain, address).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', read: read.value } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, address]);

  const back = (
    <Link
      href={`/vaults/${encodeURIComponent(chainText)}/${encodeURIComponent(address)}`}
      className={buttonClass({ variant: 'secondary' })}
    >
      {e.back}
    </Link>
  );
  const page = (body: string, more?: React.ReactNode) => (
    <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
      <h1 id={titleId} className={PAGE_TITLE}>
        {e.title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      {more ?? back}
    </section>
  );

  if (port.status === 'loading' || load.kind === 'loading')
    return (
      <Card>
        <CardWait label={e.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (port.status === 'signed-out')
    return page(
      t.plan.signedOut,
      <Link
        href={`/sign-in?next=${encodeURIComponent(`/vaults/${chainText}/${address}/targets`)}`}
        className={buttonClass({ variant: 'secondary' })}
      >
        {t.shell.signIn}
      </Link>,
    );
  if (!chain || load.kind === 'no-plan' || load.kind === 'refused') return page(e.notYours);
  if (load.kind !== 'read') return page(load.kind === 'busy' ? t.shell.slowDown : e.failed);
  const { vault } = load.read;
  const owner = port.active(chainFamily(chain))?.address ?? null;
  if (!owner || vault.owner !== owner) return page(e.notYours);

  return (
    <section aria-labelledby={titleId} data-ui="targets-screen" className="flex flex-col gap-4">
      <h1 id={titleId} className={PAGE_TITLE}>
        {e.title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{e.lead}</p>
      <VaultMixFlow
        chain={chain}
        vault={vault}
        seed={vault.positions
          .filter((position) => position.targetBps > 0)
          .map((position) => ({ assetId: position.asset, weightBps: position.targetBps }))}
        from="person"
        provenance={load.read.provenance}
      />
      <Disclaimer lang={lang} label={t.shell.disclaimer} />
    </section>
  );
}

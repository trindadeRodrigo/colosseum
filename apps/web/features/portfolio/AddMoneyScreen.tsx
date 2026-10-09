'use client';
import { ChainId, chainFamily, type Target } from '@colosseum/schemas';
import Link from 'next/link';
import { useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { shorten } from '../../components/ui/format';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { parseNumber } from '../goal/sheet';
import {
  AmountField,
  InvestCard,
  type InvestEmbedded,
  type InvestPlaced,
  MAX_USD,
  MIN_USD,
} from '../order/InvestCard';
import { addMoneyPath, placeOrder } from '../order/order-api';
import { keepOrder } from '../order/order-record';
import { chainReady, onMock } from '../order/readiness';
import type { SharedTerms } from '../shared/terms';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { sameTargets, useChainVault } from './chain-vault';
import type { Vault } from './portfolio';
import { usePortfolio } from './use-portfolio';
import { PlanParts } from './VaultPanel';
import { ownVault, sameAddress } from './vault-name';

// More money into a vault the person has (Thom, Oct 6), on one card with one press (InvestCard, gate
// INVEST-ONE-PRESS): the amount, then the card with what the wallet is missing only when it is short
// (GET /v1/funding with the vault), the trust notice where it was never accepted, and the order as our
// server made it (POST /v1/orders with `vault`) with the button that names the amount. The vault is
// one of the person's own, as their portfolio lists it, and the order is held to it and to its targets
// as this app reads them from the chain itself (chain-vault.ts; our server's where it cannot, said to
// be unverified), kept as terms of kind `vault`. With `embedded`, another screen gives the amount.

/**
 * What an add buys: the vault's targets in the order the portfolio lists its positions, which is the
 * order the API plans the trades in (`planVaultBuy` of apps/api/src/orders/prepare.ts).
 */
export const targetsOfVault = (vault: Pick<Vault, 'positions'>): Target[] =>
  vault.positions
    .filter((p) => p.targetBps > 0)
    .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));

export function AddMoneyScreen({
  chain: chainParam,
  address,
  embedded,
}: {
  chain: string;
  address: string;
  embedded?: InvestEmbedded;
}) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { state } = usePortfolio();
  const [text, setText] = useState('');
  const [locked, setLocked] = useState(false);
  const words = t.portfolio.add;

  const known = ChainId.safeParse(chainParam);
  const chain = known.success ? known.data : null;
  const read = state.kind === 'answered' && state.outcome.kind === 'read' ? state.outcome : null;
  const own = read && chain ? ownVault(read.chains, chain, address) : null;
  const vault = own?.vault ?? null;
  const active = chain ? (port.active(chainFamily(chain))?.address ?? null) : null;
  // The wallet that signs is the vault's owner, or nothing is asked of it.
  const owner = chain && vault && active && sameAddress(chain, vault.owner, active) ? active : null;
  const parsed = parseNumber(text, lang);
  const typed =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;
  const amount = embedded ? embedded.amount : typed;
  const mock = chain ? onMock(port, chain) : false;
  // The vault as this app reads it from its own node: what the add's trades are held to.
  const check = useChainVault(
    chain,
    mock,
    vault && owner ? { owner, basketId: vault.basketId, address: vault.address } : null,
  );

  if (state.kind === 'loading' || state.kind === 'reading')
    return (
      <Card>
        <CardWait label={t.portfolio.reading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (!chain || !own || !vault) {
    const signedOut = state.kind === 'signed-out';
    return (
      <section data-ui="add-money-missing" className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{words.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">
          {signedOut ? t.portfolio.signedOut : words.missing}
        </p>
        <Link
          href={
            signedOut && chain
              ? `/sign-in?next=${encodeURIComponent(addMoneyPath(chain, address))}`
              : '/portfolio'
          }
          className={buttonClass({ variant: 'secondary' })}
        >
          {signedOut ? t.shell.signIn : words.back}
        </Link>
      </section>
    );
  }

  const chainName = port.network(chain)?.name ?? t.chain.names[chain];
  const shown = targetsOfVault(vault);
  // What the add is held to: the chain's targets where this app read them, and our server's, said to
  // be unverified, where it could not. With auto-follow on the add is the deposit alone.
  const held: Pick<
    Extract<SharedTerms, { kind: 'vault' }>,
    'targets' | 'keeper' | 'source'
  > | null =
    check.state === 'read'
      ? check.targets
        ? {
            targets: check.vault.autoFollow ? [] : check.targets,
            keeper: check.vault.autoFollow,
            source: 'chain',
          }
        : null
      : check.state === 'unverified'
        ? { targets: vault.autoFollow ? [] : shown, keeper: vault.autoFollow, source: 'api' }
        : null;
  // Our server plans the order from its own read: where that is not the chain's, the order it would
  // make is one this app would refuse at the review, so none is made.
  const differs =
    check.state === 'read' &&
    check.targets !== null &&
    (!sameTargets(check.targets, shown) || check.vault.autoFollow !== vault.autoFollow);
  const sourceWords = words.source;
  const sourceSentence =
    check.state === 'reading'
      ? t.shared.check.reading
      : check.state === 'failed'
        ? sourceWords.failed(chainName)
        : check.state === 'missing'
          ? sourceWords.missing(chainName)
          : check.state === 'unverified'
            ? check.why === 'mock'
              ? sourceWords.mock
              : sourceWords.notRead(chainName)
            : !check.targets
              ? sourceWords.unlisted
              : differs
                ? sourceWords.differs(chainName)
                : sourceWords.read(chainName);
  const alarm = owner !== null && check.state !== 'reading' && (held === null || differs);
  const blocked = [
    ...(!chainReady(chain, mock) ? [t.plan.chainNotReady(chainName)] : []),
    ...(port.network(chain)?.on === false ? [t.plan.chainOff(chainName)] : []),
    ...(!active ? [t.buy.blocked.wallet] : !owner ? [words.otherWallet(shorten(vault.owner))] : []),
    // Nothing is offered until the vault is read, and never against a read that failed or differs.
    ...(owner && (held === null || differs) ? [sourceSentence] : []),
  ];

  /** Makes the order for this amount and keeps what the add is held to with it. */
  async function place(amountUsd: number): Promise<InvestPlaced> {
    if (!chain || !vault || !owner || !port.userId || !held || differs)
      return { failure: sourceSentence };
    // What the add is held to: the vault chosen and its targets as read, never the order the API answers.
    const terms: SharedTerms = {
      kind: 'vault',
      vault: vault.address,
      basketId: vault.basketId,
      ...held,
    };
    const outcome = await placeOrder(apiFetch, {
      vault: vault.address,
      amountUsd,
      chain,
      owner,
    });
    if (outcome.kind !== 'placed')
      return {
        failure:
          outcome.kind === 'code'
            ? (t.buy.failure[outcome.code as keyof typeof t.buy.failure] ?? t.buy.failure.refused)
            : outcome.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : outcome.kind === 'no-chain'
                ? t.buy.failure.noChain
                : outcome.kind === 'no-plan'
                  ? words.noVault
                  : outcome.kind === 'busy'
                    ? t.shell.slowDown
                    : outcome.kind === 'unreadable'
                      ? t.buy.failure.unreadable
                      : outcome.kind === 'refused'
                        ? t.buy.failure.refused
                        : t.buy.failure.unreachable,
      };
    const kept = keepOrder({
      orderId: outcome.order.id,
      userId: port.userId,
      proposalId: '',
      chain,
      amountUsd,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) return { failure: t.buy.failure.noStore };
    return { orderId: outcome.order.id, expiresAt: outcome.order.expiresAt };
  }

  // The wallet that is signed in when it is not the vault's owner: nothing is asked of it.
  const card = (
    <InvestCard
      chain={chain}
      chainName={chainName}
      mock={mock}
      amount={amount}
      owner={owner}
      userId={port.userId}
      buyOf={{ vault: vault.address, vaultChain: chain }}
      // With auto-follow on the add only deposits, and the keeper invests it: nothing is split here.
      holdings={held && !held.keeper ? held.targets : null}
      blocked={blocked}
      place={place}
      onProgress={(progress) => {
        setLocked(true);
        embedded?.onProgress?.(progress);
      }}
      onDone={embedded?.onDone}
      onStopped={embedded?.onStopped}
      onAmount={embedded ? embedded.onAmount : (next) => setText(String(next))}
    />
  );

  // What the add is held to, over the card: the vault's parts and where they were read.
  const context = (
    <div className="flex max-w-3xl flex-col gap-3">
      <PlanParts vault={vault} />
      {owner && (
        <p
          data-ui="source-mark"
          data-source={check.state === 'read' ? 'chain' : 'api'}
          data-state={check.state}
          className={
            alarm
              ? 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive'
              : 'flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm'
          }
        >
          <StatusMark
            status={alarm ? 'off-track' : check.state === 'read' ? 'on-track' : 'watch'}
            className="mt-1.5"
          />
          <span>
            {check.state !== 'reading' && (
              <span className="font-medium">
                {check.state === 'read' ? t.shared.check.verified : t.shared.check.notChecked}.{' '}
              </span>
            )}
            {sourceSentence}
          </span>
        </p>
      )}
      {held?.keeper && (
        <p data-ui="add-keeper" className="max-w-(--tf-measure-body) text-body-sm">
          {words.keeper}
        </p>
      )}
      {vault.pending && (
        <p data-ui="add-newer-version" className="max-w-(--tf-measure-body) text-body-sm">
          {words.newerVersion(vault.pending.version)}
        </p>
      )}
    </div>
  );
  if (embedded)
    return (
      <div data-ui="vault-invest" className="flex flex-col gap-3">
        {context}
        {card}
      </div>
    );

  return (
    <div data-ui="add-money-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 className={PAGE_TITLE}>{words.title}</h1>
        {vault.name && (
          // The person's own words, as text.
          <p className="max-w-(--tf-measure-body) text-body font-medium [overflow-wrap:anywhere]">
            {vault.name}
          </p>
        )}
        <p className="max-w-(--tf-measure-body) text-body-lg">{words.lead(chainName)}</p>
        <p className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="font-mono text-source text-muted-foreground" title={vault.address}>
            {shorten(vault.address)}
          </span>
          <Link href="/portfolio" className={buttonClass({ variant: 'link' })}>
            {words.back}
          </Link>
        </p>
      </header>
      <div className="grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-5" aria-label={words.title}>
          <AmountField
            text={text}
            onText={setText}
            hint={words.amountHint}
            value={typed}
            disabled={locked}
          />
          {card}
        </section>
        <section
          className="flex min-w-0 flex-col gap-4 border-t border-border pt-5"
          aria-label={words.strategy}
        >
          <h2 className="text-h3">{words.strategy}</h2>
          {context}
        </section>
      </div>
    </div>
  );
}

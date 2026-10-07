'use client';
import { ChainId, chainFamily, type Target, TRUST_STATUS } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { shorten } from '../../components/ui/format';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { BuySteps, MAX_USD, MIN_USD } from '../order/BuySteps';
import type { Funding } from '../order/FundingStep';
import { addMoneyPath, type OrderOutcome, placeOrder, readFunding } from '../order/order-api';
import { acceptTrust, keepOrder, trustAccepted } from '../order/order-record';
import { chainReady, onMock } from '../order/readiness';
import type { SharedTerms } from '../shared/terms';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import type { Vault } from './portfolio';
import { usePortfolio } from './use-portfolio';
import { PlanParts } from './VaultPanel';
import { ownVault, sameAddress } from './vault-name';

// More money into a vault the person has (Thom, Oct 6), in the buy's four steps (BuySteps): the amount,
// what the wallet is missing for it on the vault's chain (GET /v1/funding with the vault), the trust
// notice where it was never accepted, and one button that names the amount. It makes the order (POST
// /v1/orders with `vault`) and leads to the order screen, where every step is reviewed before anything
// is signed. The vault is one of the person's own, as their portfolio lists it, and the order is held
// to it and to the targets shown here (features/shared/terms.ts, kind `vault`). Nothing is signed here.

/**
 * What an add buys: the vault's targets in the order the portfolio lists its positions, which is the
 * order the API plans the trades in (`planVaultBuy` of apps/api/src/orders/prepare.ts).
 */
export const targetsOfVault = (vault: Pick<Vault, 'positions'>): Target[] =>
  vault.positions
    .filter((p) => p.targetBps > 0)
    .map((p) => ({ asset: p.asset, weightBps: p.targetBps }));

export function AddMoneyScreen({ chain: chainParam, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const { state } = usePortfolio();
  const [text, setText] = useState('');
  const [funding, setFunding] = useState<Funding>({ kind: 'idle' });
  const [round, setRound] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<OrderOutcome['kind'] | 'noStore' | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const asked = useRef(0);
  const words = t.portfolio.add;

  const known = ChainId.safeParse(chainParam);
  const chain = known.success ? known.data : null;
  const read = state.kind === 'answered' && state.outcome.kind === 'read' ? state.outcome : null;
  const own = read && chain ? ownVault(read.chains, chain, address) : null;
  const vault = own?.vault ?? null;
  const active = chain ? (port.active(chainFamily(chain))?.address ?? null) : null;
  // The wallet that signs is the vault's owner, or nothing is asked of it.
  const owner = chain && vault && active && sameAddress(chain, vault.owner, active) ? active : null;
  const parsed = parseNumber(text);
  const amount =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;
  const vaultAddress = vault?.address ?? null;

  // What the wallet is missing for this amount, read again a moment after the amount stops changing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the wallet again
  useEffect(() => {
    if (!chain || !vaultAddress || !owner || amount === null) {
      setFunding({ kind: 'idle' });
      return;
    }
    asked.current += 1;
    const mine = asked.current;
    setFunding({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const answer = await readFunding(apiFetch, {
        vault: vaultAddress,
        vaultChain: chain,
        amountUsd: amount,
        wallet: owner,
      });
      if (asked.current === mine) setFunding(answer);
    }, 300);
    return () => clearTimeout(timer);
  }, [chain, vaultAddress, owner, amount, apiFetch, round]);

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
              : '/monitor'
          }
          className={buttonClass({ variant: 'secondary' })}
        >
          {signedOut ? t.shell.signIn : words.back}
        </Link>
      </section>
    );
  }

  const mock = onMock(port, chain);
  const chainName = port.network(chain)?.name ?? t.chain.names[chain];
  const accepted = trustAccepted(port.userId, TRUST_STATUS.textVersion);
  const funded = funding.kind === 'read' ? funding.funding : null;
  const blocked = [
    ...(!chainReady(chain, mock) ? [t.plan.chainNotReady(chainName)] : []),
    ...(port.network(chain)?.on === false ? [t.plan.chainOff(chainName)] : []),
    ...(!active ? [t.buy.blocked.wallet] : !owner ? [words.otherWallet(shorten(vault.owner))] : []),
    ...(amount === null ? [t.buy.blocked.amount] : []),
    ...(amount !== null && owner && !funded?.ok ? [t.buy.blocked.funding] : []),
    ...(!accepted && !ticked ? [t.buy.blocked.trust] : []),
  ];

  async function review() {
    if (!chain || !vault || !owner || amount === null || !port.userId) return;
    setPlacing(true);
    setFailure(null);
    setFailureCode(null);
    // What the add is held to: the vault chosen and the targets shown, never the order the API answers.
    const terms: SharedTerms = {
      kind: 'vault',
      vault: vault.address,
      basketId: vault.basketId,
      targets: targetsOfVault(vault),
    };
    const outcome = await placeOrder(apiFetch, {
      vault: vault.address,
      amountUsd: amount,
      chain,
      owner,
    });
    if (outcome.kind !== 'placed') {
      setPlacing(false);
      setFailure(outcome.kind);
      if (outcome.kind === 'code') setFailureCode(outcome.code);
      return;
    }
    if (!accepted) acceptTrust(port.userId, TRUST_STATUS.textVersion);
    const kept = keepOrder({
      orderId: outcome.order.id,
      userId: port.userId,
      proposalId: '',
      chain,
      amountUsd: amount,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setPlacing(false);
      setFailure('noStore');
      return;
    }
    router.push(`/orders/${encodeURIComponent(outcome.order.id)}`);
  }

  const failureSentence =
    failure === null
      ? null
      : failure === 'code' && failureCode
        ? (t.buy.failure[failureCode as keyof typeof t.buy.failure] ?? t.buy.failure.refused)
        : failure === 'signed-out'
          ? t.buy.failure.signedOut
          : failure === 'no-chain'
            ? t.buy.failure.noChain
            : failure === 'no-plan'
              ? words.noVault
              : failure === 'busy'
                ? t.shell.slowDown
                : failure === 'noStore'
                  ? t.buy.failure.noStore
                  : failure === 'unreadable'
                    ? t.buy.failure.unreadable
                    : failure === 'refused'
                      ? t.buy.failure.refused
                      : t.buy.failure.unreachable;

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
          <Link href="/monitor" className={buttonClass({ variant: 'link' })}>
            {words.back}
          </Link>
        </p>
      </header>
      <div className="max-w-3xl">
        <PlanParts vault={vault} />
      </div>
      <BuySteps
        chain={chain}
        chainName={chainName}
        mock={mock}
        amount={{ text, onText: setText, hint: words.amountHint, value: amount }}
        funding={funding}
        owner={owner}
        buyOf={{ vault: vault.address, vaultChain: chain }}
        onReadAgain={() => setRound((n) => n + 1)}
        trust={{ accepted, checked: ticked, onCheck: setTicked }}
        order={{
          label: words.review(dollars(amount ?? MIN_USD, lang)),
          busy: placing,
          busyLabel: t.buy.reviewing,
          blocked,
          failure: failureSentence,
          onReview: review,
          lead: words.reviewLead(amount === null ? '' : dollars(amount, lang), chainName),
        }}
      />
    </div>
  );
}

'use client';
import { chainFamily, type SharedFamily } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonPlan } from '../../components/ui/Skeleton';
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
import { keepOrder } from '../order/order-record';
import { useApiFetch } from '../wallet/WalletProvider';
import { familyIdFor, useChainRecipe } from './chain-recipe';
import { followedOf } from './FamilyScreen';
import { sharedRefusal } from './refusal';
import { SourceMark } from './SourceMark';
import { placeShared, readFamily } from './shared-api';
import type { SharedTerms } from './terms';
import { useSharedPerson } from './use-person';

// Buying a shared portfolio, which opens a vault that follows it on the person's chain (gate
// ONE-CHAIN), on one card with one press (InvestCard, gate INVEST-ONE-PRESS): the amount, then the
// card with what the wallet is missing only when it is short (GET /v1/funding with the slug), the
// trust notice the first time, and the order as our server made it with the button that names the
// amount. The version and the weights the buy is held to are the chain's where this app read them,
// and our server's, said to be unverified, where it could not (chain-recipe.ts). With `embedded`,
// another screen gives the amount and mounts the card with its source line alone.

export function FamilyBuyScreen({ slug, embedded }: { slug: string; embedded?: InvestEmbedded }) {
  const t = useT();
  const lang = useLang();
  const apiFetch = useApiFetch();
  const person = useSharedPerson();
  const [family, setFamily] = useState<SharedFamily | null | 'failed'>(null);
  const [text, setText] = useState('100');
  const [locked, setLocked] = useState(false);
  const [round, setRound] = useState(0);
  // Our server said the portfolio changed: the way back to its page is offered under the card.
  const [changed, setChanged] = useState(false);
  const chain = person.kind === 'ready' ? person.chain : null;
  const owner = person.kind === 'ready' ? person.owner : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the portfolio again
  useEffect(() => {
    if (!chain) return;
    let mine = true;
    readFamily(apiFetch, slug, chain).then((read) => {
      if (mine) setFamily(read.kind === 'read' ? read.value.family : 'failed');
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, chain, round]);

  const recipe =
    family && family !== 'failed' && chain
      ? (family.recipes.find((r) => r.chain === chain) ?? null)
      : null;
  const mock = person.kind === 'ready' ? person.mock : false;
  const check = useChainRecipe(
    chain ?? 'solana',
    mock,
    family && family !== 'failed' ? family : null,
    recipe,
  );
  const followed = recipe ? followedOf(recipe, check) : null;
  const parsed = parseNumber(text, lang);
  const own =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;
  const amount = embedded ? embedded.amount : own;

  if (person.kind === 'loading' || (person.kind === 'ready' && family === null))
    return (
      <Card>
        <CardWait label={t.shared.family.loading} skeleton={<SkeletonPlan legs={3} />} />
      </Card>
    );
  if (person.kind !== 'ready' || family === 'failed' || !family || !recipe || !chain)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{t.shared.buy.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">
          {person.kind === 'signed-out'
            ? t.plan.signedOut
            : person.kind === 'no-chain'
              ? t.goal.blocked.chainNotChosen
              : family === 'failed'
                ? t.shared.family.missing
                : t.shared.family.notHere(chain ? t.chain.names[chain] : '')}
        </p>
        <Link
          href={
            person.kind === 'signed-out'
              ? `/sign-in?next=/indexes/${encodeURIComponent(slug)}/buy`
              : `/indexes/${encodeURIComponent(slug)}`
          }
          className={buttonClass({ variant: 'secondary' })}
        >
          {person.kind === 'signed-out' ? t.shell.signIn : t.shared.family.backToShelf}
        </Link>
      </section>
    );

  const chainName = t.chain.names[chain];
  const blocked = [
    ...(!person.signable || person.off ? [t.shared.family.chainNotReady(chainName)] : []),
    ...(!followed ? [t.shared.check.reading] : []),
    ...(followed?.missing ? [t.shared.buy.blocked.missing] : []),
    ...(followed?.tampered ? [t.shared.family.tampered(chainName)] : []),
    ...(followed?.unlisted ? [t.shared.buy.blocked.unlisted] : []),
    ...(followed?.foreign ? [t.shared.family.foreign] : []),
  ];

  /** Makes the order for this amount and keeps the terms this page showed with it. */
  async function place(amountUsd: number): Promise<InvestPlaced> {
    if (!family || family === 'failed' || !chain || !owner || !followed?.targets)
      return { failure: t.shared.check.reading };
    if (person.kind !== 'ready' || !person.userId) return { failure: t.buy.failure.signedOut };
    // What the buy is held to: the version and weights shown, never the order the API answers.
    const terms: SharedTerms = {
      kind: 'family',
      slug,
      // The vault's number is basketIdOfPlan(familyIdOf(slug)): this page's own, never the server's.
      familyId: familyIdFor(slug),
      follow: followed.follow,
      targets: followed.targets,
      source: followed.source,
    };
    const placed = await placeShared(
      apiFetch,
      {
        type: 'buy',
        owner: { [chainFamily(chain)]: owner },
        amountUsd,
        family: slug,
        version: followed.follow.version,
      },
      { chain, owner, type: 'buy' },
    );
    if (placed.kind !== 'placed') {
      // A refusal with a code is said in this app's own words for a portfolio (refusal.ts); only
      // one it has none for is said in our server's.
      const refused =
        placed.kind === 'said' || placed.kind === 'code' ? sharedRefusal(placed, t) : null;
      // The portfolio has another version than the page showed: it is read again here, so what the
      // next order is held to is the new one, the host is told, and the way back to its page is offered.
      setChanged(refused?.changed === true);
      if (refused?.changed) setRound((n) => n + 1);
      return {
        ...(refused?.changed ? { versionChanged: true } : {}),
        failure: refused
          ? refused.sentence
          : placed.kind === 'said'
            ? t.shared.publish.failure.said(placed.error)
            : placed.kind === 'code'
              ? t.buy.failure.refused
              : placed.kind === 'busy'
                ? t.shell.slowDown
                : placed.kind === 'signed-out'
                  ? t.buy.failure.signedOut
                  : placed.kind === 'unreadable'
                    ? t.buy.failure.unreadable
                    : t.buy.failure.unreachable,
      };
    }
    setChanged(false);
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain,
      amountUsd,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) return { failure: t.buy.failure.noStore };
    return {
      orderId: placed.order.id,
      expiresAt: placed.order.expiresAt,
      ...(placed.order.basketId ? { basketId: placed.order.basketId } : {}),
    };
  }

  const card = (
    <InvestCard
      chain={chain}
      chainName={chainName}
      mock={mock}
      amount={amount}
      owner={owner}
      userId={person.userId}
      buyOf={{ family: slug }}
      holdings={followed?.targets ?? null}
      blocked={blocked}
      place={place}
      onProgress={(progress) => {
        setLocked(true);
        embedded?.onProgress?.(progress);
      }}
      onDone={embedded?.onDone}
      onStopped={embedded?.onStopped}
      onVersionChanged={embedded?.onVersionChanged}
    />
  );
  if (embedded)
    return (
      <div data-ui="family-invest" className="flex flex-col gap-3">
        <SourceMark check={check} chain={chain} />
        {card}
      </div>
    );

  return (
    <div data-ui="family-buy-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className={PAGE_TITLE}>{t.shared.buy.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body font-medium [overflow-wrap:anywhere]">
          {family.name}
        </p>
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.shared.buy.lead(chainName)}</p>
        <SourceMark check={check} chain={chain} />
      </header>

      <AmountField
        text={text}
        onText={setText}
        hint={t.shared.buy.amountHint}
        value={own}
        disabled={locked}
      />
      {card}
      {changed && (
        <Link
          data-ui="family-reopen"
          href={`/indexes/${encodeURIComponent(slug)}`}
          className={`${buttonClass({ variant: 'secondary' })} self-start`}
        >
          {t.shared.refusal.reopen}
        </Link>
      )}
    </div>
  );
}

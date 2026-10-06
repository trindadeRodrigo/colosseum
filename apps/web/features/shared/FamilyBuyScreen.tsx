'use client';
import { chainFamily, type SharedFamily, TRUST_STATUS } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardLoading } from '../../components/ui/Card';
import { Field, Input } from '../../components/ui/Field';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { type Funding, FundingCard, MAX_USD, MIN_USD } from '../order/BuyScreen';
import { fundMock, readFunding } from '../order/order-api';
import { acceptTrust, keepOrder, trustAccepted } from '../order/order-record';
import { gasUnitsFor } from '../order/readiness';
import { TrustNotice } from '../order/TrustNotice';
import { unitsFor } from '../order/units';
import { useApiFetch } from '../wallet/WalletProvider';
import { familyIdFor, useChainRecipe } from './chain-recipe';
import { followedOf } from './FamilyScreen';
import { SourceMark } from './SourceMark';
import { placeShared, readFamily } from './shared-api';
import type { SharedTerms } from './terms';
import { useSharedPerson } from './use-person';

// Buying a shared portfolio, which opens a vault that follows it on the person's chain (gate
// ONE-CHAIN): the amount, what the wallet is missing for it (GET /v1/funding with the slug), the trust
// notice before the first deposit, and one primary button that names the amount. The version and the
// weights the buy is held to are the chain's where this app read them, and our server's, said to be
// unverified, where it could not (chain-recipe.ts). The order is reviewed and signed on the order
// screen.

export function FamilyBuyScreen({ slug }: { slug: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const apiFetch = useApiFetch();
  const person = useSharedPerson();
  const [family, setFamily] = useState<SharedFamily | null | 'failed'>(null);
  const [text, setText] = useState('100');
  const [funding, setFunding] = useState<Funding>({ kind: 'idle' });
  const [round, setRound] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [addingMock, setAddingMock] = useState(false);
  const reasonId = useId();
  const fundingId = useId();
  const asked = useRef(0);
  const chain = person.kind === 'ready' ? person.chain : null;
  const owner = person.kind === 'ready' ? person.owner : null;

  useEffect(() => {
    if (!chain) return;
    let mine = true;
    readFamily(apiFetch, slug, chain).then((read) => {
      if (mine) setFamily(read.kind === 'read' ? read.value.family : 'failed');
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, chain]);

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
  const parsed = parseNumber(text);
  const amount =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the wallet again
  useEffect(() => {
    if (!recipe || !owner || amount === null) {
      setFunding({ kind: 'idle' });
      return;
    }
    asked.current += 1;
    const mine = asked.current;
    setFunding({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFunding(apiFetch, { family: slug, amountUsd: amount, wallet: owner });
      if (asked.current === mine) setFunding(read);
    }, 300);
    return () => clearTimeout(timer);
  }, [recipe, owner, amount, apiFetch, slug, round]);

  if (person.kind === 'loading' || (person.kind === 'ready' && family === null))
    return (
      <Card>
        <CardLoading label={t.shared.family.loading} />
      </Card>
    );
  if (person.kind !== 'ready' || family === 'failed' || !family || !recipe || !chain)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className="font-sans text-h2 font-semibold">{t.shared.buy.title}</h1>
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
  const accepted = trustAccepted(person.userId, TRUST_STATUS.textVersion);
  const read = funding.kind === 'read' ? funding.funding : null;
  const blocked = [
    ...(!person.signable || person.off ? [t.shared.family.chainNotReady(chainName)] : []),
    ...(!followed ? [t.shared.check.reading] : []),
    ...(followed?.missing ? [t.shared.buy.blocked.missing] : []),
    ...(followed?.unlisted ? [t.shared.buy.blocked.unlisted] : []),
    ...(followed?.foreign ? [t.shared.family.foreign] : []),
    ...(!owner ? [t.buy.blocked.wallet] : []),
    ...(amount === null ? [t.buy.blocked.amount] : []),
    ...(amount !== null && owner && !read?.ok ? [t.buy.blocked.funding] : []),
    ...(!accepted && !ticked ? [t.buy.blocked.trust] : []),
  ];

  async function review() {
    if (!family || family === 'failed' || !chain || !owner || amount === null || !followed?.targets)
      return;
    if (person.kind !== 'ready' || !person.userId) return;
    setPlacing(true);
    setFailure(null);
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
        amountUsd: amount,
        family: slug,
        version: followed.follow.version,
      },
      { chain, owner, type: 'buy' },
    );
    if (placed.kind !== 'placed') {
      setPlacing(false);
      setFailure(
        placed.kind === 'said'
          ? t.shared.publish.failure.said(placed.error)
          : placed.kind === 'code'
            ? (t.buy.failure[placed.code as keyof typeof t.buy.failure] ?? t.buy.failure.refused)
            : placed.kind === 'busy'
              ? t.shell.slowDown
              : placed.kind === 'signed-out'
                ? t.buy.failure.signedOut
                : placed.kind === 'unreadable'
                  ? t.buy.failure.unreadable
                  : t.buy.failure.unreachable,
      );
      return;
    }
    if (!accepted) acceptTrust(person.userId, TRUST_STATUS.textVersion);
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain,
      amountUsd: amount,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setPlacing(false);
      setFailure(t.buy.failure.noStore);
      return;
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  async function addMock() {
    if (!chain) return;
    setAddingMock(true);
    await fundMock(apiFetch, { chain, cashUsd: Math.max(amount ?? 0, MIN_USD) * 2 });
    setAddingMock(false);
    setRound((n) => n + 1);
  }

  return (
    <div data-ui="family-buy-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="max-w-(--tf-measure-display) font-display text-h1 font-normal">
          {t.shared.buy.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body font-medium [overflow-wrap:anywhere]">
          {family.name}
        </p>
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.shared.buy.lead(chainName)}</p>
        <SourceMark check={check} chain={chain} />
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="flex flex-col gap-6">
          <Card>
            <CardBody>
              <Field
                label={t.buy.amount.label}
                hint={t.shared.buy.amountHint}
                error={text.trim() && amount === null ? t.buy.blocked.amount : undefined}
              >
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    width="14ch"
                    value={text}
                    onChange={(e) => setText(e.currentTarget.value)}
                  />
                )}
              </Field>
            </CardBody>
          </Card>
          <FundingCard
            id={fundingId}
            funding={funding}
            chainName={chainName}
            owner={owner}
            mock={mock}
            units={unitsFor(chain, mock)}
            gasUnits={gasUnitsFor(chain)}
            mockBusy={addingMock}
            onReadAgain={() => setRound((n) => n + 1)}
            onMock={addMock}
          />
        </div>
        <TrustNotice chain={chain} accepted={accepted} checked={ticked} onCheck={setTicked} />
      </div>

      <div className="flex flex-col items-start gap-2">
        <Button
          variant="primary"
          busy={placing}
          busyLabel={t.buy.reviewing}
          disabled={blocked.length > 0}
          aria-describedby={blocked.length > 0 ? reasonId : undefined}
          onClick={review}
        >
          {t.shared.buy.review(dollars(amount ?? MIN_USD, lang))}
        </Button>
        {blocked.length > 0 && (
          <ul id={reasonId} className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
            {blocked.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {failure && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{failure}</span>
          </p>
        )}
      </div>
    </div>
  );
}

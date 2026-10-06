'use client';
import type { SharedFamily, SharedRecipe } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty, CardHeader, CardLoading } from '../../components/ui/Card';
import { ChainBadges } from '../../components/ui/ChainBadge';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { assetTicker, formatBps } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { networkFor } from '../order/readiness';
import { useApiFetch } from '../wallet/WalletProvider';
import { isPlatformCreator } from './platform';
import { readShelf } from './shared-api';
import { shortAddress, useSharedPerson } from './use-person';

// The shelf (DESIGN-VAULT section 11): a card per shared portfolio, with its name, its creator's
// address, the platform badge, the version in effect and its weights, and whether auto-follow is
// offered on it (gate GOLD-ONE-TAP). A signed-in person sees only the portfolios with a recipe on their
// own chain (gate ONE-CHAIN). What a card says is the server's store: the portfolio's page reads the
// chain. A creator's name and description are text, never markup or a link.

type Load =
  | { kind: 'loading' }
  | { kind: 'read'; families: SharedFamily[] }
  | { kind: CallFailure };

export function ShelfScreen() {
  const t = useT();
  const apiFetch = useApiFetch();
  const person = useSharedPerson();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  const titleId = useId();
  const chain = person.kind === 'ready' ? person.chain : null;
  const settled = person.kind !== 'loading';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the shelf again
  useEffect(() => {
    if (!settled) return;
    let mine = true;
    setLoad({ kind: 'loading' });
    readShelf(apiFetch, chain).then((read) => {
      if (mine)
        setLoad(read.kind === 'read' ? { kind: 'read', families: read.value.families } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, settled, round]);

  const chainName = chain ? t.chain.names[chain] : null;
  return (
    <div data-ui="shelf-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 id={titleId} className="max-w-(--tf-measure-display) font-display text-h1 font-normal">
          {t.shared.shelf.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">
          {chainName ? t.shared.shelf.lead(chainName) : t.shared.shelf.leadAll}
        </p>
        {person.kind === 'ready' && person.publishable && (
          <Link href="/publish" className={`${buttonClass({ variant: 'link' })} self-start`}>
            {t.shared.shelf.publish}
          </Link>
        )}
      </header>

      {load.kind === 'loading' ? (
        <Card>
          <CardLoading label={t.shared.shelf.loading} />
        </Card>
      ) : load.kind !== 'read' ? (
        <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
          <p className="max-w-(--tf-measure-body) text-body">
            {load.kind === 'busy'
              ? t.shell.slowDown
              : load.kind === 'unreadable'
                ? t.shared.shelf.failure.unreadable
                : t.shared.shelf.failure.unreachable}
          </p>
          <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
            {t.shared.shelf.failure.retry}
          </Button>
        </section>
      ) : load.families.length === 0 ? (
        <Card>
          <CardEmpty
            sentence={chainName ? t.shared.shelf.empty(chainName) : t.shared.shelf.emptyAll}
            action={
              person.kind === 'ready' && person.publishable ? (
                <Link href="/publish" className={buttonClass({ variant: 'link' })}>
                  {t.shared.shelf.publish}
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul aria-labelledby={titleId} className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          {load.families.map((family) => (
            <li key={family.familyId} data-ui="shelf-card">
              <FamilyCard family={family} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FamilyCard({ family }: { family: SharedFamily }) {
  const t = useT();
  const lang = useLang();
  const c = t.shared.shelf.card;
  const [recipe] = family.recipes;
  const href = `/indexes/${encodeURIComponent(family.slug)}`;
  const notLive = family.recipes.some((r) => r.provenance !== 'live');
  return (
    <Card
      as="article"
      interactive
      className="h-full"
      mock={notLive}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: family.recipes.some((r) => r.provenance === 'sandbox')
          ? t.shell.testNetwork
          : undefined,
      }}
    >
      <CardHeader
        title={
          // The card's one link, stretched over the card; a link of the app, so the page is not reloaded.
          <Link
            href={href}
            className="outline-none [overflow-wrap:anywhere] after:absolute after:inset-0"
          >
            {family.name}
          </Link>
        }
        meta={recipe ? c.version(recipe.active.version) : undefined}
      />
      <CardBody className="flex flex-col gap-3">
        <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm text-muted-foreground">
          {recipe && (
            <span className="font-mono text-source" title={recipe.creator}>
              {c.by(shortAddress(recipe.creator))}
            </span>
          )}
          {recipe &&
            isPlatformCreator(
              networkFor(recipe.chain, recipe.provenance === 'mock'),
              recipe.chain,
              recipe.creator,
            ) && <span className="font-medium text-foreground">{c.platform}</span>}
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            {c.on} <ChainBadges chains={family.chains} />
          </span>
        </p>
        {family.copy && (
          <p className="line-clamp-3 max-w-(--tf-measure-body) text-body-sm [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
        {recipe && <Weights recipe={recipe} locale={LOCALE[lang]} />}
        {recipe && <Offer recipe={recipe} />}
        {recipe && recipe.textMatches === null && (
          <p className="flex items-start gap-1.5 text-body-sm">
            <StatusMark status="watch" className="mt-1.5" />
            <span>{t.shared.text.unverified}</span>
          </p>
        )}
        {recipe?.pending && (
          <p className="text-body-sm text-muted-foreground">{c.waiting(recipe.pending.version)}</p>
        )}
      </CardBody>
    </Card>
  );
}

/** The version in effect, as one line of asset and weight pairs in the mono face. */
export function Weights({ recipe, locale }: { recipe: SharedRecipe; locale: string }) {
  return (
    <p className="font-mono text-source [overflow-wrap:anywhere]">
      {recipe.active.components
        .map((c) => `${assetTicker(c.asset)} ${formatBps(c.weightBps, locale)}`)
        .join(' · ')}
    </p>
  );
}

/** Whether the auto-follow switch is offered, as a word and a shape: never by colour alone. */
export function Offer({ recipe }: { recipe: SharedRecipe }) {
  const t = useT();
  const o = t.shared.offer;
  const offer = recipe.autoFollow;
  const name = t.chain.names[recipe.chain];
  const sentence = offer.offered
    ? o.offered
    : offer.reason === 'no_oracle'
      ? o.noOracle(offer.assets.map((a) => assetTicker(a)).join(', '), name)
      : o.switchedOff(name);
  return (
    <p
      data-ui="auto-follow-offer"
      data-offered={offer.offered}
      className="flex items-start gap-1.5 text-body-sm"
    >
      <StatusMark status={offer.offered ? 'on-track' : 'watch'} className="mt-1.5" />
      <span>
        <span className="font-medium">{o.title}.</span> {sentence}
      </span>
    </p>
  );
}

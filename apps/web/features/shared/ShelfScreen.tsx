'use client';
import type { SharedFamily, SharedRecipe } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty, CardHeader } from '../../components/ui/Card';
import { ChainBadges } from '../../components/ui/ChainBadge';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { chainInAddress } from '../account/chain-choice';
import { formatBps, tokenName } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { AssetMark } from '../order/PlanView';
import { networkFor } from '../order/readiness';
import { useApiFetch } from '../wallet/WalletProvider';
import { HoldingsBar } from './HoldingsBar';
import { isPlatformCreator } from './platform';
import { holdingsOf, rate } from './product-figures';
import { readShelf } from './shared-api';
import { shortAddress, useSharedPerson } from './use-person';
import { ShelfWait } from './waits';

// The shelf (DESIGN-VAULT section 11; gate PRODUCTS-PLAN-PANE): a card per shared portfolio, the
// figures first: one bar of what it holds with each share under it, each holding's yield with its pin, what it
// is for in one line of its creator's, its chain and who published it. Whether auto-follow is offered
// and a version that waits are on its page. It shows the portfolios with a recipe on one chain: a signed-in
// person's current chain, or the chain someone signed out picked in the bar (gate CHAIN-SWITCH). The
// address names it (`?chain=robinhood`), so a link opens the same shelf. What a card says is the
// server's store: the portfolio's page reads the chain. A creator's name and description are text,
// never markup or a link.

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
  const { chain: looking, choose } = useAccount();
  const chain =
    person.kind === 'ready' ? person.chain : person.kind === 'signed-out' ? looking : null;
  const settled = person.kind !== 'loading';

  // The address names the chain: someone signed out who opens a link to another chain's shelf is
  // moved to it, once; after that the address follows the chain the bar shows.
  const adopted = useRef(false);
  useEffect(() => {
    if (!settled || !chain) return;
    if (!adopted.current) {
      adopted.current = true;
      const named = chainInAddress(window.location.search);
      if (person.kind === 'signed-out' && named && named !== chain) {
        void choose(named);
        return;
      }
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('chain') === chain) return;
    params.set('chain', chain);
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }, [settled, chain, person.kind, choose]);

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
  // Signed in when the page was read, signed out now: the person left while looking at it.
  const wasIn = useRef(false);
  const [left, setLeft] = useState(false);
  useEffect(() => {
    if (person.kind === 'ready') {
      wasIn.current = true;
      setLeft(false);
    } else if (person.kind === 'signed-out' && wasIn.current) setLeft(true);
  }, [person.kind]);
  return (
    <div data-ui="shelf-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 id={titleId} className={PAGE_TITLE}>
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
        {/* where a portfolio cannot be published yet, the shelf says so: no silent gap */}
        {person.kind === 'ready' && !person.publishable && chainName && (
          <p
            data-ui="shelf-publish-soon"
            className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
          >
            {t.shared.shelf.publishSoon(chainName)}
          </p>
        )}
        {/* the bar says "signed out" to a screen reader; the page says it to the eye, with what it still shows */}
        {left && person.kind === 'signed-out' && chainName && (
          <p data-ui="shelf-signed-out" className="max-w-(--tf-measure-body) text-body-sm">
            {t.shared.shelf.signedOut(chainName)}
          </p>
        )}
      </header>

      {load.kind === 'loading' ? (
        <ScreenWait label={t.shared.shelf.loading} skeleton={<ShelfWait />} />
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
  const p = t.shared.product;
  const locale = LOCALE[lang];
  const [recipe] = family.recipes;
  const href = `/indexes/${encodeURIComponent(family.slug)}`;
  const notLive = family.recipes.some((r) => r.provenance !== 'live');
  const paying = recipe
    ? holdingsOf(recipe, recipe.active.components, t).flatMap((h) =>
        h.yield ? [{ asset: h.asset, yield: h.yield }] : [],
      )
    : [];
  return (
    <Card
      as="article"
      interactive
      className="h-full"
      mock={notLive}
      mockLabels={{
        announce: family.recipes.some((r) => r.provenance === 'sandbox')
          ? t.shell.testNetworkLine
          : t.shell.mockAnnounce,
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
        // The list mixes chains, so each card names its own.
        meta={<ChainBadges chains={family.chains} />}
      />
      <CardBody className="flex flex-col gap-3">
        {/* The figures first: what it holds, as one bar with each share said under it, then its yield. */}
        {recipe && (
          <div className="flex flex-col gap-2">
            <HoldingsBar
              shares={recipe.active.components.map((x) => ({
                key: x.asset,
                shareBps: x.weightBps,
              }))}
            />
            <ul className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
              {recipe.active.components.map((component) => (
                <li key={component.asset} className="flex min-w-0 items-center gap-2 text-body-sm">
                  <AssetMark asset={component.asset} />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {tokenName(component.asset)}
                  </span>{' '}
                  <span className="shrink-0 tabular-nums">
                    {formatBps(component.weightBps, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {recipe && (
          // Each holding that has a reading, with its own yield and pin: nothing is added up across
          // them. Above the card's stretched link, so a pin can be opened.
          <p
            data-ui="product-yield"
            className="relative z-10 flex w-fit flex-wrap items-baseline gap-x-3 gap-y-1 text-body-sm"
          >
            <span className="text-muted-foreground">{p.yield}:</span>
            {paying.length > 0 ? (
              paying.map((h) => (
                <span key={h.asset} className="inline-flex items-baseline gap-1.5">
                  <span className="font-mono">{tokenName(h.asset)}</span>
                  <ProvenancePin
                    value={rate(h.yield.afterHaircut, locale)}
                    obs={h.yield.obs}
                    labels={t.pin}
                  />
                </span>
              ))
            ) : (
              <span>{p.noYieldReading}</span>
            )}
          </p>
        )}
        {/* What it is for, in the creator's own words: one line, as text. */}
        {family.copy && (
          <p className="line-clamp-2 max-w-(--tf-measure-body) text-body-sm [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
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
          {recipe && <span>{c.version(recipe.active.version)}</span>}
        </p>
        {recipe && recipe.textMatches === null && (
          <p className="flex items-start gap-1.5 text-body-sm">
            <StatusMark status="watch" className="mt-1.5" />
            <span>{t.shared.text.unverified}</span>
          </p>
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
        .map((c) => `${tokenName(c.asset)} ${formatBps(c.weightBps, locale)}`)
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
      ? o.noOracle(offer.assets.map((a) => tokenName(a)).join(', '), name)
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

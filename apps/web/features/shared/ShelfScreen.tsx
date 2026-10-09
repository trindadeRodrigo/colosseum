'use client';
import type { SharedFamily, SharedRecipe } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardEmpty, CardHeader } from '../../components/ui/Card';
import { ChainBadges } from '../../components/ui/ChainBadge';
import { Hint } from '../../components/ui/Hint';
import { PAGE_TITLE } from '../../components/ui/heading';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { ScreenWait } from '../../components/waits/ScreenWait';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChainBadgeMarked } from '../account/ChainName';
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
// and a version that waits are on its page. It is one list of every chain's portfolios, for everyone
// (gate CHAIN-AT-THE-PLAN): each card names the chain or chains it has a recipe on and keeps its own
// sample mark, since the list mixes chains that are run differently. Which recipe a person can buy
// is the portfolio's page's to say. What a card says is the server's store: the page reads the chain.
// A creator's name and description are text, never markup or a link.

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
  const settled = person.kind !== 'loading';
  // Where publishing is offered or not is said of the chain the person's new plans start on.
  const chainName = person.kind === 'ready' ? t.chain.names[person.chain] : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the shelf again
  useEffect(() => {
    if (!settled) return;
    let mine = true;
    setLoad({ kind: 'loading' });
    // No chain is named: every portfolio, each with the chains it has a recipe on. One whose every
    // recipe is on a chain our server has switched off has nothing to show, and is left out.
    readShelf(apiFetch, null).then((read) => {
      if (mine)
        setLoad(
          read.kind === 'read'
            ? { kind: 'read', families: read.value.families.filter((f) => f.recipes.length > 0) }
            : read,
        );
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, settled, round]);

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
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.shared.shelf.lead}</p>
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
        {left && person.kind === 'signed-out' && (
          <p data-ui="shelf-signed-out" className="max-w-(--tf-measure-body) text-body-sm">
            {t.shared.shelf.signedOut}
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
            sentence={t.shared.shelf.empty}
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
  // A portfolio on one chain shows that recipe's figures. One on more shows what is the family's own
  // (its name, its creator's words) and each chain's recipe beside that chain's name: one chain's
  // weights, creator or version are never drawn under another chain's label.
  const [first, ...more] = family.recipes;
  const recipe = more.length === 0 ? first : undefined;
  const href = `/indexes/${encodeURIComponent(family.slug)}`;
  const notLive = family.recipes.some((r) => r.provenance !== 'live');
  const marks = { testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure };
  const paying = recipe
    ? holdingsOf(recipe, recipe.active.components, t).flatMap((h) =>
        h.yield ? [{ asset: h.asset, yield: h.yield }] : [],
      )
    : [];
  /** Who published a recipe and which version is in effect, on its chain. */
  const published = (r: SharedRecipe) => (
    <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm text-muted-foreground">
      <span className="font-mono text-source">
        <Hint tip={<span className="font-mono text-source break-all">{r.creator}</span>}>
          {c.by(shortAddress(r.creator))}
        </Hint>
      </span>
      {isPlatformCreator(networkFor(r.chain, r.provenance === 'mock'), r.chain, r.creator) && (
        <span className="font-medium text-foreground">{c.platform}</span>
      )}
      <span>{c.version(r.active.version)}</span>
    </p>
  );
  return (
    <Card
      as="article"
      interactive
      className="h-full"
      mock={notLive}
      mockLabels={{
        // Recipes run differently say so each beside their chain; the card's line is the plain one.
        announce:
          recipe?.provenance === 'sandbox' ||
          (!recipe && family.recipes.every((r) => r.provenance === 'sandbox'))
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
        // The list mixes chains, so each card names its own; one on more names each beside its recipe.
        meta={recipe ? <ChainBadges chains={family.chains} /> : undefined}
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
        {!recipe && (
          // On more than one chain: each chain's own weights, publisher and version, under its name
          // and how it is run. Its yields and exit are on the portfolio's page, per chain.
          <>
            <p className="text-body-sm text-muted-foreground">{t.shared.family.perChain}</p>
            <ul data-ui="shelf-recipes" className="flex flex-col gap-3">
              {family.recipes.map((r, i) => (
                <li
                  key={r.chain}
                  data-ui="shelf-recipe"
                  data-chain={r.chain}
                  className="flex min-w-0 flex-col gap-1 border-l border-border pl-3"
                >
                  <ChainBadgeMarked
                    chain={r.chain}
                    provenance={r.provenance}
                    labels={marks}
                    announce={i === 0}
                  />
                  <Weights recipe={r} locale={locale} />
                  {published(r)}
                </li>
              ))}
            </ul>
          </>
        )}
        {/* What it is for, in the creator's own words: one line, as text. */}
        {family.copy && (
          <p className="line-clamp-2 max-w-(--tf-measure-body) text-body-sm [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
        {recipe && published(recipe)}
        {family.recipes.some((r) => r.textMatches === null) && (
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

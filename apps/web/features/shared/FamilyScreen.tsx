'use client';
import type {
  ChainId,
  RecipeVersionView,
  SharedFamily,
  SharedRecipe,
  Target,
  VaultView,
  VersionsResponse,
} from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { utcMinute } from '../../components/ui/ExecutionList';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonPlan, SkeletonRows } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { useAccount } from '../account/AccountProvider';
import { switchFailure } from '../account/ChainSwitch';
import { dollars, parseNumber } from '../goal/sheet';
import { formatBps, tokenName } from '../order/amounts';
import { Invest } from '../order/Invest';
import { AmountField, MAX_USD, MIN_USD } from '../order/InvestCard';
import type { CallFailure } from '../order/order-api';
import { keepOrder, type OrderRecord, recallOrders } from '../order/order-record';
import { PlanView } from '../order/PlanView';
import { goalLine } from '../order/plain';
import { networkFor } from '../order/readiness';
import { goalOfVault } from '../portfolio/vault-goal';
import { useApiFetch } from '../wallet/WalletProvider';
import { type ChainCheck, familyIdFor, isVaultOf, useChainRecipe } from './chain-recipe';
import { isPlatformCreator } from './platform';
import { holdingsOf, kindShares } from './product-figures';
import { Offer } from './ShelfScreen';
import { SourceMark } from './SourceMark';
import { placeShared, readFamily, readPortfolio, readVersions } from './shared-api';
import type { FollowTerms, SharedTerms } from './terms';
import { type SharedPerson, shortAddress, useSharedPerson } from './use-person';

// A shared portfolio's page (DESIGN-VAULT section 11): its name and creator, the recipe of the
// person's own chain (gate ONE-CHAIN) with the version in effect and the one that waits, whether
// auto-follow is offered (gate GOLD-ONE-TAP), the person's vaults with a follow and the prompt when the
// portfolio changed, and every version. The version and weights are read from the chain by this app
// where it can (chain-recipe.ts): what it reads is what is shown and what a follow is held to, and our
// server's answer is shown as unverified where it cannot. The creator's words are text.

type Load = { kind: 'loading' } | { kind: 'read'; family: SharedFamily } | { kind: CallFailure };

/** What a follow is held to: the chain's account and version where read, the API's otherwise. */
export type Followed = {
  follow: FollowTerms;
  targets: Target[] | null;
  source: 'chain' | 'api';
  /** The chain has no such portfolio: nothing is followed. */
  missing: boolean;
  /** This app could have read the chain and could not: nothing is followed (`failed`). */
  tampered: boolean;
  /** Read from the chain, the version holds a token this app does not list. */
  unlisted: boolean;
  /**
   * The portfolio's id is not the one its slug gives: it was not published through the app, so a
   * follow held to `familyIdOf(slug)` cannot be signed, and none is offered (gate FAMILY-ID).
   */
  foreign: boolean;
};

export function followedOf(recipe: SharedRecipe, check: ChainCheck): Followed | null {
  if (check.state === 'reading') return null;
  if (check.state === 'missing')
    return {
      follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
      targets: null,
      source: 'chain',
      missing: true,
      tampered: false,
      unlisted: false,
      foreign: false,
    };
  if (check.state === 'failed')
    return {
      follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
      targets: null,
      source: 'chain',
      missing: false,
      tampered: true,
      unlisted: false,
      foreign: false,
    };
  if (check.state === 'read')
    return {
      follow: { recipeOnchainId: check.recipe.address, version: check.recipe.active.version },
      targets: check.targets,
      source: 'chain',
      missing: false,
      tampered: false,
      unlisted: check.targets === null,
      foreign: false,
    };
  return {
    follow: { recipeOnchainId: recipe.onchainId, version: recipe.active.version },
    targets: recipe.active.components,
    source: 'api',
    missing: false,
    tampered: false,
    unlisted: false,
    foreign: check.state === 'unverified' && check.why === 'family-id',
  };
}

export function FamilyScreen({ slug }: { slug: string }) {
  const t = useT();
  const apiFetch = useApiFetch();
  const person = useSharedPerson();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  // A buy was refused because the portfolio has a newer version: the page reads it again and says so.
  const [changed, setChanged] = useState(false);
  const titleId = useId();
  const chain = person.kind === 'ready' ? person.chain : null;
  const settled = person.kind !== 'loading';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the portfolio again
  useEffect(() => {
    if (!settled) return;
    let mine = true;
    // What was read stays on the page while it is read again: only the first read shows the wait.
    setLoad((was) => (was.kind === 'read' ? was : { kind: 'loading' }));
    readFamily(apiFetch, slug, chain).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', family: read.value.family } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, chain, settled, round]);

  if (load.kind === 'loading')
    return (
      <Card>
        <CardWait label={t.shared.family.loading} skeleton={<SkeletonPlan />} />
      </Card>
    );
  if (load.kind !== 'read')
    return (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {load.kind === 'no-plan' ? t.shared.family.missing : t.shared.shelf.title}
        </h1>
        {load.kind !== 'no-plan' && (
          <p className="max-w-(--tf-measure-body) text-body">
            {load.kind === 'busy'
              ? t.shell.slowDown
              : load.kind === 'unreadable'
                ? t.shared.shelf.failure.unreadable
                : t.shared.shelf.failure.unreachable}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {load.kind !== 'no-plan' && (
            <Button variant="secondary" onClick={() => setRound((n) => n + 1)}>
              {t.shared.shelf.failure.retry}
            </Button>
          )}
          <Link href="/shelf" className={buttonClass({ variant: 'secondary' })}>
            {t.shared.family.backToShelf}
          </Link>
        </div>
      </section>
    );

  const { family } = load;
  const mine = chain ? family.recipes.find((r) => r.chain === chain) : null;
  const recipes = chain ? (mine ? [mine] : []) : family.recipes;
  return (
    <div data-ui="family-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 id={titleId} className={`${PAGE_TITLE} [overflow-wrap:anywhere]`}>
          {family.name}
        </h1>
        {family.copy && (
          <p className="max-w-(--tf-measure-body) whitespace-pre-line text-body-lg [overflow-wrap:anywhere]">
            {family.copy}
          </p>
        )}
      </header>

      {chain && !mine && (
        <p className="max-w-(--tf-measure-body) text-body">
          {t.shared.family.notHere(t.chain.names[chain])}
        </p>
      )}
      {recipes.map((recipe) => (
        <RecipeSection
          key={recipe.chain}
          family={family}
          recipe={recipe}
          person={person}
          changed={changed}
          onVersionChanged={() => {
            setChanged(true);
            setRound((n) => n + 1);
          }}
        />
      ))}
      {person.kind === 'ready' && <VaultsElsewhere family={family} chain={person.chain} />}
      <VersionsPanel slug={family.slug} chain={chain} />
      <Link href="/shelf" className={`${buttonClass({ variant: 'link' })} self-start`}>
        {t.shared.family.backToShelf}
      </Link>
    </div>
  );
}

/** One chain's recipe, read from that chain where this app can, with what the person can do with it. */
function RecipeSection({
  family,
  recipe,
  person,
  changed,
  onVersionChanged,
}: {
  family: SharedFamily;
  recipe: SharedRecipe;
  person: SharedPerson;
  /** A buy was refused for a newer version, and the page read the portfolio again. */
  changed: boolean;
  onVersionChanged: () => void;
}) {
  const t = useT();
  const lang = useLang();
  // The amount to invest, typed on this page; locked once the person has pressed.
  const [amountText, setAmountText] = useState('');
  const [pressed, setPressed] = useState(false);
  const f = t.shared.family;
  const chainName = t.chain.names[recipe.chain];
  const own = person.kind === 'ready' && person.chain === recipe.chain;
  const mock = own ? person.mock : recipe.provenance === 'mock';
  const check = useChainRecipe(recipe.chain, mock, family, recipe);
  const followed = followedOf(recipe, check);
  // A check that found something wrong is not folded away: the read failed, the chain has no such
  // portfolio, it differs from what our server said, or its words match no version on the chain.
  const alarm =
    check.state === 'failed' ||
    check.state === 'missing' ||
    (check.state === 'read' && (check.differs || check.textMatches === null));
  const reasonId = useId();
  const locale = LOCALE[lang];
  const read = check.state === 'read' ? check.recipe : null;
  // What is shown is the chain's where it was read, our server's otherwise. A line whose token this
  // app does not list is shown by its mint, so nothing the version holds is left out of sight.
  const lines = (components: { asset: string | null; mint: string; weightBps: number }[]): Line[] =>
    components.map((c) =>
      c.asset
        ? { asset: c.asset, weightBps: c.weightBps }
        : { asset: c.mint, weightBps: c.weightBps, mint: c.mint },
    );
  const active: { version: number; effectiveAt: number; components: Line[] } = read
    ? {
        version: read.active.version,
        effectiveAt: read.active.effectiveAt,
        components: lines(read.active.components),
      }
    : recipe.active;
  const pending = read
    ? read.pending && {
        version: read.pending.version,
        effectiveAt: read.pending.effectiveAt,
        components: lines(read.pending.components),
      }
    : recipe.pending;

  const blocked =
    person.kind !== 'ready'
      ? null
      : person.off || !person.signable
        ? f.chainNotReady(chainName)
        : followed?.missing
          ? f.missingOnChain(chainName)
          : followed?.tampered
            ? f.tampered(chainName)
            : followed?.unlisted
              ? f.unlisted
              : followed?.foreign
                ? f.foreign
                : null;
  const p = t.shared.product;
  const holdings = holdingsOf(recipe, active.components, t);
  const typed = parseNumber(amountText, lang);
  const amount =
    typed !== null && !Number.isNaN(typed) && typed >= MIN_USD && typed <= MAX_USD ? typed : null;
  /** The invest card is on the page: the person is ready on this chain and nothing blocks a buy. */
  const investing = person.kind === 'ready' && own && !blocked && followed !== null;
  const unmeasured = holdings.filter((h) => !h.exit);
  const list = (items: string[]) =>
    new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  return (
    <div className="flex flex-col gap-6">
      <PlanView
        title={f.recipe(chainName)}
        sub={p.sub(
          f.versionN(active.version),
          f.since(utcMinute(new Date(active.effectiveAt * 1000).toISOString())),
        )}
        answer={p.answer(list(kindShares(holdings, locale, t.plan.kinds)), chainName)}
        chain={recipe.chain}
        provenance={recipe.provenance}
        holdings={holdings.map((h) => ({
          asset: h.asset,
          shareBps: h.shareBps,
          // no amount is set on this page: the row shows the share alone
          amountUsd: null,
          // the holding's own reading after the haircut, which is what the row's label says it is
          yield: h.yield
            ? {
                lowPct: h.yield.afterHaircut * 100,
                highPct: h.yield.afterHaircut * 100,
                obs: h.yield.obs,
              }
            : null,
          why: h.why,
        }))}
        exit={{
          tiers: holdings.flatMap((h) =>
            h.exit
              ? [
                  {
                    text: (h.exit.lowerBound ? p.exit.atLeast : p.exit.about)(
                      dollars(Math.floor(h.exit.capacityUsd), lang),
                      h.name,
                      h.exit.windowDays,
                    ),
                    cost: {
                      figure: p.exit.cost(formatBps(h.exit.maxCostBps, locale)),
                      obs: h.exit.obs,
                    },
                  },
                ]
              : [],
          ),
          ...(unmeasured.length > 0
            ? { caveat: p.exit.notMeasured(list(unmeasured.map((h) => h.name))) }
            : {}),
        }}
        aside={
          <>
            {/* Who published it, by address: in view (gate PRODUCTS-PLAN-PANE). */}
            <p className="flex flex-wrap items-baseline gap-x-2 text-body-sm text-muted-foreground">
              <span>{p.publisher}</span>
              <span data-ui="creator" className="break-all font-mono text-source text-foreground">
                {read?.creator ?? recipe.creator}
              </span>
              {isPlatformCreator(
                networkFor(recipe.chain, mock),
                recipe.chain,
                read?.creator ?? recipe.creator,
              ) && (
                <span className="font-medium text-foreground">{t.shared.shelf.card.platform}</span>
              )}
            </p>
            {/* Where the version and weights come from, and words that match no version: never
                folded away (the flow audit, finding 41). */}
            {check.state === 'read' && check.textMatches === null && <TextMark matches={null} />}
            {/* The invest card says the same line over itself: said once on the page. */}
            {!investing && <SourceMark check={check} chain={recipe.chain} />}
          </>
        }
        figures={
          pending ? (
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-h4 font-semibold">
                {f.waits(
                  pending.version,
                  utcMinute(new Date(pending.effectiveAt * 1000).toISOString()),
                )}
              </h3>
              <p className="max-w-(--tf-measure-body) text-body-sm">{f.waitsLead}</p>
              <WeightsTable
                rows={pending.components}
                locale={locale}
                caption={f.versionN(pending.version)}
              />
            </div>
          ) : undefined
        }
        details={
          <div className="flex flex-col gap-3">
            <Offer recipe={recipe} />
            {/* The routine check of its words, behind a fold unless a check found something wrong. */}
            {(check.state !== 'read' || check.textMatches === 'pending') && (
              <details data-ui="family-checks" open={alarm || undefined}>
                <summary className="w-fit cursor-pointer text-body-sm font-medium text-primary underline decoration-1 underline-offset-4 hover:decoration-2">
                  {t.plan.details}
                </summary>
                <div className="mt-3 flex flex-col gap-2">
                  <TextMark matches={check.state === 'read' ? check.textMatches : 'unchecked'} />
                </div>
              </details>
            )}
          </div>
        }
        invest={
          person.kind === 'ready' && own ? (
            <div data-ui="product-invest" className="flex flex-col items-start gap-4">
              {changed && (
                // Said before any new order is offered: what is shown above is the new version.
                <p
                  data-ui="product-version-changed"
                  role="status"
                  className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body font-medium"
                >
                  <StatusMark status="watch" size={12} className="mt-1.5" />
                  <span>{p.versionChanged(f.versionN(active.version))}</span>
                </p>
              )}
              {blocked || !followed ? (
                <>
                  <Button variant="primary" disabled aria-describedby={reasonId}>
                    {f.buy}
                  </Button>
                  <p id={reasonId} className="max-w-(--tf-measure-body) text-body-sm">
                    {blocked ?? t.shared.check.reading}
                  </p>
                </>
              ) : (
                <>
                  <AmountField
                    text={amountText}
                    onText={setAmountText}
                    hint={t.shared.buy.amountHint}
                    value={amount}
                    disabled={pressed}
                  />
                  {/* One invest step everywhere (gate INVEST-ONE-PRESS). A new version remounts it,
                      so it reads the portfolio again before it makes another order. */}
                  <div className="w-full">
                    <Invest
                      key={`${recipe.active.version}:${active.version}`}
                      of={{ family: family.slug }}
                      amount={amount}
                      onProgress={() => setPressed(true)}
                      onDone={() => setPressed(false)}
                      onStopped={() => setPressed(false)}
                      onVersionChanged={() => {
                        // The amount is cleared with it: no order is made for the new version
                        // until the person has seen it and typed an amount again.
                        setPressed(false);
                        setAmountText('');
                        onVersionChanged();
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          ) : person.kind === 'signed-out' ? (
            <div data-ui="product-invest" className="flex flex-col items-start gap-2">
              <Link
                href={`/sign-in?next=/indexes/${encodeURIComponent(family.slug)}`}
                className={buttonClass({ variant: 'secondary' })}
              >
                {f.signIn}
              </Link>
            </div>
          ) : undefined
        }
      />

      {person.kind === 'ready' && own && followed && !blocked && (
        <VaultsPanel family={family} recipe={recipe} followed={followed} person={person} />
      )}
    </div>
  );
}

/**
 * The person's vaults on another chain than the current one that follow this portfolio. A vault is
 * updated on its own chain (CHAIN-SWITCH), and this page signs on the current chain only, so it says
 * which chain to switch to, with the switch.
 */
function VaultsElsewhere({ family, chain }: { family: SharedFamily; chain: ChainId }) {
  const t = useT();
  const f = t.shared.family;
  const apiFetch = useApiFetch();
  const { choose } = useAccount();
  const [elsewhere, setElsewhere] = useState<ChainId[]>([]);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let mine = true;
    const recipeOn = new Map(family.recipes.map((r) => [r.chain, r.onchainId]));
    readPortfolio(apiFetch).then((read) => {
      if (!mine || read.kind !== 'read') return;
      setElsewhere(
        read.value.chains
          .filter(
            (entry) =>
              entry.chain !== chain &&
              entry.vaults.some(
                (v) =>
                  v.recipeOnchainId !== null && v.recipeOnchainId === recipeOn.get(entry.chain),
              ),
          )
          .map((entry) => entry.chain),
      );
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, family]);
  if (elsewhere.length === 0) return null;
  return (
    <div data-ui="vaults-elsewhere" className="flex flex-col items-start gap-2">
      {elsewhere.map((other) => (
        <p key={other} className="max-w-(--tf-measure-body) text-body">
          {f.elsewhere(t.chain.names[other])}{' '}
          <Button
            variant="link"
            onClick={() => {
              setFailed('');
              choose(other).catch((e: unknown) =>
                setFailed(switchFailure(t, e, t.chain.names[other])),
              );
            }}
          >
            {f.switchTo(t.chain.names[other])}
          </Button>
        </p>
      ))}
      {failed && (
        <p role="alert" className="text-body-sm text-destructive">
          {failed}
        </p>
      )}
    </div>
  );
}

/** A line of a version as shown: a listed asset, or the mint of a token this app does not list. */
type Line = Target & { mint?: string };

function WeightsTable({
  rows,
  locale,
  caption,
}: {
  rows: Line[];
  locale: string;
  caption: string;
}) {
  const t = useT();
  return (
    <DataTable<Line>
      caption={caption}
      captionHidden
      rows={rows}
      rowKey={(r) => r.asset}
      columns={[
        {
          key: 'asset',
          header: t.plan.columns.asset,
          rowHeader: true,
          cell: (r) =>
            r.mint ? (
              <span data-ui="unlisted-mint" className="flex flex-col">
                <span className="font-mono text-source [overflow-wrap:anywhere]">{r.mint}</span>
                <span className="text-body-sm text-muted-foreground">
                  {t.shared.family.notListed}
                </span>
              </span>
            ) : (
              tokenName(r.asset)
            ),
        },
        {
          key: 'share',
          header: t.plan.columns.share,
          numeric: true,
          cell: (r) => formatBps(r.weightBps, locale),
        },
      ]}
    />
  );
}

/**
 * The person's vaults on this chain: each one that follows this portfolio, with the prompt when a newer
 * version has taken effect or waits, and the auto-follow switch where it is offered; each one that
 * does not, with a follow. Every action is an order, reviewed and signed on the order screen.
 */
function VaultsPanel({
  family,
  recipe,
  followed,
  person,
}: {
  family: SharedFamily;
  recipe: SharedRecipe;
  followed: Followed;
  person: Extract<SharedPerson, { kind: 'ready' }>;
}) {
  const t = useT();
  const lang = useLang();
  const v = t.shared.vaults;
  const router = useRouter();
  const apiFetch = useApiFetch();
  const [vaults, setVaults] = useState<VaultView[] | null | 'failed'>(null);
  // The orders this browser placed: a vault bought from a goal is named by that goal.
  const [records, setRecords] = useState<OrderRecord[]>([]);
  useEffect(() => setRecords(recallOrders(person.userId)), [person.userId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    let mine = true;
    readPortfolio(apiFetch).then((read) => {
      if (!mine) return;
      if (read.kind !== 'read') return setVaults('failed');
      const entry = read.value.chains.find((c) => c.chain === person.chain);
      setVaults(entry?.vaults ?? []);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, person.chain]);

  /** A follow order for this vault, kept with its terms, then the order screen. */
  async function follow(vault: VaultView, autoFollow: boolean, accept: boolean) {
    if (!person.owner || !person.userId) return;
    setBusy(`${vault.address}:${autoFollow}:${accept}`);
    setFailure(null);
    // The plan number the step names has to be the vault's own, as the guard derives it.
    if (
      isVaultOf(person.chain, person.mock, vault.owner, vault.basketId, vault.address) === false
    ) {
      setBusy(null);
      setFailure(t.order.mismatch.shape);
      return;
    }
    const terms: SharedTerms = {
      kind: 'follow',
      slug: family.slug,
      familyId: familyIdFor(family.slug),
      vault: vault.address,
      basketId: vault.basketId,
      follow: accept ? followed.follow : null,
      autoFollow,
      source: followed.source,
    };
    const placed = await placeShared(
      apiFetch,
      {
        type: 'follow',
        vault: vault.address,
        family: family.slug,
        autoFollow,
        version: followed.follow.version,
      },
      { chain: person.chain, owner: vault.owner, type: 'follow' },
    );
    if (placed.kind !== 'placed') {
      setBusy(null);
      setFailure(
        placed.kind === 'said'
          ? t.shared.publish.failure.said(placed.error)
          : placed.kind === 'busy'
            ? t.shell.slowDown
            : t.shared.publish.failure.unreachable,
      );
      return;
    }
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain: person.chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setBusy(null);
      setFailure(t.shared.publish.failure.noStore);
      return;
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  const offered = recipe.autoFollow.offered;
  /**
   * The switch an accept asks for: the vault's own, but never on into a portfolio that does not offer
   * it (gate GOLD-ONE-TAP). A vault with auto-follow on then switches it off before it takes the
   * version, as the API plans it.
   */
  const keep = (vault: VaultView) => vault.autoFollow && offered;
  return (
    <Card as="section" aria-labelledby={titleId}>
      <CardHeader title={v.title} level={2} id={titleId} />
      {vaults === null ? (
        <CardWait label={t.shared.vault.loading} skeleton={<SkeletonRows rows={2} columns={3} />} />
      ) : (
        <CardBody className="flex flex-col gap-4">
          {vaults === 'failed' ? (
            <p className="text-body-sm">{v.failure}</p>
          ) : vaults.length === 0 ? (
            <p className="text-body-sm">{v.none}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {vaults.map((vault) => {
                const follows = vault.recipeOnchainId === followed.follow.recipeOnchainId;
                // A vault bought from a goal goes by that goal, where this browser kept it.
                const goal = goalOfVault(vault, records)?.goal.sheet;
                const behind = follows && vault.acceptedVersion < followed.follow.version;
                return (
                  <li
                    key={vault.address}
                    data-ui="my-vault"
                    className="flex flex-col items-start gap-2 py-3"
                  >
                    <p className="flex flex-wrap items-baseline gap-x-2 text-body">
                      <Link
                        href={`/vaults/${vault.chain}/${encodeURIComponent(vault.address)}`}
                        className={buttonClass({ variant: 'link' })}
                        title={vault.address}
                      >
                        {goal
                          ? goalLine(goal, t, dollars(goal.amountUsd, lang), (usd) =>
                              dollars(usd, lang),
                            )
                          : v.address(shortAddress(vault.address))}
                      </Link>
                      <span className="text-body-sm text-muted-foreground">
                        {follows
                          ? v.following
                          : vault.recipeOnchainId === null
                            ? v.ownPlan
                            : v.notFollowing}
                      </span>
                      {follows && (
                        <span className="text-body-sm text-muted-foreground">
                          {v.autoIs(vault.autoFollow)}
                        </span>
                      )}
                    </p>
                    {follows && (behind || vault.pending) && (
                      <FollowPrompt
                        vault={vault}
                        version={followed.follow.version}
                        behind={behind}
                        busy={busy === `${vault.address}:${keep(vault)}:true`}
                        onAccept={() => follow(vault, keep(vault), true)}
                      />
                    )}
                    {follows && !offered && (
                      <p className="max-w-(--tf-measure-body) text-body-sm">{v.oneTap}</p>
                    )}
                    {follows && (offered || vault.autoFollow) && !behind && (
                      <Button
                        variant="secondary"
                        busy={busy === `${vault.address}:${!vault.autoFollow}:false`}
                        onClick={() => follow(vault, !vault.autoFollow, false)}
                      >
                        {vault.autoFollow ? v.autoOff : v.autoOn}
                      </Button>
                    )}
                    {!follows && (
                      <>
                        <Button
                          variant="secondary"
                          busy={busy === `${vault.address}:${keep(vault)}:true`}
                          onClick={() => follow(vault, keep(vault), true)}
                        >
                          {v.followWith}
                        </Button>
                        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
                          {v.followNote}
                        </p>
                      </>
                    )}
                  </li>
                );
              })}
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
        </CardBody>
      )}
    </Card>
  );
}

/**
 * The prompt when a followed portfolio changed (gate GOLD-ONE-TAP's one tap): the version in effect
 * that the vault has not taken, with an accept, or the version that waits, with its time. Read from
 * the person's own vault (`VaultView.pending` of GET /v1/portfolio) and the version in effect.
 */
export function FollowPrompt({
  vault,
  version,
  behind,
  busy,
  onAccept,
}: {
  vault: VaultView;
  /** The version in effect, as this app read it. */
  version: number;
  /** The vault holds an earlier version than the one in effect. */
  behind: boolean;
  busy: boolean;
  onAccept: () => void;
}) {
  const t = useT();
  const p = t.shared.prompt;
  const waiting = !behind && vault.pending;
  const added = vault.pending?.newAssets ?? [];
  return (
    <div
      data-ui="follow-prompt"
      className="flex w-full flex-col items-start gap-2 border-l-2 border-l-primary pl-3"
    >
      <p className="text-body font-medium">{p.title}</p>
      <p className="max-w-(--tf-measure-body) text-body-sm">
        {waiting && vault.pending
          ? p.waits(
              vault.pending.version,
              utcMinute(new Date(vault.pending.effectiveAt * 1000).toISOString()),
            )
          : p.inEffect(version)}
      </p>
      {added.length > 0 && (
        <p className="max-w-(--tf-measure-body) text-body-sm">
          {p.newAssets(added.map((a) => tokenName(a)).join(', '))}
        </p>
      )}
      {behind && (
        <Button variant="primary" busy={busy} onClick={onAccept}>
          {p.accept(version)}
        </Button>
      )}
    </div>
  );
}

/** Every version the server has seen, newest first, per chain. */
function VersionsPanel({ slug, chain }: { slug: string; chain: ChainId | null }) {
  const t = useT();
  const f = t.shared.family;
  const apiFetch = useApiFetch();
  const [read, setRead] = useState<VersionsResponse | null>(null);
  useEffect(() => {
    let mine = true;
    readVersions(apiFetch, slug, chain).then((answer) => {
      if (mine && answer.kind === 'read') setRead(answer.value);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, slug, chain]);
  if (!read || read.chains.length === 0) return null;
  return (
    <section aria-label={f.versions} className="flex flex-col gap-4">
      <h2 className="text-h4 font-semibold">{f.versions}</h2>
      {read.chains.map((entry) => (
        <DataTable<RecipeVersionView>
          key={entry.chain}
          caption={`${f.versions} · ${t.chain.names[entry.chain]}`}
          captionHidden
          rows={entry.versions}
          rowKey={(r) => String(r.version)}
          columns={[
            {
              key: 'version',
              header: f.columns.version,
              rowHeader: true,
              cell: (r) => String(r.version),
            },
            { key: 'status', header: f.columns.status, cell: (r) => f.status[r.status] },
            {
              key: 'effective',
              header: f.columns.effective,
              cell: (r) => utcMinute(new Date(r.effectiveAt * 1000).toISOString()),
            },
          ]}
        />
      ))}
    </section>
  );
}

/**
 * Whether the name and description are the text the creator published: the hash of the text shown,
 * worked out here, against the versions the page read from the chain. Where nothing was read the text
 * is said not to be checked: the server's word on it is not repeated. The creator's words are never
 * vouched for when neither version matches.
 */
function TextMark({ matches }: { matches: 'active' | 'pending' | null | 'unchecked' }) {
  const t = useT();
  if (matches === 'active') return null;
  if (matches === 'unchecked')
    return (
      <p
        data-ui="text-unchecked"
        className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground"
      >
        {t.shared.text.notChecked}
      </p>
    );
  return matches === 'pending' ? (
    <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
      {t.shared.text.pending}
    </p>
  ) : (
    <p
      data-ui="text-unverified"
      className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
    >
      <StatusMark status="watch" className="mt-1.5" />
      <span>{t.shared.text.unverified}</span>
    </p>
  );
}

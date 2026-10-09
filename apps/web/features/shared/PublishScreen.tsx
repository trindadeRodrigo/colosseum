'use client';
import { ChainId, chainFamily, type SharedFamily, type Target } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonLine, SkeletonListRow } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from '../order/amounts';
import { keepOrder } from '../order/order-record';
import { deploymentsFor, networkFor } from '../order/readiness';
import { assetsFor } from '../order/units';
import { tokens } from '../portfolio/figures';
import { readPortfolio, type Vault } from '../portfolio/portfolio';
import { sameAddress } from '../portfolio/vault-name';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { familyIdFor } from './chain-recipe';
import { type PublishVaultRead, readPublishVault } from './publish-vault';
import { placeShared, readFamily } from './shared-api';
import type { SharedTerms } from './terms';
import { useSharedPerson } from './use-person';
import { PublishWait } from './waits';

// Publish an owner-proved vault's strategy through the existing reviewed order/signature contract.
// Assets and weights are immutable here. A fresh chain read must still match the displayed snapshot
// before an order is made, and any person/chain/network/vault change discards a late reply.

export const LIMITS = { min: 3, max: 12, low: 200, high: 5000, step: 50, chars: 280 } as const;

// The server's rules for the creator's text (apps/api/src/orders/shared.ts), the same here so the
// form says so before anything is sent: a link, a scheme or `www.` or a bare host (`evil.xyz/airdrop`),
// an email address included; and a character a person cannot see or that turns text around.
const LINK = /:\/\/|www\.|(?<!\w)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/i;
const HIDDEN = /\p{Cf}|(?!\n)\p{Cc}/u;
const ASCII = /^[\x20-\x7e]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A weight typed in percent, as basis points; null when it is not a number with at most two places. */
export function bpsOf(text: string): number | null {
  const plain = text.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(plain)) return null;
  return Math.round(Number(plain) * 100);
}

/** An address on the shelf made from a name: lower case, letters and digits, dashes between. */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

export type Problem = 'chain' | 'name' | 'slug' | 'copy' | 'count' | 'weight' | 'sum' | 'twice';

/** What the form breaks of the rules a portfolio follows, in the order the form reads. */
export function problemsOf(form: {
  name: string;
  slug: string;
  copy: string;
  rows: { asset: string; bps: number | null }[];
}): Problem[] {
  const out: Problem[] = [];
  if (
    !ASCII.test(form.name) ||
    form.name.trim() !== form.name ||
    form.name.length > LIMITS.chars ||
    LINK.test(form.name)
  )
    out.push('name');
  if (!SLUG.test(form.slug) || form.slug.length > 64) out.push('slug');
  if (form.copy.length > LIMITS.chars || LINK.test(form.copy) || HIDDEN.test(form.copy))
    out.push('copy');
  if (form.rows.length < LIMITS.min || form.rows.length > LIMITS.max) out.push('count');
  if (
    form.rows.some(
      (r) =>
        r.bps === null || r.bps < LIMITS.low || r.bps > LIMITS.high || r.bps % LIMITS.step !== 0,
    )
  )
    out.push('weight');
  if (form.rows.reduce((n, r) => n + (r.bps ?? 0), 0) !== 10_000) out.push('sum');
  if (new Set(form.rows.map((r) => r.asset)).size !== form.rows.length) out.push('twice');
  return out;
}

type Existing =
  | { kind: 'reading' }
  | { kind: 'new' }
  | { kind: 'mine'; family: SharedFamily; next: number }
  /** The person's own portfolio, whose id is not its slug's: not updated from here (gate FAMILY-ID). */
  | { kind: 'foreign' }
  | { kind: 'theirs' }
  | { kind: 'unreadable' };

export function PublishScreen() {
  const t = useT();
  const lang = useLang();
  const p = t.shared.publish;
  const router = useRouter();
  const apiFetch = useApiFetch();
  const port = useWalletPort();
  // The chain of the vault whose strategy is shared, as the vault's page names it in the address
  // (`?vault=…&chain=…`); with none named, the chain the person's new plans start on.
  const [named] = useState<ChainId | null>(() => {
    if (typeof window === 'undefined') return null;
    const read = ChainId.safeParse(new URLSearchParams(window.location.search).get('chain'));
    return read.success ? read.data : null;
  });
  const person = useSharedPerson(named);
  const chain = person.kind === 'ready' ? person.chain : null;
  const mock = person.kind === 'ready' ? person.mock : false;
  const assets = chain ? assetsFor(chain, mock) : [];
  const [name, setName] = useState('');
  const [slugText, setSlugText] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const [vaults, setVaults] = useState<{ key: string; values: Vault[] } | null>(null);
  const [selected, setSelected] = useState('');
  const [snapshot, setSnapshot] = useState<{ key: string; read: PublishVaultRead } | null>(null);
  const [sourceFailure, setSourceFailure] = useState(false);
  const [requested, setRequested] = useState('');
  const [existing, setExisting] = useState<Existing>({ kind: 'new' });
  const [placing, setPlacing] = useState(false);
  const inFlight = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  /** The parts of the form the person has put a hand to: a rule is said once its part has been. */
  const [touched, setTouched] = useState({ name: false, slug: false, copy: false, rows: false });
  const touch = (part: keyof typeof touched) =>
    setTouched((was) => (was[part] ? was : { ...was, [part]: true }));
  const reasonId = useId();
  const slug = slugText ?? slugOf(name);
  const owner = person.kind === 'ready' ? person.owner : null;

  // Every asynchronous result belongs to this person, chain, network and selected vault.
  const deployment = chain ? deploymentsFor(chain, mock)?.[chain] : undefined;
  const identity = JSON.stringify([
    person.kind === 'ready' ? person.userId : null,
    chain,
    owner,
    mock,
    chain ? networkFor(chain, mock) : null,
    chain ? port.network(chain) : null,
    person.kind === 'ready' ? [person.signable, person.off, person.publishable] : null,
    deployment,
  ]);
  const sourceKey = `${identity}:${selected}:${vaults?.key === identity ? (vaults.values.find((v) => v.address === selected)?.basketId ?? '') : ''}`;
  const active = useRef({ key: sourceKey, revision: 0, form: '' });
  if (active.current.key !== sourceKey) {
    active.current = { key: sourceKey, revision: active.current.revision + 1, form: '' };
  }
  active.current.form = JSON.stringify([name, slug, copy, existing]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setRequested(new URLSearchParams(window.location.search).get('vault') ?? '');
  }, []);
  useEffect(() => {
    if (!chain || !owner) return;
    let current = true;
    setVaults(null);
    setSelected('');
    setSnapshot(null);
    inFlight.current = false;
    setPlacing(false);
    setFailure(null);
    setSourceFailure(false);
    readPortfolio(apiFetch, chain).then((result) => {
      if (!current) return;
      if (result.kind !== 'read') return setSourceFailure(true);
      const values =
        result.chains
          .find((entry) => entry.chain === chain)
          ?.vaults.filter((v) => sameAddress(chain, v.owner, owner)) ?? [];
      setVaults({ key: identity, values });
      // An explicit invalid source link never silently selects a different vault.
      const first = requested
        ? values.find((v) => sameAddress(chain, v.address, requested))
        : values[0];
      setSelected(first?.address ?? '');
    });
    return () => {
      current = false;
    };
  }, [apiFetch, chain, owner, identity, requested]);
  const own = vaults?.key === identity ? vaults.values : [];
  const source = own.find((v) => v.address === selected);
  useEffect(() => {
    setSnapshot(null);
    setFailure(null);
    inFlight.current = false;
    setPlacing(false);
    if (!chain || !owner || !source) return;
    let current = true;
    const at = { chain, owner, address: source.address, basketId: source.basketId, mock };
    readPublishVault(apiFetch, at).then((read) => {
      if (current) setSnapshot({ key: sourceKey, read });
    });
    return () => {
      current = false;
    };
  }, [apiFetch, chain, owner, source, mock, sourceKey]);

  // Whether this address is a portfolio already: the person's own (the next version) or another's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: account and network changes invalidate the family read
  useEffect(() => {
    if (!chain || !SLUG.test(slug)) {
      setExisting({ kind: 'new' });
      return;
    }
    let mine = true;
    setExisting({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFamily(apiFetch, slug, chain);
      if (!mine) return;
      if (read.kind !== 'read')
        return setExisting({ kind: read.kind === 'no-plan' ? 'new' : 'unreadable' });
      const recipe = read.value.family.recipes.find((r) => r.chain === chain);
      if (!recipe || !owner || !sameAddress(chain, recipe.creator, owner))
        return setExisting({ kind: 'theirs' });
      // An update is only of a portfolio whose id is its slug's: the id the guard holds the bytes to
      // is the one this page works out, never the server's (gate FAMILY-ID).
      if (read.value.family.familyId !== familyIdFor(slug)) return setExisting({ kind: 'foreign' });
      setExisting({
        kind: 'mine',
        family: read.value.family,
        next: (recipe.pending?.version ?? recipe.active.version) + 1,
      });
    }, 300);
    return () => {
      mine = false;
      clearTimeout(timer);
    };
  }, [apiFetch, slug, chain, owner, identity]);

  if (person.kind === 'loading') return <PublishWait />;
  if (person.kind !== 'ready' || !chain)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">
          {person.kind === 'no-chain'
            ? t.goal.blocked.chainNotChosen
            : person.kind === 'no-wallet'
              ? t.chain.switch.noWallet(t.chain.names[person.chain])
              : p.signIn}
        </p>
        <Link href="/sign-in?next=/publish" className={buttonClass({ variant: 'secondary' })}>
          {t.shell.signIn}
        </Link>
      </section>
    );
  if (!person.publishable)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">{p.problems.chain}</p>
      </section>
    );

  const sourceRead = snapshot?.key === sourceKey ? snapshot.read : null;
  const components = sourceRead?.kind === 'read' ? sourceRead.components : [];
  const read = components.map((r) => ({ asset: r.asset, bps: r.weightBps }));
  const problems = problemsOf({ name, slug, copy, rows: read });
  const sum = read.reduce((n, r) => n + (r.bps ?? 0), 0);
  // Always the page's own: an update is offered only where the stored id is this one.
  const familyId = familyIdFor(slug || 'x');
  const chainName = t.chain.names[chain];
  // A rule the form breaks is said after the person has typed in its part, or asked for the review:
  // an empty form says nothing is wrong with it yet.
  const partOf = (k: Problem): keyof typeof touched =>
    k === 'name' || k === 'slug' || k === 'copy' ? k : 'rows';
  const said = problems.filter(
    (k) =>
      tried ||
      (sourceRead?.kind === 'read' && partOf(k) === 'rows') ||
      k === 'chain' ||
      touched[partOf(k)] ||
      (k === 'slug' && touched.name),
  );
  const blocked = [
    ...said.map((k) => p.problems[k]),
    ...(sourceFailure ? [p.sourceUnavailable] : []),
    ...(!source ? [vaults ? p.noVaults : p.readingVaults] : []),
    ...(source && !sourceRead ? [p.readingStrategy] : []),
    ...(sourceRead && sourceRead.kind !== 'read' ? [p.sourceProblems[sourceRead.kind]] : []),
    ...(existing.kind === 'theirs' ? [p.theirs] : []),
    ...(existing.kind === 'foreign' ? [t.shared.family.foreign] : []),
    ...(existing.kind === 'reading' ? [t.shared.check.reading] : []),
    ...(existing.kind === 'unreadable' ? [p.failure.unreadable] : []),
    ...(!person.signable || person.off ? [t.shared.family.chainNotReady(chainName)] : []),
    ...(!owner ? [t.buy.blocked.wallet] : []),
  ];
  const locale = LOCALE[lang];
  const symbolOf = (id: string) => assets.find((a) => a.id === id)?.symbol ?? id;

  async function review() {
    setTried(true);
    if (
      inFlight.current ||
      placing ||
      problems.length > 0 ||
      blocked.length > 0 ||
      !source ||
      sourceRead?.kind !== 'read' ||
      !chain ||
      !owner ||
      person.kind !== 'ready' ||
      !person.userId
    )
      return;
    inFlight.current = true;
    setPlacing(true);
    setFailure(null);
    const guard = { ...active.current };
    const current = () =>
      alive.current &&
      active.current.key === guard.key &&
      active.current.revision === guard.revision &&
      active.current.form === guard.form;
    const fresh = await readPublishVault(apiFetch, {
      chain,
      owner,
      address: source.address,
      basketId: source.basketId,
      mock,
    });
    if (!current()) return;
    if (fresh.kind !== 'read') {
      setSnapshot({ key: sourceKey, read: fresh });
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    if (
      JSON.stringify([
        fresh.strategy,
        fresh.components,
        fresh.source,
        fresh.value.provenance,
        fresh.value.vault.recipeOnchainId,
        fresh.value.vault.acceptedVersion,
      ]) !==
      JSON.stringify([
        sourceRead.strategy,
        components,
        sourceRead.source,
        sourceRead.value.provenance,
        sourceRead.value.vault.recipeOnchainId,
        sourceRead.value.vault.acceptedVersion,
      ])
    ) {
      setSnapshot({ key: sourceKey, read: fresh });
      setFailure(p.strategyChanged);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    const familyRead = await readFamily(apiFetch, slug, chain);
    if (!current()) return;
    if (familyRead.kind !== 'read' && familyRead.kind !== 'no-plan') {
      setFailure(p.failure.unreadable);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    let now: Existing = { kind: 'new' };
    if (familyRead.kind === 'read') {
      const recipe = familyRead.value.family.recipes.find((r) => r.chain === chain);
      now =
        !recipe || !sameAddress(chain, recipe.creator, owner)
          ? { kind: 'theirs' }
          : familyRead.value.family.familyId !== familyId
            ? { kind: 'foreign' }
            : {
                kind: 'mine',
                family: familyRead.value.family,
                next: (recipe.pending?.version ?? recipe.active.version) + 1,
              };
    }
    if (
      now.kind !== existing.kind ||
      (now.kind === 'mine' && existing.kind === 'mine' && now.next !== existing.next)
    ) {
      setExisting(now);
      setFailure(t.shared.refusal.versionChanged);
      inFlight.current = false;
      setPlacing(false);
      return;
    }
    // Freeze the exact display; no private chat text enters these public terms.
    const frozen: Target[] = fresh.components.map((c) => ({ ...c }));
    // What the guard holds the bytes to: this form's id, text and weights.
    const terms: SharedTerms = {
      kind: 'publish',
      action: existing.kind === 'mine' ? 'update' : 'publish',
      familyId,
      components: frozen,
      text: { slug, name, copy, kind: 'index' },
      version: existing.kind === 'mine' ? existing.next : 1,
    };
    const placed = await placeShared(
      apiFetch,
      {
        type: 'publish',
        creator: { [chainFamily(chain)]: owner },
        family: slug,
        familyId,
        name,
        copy,
        recipes: [{ chain, components: frozen.map((c) => ({ kind: 'asset', ...c })) }],
      },
      { chain, owner, type: 'publish' },
    );
    if (!current()) return;
    if (placed.kind !== 'placed') {
      inFlight.current = false;
      setPlacing(false);
      setFailure(
        placed.kind === 'said'
          ? p.failure.said(placed.error)
          : placed.kind === 'busy'
            ? t.shell.slowDown
            : placed.kind === 'signed-out'
              ? p.failure.signedOut
              : placed.kind === 'unreadable'
                ? p.failure.unreadable
                : p.failure.unreachable,
      );
      return;
    }
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: person.userId,
      proposalId: '',
      chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      inFlight.current = false;
      setPlacing(false);
      setFailure(p.failure.noStore);
      return;
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  return (
    <div data-ui="publish-screen" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{p.lead(chainName)}</p>
      </header>

      <form
        className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
        noValidate
      >
        <Card as="section" aria-label={p.sourceVault} className="lg:col-span-2">
          <CardBody className="flex flex-col gap-4">
            <Field label={p.sourceVault} hint={p.sourceHint}>
              {(control) => (
                <Select
                  {...control}
                  value={selected}
                  onChange={(e) => setSelected(e.currentTarget.value)}
                >
                  <option value="">{p.chooseVault}</option>
                  {own.map((v) => (
                    <option key={v.address} value={v.address}>
                      {v.name ?? v.address}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {source && (
              <Link
                href={`/vaults/${chain}/${encodeURIComponent(source.address)}`}
                className={buttonClass({ variant: 'link' })}
              >
                {p.editStrategy}
              </Link>
            )}
            {source && (
              <p
                data-ui="publish-source"
                className="break-all font-mono text-source text-muted-foreground"
              >
                {chainName} · {source.address}
              </p>
            )}
            {/* While the vaults are read the two lines a chosen vault brings keep their place: the
                way back to its conversation and its address. */}
            {!source && !vaults && (
              <span
                aria-hidden="true"
                data-ui="publish-source-wait"
                className="flex flex-col gap-4"
              >
                <SkeletonLine className="text-body" width="w-56" />
                {/* an address breaks over two lines on a phone */}
                <SkeletonLine className="font-mono text-source sm:hidden" lines={2} />
                <SkeletonLine className="font-mono text-source max-sm:hidden" width="w-96" />
              </span>
            )}
            <p className="max-w-(--tf-measure-body) text-body-sm">{p.privacy}</p>
          </CardBody>
        </Card>

        <Card
          as="section"
          aria-label={p.about}
          mock={mock}
          mockLabels={{ announce: t.shell.mockAnnounce }}
        >
          <CardBody className="flex flex-col gap-5">
            <Field
              label={p.name}
              hint={p.nameHint}
              error={tried && problems.includes('name') ? p.problems.name : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  disabled={placing}
                  value={name}
                  maxLength={LIMITS.chars}
                  autoComplete="off"
                  onChange={(e) => {
                    touch('name');
                    setName(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={p.slug}
              hint={p.slugHint}
              error={
                tried && problems.includes('slug')
                  ? p.problems.slug
                  : existing.kind === 'theirs'
                    ? p.theirs
                    : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  disabled={placing}
                  value={slug}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    touch('slug');
                    setSlugText(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <Field
              label={p.copy}
              hint={p.copyHint}
              error={tried && problems.includes('copy') ? p.problems.copy : undefined}
            >
              {(control) => (
                <Textarea
                  {...control}
                  disabled={placing}
                  value={copy}
                  maxLength={LIMITS.chars}
                  onChange={(e) => {
                    touch('copy');
                    setCopy(e.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <div className="flex flex-col gap-1">
              <p className="text-caption font-medium">{p.familyId}</p>
              <p
                data-ui="family-id"
                className="break-all font-mono text-source text-muted-foreground"
              >
                {SLUG.test(slug) ? familyId : '—'}
              </p>
            </div>
            <p className="max-w-(--tf-measure-body) text-body-sm">
              {existing.kind === 'mine' ? p.update(existing.next) : p.first}
            </p>
          </CardBody>
        </Card>

        <Card
          as="section"
          aria-label={p.assets}
          mock={
            sourceRead?.kind === 'read' &&
            (sourceRead.source === 'mock' ||
              networkFor(chain, mock) !== 'mainnet' ||
              sourceRead.value.provenance !== 'live')
          }
          mockLabels={{
            announce: t.shell.mockAnnounce,
            note:
              sourceRead?.kind === 'read' && sourceRead.source === 'mock'
                ? t.shell.mockAnnounce
                : t.shell.testNetworkLine,
          }}
        >
          <CardHeader title={p.assets} level={2} meta={p.total(formatBps(sum, locale))} />
          <CardBody className="flex flex-col gap-4">
            <p className="text-body-sm text-muted-foreground">{p.assetsHint}</p>
            <ul className="flex flex-col gap-3">
              {components.map((row) => (
                <li
                  key={row.asset}
                  data-ui="publish-row"
                  className="flex justify-between gap-3 text-body"
                >
                  <span>{symbolOf(row.asset)}</span>
                  <span className="tabular-nums">{formatBps(row.weightBps, locale)}</span>
                </li>
              ))}
            </ul>
            {/* The strategy's rows while the vaults, then the chosen vault's strategy, are read. The
                sentence under the form's button says which; no share is drawn before it is read. */}
            {(!vaults || (source && !sourceRead)) && (
              <span aria-hidden="true" data-ui="publish-rows-wait" className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <SkeletonListRow key={i} mark={false} type="text-body" />
                ))}
              </span>
            )}
            {sourceRead?.kind === 'read' && (
              <>
                <p className="font-mono text-source text-muted-foreground">
                  {p.strategySource(
                    sourceRead.source === 'mock' ? t.shell.mockAnnounce : chainName,
                  )}
                </p>
                <h2 className="text-caption font-medium">{p.holdings}</h2>
                <ul className="flex flex-col gap-2 text-body-sm">
                  {[sourceRead.value.vault.cash, ...sourceRead.value.vault.positions].map(
                    (holding) => (
                      <li key={holding.asset} className="flex justify-between gap-3">
                        <span>{symbolOf(holding.asset)}</span>
                        <span className="tabular-nums">{tokens(lang, holding.display)}</span>
                      </li>
                    ),
                  )}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        <div className="flex flex-col items-start gap-2 lg:col-span-2">
          <Button
            type="submit"
            variant="primary"
            busy={placing}
            busyLabel={p.reviewing}
            disabled={blocked.length > 0 || !source || sourceRead?.kind !== 'read'}
            aria-describedby={blocked.length > 0 ? reasonId : undefined}
          >
            {p.review}
          </Button>
          {blocked.length > 0 && (
            <ul
              id={reasonId}
              className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm"
            >
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
              <span className="[overflow-wrap:anywhere]">{failure}</span>
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

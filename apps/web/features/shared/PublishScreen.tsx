'use client';
import { type ChainId, chainFamily, type SharedFamily, type Target } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader, CardLoading } from '../../components/ui/Card';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatBps } from '../order/amounts';
import { keepOrder } from '../order/order-record';
import { assetsFor } from '../order/units';
import { useApiFetch } from '../wallet/WalletProvider';
import { familyIdFor } from './chain-recipe';
import { placeShared, readFamily } from './shared-api';
import type { SharedTerms } from './terms';
import { useSharedPerson } from './use-person';

// The publish form (DESIGN-VAULT section 11, gate SHARED-FULL): a name, an address on the shelf, a
// description, and the assets and weights, on the person's chain. The family id is worked out here
// from the address (`familyIdOf`), never taken from our server, and shown. The order is reviewed on the
// order screen and signed through the executor with the consent `publish`: the guard holds the bytes to
// this form's id, text and weights, and hashes the text itself (AGT-4). The limits a portfolio follows
// are checked here first so the person is told before anything is asked; the server and the registry
// check them again. Solana only for now: on an EVM chain the form is not shown, since the guard does not
// sign a publish there until AGT-4 and our server refuses one.

export const LIMITS = { min: 3, max: 12, low: 200, high: 5000, step: 50, chars: 280 } as const;

// The server's rules for the creator's text (apps/api/src/orders/shared.ts), the same here so the
// form says so before anything is sent: a link, a scheme or `www.` or a bare host (`evil.xyz/airdrop`),
// an email address included; and a character a person cannot see or that turns text around.
const LINK = /:\/\/|www\.|(?<!\w)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![\w-])/i;
const HIDDEN = /\p{Cf}|(?!\n)\p{Cc}/u;
const ASCII = /^[\x20-\x7e]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

type Row = { key: number; asset: string; weight: string };

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
export function problemsOf(
  form: { name: string; slug: string; copy: string; rows: { asset: string; bps: number | null }[] },
  chain: ChainId,
): Problem[] {
  const out: Problem[] = [];
  if (chainFamily(chain) !== 'solana') out.push('chain');
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
  | { kind: 'theirs' };

export function PublishScreen() {
  const t = useT();
  const lang = useLang();
  const p = t.shared.publish;
  const router = useRouter();
  const apiFetch = useApiFetch();
  const person = useSharedPerson();
  const chain = person.kind === 'ready' ? person.chain : null;
  const mock = person.kind === 'ready' ? person.mock : false;
  const assets = chain ? assetsFor(chain, mock) : [];
  const [name, setName] = useState('');
  const [slugText, setSlugText] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [existing, setExisting] = useState<Existing>({ kind: 'new' });
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const reasonId = useId();
  const slug = slugText ?? slugOf(name);
  const owner = person.kind === 'ready' ? person.owner : null;

  // Three rows to start from, on the chain's own assets.
  useEffect(() => {
    if (rows !== null || assets.length < LIMITS.min) return;
    setRows(
      assets
        .slice(0, 3)
        .map((a, i) => ({ key: i, asset: a.id, weight: ['40', '30', '30'][i] ?? '' })),
    );
  }, [rows, assets]);

  // Whether this address is a portfolio already: the person's own (the next version) or another's.
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
      if (read.kind !== 'read') return setExisting({ kind: 'new' });
      const recipe = read.value.family.recipes.find((r) => r.chain === chain);
      if (!recipe || recipe.creator !== owner) return setExisting({ kind: 'theirs' });
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
  }, [apiFetch, slug, chain, owner]);

  if (person.kind === 'loading')
    return (
      <Card>
        <CardLoading label={t.chain.reading} />
      </Card>
    );
  if (person.kind !== 'ready' || !chain)
    return (
      <section className="flex flex-col items-start gap-4">
        <h1 className={PAGE_TITLE}>{p.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body">
          {person.kind === 'no-chain' ? t.goal.blocked.chainNotChosen : p.signIn}
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

  const list = rows ?? [];
  const read = list.map((r) => ({ asset: r.asset, bps: bpsOf(r.weight) }));
  const problems = problemsOf({ name, slug, copy, rows: read }, chain);
  const sum = read.reduce((n, r) => n + (r.bps ?? 0), 0);
  // Always the page's own: an update is offered only where the stored id is this one.
  const familyId = familyIdFor(slug || 'x');
  const chainName = t.chain.names[chain];
  const blocked = [
    ...problems.map((k) => p.problems[k]),
    ...(existing.kind === 'theirs' ? [p.theirs] : []),
    ...(existing.kind === 'foreign' ? [t.shared.family.foreign] : []),
    ...(existing.kind === 'reading' ? [t.shared.check.reading] : []),
    ...(!person.signable || person.off ? [t.shared.family.chainNotReady(chainName)] : []),
    ...(!owner ? [t.buy.blocked.wallet] : []),
  ];
  const locale = LOCALE[lang];
  const symbolOf = (id: string) => assets.find((a) => a.id === id)?.symbol ?? id;

  async function review() {
    setTried(true);
    if (blocked.length > 0 || !chain || !owner || person.kind !== 'ready' || !person.userId) return;
    setPlacing(true);
    setFailure(null);
    const components: Target[] = read.map((r) => ({ asset: r.asset, weightBps: r.bps ?? 0 }));
    // What the guard holds the bytes to: this form's id, text and weights.
    const terms: SharedTerms = {
      kind: 'publish',
      action: existing.kind === 'mine' ? 'update' : 'publish',
      familyId,
      components,
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
        recipes: [{ chain, components: components.map((c) => ({ kind: 'asset', ...c })) }],
      },
      { chain, owner, type: 'publish' },
    );
    if (placed.kind !== 'placed') {
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
      setPlacing(false);
      setFailure(p.failure.noStore);
      return;
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  const setRow = (key: number, change: Partial<Row>) =>
    setRows((all) => (all ?? []).map((r) => (r.key === key ? { ...r, ...change } : r)));
  const unused = (current: string) =>
    assets.filter((a) => a.id === current || !list.some((r) => r.asset === a.id));

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
                  value={name}
                  maxLength={LIMITS.chars}
                  autoComplete="off"
                  onChange={(e) => setName(e.currentTarget.value)}
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
                  value={slug}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setSlugText(e.currentTarget.value)}
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
                  value={copy}
                  maxLength={LIMITS.chars}
                  onChange={(e) => setCopy(e.currentTarget.value)}
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

        <Card as="section" aria-label={p.assets}>
          <CardHeader title={p.assets} level={2} meta={p.total(formatBps(sum, locale))} />
          <CardBody className="flex flex-col gap-4">
            <p className="text-body-sm text-muted-foreground">{p.assetsHint}</p>
            <ul className="flex flex-col gap-3">
              {list.map((row, i) => (
                <li key={row.key} data-ui="publish-row" className="flex flex-wrap items-end gap-3">
                  <Field label={`${p.asset} ${i + 1}`} className="min-w-[9rem] flex-1">
                    {(control) => (
                      <Select
                        {...control}
                        value={row.asset}
                        onChange={(e) => setRow(row.key, { asset: e.currentTarget.value })}
                      >
                        {unused(row.asset).map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.symbol}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={`${p.weight} ${i + 1}`}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        width="7ch"
                        align="end"
                        value={row.weight}
                        onChange={(e) => setRow(row.key, { weight: e.currentTarget.value })}
                      />
                    )}
                  </Field>
                  <Button
                    variant="secondary"
                    onClick={() => setRows((all) => (all ?? []).filter((r) => r.key !== row.key))}
                  >
                    {p.remove(symbolOf(row.asset))}
                  </Button>
                </li>
              ))}
            </ul>
            {list.length < LIMITS.max && unused('').length > 0 && (
              <Button
                variant="secondary"
                className="self-start"
                onClick={() =>
                  setRows((all) => [
                    ...(all ?? []),
                    {
                      key: Math.max(-1, ...(all ?? []).map((r) => r.key)) + 1,
                      asset: unused('')[0]?.id ?? '',
                      weight: '',
                    },
                  ])
                }
              >
                {p.add}
              </Button>
            )}
          </CardBody>
        </Card>

        <div className="flex flex-col items-start gap-2 lg:col-span-2">
          <Button
            type="submit"
            variant="primary"
            busy={placing}
            busyLabel={p.reviewing}
            disabled={(tried && blocked.length > 0) || existing.kind === 'reading'}
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

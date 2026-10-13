'use client';
import { ChainId, chainFamily, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { DataTable } from '../../components/ui/DataTable';
import { Field, Input } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatRaw, parseRaw, rawOfShown, shownRaw, tokenName } from '../order/amounts';
import type { CallFailure } from '../order/order-api';
import { keepOrder } from '../order/order-record';
import { chainReady, onMock } from '../order/readiness';
import { StepCard } from '../order/StepCard';
import { unitsFor } from '../order/units';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { isVaultOf } from './chain-recipe';
import { placeShared, readVault } from './shared-api';
import type { SharedTerms, WithdrawItem } from './terms';
import { WithdrawWait } from './waits';

// Taking money out of a vault (WITHDRAW, Oct 6), for its owner only, in the buy's step pattern: what
// leaves (everything, or chosen tokens, each in full or by amount), a review of exactly that and of
// where it goes, which is the owner's own wallet and nowhere else, then the order (POST /v1/orders,
// type `withdraw`) and its screen, where every step is checked by the guard before it is signed. The
// tokens leave as they are: nothing is sold. Nothing is signed here. With `embedded` the vault's own
// page holds it in its pane: the same choice and review under the page's heading, and the order's id
// handed to the page, which shows the steps there, in place of the order's own page.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };
type StepId = 'what' | 'check' | 'confirm';
const STEPS: readonly StepId[] = ['what', 'check', 'confirm'];
type Pick = { on: boolean; text: string };

export function WithdrawScreen({
  chain: chainText,
  address,
  embedded,
}: {
  chain: string;
  address: string;
  /** Held in another screen's pane: no title of its own, and the order made is handed to the host. */
  embedded?: { onOrder: (orderId: string) => void };
}) {
  const t = useT();
  const lang = useLang();
  const w = t.withdraw;
  const router = useRouter();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const known = ChainId.safeParse(chainText);
  const chain = known.success ? known.data : null;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [everything, setEverything] = useState(true);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [open, setOpen] = useState<StepId>('what');
  const [chosen, setChosen] = useState(false);
  const [seen, setSeen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();
  const groupId = useId();
  const reasonId = useId();
  const seenId = useId();

  useEffect(() => {
    if (!chain) return setLoad({ kind: 'no-plan' });
    let mine = true;
    setLoad({ kind: 'loading' });
    readVault(apiFetch, chain, address).then((read) => {
      if (mine) setLoad(read.kind === 'read' ? { kind: 'read', read: read.value } : read);
    });
    return () => {
      mine = false;
    };
  }, [apiFetch, chain, address]);

  const back = (
    <Link href="/monitor" className={buttonClass({ variant: 'secondary' })}>
      {w.back}
    </Link>
  );
  const page = (body: string, more?: React.ReactNode) =>
    embedded ? (
      // in a host's pane: the sentence alone, under the host's heading and beside its way back
      <p data-ui="withdraw-gate" className="max-w-(--tf-measure-body) text-body">
        {body}
      </p>
    ) : (
      <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {w.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body">{body}</p>
        {more ?? back}
      </section>
    );

  if (port.status === 'loading' || load.kind === 'loading') return <WithdrawWait chain={chain} />;
  if (port.status === 'signed-out')
    return page(
      t.plan.signedOut,
      <Link
        href={`/sign-in?next=${encodeURIComponent(`/vaults/${chainText}/${address}/withdraw`)}`}
        className={buttonClass({ variant: 'secondary' })}
      >
        {t.shell.signIn}
      </Link>,
    );
  if (!chain || load.kind === 'no-plan' || load.kind === 'refused') return page(w.notYours);
  if (load.kind !== 'read') return page(load.kind === 'busy' ? t.shell.slowDown : w.failed);

  const { vault } = load.read;
  const owner = port.active(chainFamily(chain))?.address ?? null;
  // The owner's page and nobody else's: a vault pays only its owner, and nobody else is shown the way.
  if (!owner || vault.owner !== owner) return page(w.notYours);
  const holdings = [vault.cash, ...vault.positions].filter((h) => BigInt(h.raw) > 0n);
  if (holdings.length === 0) return page(w.empty);

  const mock = onMock(port, chain);
  const chainName = t.chain.names[chain];
  const units = unitsFor(chain, mock);
  const symbol = (asset: string) => units?.tokens[asset]?.symbol ?? tokenName(asset);
  // Every amount here is the figure the portfolio and the wallet show: the raw amount times the
  // token's multiplier (a stock token's issuer sets one), in the units this repository committed.
  const multiplierOf = (asset: string) =>
    holdings.find((h) => h.asset === asset)?.multiplier ?? '1';
  const whole = (raw: string, asset: string) => {
    const u = units?.tokens[asset];
    const shown = shownRaw(BigInt(raw), multiplierOf(asset)).toString();
    // To the token's last place: an amount typed back as it is shown is the amount that was shown.
    const figure = u ? formatRaw(shown, u.decimals, LOCALE[lang], u.decimals) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : `${raw} ${tokenName(asset)}`;
  };

  // What the person chose, as raw amounts: null for all of a token. An amount that is not one of this
  // token, or is more than the vault holds, is said beside its field and holds the step.
  const errors: Record<string, string> = {};
  const items: WithdrawItem[] = everything
    ? holdings.map((h) => ({
        asset: h.asset,
        amountRaw: null,
        heldRaw: h.raw,
        multiplier: h.multiplier,
      }))
    : holdings.flatMap((h) => {
        const pick = picks[h.asset];
        if (!pick?.on) return [];
        const decimals = units?.tokens[h.asset]?.decimals;
        const item = { asset: h.asset, heldRaw: h.raw, multiplier: h.multiplier };
        if (!pick.text.trim() || decimals === undefined) return [{ ...item, amountRaw: null }];
        // Typed as it is shown; signed in exact raw units, rounded down, never above the balance: the
        // whole shown balance is the whole raw balance, whatever the rounding.
        const typed = parseRaw(pick.text, decimals);
        const held = BigInt(h.raw);
        const all = shownRaw(held, h.multiplier);
        const raw = typed === null ? null : typed === all ? held : rawOfShown(typed, h.multiplier);
        if (typed === null || raw === null || raw === 0n) errors[h.asset] = w.what.errors.amount;
        else if (typed > all || raw > held)
          errors[h.asset] = w.what.errors.over(whole(h.raw, h.asset));
        return [{ ...item, amountRaw: raw === null || raw === 0n ? null : raw.toString() }];
      });
  const valid = items.length > 0 && Object.keys(errors).length === 0;
  // Everything a token holds, taken by amount, empties it as taking all of it does.
  const emptied =
    items.length === holdings.length &&
    items.every((i) => i.amountRaw === null || i.amountRaw === i.heldRaw);

  /** Any change to what leaves is reviewed again. */
  const change = (apply: () => void) => {
    apply();
    setSeen(false);
    setFailure(null);
  };
  const go = (step: StepId) => {
    if (open === 'what' && valid) setChosen(true);
    setOpen(step);
  };

  const signable = chainReady(chain, mock) && port.network(chain)?.on !== false;
  const blocked = [
    ...(!signable ? [w.confirm.blocked.chain(chainName)] : []),
    ...(!valid ? [w.confirm.blocked.what] : []),
    ...(valid && !seen ? [w.confirm.blocked.check] : []),
  ];

  async function review() {
    if (!chain || !owner || !port.userId || !valid || !seen) return;
    setPlacing(true);
    setFailure(null);
    // The plan number the steps name has to be this vault's own, as the guard derives its address.
    if (isVaultOf(chain, mock, owner, vault.basketId, vault.address) === false) {
      setPlacing(false);
      setFailure(w.confirm.blocked.vault);
      return;
    }
    // What the withdrawal is held to: the tokens and the amounts reviewed here, for this owner.
    const terms: SharedTerms = {
      kind: 'withdraw',
      vault: vault.address,
      basketId: vault.basketId,
      owner,
      everything,
      items,
      autoFollowOff: vault.autoFollow,
    };
    const placed = await placeShared(
      apiFetch,
      {
        type: 'withdraw',
        vaults: [vault.address],
        sellToCash: false,
        ...(everything
          ? {}
          : { withdrawals: items.map(({ asset, amountRaw }) => ({ asset, amountRaw })) }),
      },
      { chain, owner, type: 'withdraw' },
    );
    if (placed.kind !== 'placed') {
      setPlacing(false);
      setFailure(
        placed.kind === 'said'
          ? t.shared.publish.failure.said(placed.error)
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
    const kept = keepOrder({
      orderId: placed.order.id,
      userId: port.userId,
      proposalId: '',
      chain,
      amountUsd: 0,
      lines: [],
      terms,
      approved: null,
    });
    if (!kept) {
      setPlacing(false);
      setFailure(t.buy.failure.noStore);
      return;
    }
    if (embedded) {
      setPlacing(false);
      return embedded.onOrder(placed.order.id);
    }
    router.push(`/orders/${encodeURIComponent(placed.order.id)}`);
  }

  const next = (step: StepId, ready: boolean) => (
    <Button
      variant="primary"
      disabled={!ready}
      onClick={() => go(STEPS[STEPS.indexOf(step) + 1] ?? step)}
    >
      {w.steps.next}
    </Button>
  );

  const what = (
    <div className="flex flex-col items-start gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-body font-medium">{w.what.legend}</legend>
        {(
          [
            [true, w.what.everything],
            [false, w.what.some],
          ] as const
        ).map(([all, label]) => (
          <label key={String(all)} className="inline-flex items-center gap-2 text-body">
            <input
              type="radio"
              name={groupId}
              className="size-4 accent-primary"
              checked={everything === all}
              onChange={() => change(() => setEverything(all))}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {!everything && (
        <ul data-ui="withdraw-picks" className="flex w-full flex-col divide-y divide-border">
          {holdings.map((h) => {
            const pick = picks[h.asset] ?? { on: false, text: '' };
            const set = (to: Partial<Pick>) =>
              change(() => setPicks((all) => ({ ...all, [h.asset]: { ...pick, ...to } })));
            const byAmount = units?.tokens[h.asset] !== undefined;
            return (
              <li key={h.asset} data-asset={h.asset} className="flex flex-col gap-2 py-3">
                <label className="inline-flex items-center gap-2 text-body">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={pick.on}
                    onChange={(e) => set({ on: e.currentTarget.checked })}
                  />
                  {w.what.take(symbol(h.asset))}
                </label>
                <p className="text-body-sm text-muted-foreground tabular-nums">
                  {w.what.holds(whole(h.raw, h.asset))}
                </p>
                {pick.on &&
                  (byAmount ? (
                    <Field
                      label={w.what.amount(symbol(h.asset))}
                      hint={w.what.amountHint}
                      error={errors[h.asset]}
                    >
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="decimal"
                          width="18ch"
                          value={pick.text}
                          onChange={(e) => set({ text: e.currentTarget.value })}
                        />
                      )}
                    </Field>
                  ) : (
                    <p className="text-body-sm text-muted-foreground">{w.what.wholeOnly}</p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {!everything && items.length === 0 && <p className="text-body-sm">{w.what.errors.none}</p>}
      {next('what', valid)}
    </div>
  );

  const check = (
    <div className="flex flex-col items-start gap-4">
      <DataTable<WithdrawItem>
        caption={w.check.leaves}
        rows={items}
        rowKey={(r) => r.asset}
        columns={[
          { key: 'asset', header: w.check.token, rowHeader: true, cell: (r) => symbol(r.asset) },
          {
            key: 'amount',
            header: w.check.amount,
            numeric: true,
            cell: (r) =>
              r.amountRaw === null
                ? w.check.all(whole(r.heldRaw, r.asset))
                : whole(r.amountRaw, r.asset),
          },
        ]}
      />
      <dl className="grid gap-x-6 gap-y-1 text-body-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{w.check.to}</dt>
        <dd>
          {w.check.own}{' '}
          <span data-ui="withdraw-to" className="break-all font-mono text-source">
            {owner}
          </span>
        </dd>
        <dt className="text-muted-foreground">{w.check.from}</dt>
        <dd className="break-all font-mono text-source">{vault.address}</dd>
      </dl>
      <p className="max-w-(--tf-measure-body) text-body-sm">
        {emptied ? w.check.emptied : w.check.stays}
      </p>
      {vault.autoFollow && (
        <p
          data-ui="withdraw-keeper"
          className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
        >
          <StatusMark status="watch" size={12} className="mt-1.5" />
          <span>{w.check.autoFollow}</span>
        </p>
      )}
      <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
        {w.check.onlyOwner}
      </p>
      <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
        {w.check.noSale}
      </p>
      <label htmlFor={seenId} className="inline-flex items-center gap-2 text-body">
        <input
          id={seenId}
          type="checkbox"
          className="size-4 accent-primary"
          checked={seen}
          disabled={!valid}
          onChange={(e) => setSeen(e.currentTarget.checked)}
        />
        {w.check.confirm}
      </label>
      {next('check', valid && seen)}
    </div>
  );

  const confirm = (
    <div className="flex flex-col items-start gap-3">
      <p className="max-w-(--tf-measure-body) text-body">{w.confirm.lead}</p>
      <Button
        variant="primary"
        busy={placing}
        busyLabel={w.confirm.busy}
        disabled={blocked.length > 0}
        aria-describedby={blocked.length > 0 ? reasonId : undefined}
        onClick={review}
      >
        {w.confirm.button}
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
  );

  const provenance = load.read.provenance;
  return (
    <div
      data-ui="withdraw-screen"
      className={embedded ? 'flex min-w-0 flex-col gap-4' : 'flex flex-col gap-8'}
    >
      {embedded ? (
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {w.lead(chainName)}
        </p>
      ) : (
        <header className="flex flex-col items-start gap-3">
          <ChainBadge chain={chain} />
          <h1 id={titleId} className={PAGE_TITLE}>
            {w.title}
          </h1>
          <p className="max-w-(--tf-measure-body) text-body-lg">{w.lead(chainName)}</p>
        </header>
      )}
      <StepCard
        ui="withdraw"
        label={w.steps.label}
        doneWord={w.steps.done}
        steps={[
          {
            id: 'what',
            name: w.steps.names.what,
            done: chosen && valid,
            summary: !valid
              ? null
              : everything
                ? w.what.summaryAll
                : w.what.summarySome(items.length),
            panel: what,
          },
          {
            id: 'check',
            name: w.steps.names.check,
            done: valid && seen,
            summary: valid && seen ? w.check.seen : null,
            panel: check,
          },
          { id: 'confirm', name: w.steps.names.confirm, done: false, panel: confirm },
        ]}
        open={open}
        onOpen={go}
        mock={provenance === 'mock'}
        mockAnnounce={t.shell.mockAnnounce}
        note={provenance === 'sandbox' ? t.buy.steps.note.testNetwork(chainName) : null}
      />
    </div>
  );
}

'use client';
import { ChainId, chainFamily, type VaultResponse } from '@colosseum/schemas';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Disclaimer } from '../../components/ui/Disclaimer';
import { Field, Input, Select } from '../../components/ui/Field';
import { PAGE_TITLE } from '../../components/ui/heading';
import { SkeletonSummary } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import type { CallFailure } from '../order/order-api';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { onMock } from '../order/readiness';
import { assetsFor, unitsFor } from '../order/units';
import { readVault } from '../shared/shared-api';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { ApplyVaultMix } from './ApplyVaultMix';
import {
  bpsOf,
  cashLeft,
  type EditorLine,
  editorIssues,
  MAX_LINES,
  mixOf,
  textOf,
  type WeightUnit,
} from './mix';

// The weights of a vault the person owns, set by their own hand (gate ANY-COMPOSITION, #191): the
// vault's current targets to start from, any asset of the chain's list added or removed (at most 16
// besides cash, never the cash token), whole percents or basis points, and what is left shown as cash.
// The review and the order are the same as for a preview from the vault conversation.

type Load = { kind: 'loading' } | { kind: 'read'; read: VaultResponse } | { kind: CallFailure };
type Row = { assetId: string; text: string };

export function TargetsScreen({ chain: chainText, address }: { chain: string; address: string }) {
  const t = useT();
  const lang = useLang();
  const e = t.mix.editor;
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const known = ChainId.safeParse(chainText);
  const chain = known.success ? known.data : null;
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [unit, setUnit] = useState<WeightUnit>('percent');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState('');
  const [reviewing, setReviewing] = useState<EditorLine[] | null>(null);
  const titleId = useId();

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
    <Link
      href={`/vaults/${encodeURIComponent(chainText)}/${encodeURIComponent(address)}`}
      className={buttonClass({ variant: 'secondary' })}
    >
      {e.back}
    </Link>
  );
  const page = (body: string, more?: React.ReactNode) => (
    <section aria-labelledby={titleId} className="flex flex-col items-start gap-4">
      <h1 id={titleId} className={PAGE_TITLE}>
        {e.title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{body}</p>
      {more ?? back}
    </section>
  );

  if (port.status === 'loading' || load.kind === 'loading')
    return (
      <Card>
        <CardWait label={e.loading} skeleton={<SkeletonSummary />} />
      </Card>
    );
  if (port.status === 'signed-out')
    return page(
      t.plan.signedOut,
      <Link
        href={`/sign-in?next=${encodeURIComponent(`/vaults/${chainText}/${address}/targets`)}`}
        className={buttonClass({ variant: 'secondary' })}
      >
        {t.shell.signIn}
      </Link>,
    );
  if (!chain || load.kind === 'no-plan' || load.kind === 'refused') return page(e.notYours);
  if (load.kind !== 'read') return page(load.kind === 'busy' ? t.shell.slowDown : e.failed);
  const { vault } = load.read;
  const owner = port.active(chainFamily(chain))?.address ?? null;
  if (!owner || vault.owner !== owner) return page(e.notYours);

  const mock = onMock(port, chain);
  const cash = unitsFor(chain, mock)?.cash ?? vault.cash.asset;
  const shown: Row[] =
    rows ??
    vault.positions
      .filter((position) => position.targetBps > 0 && position.asset !== cash)
      .map((position) => ({ assetId: position.asset, text: textOf(position.targetBps, unit) }));
  const lines: EditorLine[] = shown.map((row) => ({
    assetId: row.assetId,
    weightBps: bpsOf(row.text, unit) ?? Number.NaN,
  }));
  const unread = lines.some((line) => Number.isNaN(line.weightBps));
  const issues = editorIssues(
    lines.map((line) => ({
      ...line,
      weightBps: Number.isNaN(line.weightBps) ? 0.5 : line.weightBps,
    })),
    cash,
  );
  const left = cashLeft(lines.filter((line) => !Number.isNaN(line.weightBps)));
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 })
      .format(Math.abs(bps) / 10_000)
      .replace('-', '−');
  const listed = assetsFor(chain, mock).filter(
    (asset) => asset.id !== cash && !shown.some((row) => row.assetId === asset.id),
  );
  const nameOf = (asset: string) =>
    assetsFor(chain, mock).find((a) => a.id === asset)?.symbol ?? displayName(asset, t.plan);
  const edit = (next: Row[]) => setRows(next);
  const switchUnit = (to: WeightUnit) => {
    // The weights keep their value: each row is written again in the other unit where it reads.
    edit(
      shown.map((row) => {
        const bps = bpsOf(row.text, unit);
        return bps === null ? row : { ...row, text: textOf(bps, to) };
      }),
    );
    setUnit(to);
  };

  if (reviewing)
    return (
      <section aria-labelledby={titleId} className="flex flex-col gap-4">
        <h1 id={titleId} className={PAGE_TITLE}>
          {e.title}
        </h1>
        <ApplyVaultMix
          chain={chain}
          vault={vault}
          lines={mixOf(reviewing, cash)}
          origin="person"
          onBack={() => setReviewing(null)}
        />
        <Disclaimer lang={lang} label={t.shell.disclaimer} />
      </section>
    );

  return (
    <section aria-labelledby={titleId} data-ui="targets-screen" className="flex flex-col gap-4">
      <h1 id={titleId} className={PAGE_TITLE}>
        {e.title}
      </h1>
      <p className="max-w-(--tf-measure-body) text-body">{e.lead}</p>
      <Card
        as="section"
        aria-label={e.title}
        mock={load.read.provenance !== 'live'}
        mockLabels={{
          announce:
            load.read.provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        <CardHeader
          title={e.lines(lines.filter((l) => l.weightBps > 0).length)}
          level={2}
          meta={t.chain.names[chain]}
        />
        <CardBody className="flex min-w-0 flex-col gap-4">
          <Field label={e.unit}>
            {(control) => (
              <Select
                {...control}
                value={unit}
                onChange={(ev) => switchUnit(ev.currentTarget.value as WeightUnit)}
              >
                <option value="percent">{e.percent}</option>
                <option value="bps">{e.bps}</option>
              </Select>
            )}
          </Field>
          <ul data-ui="targets-lines" className="flex flex-col gap-3">
            {shown.map((row, i) => {
              const name = nameOf(row.assetId);
              return (
                <li key={row.assetId} className="flex flex-wrap items-end gap-3">
                  <span className="flex min-w-[8rem] items-center gap-2 pb-2 text-body">
                    <AssetMark asset={row.assetId} />
                    {name}
                  </span>
                  <Field
                    label={e.weight(name)}
                    error={bpsOf(row.text, unit) === null ? e.issues['not-whole'] : undefined}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        width="10ch"
                        align="end"
                        value={row.text}
                        onChange={(ev) => {
                          const text = ev.currentTarget.value;
                          edit(shown.map((r, j) => (j === i ? { ...r, text } : r)));
                        }}
                      />
                    )}
                  </Field>
                  <Button
                    variant="secondary"
                    size="dense"
                    onClick={() => edit(shown.filter((_, j) => j !== i))}
                  >
                    {e.remove(name)}
                  </Button>
                </li>
              );
            })}
          </ul>
          <p data-ui="targets-cash" className="text-body tabular-nums">
            {e.cash(left < 0 ? `−${share(left)}` : share(left))}
          </p>
          {listed.length > 0 && shown.length < MAX_LINES ? (
            <div className="flex flex-wrap items-end gap-3">
              <Field label={e.add}>
                {(control) => (
                  <Select
                    {...control}
                    value={adding}
                    onChange={(ev) => setAdding(ev.currentTarget.value)}
                  >
                    <option value="">{t.mix.goal.choose}</option>
                    {listed.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {asset.symbol}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button
                variant="secondary"
                size="dense"
                disabled={!adding}
                onClick={() => {
                  if (!adding) return;
                  edit([...shown, { assetId: adding, text: '' }]);
                  setAdding('');
                }}
              >
                {e.addButton}
              </Button>
            </div>
          ) : (
            listed.length === 0 && <p className="text-body-sm text-muted-foreground">{e.addNone}</p>
          )}
          {(issues.length > 0 || unread) && (
            <ul data-ui="targets-issues" className="flex flex-col gap-1">
              {issues.map((issue) => (
                <li key={issue} className="flex items-start gap-1.5 text-body-sm">
                  <StatusMark status="watch" className="mt-1.5" />
                  <span>
                    {issue === 'over-whole' ? e.issues['over-whole'](share(left)) : e.issues[issue]}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="primary"
            data-action="targets-review"
            disabled={issues.length > 0 || unread}
            className="self-start"
            onClick={() => setReviewing(lines)}
          >
            {t.mix.vault.review}
          </Button>
        </CardBody>
      </Card>
      <Disclaimer lang={lang} label={t.shell.disclaimer} />
    </section>
  );
}

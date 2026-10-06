'use client';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { Status } from '../../components/ui/StatusMark';
import { type Base, useAnswer, useBearing } from './BearingProvider';
import { R, type Res } from './data';
import { capFact } from './dex';
import { FlowChart } from './Flow';
import type { Fact } from './fact';
import { pct, REGIMES, usd, usd1 } from './format';
import { Card, Count, Fig, Kpi, Kpis, Loading, Reason, useWords } from './parts';
import { chunksFor, parseAmount, type SimPath, simPaths } from './sim';
import { etLabel, regimeAt } from './time';
import type { RecovBody, SheetBody, SplitBody } from './types';

// The simulation page (analytics2.js, simPage): sell a position now, and see what each way out would
// lose, as a flow and as a table; what the best path pays, part by part; and the same sale in every
// time of week. The amount is the person's own input and carries no pin.

export function SimPage() {
  const { base } = useBearing();
  const b = useAnswer(() => base(), [base]);
  const reading = useWords().sim.reading;
  if (!b) return <Loading>{reading}</Loading>;
  if (!b.assets.ok)
    return (
      <p className="mt-6">
        <Reason code={b.assets.reason} />
      </p>
    );
  return <SimForm b={b} />;
}

function SimForm({ b }: { b: Base }) {
  const { ui, setUi } = useBearing();
  const t = useWords().sim;
  const body = b.assets.ok ? b.assets.body : null;
  const ids = (body?.assets ?? []).map((a) => a.symbol).sort();
  const [asked] = useState(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('asset'),
  );
  const fromLink = asked ? ids.find((id) => id.toLowerCase() === asked.toLowerCase()) : undefined;
  const [run, setRun] = useState(() => {
    const asset = fromLink ?? (ids.includes(ui.sim.asset) ? ui.sim.asset : (ids[0] ?? ''));
    return { asset, size: ui.sim.size };
  });
  const [size, setSize] = useState(String(run.size));
  const [err, setErr] = useState('');
  const sizeRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const submit = (asset: string, e?: FormEvent) => {
    e?.preventDefault();
    const v = parseAmount(size);
    if (v == null) {
      setErr(t.amountError);
      sizeRef.current?.focus();
      return;
    }
    setErr('');
    setRun({ asset, size: v });
    setUi((s) => ({ ...s, sim: { asset, size: v } }));
  };
  const field = 'flex min-w-0 flex-col gap-1';
  const control = 'min-h-8 rounded-md border border-input bg-muted px-2 py-1 text-[0.8125rem]';
  return (
    <>
      <Card className="mt-6">
        <form
          noValidate
          onSubmit={(e) => submit(run.asset, e)}
          className="flex flex-wrap items-end gap-x-4 gap-y-3"
        >
          <label className={field}>
            <span className="text-caption font-medium text-muted-foreground">{t.asset}</span>
            <select
              name="asset"
              value={run.asset}
              onChange={(e) => submit(e.target.value)}
              className={control}
            >
              {ids.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <label className={field}>
            <span className="text-caption font-medium text-muted-foreground">{t.amount}</span>
            <input
              ref={sizeRef}
              name="size"
              inputMode="decimal"
              autoComplete="off"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              aria-describedby={errId}
              aria-invalid={err ? true : undefined}
              className={`${control} w-40 font-mono`}
            />
          </label>
          <Button type="submit" variant="primary" size="dense">
            {t.simulate}
          </Button>
          <p
            id={errId}
            role="alert"
            className="basis-full font-mono text-b-meta text-destructive empty:hidden"
          >
            {err}
          </p>
        </form>
      </Card>
      <div aria-live="polite">
        {body && run.asset && (
          <SimRun key={`${run.asset}|${run.size}`} b={b} id={run.asset} n={run.size} />
        )}
      </div>
    </>
  );
}

function SimRun({ b, id, n }: { b: Base; id: string; n: number }) {
  const { reader, clock } = useBearing();
  const words = useWords();
  const t = words.sim;
  const body = b.assets.ok ? b.assets.body : null;
  const at = new Date(clock.now || Date.now());
  const r = regimeAt(at);
  const a = body?.assets.find((x) => x.symbol === id);
  const cap = body ? capFact(a, r, body) : null;
  const chunks = cap ? chunksFor(n, cap) : 0;
  const rs = useAnswer(
    () =>
      Promise.all([
        reader.get<SheetBody>(R.sheet(id, n)),
        reader.get<RecovBody>(R.recov(id, n)),
        chunks ? reader.get<SheetBody>(R.sheet(id, n / chunks)) : Promise.resolve(null),
        reader.get<SplitBody>(R.split(id, n)),
        chunks ? reader.get<SplitBody>(R.split(id, n / chunks)) : Promise.resolve(null),
      ]),
    [id, n, chunks, reader],
  );
  if (!rs || !body || !cap) return <Loading>{t.pricing(usd(n), id)}</Loading>;
  const [s, recov, sc, fNow, fSplit] = rs as [
    Res<SheetBody>,
    Res<RecovBody>,
    Res<SheetBody> | null,
    Res<SplitBody>,
    Res<SplitBody> | null,
  ];
  if (!s.ok)
    return (
      <p className="mt-4">
        <Reason code={s.reason} />
      </p>
    );
  const { paths, best, verdict } = simPaths({
    id,
    n,
    at,
    r,
    sheet: s.body,
    chunks,
    chunkSheet: sc,
    recov,
    words,
  });
  const ex = best?.ex ?? null;
  const parts: Array<[string, Fact | undefined]> = ex
    ? [
        [t.parts.poolFee, ex.poolFee],
        [t.parts.transferFee, ex.transferFee],
        [t.parts.impact, ex.impact],
        [t.parts.basis, ex.basis],
        [t.parts.platformFee, ex.platformFee],
      ]
    : [];
  const pathCols: Column<SimPath>[] = [
    {
      key: 'path',
      header: t.head.path,
      rowHeader: true,
      cell: (p) => (
        <span className="inline-flex items-center gap-1.5">
          {p === best && <Status status="on-track">{t.best}</Status>}
          <b className="font-semibold whitespace-nowrap">{p.name}</b>
        </span>
      ),
    },
    {
      key: 'how',
      header: t.head.how,
      cell: (p) => <span className="whitespace-normal">{p.how}</span>,
    },
    {
      key: 'when',
      header: t.head.when,
      cell: (p) => <span className="whitespace-normal">{p.when}</span>,
    },
    {
      key: 'cost',
      header: t.head.cost,
      numeric: true,
      cell: (p) =>
        p.assumption ? (
          <>
            <Fig f={p.capF} fmt={usd1} />
            <span className="block font-mono text-b-meta text-muted-foreground">
              {t.capacityNotCost}
            </span>
          </>
        ) : (
          <Fig f={p.total} fmt={pct} />
        ),
    },
    {
      key: 'loss',
      header: t.head.loss,
      numeric: true,
      cell: (p) =>
        p.assumption ? (
          <span className="text-muted-foreground">{t.neverChosen}</span>
        ) : (
          <Fig f={p.loss} fmt={usd} />
        ),
    },
  ];
  const costIn = (g: string) => s.body.costs.find((x) => x.regime === g)?.exit ?? null;
  const regimeCols: Column<string>[] = [
    {
      key: 'r',
      header: t.regime,
      rowHeader: true,
      cell: (g) => (
        <>
          {words.regimes[g as keyof typeof words.regimes] ?? g}
          {g === r && (
            <span className="block font-mono text-b-meta font-normal text-muted-foreground">
              {t.now}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'cost',
      header: t.head.cost,
      numeric: true,
      cell: (g) => {
        const e = costIn(g);
        return e ? <Fig f={e.total} fmt={pct} /> : <Reason code="no_samples_in_regime" />;
      },
    },
    {
      key: 'loss',
      header: t.head.loss,
      numeric: true,
      cell: (g) => {
        const e = costIn(g);
        return e ? <Fig f={e.lossUsd} fmt={usd} /> : <Reason code="no_samples_in_regime" />;
      },
    },
  ];
  return (
    <div data-ui="bearing-sim">
      <div className="mt-4">
        <Kpis>
          <Kpi label={t.kpi.sale} note={t.kpi.saleNote(id)}>
            <Count>{usd(n)}</Count>
          </Kpi>
          <Kpi label={t.kpi.now} note={etLabel(at, words.heat.days)}>
            <span className="font-sans text-[1.0625rem]">{words.regimes[r]}</span>
          </Kpi>
          <Kpi label={t.kpi.capacity} note={t.kpi.capacityNote}>
            <Fig f={cap} fmt={usd1} />
          </Kpi>
          <Kpi
            label={t.kpi.loss}
            note={best?.loss.value != null ? t.kpi.lossNote(pct(best.loss.value / n)) : ''}
          >
            {best ? <Fig f={best.loss} fmt={usd} /> : <Reason code="no_samples_in_regime" />}
          </Kpi>
        </Kpis>
      </div>
      <p className="mt-5 max-w-[60ch] font-display text-[clamp(1.15rem,1rem+0.5vw,1.4rem)]/[1.35]">
        {verdict}
      </p>
      <section className="mt-8">
        <h2 className="mb-2 text-b-section font-semibold">{t.flowTitle}</h2>
        <FlowChart
          id={id}
          n={n}
          r={r}
          paths={paths}
          best={best}
          splitNow={fNow}
          splitChunk={fSplit}
          chunks={chunks}
        />
      </section>
      <section className="mt-8">
        <h2 className="mb-2 text-b-section font-semibold">{t.pathsTitle}</h2>
        <DataTable
          dense
          caption={t.pathsCaption}
          captionHidden
          rows={paths}
          rowKey={(p) => p.key}
          columns={pathCols}
        />
        <p className="mt-2 max-w-[88ch] text-muted-foreground">{t.pathsNote}</p>
      </section>
      {ex && (
        <section className="mt-8">
          <h2 className="mb-2 text-b-section font-semibold">{t.paysTitle}</h2>
          <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-4 gap-y-2">
            {parts.map(([label, f]) =>
              f ? (
                <div key={label} className="border-t border-border pt-1.5">
                  <dt className="text-caption text-muted-foreground">{label}</dt>
                  <dd className="m-0 mt-0.5 font-mono text-[0.875rem]/5 font-medium">
                    <Fig f={f} fmt={pct} />
                  </dd>
                </div>
              ) : null,
            )}
            {ex.networkFeeUsd && (
              <div className="border-t border-border pt-1.5">
                <dt className="text-caption text-muted-foreground">{t.parts.networkFee}</dt>
                <dd className="m-0 mt-0.5 font-mono text-[0.875rem]/5 font-medium">
                  <Fig f={ex.networkFeeUsd} fmt={usd} />
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
      <section className="mt-8">
        <h2 className="mb-2 text-b-section font-semibold">{t.byRegimeTitle}</h2>
        <DataTable
          dense
          caption={t.byRegimeCaption}
          captionHidden
          rows={[...REGIMES]}
          rowKey={(g) => g}
          columns={regimeCols}
        />
      </section>
    </div>
  );
}

'use client';
import type { PlanNewest } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import { Card, CardBody } from '../../components/ui/Card';
import { type Column, DataTable } from '../../components/ui/DataTable';
import { StalePlate } from '../../components/ui/MockPlate';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { useLang, useT } from '../../i18n/I18nProvider';
import { displayName } from '../order/plain';
import { dollars, drift, share, shareTenths } from '../portfolio/figures';
import type { Plan, PlansChain } from './api';
import { sampleLine } from './parts';
import { leastLive, pricePin, snapshotPin } from './pins';
import { Block } from './plan-blocks';
import { holdsNothing, outside, type PlanRow, rowsOf, unweighed } from './plan-rows';
import { useWords } from './words';

// Each part of a plan against its target, at the vault's newest snapshot: the asset by its name, its
// value on the pin of the price it stood on, its share now, its planned share and the difference,
// with the cash as a row like any other (plan-rows.ts). The band the chain stated at the read is
// drawn beside each difference as a shaded range about the planned share, the part marked on it; a
// part outside it says so in words and with the Watch mark, in a cell of its own, and its row is
// tinted only beside those (data-table.md). A part with no price shows no value and no share: it says
// it has no price.
//
// The shares are written as the monitor writes them (features/portfolio/VaultPanel.tsx): rounded
// together so they add up to the whole, the difference the one between the two shares as written.
// Whether a part is outside the band is read from the snapshot's own drift, never from those.

const GAUGE_W = 96;
const GAUGE_H = 14;

/**
 * The band as a drawing: a track with the planned share at its middle, the band shaded about it, and
 * the part as a square where it is. The cash is held to the band on one side only, so its range runs
 * from the left end. For the eye: the difference beside it and the row's own words say the same.
 */
function BandGauge({
  driftBps,
  bandBps,
  extentBps,
  cash,
}: {
  driftBps: number;
  bandBps: number;
  /** What the half of the track spans, the same for every row of a table. */
  extentBps: number;
  cash: boolean;
}) {
  const mid = GAUGE_W / 2;
  const scale = (GAUGE_W / 2 - 4) / extentBps;
  const at = mid + Math.max(-extentBps, Math.min(extentBps, driftBps)) * scale;
  const edge = bandBps * scale;
  const from = cash ? 0 : mid - edge;
  return (
    <svg
      data-ui="band-gauge"
      aria-hidden="true"
      width={GAUGE_W}
      height={GAUGE_H}
      viewBox={`0 0 ${GAUGE_W} ${GAUGE_H}`}
      className="inline-block shrink-0 align-middle"
    >
      <line x1={0} x2={GAUGE_W} y1={GAUGE_H / 2} y2={GAUGE_H / 2} stroke="var(--border)" />
      <rect
        data-ui="band-range"
        x={from}
        y={2}
        width={mid + edge - from}
        height={GAUGE_H - 4}
        fill="var(--foreground)"
        fillOpacity={0.12}
      />
      {!cash && (
        <line
          x1={mid - edge}
          x2={mid - edge}
          y1={1}
          y2={GAUGE_H - 1}
          stroke="var(--muted-foreground)"
        />
      )}
      <line
        x1={mid + edge}
        x2={mid + edge}
        y1={1}
        y2={GAUGE_H - 1}
        stroke="var(--muted-foreground)"
      />
      <line x1={mid} x2={mid} y1={0} y2={GAUGE_H} stroke="var(--muted-foreground)" />
      <rect
        data-ui="band-mark"
        x={at - 3.5}
        y={GAUGE_H / 2 - 3.5}
        width={7}
        height={7}
        fill="var(--foreground)"
      />
    </svg>
  );
}

/** Words in a figure's place: the table's own face, not the figures'. */
const Said = ({ children }: { children: ReactNode }) => (
  <span className="font-sans text-muted-foreground">{children}</span>
);

export function PlanPositions({
  chain,
  plan,
  newest,
}: {
  chain: PlansChain;
  plan: Plan;
  newest: PlanNewest;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.plan.parts;
  const columns = t.portfolio.vault.columns;
  const label = leastLive(chain.provenance, plan.provenance, newest.provenance);

  const rows = rowsOf(newest);
  // A part that is held has no price: the plan cannot be weighed, and nothing is held to the band.
  const blind = unweighed(rows);
  const band = blind ? null : newest.bandBps;
  const nowTenths = shareTenths(rows.map((row) => row.weightBps));
  const plannedTenths = shareTenths(rows.map((row) => row.targetBps));
  const at = (row: PlanRow) => rows.indexOf(row);
  /** Held with no price: it has no share to write. */
  const dark = (row: PlanRow) => row.held && row.valueUsd === null;
  const extent = Math.max((band ?? 0) * 2, ...rows.map((row) => Math.abs(row.driftBps)), 1);

  const value = (row: PlanRow) => {
    if (row.cash)
      return (
        <ProvenancePin
          value={dollars(lang, row.valueUsd ?? '0')}
          obs={snapshotPin(newest, chain.provenance, plan.provenance)}
          labels={t.pin}
        />
      );
    if (row.valueUsd === null) return <Said>{row.held ? words.noPrice : words.noneHeld}</Said>;
    const price = newest.prices.find((p) => p.asset === row.asset);
    // a value whose price was not kept with the snapshot has no pin, and so is not shown
    if (!price) return <Said>{words.priceNotKept}</Said>;
    return (
      <ProvenancePin
        value={dollars(lang, row.valueUsd)}
        obs={pricePin(price, chain.provenance, plan.provenance, newest.provenance)}
        labels={t.pin}
      />
    );
  };

  const table: Column<PlanRow>[] = [
    {
      key: 'asset',
      header: columns.asset,
      rowHeader: true,
      cell: (row) => displayName(row.asset, t.plan),
    },
    { key: 'value', header: columns.value, numeric: true, cell: value },
    {
      key: 'weight',
      header: columns.weight,
      numeric: true,
      cell: (row) =>
        dark(row) ? <Said>{words.notWeighed}</Said> : share(lang, (nowTenths[at(row)] ?? 0) * 10),
    },
    {
      key: 'target',
      header: columns.target,
      numeric: true,
      cell: (row) => share(lang, (plannedTenths[at(row)] ?? 0) * 10),
    },
    {
      key: 'drift',
      header: columns.drift,
      numeric: true,
      cell: (row) =>
        dark(row) ? (
          <Said>{words.notWeighed}</Said>
        ) : (
          <span className="inline-flex items-center justify-end gap-3">
            <span data-ui="part-drift">
              {drift(lang, ((nowTenths[at(row)] ?? 0) - (plannedTenths[at(row)] ?? 0)) * 10)}
            </span>
            {band !== null && (
              <BandGauge
                driftBps={row.driftBps}
                bandBps={band}
                extentBps={extent}
                cash={row.cash}
              />
            )}
          </span>
        ),
    },
  ];

  return (
    <Block
      ui="plan-parts"
      heading={words.heading}
      lead={
        blind
          ? words.unweighed
          : band === null
            ? w.status.lines.no_band
            : words.band(share(lang, band))
      }
    >
      {holdsNothing(rows) ? (
        <p data-ui="parts-empty" className="text-body-sm text-foreground">
          {words.empty}
        </p>
      ) : (
        <Card mock={label !== 'live'} mockLabels={{ announce: sampleLine(t.shell, label) }}>
          <CardBody className="flex flex-col gap-4">
            {/* Older than an hour, as the answer says: the whole table is as old as its snapshot. */}
            {newest.stale && (
              <p data-ui="parts-stale">
                <StalePlate
                  ageSec={newest.ageSeconds}
                  labels={{ stale: t.pin.stale, ageUnknown: t.pin.ageUnknown }}
                />
              </p>
            )}
            <DataTable<PlanRow>
              caption={words.caption}
              captionHidden
              columns={table}
              rows={rows}
              rowKey={(row) => row.asset}
              statusHeader={words.status}
              rowStatus={
                band === null
                  ? undefined
                  : (row) => (outside(row, band) ? { status: 'watch', word: words.outside } : null)
              }
            />
          </CardBody>
        </Card>
      )}
    </Block>
  );
}

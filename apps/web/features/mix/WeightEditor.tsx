'use client';
import type { ChainId } from '@colosseum/schemas';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Field, Input, Select } from '../../components/ui/Field';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { displayName } from '../order/plain';
import { assetsFor } from '../order/units';
import {
  bpsOf,
  cashLeft,
  type EditorLine,
  editorIssues,
  MAX_LINES,
  textOf,
  type WeightUnit,
} from './mix';

// The weights of a mix, set by the person's own hand (gate ANY-COMPOSITION, #191): any asset of the
// chain's list added or removed (at most 16 besides cash, never the cash token), whole percents or
// basis points, and what is left shown as cash. A vault's targets and a conversation's preview both
// start here: the weights the server reviews are the ones typed in these fields.

export type EditorRow = { assetId: string; text: string };
export type Weights = { rows: EditorRow[]; unit: WeightUnit };

/** Lines as rows to type in, in percents. */
export const weightsOf = (lines: readonly EditorLine[]): Weights => ({
  rows: lines.map((line) => ({ assetId: line.assetId, text: textOf(line.weightBps, 'percent') })),
  unit: 'percent',
});

/** The rows as lines, or null while a weight does not read or the mix cannot be reviewed. */
export function linesOf({ rows, unit }: Weights, cash: string): EditorLine[] | null {
  const lines: EditorLine[] = [];
  for (const row of rows) {
    const weightBps = bpsOf(row.text, unit);
    if (weightBps === null) return null;
    lines.push({ assetId: row.assetId, weightBps });
  }
  return editorIssues(lines, cash).length ? null : lines;
}

export function WeightEditor({
  chain,
  mock,
  cash,
  value,
  onChange,
  names,
  plain = false,
}: {
  chain: ChainId;
  mock: boolean;
  cash: string;
  value: Weights;
  onChange: (next: Weights) => void;
  /** Names the server gave for assets this app's list does not hold. */
  names?: Readonly<Record<string, string>>;
  /** Percents only, with no count of the lines: the editor behind the deposit step of a new goal. */
  plain?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const e = t.mix.editor;
  const [adding, setAdding] = useState('');
  const { rows, unit } = value;
  const read = rows.map((row) => ({ assetId: row.assetId, weightBps: bpsOf(row.text, unit) }));
  // A weight that does not read is said on its own field; here it stands as one that is not whole.
  const issues = editorIssues(
    read.map((line) => ({ assetId: line.assetId, weightBps: line.weightBps ?? 0.5 })),
    cash,
  );
  const left = cashLeft(read.filter((line): line is EditorLine => line.weightBps !== null));
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      Math.abs(bps) / 10_000,
    );
  const all = assetsFor(chain, mock);
  const listed = all.filter(
    (asset) => asset.id !== cash && !rows.some((row) => row.assetId === asset.id),
  );
  const nameOf = (asset: string) =>
    all.find((a) => a.id === asset)?.symbol ?? names?.[asset] ?? displayName(asset, t.plan);
  const edit = (next: EditorRow[]) => onChange({ rows: next, unit });
  const switchUnit = (to: WeightUnit) =>
    // The weights keep their value: each row is written again in the other unit. A text that did not
    // read is emptied, never kept to mean something else ("150" percent is not 150 basis points).
    onChange({
      unit: to,
      rows: rows.map((row) => {
        const bps = bpsOf(row.text, unit);
        return { ...row, text: bps === null ? '' : textOf(bps, to) };
      }),
    });

  return (
    <div data-ui="weight-editor" className="flex min-w-0 flex-col gap-4">
      {!plain && (
        <>
          <p className="text-caption text-muted-foreground">
            {e.lines(read.filter((line) => (line.weightBps ?? 0) > 0).length)}
          </p>
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
        </>
      )}
      <ul data-ui="targets-lines" className="flex flex-col gap-3">
        {rows.map((row, i) => {
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
                      edit(rows.map((r, j) => (j === i ? { ...r, text } : r)));
                    }}
                  />
                )}
              </Field>
              <Button
                variant="secondary"
                size="dense"
                onClick={() => edit(rows.filter((_, j) => j !== i))}
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
      {listed.length > 0 && rows.length < MAX_LINES ? (
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
              edit([...rows, { assetId: adding, text: '' }]);
              setAdding('');
            }}
          >
            {e.addButton}
          </Button>
        </div>
      ) : (
        listed.length === 0 && <p className="text-body-sm text-muted-foreground">{e.addNone}</p>
      )}
      {issues.length > 0 && (
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
    </div>
  );
}

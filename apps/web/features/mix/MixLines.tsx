'use client';
import { useMemo, useState } from 'react';
import { cn } from '../../components/ui/cn';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { dollars } from '../portfolio/figures';
import { fillOf, MixJoint, useJointMotion } from '../shared/MixJoint';

// A mix, read only: the joint the conversation's preview draws (MixJoint.tsx, gate MIX-JOINT), tied to
// a row for each asset with its share the same way, and, where the server has checked an amount, what goes into each in dollars. A figure
// that is not the server's is never drawn here: an amount not checked yet is a dash.

export type MixRow = {
  assetId: string;
  name: string;
  weightBps: number;
  /** The line's dollars as the server's review has them; null while there is no review of this mix. */
  amountUsd?: number | null;
};

export function MixLines({
  rows,
  caption,
  amounts = false,
}: {
  rows: readonly MixRow[];
  caption: string;
  /** Show the dollars column: on the deposit step, where an amount is typed. */
  amounts?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const d = t.mix.deposit;
  const copy = t.shared.vault.conversation;
  const [pointed, setLit] = useState<string | null>(null);
  const lit = rows.some((row) => row.assetId === pointed) ? pointed : null;
  // The drawing moves when the mix does, never when the dollars beside it fill in.
  const mix = rows.map((row) => `${row.assetId}=${row.weightBps}`).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mix` is the rows' assets and weights
  const shares = useMemo(
    () => rows.map((row) => ({ key: row.assetId, bps: row.weightBps })),
    [mix],
  );
  const { motion, run } = useJointMotion(shares);
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      bps / 10_000,
    );
  return (
    <div data-ui="mix-lines" className="flex min-w-0 flex-col gap-3">
      <MixJoint
        pieces={rows.map((row) => ({
          key: row.assetId,
          bps: row.weightBps,
          name: row.name,
          share: share(row.weightBps),
        }))}
        words={{
          label: copy.jointLabel,
          hint: copy.jointHint,
          widenedLabel: copy.jointLabelWidened,
          widenedHint: copy.jointHintWidened,
        }}
        lit={lit}
        onLit={setLit}
        motion={motion}
        run={run}
      />
      <table className="w-full table-fixed border-collapse text-body-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-caption text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 text-start font-normal">
              {t.shared.vault.columns.asset}
            </th>
            <th scope="col" className="w-16 py-2 text-end font-normal">
              {d.share}
            </th>
            {amounts && (
              <th scope="col" className="w-28 py-2 text-end font-normal">
                {t.mix.review.amount}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.assetId}
              data-asset={row.assetId}
              data-row={row.assetId}
              data-lit={lit === row.assetId}
              // the row answers as its piece does: a mouse over it, or a finger's tap
              onPointerEnter={(e) => e.pointerType === 'mouse' && setLit(row.assetId)}
              onPointerLeave={(e) => e.pointerType === 'mouse' && setLit(null)}
              onPointerUp={(e) => {
                if (e.pointerType !== 'mouse')
                  setLit((now) => (now === row.assetId ? null : row.assetId));
              }}
              className={cn(
                'border-b border-border motion-safe:transition-colors motion-safe:duration-(--tf-dur-fade)',
                lit === row.assetId && 'bg-muted',
              )}
            >
              <th scope="row" className="py-3 pr-2 pl-1 text-start font-normal">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    data-part="swatch"
                    className={cn('size-2.5 shrink-0', fillOf(index))}
                  />
                  <AssetMark asset={row.assetId} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>
                </span>
              </th>
              <td className="py-3 text-end tabular-nums">{share(row.weightBps)}</td>
              {amounts && (
                <td data-ui="mix-line-amount" className="py-3 pr-1 text-end tabular-nums">
                  {row.amountUsd == null ? (
                    <>
                      <span aria-hidden="true" className="text-muted-foreground">
                        —
                      </span>
                      <span className="sr-only">{d.unchecked}</span>
                    </>
                  ) : (
                    dollars(lang, row.amountUsd.toFixed(2))
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

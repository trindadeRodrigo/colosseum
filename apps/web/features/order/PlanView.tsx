'use client';
import type { AssetId, ChainId, Provenance } from '@colosseum/schemas';
import { type ReactNode, useId } from 'react';
import { Card } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { ExitPlanLine } from '../../components/ui/ExitPlanLine';
import { MAX_LEGS, PlanLegs } from '../../components/ui/PlanLegs';
import type { PinSource } from '../../components/ui/provenance';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { formatBps } from './amounts';
import { displayName } from './plain';

// A plan, showing how, whatever it is a plan of (gate INVEST-TWO-PANE): the shape the Invest screen's
// pane, a plan's own page and the product pages share. It knows nothing of where the plan came from:
// `PlanPane` hands it a goal's plan (features/order/PlanPane.tsx), a product page a shared portfolio.
// The answer first, in one line; what the caller puts under it (the ways to close a gap, or who
// published a portfolio); one row per holding with its share, its dollars where an amount is set, its
// yield with a pin where it has one, and one sentence of why; the exit plan as its own block; then the
// caller's figures, its details and its invest step. Anything not live is hatched and says so once.

export type PlanViewHolding = {
  /** Where two rows may name the same asset; left out, the asset is the key. */
  key?: string;
  asset: AssetId;
  shareBps: number;
  /** Null where no amount is set yet (a product page before the person types one). */
  amountUsd: number | null;
  /** Null where the holding has no yield to show: the row shows a dash, never 0%. */
  yield: { lowPct: number; highPct: number; obs: PinSource | null } | null;
  /** One sentence: the reason that decided this holding. */
  why: string;
  /** Every reason, the deciding one first: the table shows them all. */
  reasons?: readonly string[];
};

export type PlanViewExit = {
  /** The tiers of the way out, each a sentence, with its cost and the cost's pin where measured. */
  tiers: { text: string; cost?: { figure: string; obs: PinSource | null } }[];
  /** Said once where a cost is not measured: "Not measured yet, so no cost is shown." Never a zero. */
  caveat?: string;
};

export type PlanViewProps = {
  title: string;
  /** Under the title, muted: "Low risk · on Solana · nothing bought yet". */
  sub?: string;
  /** The heading level of the title: 2 on a page, 3 inside another section. */
  level?: 2 | 3;
  /** The answer in one line. A figure in it carries its own pin. */
  answer: ReactNode;
  chain: ChainId;
  /** How the figures are run: anything but `live` hatches the card and says so in one quiet line. */
  provenance: Provenance;
  /** An income plan may hold no stock: the legs refuse one. */
  profile?: 'income';
  holdings: readonly PlanViewHolding[];
  exit: PlanViewExit;
  /** Under the answer: the ways to close a gap, or the version and who published. */
  aside?: ReactNode;
  /** After the exit plan: the caller's own figures (the stat cells, the chart). */
  figures?: ReactNode;
  /** Under the card: what is behind a fold. */
  details?: ReactNode;
  /** The invest step, or the one button that leads to it. */
  invest?: ReactNode;
};

const percent = (value: number, lang: Lang) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);

export function PlanView({
  title,
  sub,
  level = 2,
  answer,
  provenance,
  profile,
  holdings,
  exit,
  aside,
  figures,
  details,
  invest,
}: PlanViewProps) {
  const t = useT();
  const lang = useLang();
  const paneId = useId();
  const Title = `h${level}` as 'h2' | 'h3';
  const share = (bps: number) => formatBps(bps, LOCALE[lang]);
  const name = (assetId: string) => displayName(assetId, t.plan);
  const range = (y: NonNullable<PlanViewHolding['yield']>) =>
    y.lowPct === y.highPct
      ? percent(y.lowPct, lang)
      : t.plan.projectedValue(percent(y.lowPct, lang), percent(y.highPct, lang));
  const size = (h: PlanViewHolding) =>
    h.amountUsd === null
      ? share(h.shareBps)
      : `${share(h.shareBps)} · ${dollars(h.amountUsd, lang)}`;
  const priced = holdings.some((h) => h.amountUsd !== null);
  return (
    <div data-ui="plan-pane" className="flex flex-col gap-6">
      <Card
        as="section"
        aria-labelledby={paneId}
        mock={provenance !== 'live'}
        mockLabels={{
          announce: provenance === 'sandbox' ? t.shell.testNetworkLine : t.shell.mockAnnounce,
        }}
      >
        {/* The head, then the rest; a sample card says so once at its foot. */}
        <div className="px-6 pt-6">
          <Title id={paneId} className="text-[1.125rem]/7 font-medium">
            {title}
          </Title>
          {sub && <p className="mt-1 text-body-sm text-muted-foreground">{sub}</p>}
        </div>
        <div className="clear-both flex flex-col gap-5 px-6 pt-5 pb-6">
          {/* The answer first, in one line. */}
          <div data-ui="plan-verdict" className="flex max-w-(--tf-measure-body) flex-col gap-3">
            <p data-ui="plan-answer" className="text-body-lg">
              {answer}
            </p>
            {aside}
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-[0.8125rem]/5 font-medium">{t.plan.holds}</h3>
            {holdings.length > MAX_LEGS ? (
              <DataTable<PlanViewHolding>
                caption={t.plan.holds}
                captionHidden
                rows={holdings}
                rowKey={(h) => h.key ?? h.asset}
                columns={[
                  {
                    key: 'asset',
                    header: t.plan.columns.asset,
                    rowHeader: true,
                    cell: (h) => name(h.asset),
                  },
                  {
                    key: 'share',
                    header: t.plan.columns.share,
                    numeric: true,
                    cell: (h) => share(h.shareBps),
                  },
                  ...(priced
                    ? [
                        {
                          key: 'amount',
                          header: t.plan.columns.amount,
                          numeric: true,
                          cell: (h: PlanViewHolding) =>
                            h.amountUsd === null ? '—' : dollars(h.amountUsd, lang),
                        },
                      ]
                    : []),
                  {
                    key: 'why',
                    header: t.plan.columns.why,
                    cell: (h) => (h.reasons ?? [h.why]).join(' ') || t.plan.noReason,
                  },
                ]}
              />
            ) : (
              <PlanLegs
                profile={profile}
                legs={holdings.map((h) => ({
                  id: h.key ?? h.asset,
                  name: name(h.asset),
                  weight: h.shareBps / 10_000,
                  weightLabel: size(h),
                  rate: h.yield ? { afterHaircut: range(h.yield), obs: h.yield.obs } : null,
                  why: h.why || undefined,
                  // The card carries the hatch for the whole plan, as the showcase case does.
                  mock: false,
                }))}
                labels={{ afterHaircut: t.plan.legs.afterHaircut, quoted: t.plan.legs.quoted }}
                pinLabels={t.pin}
              />
            )}
          </div>
          <ExitPlanLine
            tiers={exit.tiers}
            caveat={exit.caveat}
            inKind={t.plan.inKind}
            labels={{ exitPlan: t.plan.exitPlan, costPrefix: t.plan.costPrefix }}
            pinLabels={t.pin}
          />
          {figures}
        </div>
      </Card>
      {details}
      {invest}
    </div>
  );
}

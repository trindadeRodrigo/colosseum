'use client';
import type { MixReview } from '@colosseum/schemas';
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { AssetMark } from '../order/PlanView';
import { dollars } from '../portfolio/figures';
import { unticked } from './mix';

// The server's reading of a mix before it is bought or applied (gate ANY-COMPOSITION, #191): every
// line with its amount, the sourced price it was counted at and the most it may hold and still exit as
// planned, each figure with its pin; then each warning, which the person ticks one by one. Nothing here
// is a figure of the model's or of this app's: the review is the server's, and the confirm sends back
// its hash with the ticks.

const NONE: ReadonlySet<string> = new Set();

/**
 * The warnings the person ticked, held to the one review they were ticked on. A tick is given to a
 * warning with its figures, which only the review's hash names: a review with another hash (a figure
 * that moved, a weight that changed) starts with none, even where a warning keeps its id.
 */
export function useTicks(
  review: MixReview | null,
): [ReadonlySet<string>, (id: string, on: boolean) => void] {
  const [held, setHeld] = useState<{ hash: string; ids: ReadonlySet<string> } | null>(null);
  const hash = review?.reviewHash ?? null;
  const ticked = held && held.hash === hash ? held.ids : NONE;
  const tick = (id: string, on: boolean) => {
    if (!hash) return;
    setHeld((old) => {
      const next = new Set(old && old.hash === hash ? old.ids : NONE);
      if (on) next.add(id);
      else next.delete(id);
      return { hash, ids: next };
    });
  };
  return [ticked, tick];
}

export function MixReviewCard({
  review,
  ticked,
  onTick,
  confirmLabel,
  onConfirm,
  onBack,
  backLabel,
  purpose,
  focusOnOpen = false,
  busy,
  changed,
}: {
  review: MixReview;
  ticked: ReadonlySet<string>;
  onTick: (id: string, on: boolean) => void;
  confirmLabel: string;
  onConfirm: () => void;
  onBack: () => void;
  /** Where "back" leads, when it is not to changing the mix: the deposit step of a new goal. */
  backLabel?: string;
  /** What the mix was checked for, in words: "For growth, at higher risk." A new goal's review. */
  purpose?: string;
  /** The review took the place of another screen: its heading takes focus, so it is read from the top. */
  focusOnOpen?: boolean;
  busy: boolean;
  /** The server answered a new review to a confirm: its figures moved since the person looked. */
  changed?: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const r = t.mix.review;
  const titleId = useId();
  const share = (bps: number) =>
    new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 2 }).format(
      bps / 10_000,
    );
  const usd = (value: number) => dollars(lang, value.toFixed(2));
  const left = unticked(review, ticked).length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the review opens
  useEffect(() => {
    if (!focusOnOpen) return;
    const heading = document.getElementById(titleId);
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }, []);
  return (
    <Card
      as="section"
      aria-labelledby={titleId}
      mock={review.provenance !== 'live'}
      mockLabels={{
        announce: review.provenance === 'mock' ? t.shell.mockAnnounce : t.shell.testNetworkLine,
      }}
    >
      <CardHeader id={titleId} title={r.title} level={2} meta={t.chain.names[review.chain]} />
      <CardBody className="flex min-w-0 flex-col gap-4">
        <p className="max-w-(--tf-measure-body) text-body-sm">{r.lead}</p>
        {purpose && (
          <p data-ui="mix-review-purpose" className="text-body-sm">
            {purpose}
          </p>
        )}
        {changed && (
          <p role="status" className="flex items-start gap-1.5 text-body-sm">
            <StatusMark status="watch" className="mt-1.5" />
            <span>{r.changed}</span>
          </p>
        )}
        <table
          data-ui="mix-review-lines"
          className="w-full table-fixed border-collapse text-body-sm"
        >
          <caption className="sr-only">{r.title}</caption>
          <thead className="text-caption text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="py-2 text-start font-normal">
                {r.asset}
              </th>
              <th scope="col" className="w-16 py-2 text-end font-normal">
                {r.weight}
              </th>
              <th scope="col" className="w-24 py-2 text-end font-normal">
                {r.amount}
              </th>
            </tr>
          </thead>
          <tbody>
            {review.lines.map((line) => (
              <tr key={line.assetId} className="border-b border-border align-top">
                <th scope="row" className="py-3 pr-2 text-start font-normal">
                  <span className="flex min-w-0 items-center gap-2">
                    <AssetMark asset={line.assetId} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {line.cls === 'cash' ? r.cash : line.symbol}
                    </span>
                  </span>
                  <span className="mt-2 flex flex-col gap-1 text-caption text-muted-foreground">
                    <span>
                      {r.price}:{' '}
                      {line.price ? (
                        <ProvenancePin
                          value={dollars(lang, line.price.usdPerToken)}
                          obs={line.price}
                          labels={t.pin}
                        />
                      ) : (
                        r.cashPrice
                      )}
                    </span>
                    {line.exitCeiling && (
                      <span data-ui="exit-ceiling">
                        {r.exit}:{' '}
                        <ProvenancePin
                          value={usd(line.exitCeiling.usd)}
                          obs={line.exitCeiling}
                          labels={t.pin}
                        />{' '}
                        ({line.exitCeiling.measured ? r.measured : r.tier})
                      </span>
                    )}
                  </span>
                </th>
                <td className="py-3 text-end tabular-nums">{share(line.weightBps)}</td>
                <td className="py-3 text-end tabular-nums">{usd(line.amountUsd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr data-ui="mix-review-total">
              <th scope="row" colSpan={2} className="py-3 text-start font-medium">
                {r.total}
              </th>
              <td className="py-3 text-end font-medium tabular-nums">{usd(review.amountUsd)}</td>
            </tr>
          </tfoot>
        </table>
        {review.warnings.length > 0 && (
          <fieldset data-ui="mix-review-warnings" className="flex min-w-0 flex-col gap-3">
            <legend className="text-caption font-medium">{r.warnings}</legend>
            {review.warnings.map((warning) => (
              <label
                key={warning.id}
                data-warning={warning.code}
                className="flex max-w-(--tf-measure-body) items-start gap-2 text-body-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={ticked.has(warning.id)}
                  onChange={(e) => onTick(warning.id, e.currentTarget.checked)}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {warning.text}
                  {warning.figures.map((figure) => (
                    <span
                      key={`${figure.label}:${figure.fetchedAt}`}
                      className="block text-caption text-muted-foreground"
                    >
                      {figure.label}:{' '}
                      <ProvenancePin
                        value={figure.unit === 'USD' ? usd(figure.value) : share(figure.value)}
                        obs={figure}
                        labels={t.pin}
                      />
                    </span>
                  ))}
                </span>
              </label>
            ))}
            <p aria-live="polite" className="text-caption text-muted-foreground">
              {left === 0 ? r.allTicked : r.left(left)}
            </p>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            data-action="mix-confirm"
            disabled={busy || left > 0}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onBack}>
            {backLabel ?? r.back}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

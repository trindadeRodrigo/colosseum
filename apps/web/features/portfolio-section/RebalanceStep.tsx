'use client';
import type { RebalanceEntry } from '@colosseum/schemas';
import { Fragment, type ReactNode } from 'react';
import { ExplorerLink } from '../../components/ui/ExplorerLink';
import { Hint } from '../../components/ui/Hint';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { Status } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatRaw, tokenName } from '../order/amounts';
import { displayName } from '../order/plain';
import { unitsFor } from '../order/units';
import { share, shareExact, utc } from '../portfolio/figures';
import type { RebalancesChain } from './api';
import { basisPoints, localTime } from './list-figures';
import { entryPin, leastLive } from './pins';
import { explorerHref } from './rebalances';
import { useWords } from './words';

// One step of the rebalancing list, as a block that stacks (data-table.md: a row of this many parts
// is a block on a phone, so it is one everywhere): when, and what kind of time that is; whose step it
// was and how it ended, each a word with a shape; why; each trade in plain words with its amounts, its
// quoted cost and the traded asset against its planned share before and after; and the transaction on
// the chain's explorer. It says what the answer carries and no more: a cost is the quote the step was
// built with, never what the trade paid, and a keeper's trade says it was worked out from two
// readings. Every amount and every cost carries the entry's own stamp as its pin.

/**
 * Whose step it is, as a shape that needs no colour: an upright bar for the person's own, two flat
 * bars for the keeper's. Square, orthogonal, in the colour of the text; the word beside it says it.
 */
function ByMark({ by }: { by: RebalanceEntry['by'] }) {
  return (
    <svg
      data-ui="by-mark"
      data-by={by}
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={by === 'owner' ? 'M4 1H8V11H4Z' : 'M1 2H11V5H1ZM1 7H11V10H1Z'} fill="currentColor" />
    </svg>
  );
}

/** An instant written in the reader's own time, with the same instant in UTC within reach. */
function Instant({
  at,
  className,
  children,
}: {
  at: string;
  className?: string;
  children: string;
}) {
  const lang = useLang();
  return (
    <time dateTime={at} className={className}>
      <Hint tip={utc(lang, at)}>{children}</Hint>
    </time>
  );
}

type Row = { id: string; term: string; value: ReactNode };

export function RebalanceStep({
  chain,
  entry,
}: {
  chain: Pick<RebalancesChain, 'provenance'>;
  entry: RebalanceEntry;
}) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const words = w.rebalancing;
  // The label of what the step shows: its chain's, or its own where that is less live.
  const label = leastLive(chain.provenance, entry.provenance);
  const pin = entryPin(entry, chain.provenance);
  // What a raw amount means is this app's own word (features/order/units.ts), never the answer's.
  const units = unitsFor(entry.chain, label === 'mock')?.tokens;
  const failed = entry.outcome === 'failed';
  const adopts = entry.kind === 'accept_version' || entry.kind === 'adopt_version';
  const quoted = entry.trades.some((trade) => trade.expected !== undefined);
  const name = (asset: string) => displayName(asset, t.plan);

  /** A raw amount in the token's own units, or null where this app has none for the token. */
  const amountOf = (asset: string, raw: string | undefined): string | null => {
    const unit = units?.[asset];
    if (raw === undefined || unit === undefined) return null;
    const figure = formatRaw(raw, unit.decimals, LOCALE[lang]);
    return figure === null ? null : words.trade.tokens(figure, unit.symbol);
  };
  /** How far a part sat from its planned share, in words. */
  const far = (bps: number): string => {
    if (bps === 0) return words.trade.at;
    const size = Math.abs(bps);
    // one decimal, as every share is written, and a second where one would read as nothing
    const by = share(lang, size) === share(lang, 0) ? shareExact(lang, size) : share(lang, size);
    return bps > 0 ? words.trade.over(by) : words.trade.under(by);
  };

  return (
    <li
      data-ui="step"
      data-by={entry.by}
      data-outcome={entry.outcome}
      data-derived={entry.derived || undefined}
      className="flex flex-col gap-3 p-6"
    >
      <p data-ui="step-when" className="text-body-sm">
        <Instant at={entry.at} className="font-medium tabular-nums">
          {localTime(lang, entry.at)}
        </Instant>
        <span className="text-muted-foreground">
          {' · '}
          {/* a keeper's trade is dated by the chain; a step of the person's own by when it was built */}
          {entry.derived ? words.when.chain : words.when.built}
        </span>
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span
          data-ui="step-by"
          data-by={entry.by}
          className="inline-flex items-center gap-2 text-caption font-medium"
        >
          <ByMark by={entry.by} />
          <span>{words.by[entry.by]}</span>
        </span>
        <span data-ui="step-outcome" data-outcome={entry.outcome}>
          <Status status={failed ? 'off-track' : 'on-track'}>{words.outcome[entry.outcome]}</Status>
        </span>
      </p>
      <p data-ui="step-why" className="max-w-(--tf-measure-body) text-body-sm">
        {entry.why === null ? words.why.none : words.why[entry.why]}
        {adopts && ` ${words.why.version}`}
      </p>

      {entry.trades.length === 0 ? (
        <p data-ui="step-no-trade" className="text-body-sm">
          {words.noTrade}
        </p>
      ) : (
        <ul data-ui="step-trades" className="flex list-none flex-col gap-4 p-0">
          {entry.trades.map((trade) => {
            // One side is the chain's cash; `asset` is the other. Bought with cash, or sold for it.
            const buys = trade.asset === trade.buy;
            const sentence = buys
              ? (failed ? words.trade.triedBuy : words.trade.bought)(
                  name(trade.asset),
                  tokenName(trade.sell),
                )
              : trade.asset === trade.sell
                ? (failed ? words.trade.triedSell : words.trade.sold)(
                    name(trade.asset),
                    tokenName(trade.buy),
                  )
                : (failed ? words.trade.triedSwap : words.trade.swapped)(
                    name(trade.sell),
                    name(trade.buy),
                  );
            const put = amountOf(trade.sell, trade.amountInRaw);
            const before = amountOf(trade.asset, trade.rawBefore);
            const after = amountOf(trade.asset, trade.rawAfter);
            const rows: Row[] = [];
            const figure = (id: string, term: string, value: string | null) => {
              if (value !== null)
                rows.push({
                  id,
                  term,
                  value: <ProvenancePin value={value} obs={pin} labels={t.pin} />,
                });
            };
            figure(
              'put',
              failed ? words.trade.amount : buys ? words.trade.paid : words.trade.soldAmount,
              put,
            );
            figure('held-before', words.trade.heldBefore, before);
            figure('held-after', words.trade.heldAfter, after);
            if (trade.expected)
              rows.push({
                id: 'quoted',
                term: words.trade.quoted,
                value: (
                  <>
                    <ProvenancePin
                      value={words.trade.bps(basisPoints(lang, trade.expected.costBps))}
                      obs={pin}
                      labels={t.pin}
                    />
                    {trade.expected.costBps === 0 && (
                      <span
                        data-ui="quote-zero"
                        className="block font-sans text-caption text-muted-foreground"
                      >
                        {words.trade.quoteZero}
                      </span>
                    )}
                  </>
                ),
              });
            for (const side of ['before', 'after'] as const) {
              const reading = trade[side];
              if (reading)
                rows.push({
                  id: `share-${side}`,
                  term: words.trade[side],
                  value: (
                    <>
                      <span>{far(reading.driftBps)}</span>
                      <span className="text-muted-foreground">
                        {' · '}
                        <Instant at={reading.observedAt}>
                          {words.trade.read(localTime(lang, reading.observedAt))}
                        </Instant>
                      </span>
                    </>
                  ),
                });
            }
            // A keeper's trade whose token this app has no units for: said, never a raw count.
            const unread =
              (trade.rawBefore !== undefined || trade.rawAfter !== undefined) &&
              before === null &&
              after === null;
            return (
              <li
                key={`${trade.sell}>${trade.buy}:${trade.amountInRaw ?? trade.rawAfter ?? ''}`}
                data-ui="trade"
                data-asset={trade.asset}
                className="flex flex-col gap-1.5"
              >
                <p data-ui="trade-sentence" className="text-body">
                  {sentence}
                </p>
                {rows.length > 0 && (
                  <dl className="grid gap-x-6 gap-y-1 text-body-sm min-[480px]:grid-cols-[auto_1fr]">
                    {rows.map((row) => (
                      <Fragment key={row.id}>
                        <dt className="text-muted-foreground">{row.term}</dt>
                        <dd data-row={row.id} className="tabular-nums">
                          {row.value}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                )}
                {unread && (
                  <p data-ui="trade-no-units" className="text-caption text-muted-foreground">
                    {words.trade.noUnits(tokenName(trade.asset))}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {quoted && (
        <p
          data-ui="step-quote-note"
          className="max-w-(--tf-measure-body) text-caption text-muted-foreground"
        >
          {words.quoteNote}
        </p>
      )}
      {entry.derived && (
        <p
          data-ui="step-derived"
          className="max-w-(--tf-measure-body) text-caption text-muted-foreground"
        >
          {words.derived}
        </p>
      )}
      {entry.txId !== null ? (
        <p data-ui="step-tx">
          <ExplorerLink
            signature={entry.txId}
            href={explorerHref(entry, label)}
            explorer={t.chain.explorers[entry.chain]}
            labels={{
              ...t.order.link,
              // the sample chain's transactions are on no network: said, in place of a link
              ...(label === 'mock' ? { unavailable: words.noExplorer } : {}),
            }}
          />
        </p>
      ) : (
        !entry.derived && (
          <p data-ui="step-no-tx" className="text-caption text-muted-foreground">
            {words.noTx}
          </p>
        )
      )}
    </li>
  );
}

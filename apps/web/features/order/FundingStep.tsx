'use client';
import type { FundingFigure } from '@colosseum/schemas';
import { Wait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { DataTable } from '../../components/ui/DataTable';
import { utcMinute } from '../../components/ui/ExecutionList';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { formatRaw } from './amounts';
import type { FundingOutcome, TestFundsOutcome } from './order-api';
import type { TokenUnits, unitsFor } from './units';

// The funds step of a buy: what the wallet needs on the plan's chain in one line, the way to fill it
// (test funds from our server on a test network, sample cash on the mock, or the address to send to),
// and the table of each balance with where it was read, behind a disclosure. The card it sits in
// says once, in a quiet line, that every figure here is a sample or the test network's.

export type Funding = { kind: 'idle' } | { kind: 'reading' } | FundingOutcome;

type FundingRow = {
  key: 'cash' | 'gas';
  name: string;
  figure: FundingFigure;
  /** What a raw amount of it means, from what this repository committed; null shows the raw amount. */
  units: TokenUnits | null;
};

export type TestFundsState = { busy: boolean; outcome: TestFundsOutcome | null; onAsk: () => void };

export function FundingStep({
  funding,
  chainName,
  owner,
  mock,
  units,
  gasUnits,
  mockBusy,
  onReadAgain,
  onMock,
  testFunds,
}: {
  funding: Funding;
  chainName: string;
  owner: string | null;
  mock: boolean;
  /** The chain's token units from its committed deployment: the API's decimals are never read. */
  units: ReturnType<typeof unitsFor>;
  gasUnits: TokenUnits | null;
  mockBusy: boolean;
  onReadAgain: () => void;
  onMock: () => void;
  testFunds: TestFundsState;
}) {
  const t = useT();
  const lang = useLang();
  const locale = LOCALE[lang];
  const read = funding.kind === 'read' ? funding.funding : null;
  // An amount in whole units with the committed decimals; with none committed, the raw amount alone.
  const words = (raw: string, u: TokenUnits | null) => {
    const figure = u ? formatRaw(raw, u.decimals, locale) : null;
    return u && figure !== null ? `${figure} ${u.symbol}` : raw;
  };
  const amount = (raw: string, u: TokenUnits | null) => (
    <span className="whitespace-nowrap">{words(raw, u)}</span>
  );
  const cashUnits = read && units ? (units.tokens[read.cash.asset] ?? null) : null;
  const rows: FundingRow[] = read
    ? [
        {
          key: 'cash',
          name: t.buy.funding.cash(cashUnits?.symbol ?? read.cash.symbol),
          figure: read.cash,
          units: cashUnits,
        },
        {
          key: 'gas',
          name: t.buy.funding.gas(gasUnits?.symbol ?? read.gas.symbol),
          figure: read.gas,
          units: gasUnits,
        },
      ]
    : [];
  const sentence =
    funding.kind === 'read' || funding.kind === 'idle' || funding.kind === 'reading'
      ? null
      : funding.kind === 'busy'
        ? t.shell.slowDown
        : funding.kind === 'unreachable'
          ? t.buy.funding.failure.unreachable
          : funding.kind === 'unreadable'
            ? t.buy.funding.failure.unreadable
            : funding.kind === 'no-plan'
              ? t.buy.funding.failure.noPlan
              : funding.kind === 'signed-out'
                ? t.buy.failure.signedOut
                : funding.kind === 'no-chain'
                  ? t.buy.failure.noChain
                  : t.buy.funding.failure.refused;

  // The need in one line, then what the wallet holds of it.
  const [cashRow, gasRow] = rows;
  const need =
    cashRow && gasRow
      ? t.buy.funding.needs(
          words(cashRow.figure.needRaw, cashRow.units),
          words(gasRow.figure.needRaw, gasRow.units),
        )
      : null;
  const short = rows.filter((r) => r.figure.missingRaw !== '0');
  const held =
    !read || !cashRow || !gasRow
      ? null
      : read.ok
        ? t.buy.funding.ok
        : cashRow.figure.haveRaw === '0' && gasRow.figure.haveRaw === '0'
          ? t.buy.funding.haveNone
          : t.buy.funding.lacking(
              short
                .map((r) => words(r.figure.missingRaw, r.units))
                .reduce((a, b) => t.buy.funding.and(a, b)),
            );
  // Test funds are offered where the server says it can send them, on a test network only.
  const offered =
    read !== null && !read.ok && read.provenance === 'sandbox' && read.testFunds === true;
  const outcome = testFunds.outcome;
  const sent =
    outcome?.kind === 'sent'
      ? t.buy.funding.testSent(
          t.buy.funding.and(
            words(
              outcome.sent.cash.raw,
              cashUnits ?? {
                symbol: outcome.sent.cash.symbol,
                decimals: outcome.sent.cash.decimals,
              },
            ),
            words(
              outcome.sent.gas.raw,
              gasUnits ?? { symbol: outcome.sent.gas.symbol, decimals: outcome.sent.gas.decimals },
            ),
          ),
        )
      : null;
  const failed =
    !outcome || outcome.kind === 'sent'
      ? null
      : outcome.kind === 'busy'
        ? t.buy.funding.testFailure.busy
        : outcome.kind === 'too-much'
          ? t.buy.funding.testFailure.tooMuch
          : outcome.kind === 'enough'
            ? t.buy.funding.testFailure.enough
            : outcome.kind === 'refused'
              ? t.buy.funding.testFailure.refused
              : t.buy.funding.testFailure.unreachable;

  return (
    <div data-ui="funding-step" className="flex flex-col gap-4">
      <div aria-live="polite" className="flex flex-col gap-3">
        {funding.kind === 'reading' || funding.kind === 'idle' ? (
          <Wait label={t.buy.funding.reading} skeleton={<SkeletonRows rows={2} columns={4} />} />
        ) : null}
        {read && (
          <p data-ui="funding-line" className="max-w-(--tf-measure-body) text-body">
            {need} {held}
          </p>
        )}
        {read?.newVault && (
          <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
            {t.buy.funding.newVault}
          </p>
        )}
        {sentence && <p className="max-w-(--tf-measure-body) text-body-sm">{sentence}</p>}
        {sent && (
          <p data-ui="test-funds-sent" className="max-w-(--tf-measure-body) text-body-sm">
            {sent}
          </p>
        )}
        {failed && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{failed}</span>
          </p>
        )}
      </div>
      {read && !read.ok && offered && (
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {t.buy.funding.testNote}
        </p>
      )}
      {read && !read.ok && !offered && !mock && (
        // No test funds from this server: the person adds what is missing themselves.
        <div className="flex flex-col gap-1">
          <p className="max-w-(--tf-measure-body) text-body-sm">{t.buy.funding.short(chainName)}</p>
          {owner && (
            <p className="break-all font-mono text-source">{t.buy.funding.address(owner)}</p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {offered && (
          <Button
            variant="secondary"
            busy={testFunds.busy}
            busyLabel={t.buy.funding.testFunding}
            onClick={testFunds.onAsk}
          >
            {t.buy.funding.testFunds}
          </Button>
        )}
        {mock && read && !read.ok && (
          <Button
            variant="secondary"
            busy={mockBusy}
            busyLabel={t.buy.funding.mockFunding}
            onClick={onMock}
          >
            {t.buy.funding.mockFund}
          </Button>
        )}
        <Button variant="secondary" onClick={onReadAgain}>
          {t.buy.funding.readAgain}
        </Button>
      </div>
      {read && (
        <details data-ui="funding-details" className="group/details">
          <summary className="w-fit cursor-pointer text-body-sm font-medium text-primary underline decoration-1 underline-offset-4 hover:decoration-2">
            {t.buy.funding.details}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <DataTable<FundingRow>
              caption={t.buy.funding.title}
              captionHidden
              rows={rows}
              rowKey={(r) => r.key}
              columns={[
                { key: 'name', header: t.plan.risk.name, rowHeader: true, cell: (r) => r.name },
                {
                  key: 'have',
                  header: t.buy.funding.have,
                  numeric: true,
                  cell: (r) => amount(r.figure.haveRaw, r.units),
                },
                {
                  key: 'need',
                  header: t.buy.funding.need,
                  numeric: true,
                  cell: (r) => amount(r.figure.needRaw, r.units),
                },
                {
                  key: 'missing',
                  header: t.buy.funding.missing,
                  numeric: true,
                  cell: (r) => amount(r.figure.missingRaw, r.units),
                },
              ]}
            />
            {owner && (read.ok || offered || mock) && (
              <p className="break-all font-mono text-source">{t.buy.funding.address(owner)}</p>
            )}
            {/* Where each balance comes from (card.md: source lines in mono). */}
            <ul className="flex flex-col gap-1 font-mono text-source text-muted-foreground [overflow-wrap:anywhere]">
              {rows.map((r) => (
                <li key={r.key}>
                  {[
                    r.figure.symbol,
                    r.figure.source,
                    utcMinute(r.figure.fetchedAt),
                    r.figure.method,
                  ].join(' · ')}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

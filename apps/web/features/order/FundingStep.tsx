'use client';
import type { FundingFigure } from '@colosseum/schemas';
import { Wait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { DataTable } from '../../components/ui/DataTable';
import { shorten } from '../../components/ui/format';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { utc } from '../portfolio/figures';
import { formatRaw } from './amounts';
import type { FundingOutcome, TestFundsOutcome } from './order-api';
import type { TokenUnits, unitsFor } from './units';
import { FundsWait } from './waits';

// The funds step of a buy: that the balance is short and which token to add, in plain words and no
// figure (Thom, Oct 12), the wallet's address on the plan's chain with its copy beside it, the way to
// fill it (test funds from our server on a test network, sample cash on the mock), and the table of
// each balance with where it was read, behind a disclosure. The card it sits in
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
  capped,
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
  /**
   * The shortfall is more than one send of test funds gives: what a send gives is said in place of
   * the plain note, and the button says what it will send.
   */
  capped?: { note: string; label: string };
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

  // A short wallet: which token to add, the deposit's first and the fee's after, each named by its
  // symbol from the read and never by an amount. On the sample chain nothing can be sent, so nothing
  // is asked for and no address is shown: the heading and the sample-cash button alone.
  const add = (mock ? [] : rows)
    .filter((r) => r.figure.missingRaw !== '0')
    .map((r) => {
      const symbol = r.units?.symbol ?? r.figure.symbol;
      return {
        key: r.key,
        line: r.key === 'cash' ? t.buy.funding.addToken(symbol) : t.buy.funding.addGas(symbol),
      };
    });
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
          : outcome.kind === 'low'
            ? outcome.of === 'gas'
              ? t.buy.funding.testFailure.lowGas
              : t.buy.funding.testFailure.lowCash
            : outcome.kind === 'enough'
              ? t.buy.funding.testFailure.enough
              : outcome.kind === 'refused'
                ? t.buy.funding.testFailure.refused
                : t.buy.funding.testFailure.unreachable;

  return (
    <div data-ui="funding-step" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
        <div aria-live="polite" className="flex flex-col gap-3">
          {funding.kind === 'reading' || funding.kind === 'idle' ? (
            <Wait label={t.buy.funding.reading} skeleton={<FundsWait />} />
          ) : null}
          {read?.ok && (
            <p data-ui="funding-line" className="max-w-(--tf-measure-body) text-body">
              {t.buy.funding.ok}
            </p>
          )}
          {read && !read.ok && (
            <div data-ui="funding-line" className="flex max-w-(--tf-measure-body) flex-col gap-1">
              <p className="text-body font-medium">{t.buy.funding.insufficient}</p>
              {add.map((a) => (
                <p key={a.key} className="text-body">
                  {a.line}
                </p>
              ))}
            </div>
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
        {read && !read.ok && !mock && owner && (
          // Where to send it, outside the live region so a new read does not say it again: the short
          // address with the account menu's copy beside it; the whole one is what is copied, what a
          // screen reader hears and what the pointer shows.
          <p className="flex min-h-10 items-center gap-x-1">
            <span data-ui="funding-address" title={owner} className="font-mono text-source">
              <span aria-hidden="true">{shorten(owner)}</span>
              <span className="sr-only">
                {chainName}: {owner}
              </span>
            </span>
            <CopyButton
              value={owner}
              title={`${t.shell.copyAddress}: ${owner}`}
              labels={{ copy: t.shell.copyAddress, copied: t.shell.copied }}
            />
          </p>
        )}
      </div>
      {read && !read.ok && offered && (
        <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
          {capped ? (
            <span data-ui="test-funds-cap">
              {capped.note} {t.buy.funding.testNote}
            </span>
          ) : (
            t.buy.funding.testNote
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {offered && (
          <Button
            variant="secondary"
            busy={testFunds.busy}
            busyLabel={t.buy.funding.testFunding}
            onClick={testFunds.onAsk}
          >
            {capped ? capped.label : t.buy.funding.testFunds}
          </Button>
        )}
        {/* One way to fill the wallet at a time: test funds where the server sends them. */}
        {mock && !offered && read && !read.ok && (
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
          <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
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
            {owner && read.ok && (
              <p className="break-all font-mono text-source">{t.buy.funding.address(owner)}</p>
            )}
            {/* Where each balance comes from (card.md: source lines in mono). */}
            <ul className="flex flex-col gap-1 font-mono text-source text-muted-foreground [overflow-wrap:anywhere]">
              {rows.map((r) => (
                <li key={r.key}>
                  {[
                    r.units?.symbol ?? r.figure.symbol,
                    r.figure.source,
                    utc(lang, r.figure.fetchedAt),
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

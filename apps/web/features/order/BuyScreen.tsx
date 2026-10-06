'use client';
import { chainFamily, type FundingFigure, TRUST_STATUS } from '@colosseum/schemas';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { CardWait } from '../../components/shell/Wait';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { DataTable } from '../../components/ui/DataTable';
import { utcMinute } from '../../components/ui/ExecutionList';
import { Field, Input } from '../../components/ui/Field';
import { SkeletonRows } from '../../components/ui/Skeleton';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars, parseNumber } from '../goal/sheet';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { formatRaw } from './amounts';
import {
  type FundingOutcome,
  fundMock,
  type OrderOutcome,
  placeOrder,
  readFunding,
} from './order-api';
import { acceptTrust, keepOrder, trustAccepted } from './order-record';
import { PlanGate } from './PlanGate';
import { gasUnitsFor } from './readiness';
import { TrustNotice } from './TrustNotice';
import { type TokenUnits, unitsFor } from './units';
import { usePlan } from './use-plan';

// Buying a plan: the amount, what the wallet is missing for it on the plan's chain (GET /v1/funding,
// cash and network fees), the trust notice accepted once before the first deposit, and one primary
// button that names the action and the amount. It makes the order (POST /v1/orders) and leads to the
// order screen, where every step is reviewed before anything is signed. Nothing is signed here.

export const MIN_USD = 10;
export const MAX_USD = 1_000_000;

export type Funding = { kind: 'idle' } | { kind: 'reading' } | FundingOutcome;

export function BuyScreen({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const state = usePlan(id);
  const [text, setText] = useState<string | null>(null);
  const [funding, setFunding] = useState<Funding>({ kind: 'idle' });
  const [round, setRound] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<OrderOutcome['kind'] | 'noStore' | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [addingMock, setAddingMock] = useState(false);
  const reasonId = useId();
  const fundingId = useId();
  const asked = useRef(0);

  const ready = state.kind === 'ready' ? state : null;
  const plan = ready?.plan ?? null;
  const chain = ready?.chain ?? null;
  const owner = chain ? (port.active(chainFamily(chain))?.address ?? null) : null;
  const typed = text ?? (plan ? String(plan.proposal.sheet.amountUsd) : '');
  const parsed = parseNumber(typed);
  const amount =
    parsed !== null && !Number.isNaN(parsed) && parsed >= MIN_USD && parsed <= MAX_USD
      ? parsed
      : null;

  // What the wallet is missing for this amount, read again a moment after the amount stops changing.
  // Only the latest read is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` reads the wallet again
  useEffect(() => {
    if (!plan || !owner || amount === null) {
      setFunding({ kind: 'idle' });
      return;
    }
    asked.current += 1;
    const mine = asked.current;
    setFunding({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFunding(apiFetch, {
        proposalId: plan.id,
        amountUsd: amount,
        wallet: owner,
      });
      if (asked.current === mine) setFunding(read);
    }, 300);
    return () => clearTimeout(timer);
  }, [plan, owner, amount, apiFetch, round]);

  if (!ready || !plan || !chain) {
    const gate = state.kind === 'ready' ? { kind: 'loading' as const } : state;
    return <PlanGate state={gate} next={`/plan/${encodeURIComponent(id)}/buy`} />;
  }

  const chainName = t.chain.names[chain];
  const accepted = trustAccepted(port.userId, TRUST_STATUS.textVersion);
  const read = funding.kind === 'read' ? funding.funding : null;
  const blocked = [
    ...(!ready.buyable ? [t.plan.chainNotReady(chainName)] : []),
    ...(ready.off ? [t.plan.chainOff(chainName)] : []),
    ...(!owner ? [t.buy.blocked.wallet] : []),
    ...(amount === null ? [t.buy.blocked.amount] : []),
    ...(amount !== null && owner && !read?.ok ? [t.buy.blocked.funding] : []),
    ...(!accepted && !ticked ? [t.buy.blocked.trust] : []),
  ];

  async function review() {
    if (!plan || !chain || !owner || amount === null) return;
    setPlacing(true);
    setFailure(null);
    setFailureCode(null);
    const outcome = await placeOrder(apiFetch, {
      proposalId: plan.id,
      amountUsd: amount,
      chain,
      owner,
    });
    if (outcome.kind !== 'placed') {
      setPlacing(false);
      setFailure(outcome.kind);
      if (outcome.kind === 'code') setFailureCode(outcome.code);
      return;
    }
    if (!accepted && port.userId) acceptTrust(port.userId, TRUST_STATUS.textVersion);
    const kept = keepOrder({
      orderId: outcome.order.id,
      userId: port.userId ?? '',
      proposalId: plan.id,
      chain,
      amountUsd: amount,
      lines: plan.proposal.lines,
      approved: null,
      ...(plan.fromLink ? { linked: true as const } : {}),
      goal: {
        sheet: plan.proposal.sheet,
        card: plan.proposal.card,
        verdict: plan.proposal.verdict ?? null,
        placedAt: new Date().toISOString(),
      },
    });
    if (!kept) {
      setPlacing(false);
      setFailure('noStore');
      return;
    }
    router.push(`/orders/${encodeURIComponent(outcome.order.id)}`);
  }

  async function addMock() {
    if (!chain) return;
    setAddingMock(true);
    await fundMock(apiFetch, { chain, cashUsd: Math.max(amount ?? 0, MIN_USD) * 2 });
    setAddingMock(false);
    setRound((n) => n + 1);
  }

  const failureSentence =
    failure === null
      ? null
      : failure === 'code' && failureCode
        ? t.buy.failure[failureCode as keyof typeof t.buy.failure]
        : failure === 'signed-out'
          ? t.buy.failure.signedOut
          : failure === 'no-chain'
            ? t.buy.failure.noChain
            : failure === 'no-plan'
              ? t.buy.failure.noPlan
              : failure === 'busy'
                ? t.shell.slowDown
                : failure === 'noStore'
                  ? t.buy.failure.noStore
                  : failure === 'unreadable'
                    ? t.buy.failure.unreadable
                    : failure === 'refused'
                      ? t.buy.failure.refused
                      : t.buy.failure.unreachable;

  return (
    <div data-ui="buy-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 className="max-w-(--tf-measure-display) font-display text-h1 font-normal">
          {t.buy.title}
        </h1>
        <p className="max-w-(--tf-measure-body) text-body-lg">{t.buy.lead(chainName)}</p>
      </header>

      {/* Two columns from 1024px, as the guide sets its controls and their panels side by side. */}
      <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="flex flex-col gap-6">
          <Card>
            <CardBody>
              <Field
                label={t.buy.amount.label}
                hint={t.buy.amount.hint(dollars(plan.proposal.sheet.amountUsd, lang))}
                error={typed.trim() && amount === null ? t.buy.blocked.amount : undefined}
              >
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    width="14ch"
                    value={typed}
                    onChange={(e) => setText(e.currentTarget.value)}
                  />
                )}
              </Field>
            </CardBody>
          </Card>
          <FundingCard
            id={fundingId}
            funding={funding}
            chainName={chainName}
            owner={owner}
            mock={ready.mock}
            units={unitsFor(chain, ready.mock)}
            gasUnits={gasUnitsFor(chain)}
            mockBusy={addingMock}
            onReadAgain={() => setRound((n) => n + 1)}
            onMock={addMock}
          />
        </div>
        <TrustNotice chain={chain} accepted={accepted} checked={ticked} onCheck={setTicked} />
      </div>

      <div className="flex flex-col items-start gap-2">
        <Button
          variant="primary"
          busy={placing}
          busyLabel={t.buy.reviewing}
          disabled={blocked.length > 0}
          aria-describedby={blocked.length > 0 ? reasonId : undefined}
          onClick={review}
        >
          {t.buy.review(
            amount === null ? dollars(plan.proposal.sheet.amountUsd, lang) : dollars(amount, lang),
          )}
        </Button>
        {blocked.length > 0 && (
          <ul id={reasonId} className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm">
            {blocked.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {failureSentence && (
          <p
            role="alert"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
          >
            <StatusMark status="off-track" size={12} className="mt-1.5" />
            <span>{failureSentence}</span>
          </p>
        )}
      </div>
    </div>
  );
}

type FundingRow = {
  key: 'cash' | 'gas';
  name: string;
  figure: FundingFigure;
  /** What a raw amount of it means, from what this repository committed; null shows the raw amount. */
  units: TokenUnits | null;
};

/** What the wallet holds and is missing for a buy, with where each balance comes from. */
export function FundingCard({
  id,
  funding,
  chainName,
  owner,
  mock,
  units,
  gasUnits,
  mockBusy,
  onReadAgain,
  onMock,
}: {
  id: string;
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
}) {
  const t = useT();
  const lang = useLang();
  const locale = LOCALE[lang];
  const read = funding.kind === 'read' ? funding.funding : null;
  // An amount in whole units with the committed decimals; with none committed, the raw amount alone.
  const amount = (raw: string, u: TokenUnits | null) => {
    const figure = u ? formatRaw(raw, u.decimals, locale) : null;
    return (
      <span className="whitespace-nowrap">
        {u && figure !== null ? `${figure} ${u.symbol}` : raw}
      </span>
    );
  };
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
    funding.kind === 'read'
      ? null
      : funding.kind === 'unreachable' || funding.kind === 'busy'
        ? funding.kind === 'busy'
          ? t.shell.slowDown
          : t.buy.funding.failure.unreachable
        : funding.kind === 'unreadable'
          ? t.buy.funding.failure.unreadable
          : funding.kind === 'no-plan'
            ? t.buy.funding.failure.noPlan
            : funding.kind === 'signed-out'
              ? t.buy.failure.signedOut
              : funding.kind === 'no-chain'
                ? t.buy.failure.noChain
                : funding.kind === 'refused'
                  ? t.buy.funding.failure.refused
                  : null;
  return (
    <Card
      as="section"
      aria-labelledby={id}
      mock={read !== null && read.provenance !== 'live'}
      mockLabels={{
        announce: t.shell.mockAnnounce,
        note: read?.provenance === 'sandbox' ? t.shell.testNetwork : undefined,
      }}
    >
      <CardHeader title={t.buy.funding.title} level={2} id={id} />
      {funding.kind === 'reading' || funding.kind === 'idle' ? (
        <CardWait label={t.buy.funding.reading} skeleton={<SkeletonRows rows={2} columns={4} />} />
      ) : (
        <CardBody className="flex flex-col gap-4">
          <div aria-live="polite" className="flex flex-col gap-4">
            {read && (
              <>
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
                <p className="max-w-(--tf-measure-body) text-body">
                  {read.ok ? t.buy.funding.ok : t.buy.funding.short(chainName)}
                </p>
                {read.newVault && (
                  <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
                    {t.buy.funding.newVault}
                  </p>
                )}
                {!read.ok && owner && (
                  <p className="break-all font-mono text-source">{t.buy.funding.address(owner)}</p>
                )}
              </>
            )}
            {sentence && <p className="max-w-(--tf-measure-body) text-body-sm">{sentence}</p>}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={onReadAgain}>
              {t.buy.funding.readAgain}
            </Button>
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
          </div>
        </CardBody>
      )}
      {read && (
        // Where each balance comes from (card.md: the footer holds the source lines).
        <CardFooter>
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
        </CardFooter>
      )}
    </Card>
  );
}

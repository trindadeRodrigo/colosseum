'use client';
import { type ChainId, type Provenance, type Target, TRUST_STATUS } from '@colosseum/schemas';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { DataTable } from '../../components/ui/DataTable';
import { StatusMark } from '../../components/ui/StatusMark';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { readPortfolio } from '../shared/shared-api';
import { useApiFetch, useWalletPort } from '../wallet/WalletProvider';
import { formatBps } from './amounts';
import { type Funding, FundingStep } from './FundingStep';
import type { InvestProgress } from './invest-words';
import { MAX_USD, MIN_USD } from './limits';
import { OrderScreen } from './OrderScreen';
import {
  type BuyOf,
  fundMock,
  readFunding,
  requestTestFunds,
  TEST_SEND,
  type TestFundsOutcome,
} from './order-api';
import { acceptTrust, forgetUnapproved, trustAccepted } from './order-record';
import { displayName } from './plain';
import { gasUnitsFor } from './readiness';
import { TrustNotice } from './TrustNotice';
import { unitsFor } from './units';
import { FundsWait } from './waits';

// Investing, on one card with one press (gate INVEST-ONE-PRESS): what is bought and for how much; what
// the wallet is missing, shown only when it is short; the trust notice, here the first time only;
// then the order as our server made it, each step with the least it may receive, and the button that
// names the action and the amount. One press approves that order exactly as shown and runs its steps
// one after another. The same card buys a plan, buys a shared portfolio and adds money to a vault:
// its host says what the buy is of, the amount, and how the order is made.
//
// Nothing that decides what is signed is here. The order is checked against what the person typed
// before it is offered, the guard checks every step's bytes, and a step that may still land is never
// signed twice: all of it is the order's own screen (OrderScreen.tsx), drawn inside this card, and
// the runner behind it (run-order.ts). This card only decides when an order is made and what stands
// in the way of the press.

/** How long the amount has to be still, once the wallet is read, before an order is made for it. */
export const STILL_MS = 1_000;
/** How many orders a card makes by itself; after that the person asks for the prices. */
export const AUTO_ORDERS = 4;
/** How long the press is held after an order takes another's place on the card. */
export const READ_MS = 1_500;

export { AmountField } from './AmountField';
export { MAX_USD, MIN_USD };

/** An order made for the card, or why none was, in the words the card shows. */
export type InvestPlaced =
  | {
      orderId: string;
      /** Unix seconds: an order nobody approved by then is made again, with new prices. */
      expiresAt: number;
      /** The number of the vault it deposits into, where the order states it. */
      basketId?: string;
    }
  | {
      failure: string;
      /**
       * What is bought changed on our server (a shared portfolio has a newer version): the host is
       * told, and no other order is made until the person asks for the prices again.
       */
      versionChanged?: boolean;
    };

export type InvestCardProps = {
  chain: ChainId;
  chainName: string;
  /** The chain runs on the mock. */
  mock: boolean;
  /** The amount in dollars, or null while what was typed is not one from $10 to $1,000,000. */
  amount: number | null;
  /** The wallet that signs, on this chain. */
  owner: string | null;
  userId: string | null;
  /** What the buy is of: what the wallet's funds are read for, and test funds asked for. */
  buyOf: BuyOf;
  /** What the amount is split into, by weight; what is left of the whole stays as cash. */
  holdings: readonly Target[] | null;
  /** The keeper may trade the vault this buy fills. Left out: it may. */
  keeper?: boolean;
  /** The host's own reasons no order can be made yet (the chain is not ready, a read is unverified). */
  blocked: readonly string[];
  /**
   * Makes the order for this amount and keeps this browser's record of it (order-record.ts), with
   * what the host's screen showed. Nothing is signed by it.
   */
  place: (amount: number) => Promise<InvestPlaced>;
  /** The person pressed, and then each step as it runs. */
  onProgress?: (progress: InvestProgress) => void;
  /** Every step is confirmed. `vault` is the vault's address where the portfolio could be read. */
  onDone?: (done: { orderId: string; vault: string | null }) => void;
  /** The sequence stopped short of done: the order's own page has the rest. */
  onStopped?: (stopped: { orderId: string }) => void;
  /**
   * Our server refused the order because what is bought changed (a shared portfolio's version). The
   * card makes no other order by itself: the host reads the new version and says so, and the person
   * asks for the prices again.
   */
  onVersionChanged?: () => void;
  /**
   * The person chose another amount on the card ("Invest $12,900 instead", what the wallet covers):
   * the host changes its amount, and what was built for the old one. Left out: no such choice.
   */
  onAmount?: (amount: number) => void;
  /**
   * Where the amount is changed: a field on the page, or the goal the plan was built from, where it
   * cannot be typed. Said when the wallet is short by more than test funds send.
   */
  amountFrom?: 'field' | 'goal';
  /**
   * An order the person already approved on this card, taken up again after the card was lost (a
   * reload of /goal in the middle of its steps): the card opens on that order, as the order's own
   * record and our server have it, and makes no other. Nothing about it is read from the host.
   */
  resume?: { orderId: string; expiresAt: number; basketId?: string };
  /** An order that finishes the one on the card took its place there (it is not approved yet). */
  onFollowUp?: (orderId: string) => void;
  /** The host says where to go once every step is confirmed: no link of the card's own. */
  hostEnds?: boolean;
};

/** What a host that mounts a buy inside its own screen passes: the amount, and what it is told. */
export type InvestEmbedded = Pick<
  InvestCardProps,
  | 'amount'
  | 'onProgress'
  | 'onDone'
  | 'onStopped'
  | 'onVersionChanged'
  | 'onAmount'
  | 'hostEnds'
  | 'onFollowUp'
> & {
  /** The id of an order approved on this card before it was lost: the card takes it up again. */
  resumeOrder?: string;
};

type Made = {
  key: string;
  orderId: string;
  expiresAt: number;
  basketId?: string;
  /** It took the place of another order on this card. */
  again: boolean;
};

export function InvestCard({
  chain,
  chainName,
  mock,
  amount,
  owner,
  userId,
  buyOf,
  holdings,
  keeper = true,
  blocked,
  place,
  onProgress,
  onDone,
  onStopped,
  onVersionChanged,
  onAmount,
  amountFrom = 'field',
  resume,
  hostEnds,
  onFollowUp,
}: InvestCardProps) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const apiFetch = useApiFetch();
  const reasonId = useId();
  const [funding, setFunding] = useState<Funding>({ kind: 'idle' });
  const [fundsRound, setFundsRound] = useState(0);
  const [ticked, setTicked] = useState(false);
  const [made, setMade] = useState<Made | null>(
    resume ? { key: 'resume', again: false, ...resume } : null,
  );
  const [placing, setPlacing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [orderRound, setOrderRound] = useState(0);
  // The person pressed: from then on the card is that order's, whatever is typed or read after.
  const [started, setStarted] = useState(Boolean(resume));
  const [mockBusy, setMockBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestFundsOutcome | null>(null);
  const fundsAsked = useRef(0);
  const orderAsked = useRef(0);
  // How many orders this card has made, and the one the person asked for by hand.
  const orders = useRef(0);
  const asked = useRef<string | null>(null);
  const [paused, setPaused] = useState(false);
  // What is bought changed under the card: no order is made again until the person asks.
  const mustAsk = useRef(false);
  const changed = useRef(onVersionChanged);
  changed.current = onVersionChanged;
  // The order on the card ran out before anybody pressed: its prices are old, and no other is made
  // until the person asks.
  const [old, setOld] = useState(false);
  // The tab came back into view: an order that waited for that is made now.
  const [seen, setSeen] = useState(0);
  const unseen = useRef(false);
  // An order took the place of another on this card: said, and the press held for a moment, so
  // nobody approves figures they could not have read.
  const shown = useRef(0);
  const [fresh, setFresh] = useState(false);
  // The host's way of making the order, as it is now: read when an order is made, never a reason
  // to make one.
  const placer = useRef(place);
  placer.current = place;
  const buy = useRef(buyOf);
  buy.current = buyOf;
  const buyKey = JSON.stringify(buyOf);

  // What the wallet is missing for this amount, read again a moment after the amount stops changing.
  // Only the latest read is shown. Not read again once the person has pressed: the order spends it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fundsRound` reads the wallet again, and `buyKey` stands for what is bought
  useEffect(() => {
    if (started) return;
    if (!owner || amount === null) {
      setFunding({ kind: 'idle' });
      return;
    }
    fundsAsked.current += 1;
    const mine = fundsAsked.current;
    setFunding({ kind: 'reading' });
    const timer = setTimeout(async () => {
      const read = await readFunding(apiFetch, {
        ...buy.current,
        amountUsd: amount,
        wallet: owner,
      });
      if (fundsAsked.current === mine) setFunding(read);
    }, 300);
    return () => clearTimeout(timer);
  }, [owner, amount, apiFetch, fundsRound, buyKey, started]);

  const read = funding.kind === 'read' ? funding.funding : null;
  // The wallet held what this buy needs when it was last read: kept while it is read again, so an
  // order made for it is not thrown away by a second look, and dropped when a read says it is short.
  const want = owner && amount !== null ? `${buyKey}|${owner}|${amount}` : null;
  const [okFor, setOkFor] = useState<string | null>(null);
  if (read && want && (read.ok ? okFor !== want : okFor === want)) setOkFor(read.ok ? want : null);
  const funded = want !== null && okFor === want;
  // The last answer about the wallet for this buy, shown while it is read again: what was said
  // (what is missing, why test funds were not sent) does not blink away with each read.
  const [last, setLast] = useState<{ of: string; funding: Funding } | null>(null);
  if (want && funding.kind !== 'idle' && funding.kind !== 'reading' && last?.funding !== funding)
    setLast({ of: want, funding });
  const heard: Funding = funding.kind === 'reading' && last?.of === want ? last.funding : funding;
  const clear = blocked.length === 0;
  // The order is made once nothing stands in its way but the person: the wallet holds what it
  // needs and the host has no reason against it. One order for an amount, a wallet and a round.
  const key = want !== null && clear && funded ? `${want}|${orderRound}` : null;

  // One order at a time for the card. The one before it, which nobody approved, is forgotten here
  // as another takes its place or the card goes away; our server's copy runs out by itself.
  const open = useRef<string | null>(null);
  const forget = useRef((orderId: string) => forgetUnapproved(orderId, userId));
  forget.current = (orderId: string) => forgetUnapproved(orderId, userId);
  // The order whose steps are being run from this card. If the card goes before they end, the run is
  // stopped with it (OrderScreen) and nothing is left to say so: the host is told here, once, so what
  // it locked for the run (an amount field, a conversation) is the person's again.
  const runOf = useRef<string | null>(null);
  const stoppedTo = useRef(onStopped);
  stoppedTo.current = onStopped;
  useEffect(
    () => () => {
      if (open.current) forget.current(open.current);
      if (runOf.current) stoppedTo.current?.({ orderId: runOf.current });
      runOf.current = null;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `seen` makes the order that waited for the tab to be looked at
  useEffect(() => {
    if (started) return;
    const drop = () => {
      if (open.current) forget.current(open.current);
      open.current = null;
    };
    if (key === null) {
      // What it was made for no longer holds: the order is left unsigned.
      orderAsked.current += 1;
      drop();
      setMade(null);
      setPlacing(false);
      return;
    }
    if (made?.key === key || amount === null) return;
    orderAsked.current += 1;
    const mine = orderAsked.current;
    drop();
    setMade(null);
    setFailure(null);
    // Making an order asks the chain for quotes and counts against the person's budget for
    // building steps (the API's `build` class), which the run itself needs. So a card makes few
    // by itself: after that the person asks for the prices.
    if ((old || mustAsk.current || orders.current >= AUTO_ORDERS) && asked.current !== key) {
      setPlacing(false);
      setPaused(true);
      return;
    }
    setPaused(false);
    setPlacing(true);
    // Only once the amount has been still for a moment: never an order for each key pressed.
    const timer = setTimeout(async () => {
      // Never in a tab nobody is looking at: it is made when the tab is seen again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        unseen.current = true;
        setPlacing(false);
        return;
      }
      orders.current += 1;
      const answer = await placer.current(amount);
      if (orderAsked.current !== mine) {
        // Too late: another amount is on the card. This one is nobody's.
        if ('orderId' in answer) forget.current(answer.orderId);
        return;
      }
      setPlacing(false);
      if ('failure' in answer) {
        if (answer.versionChanged) {
          // Nothing is made again by itself: the host reads what changed, and the person asks.
          mustAsk.current = true;
          changed.current?.();
        }
        return setFailure(answer.failure);
      }
      open.current = answer.orderId;
      shown.current += 1;
      setMade({ key, again: shown.current > 1, ...answer });
    }, STILL_MS);
    return () => clearTimeout(timer);
  }, [key, made, amount, started, old, seen]);

  useEffect(() => {
    const onSeen = () => {
      if (document.visibilityState !== 'visible' || !unseen.current) return;
      unseen.current = false;
      setSeen((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onSeen);
    return () => document.removeEventListener('visibilitychange', onSeen);
  }, []);

  // The press is held for a moment after an order takes another's place: each one from when it shows.
  const replaced = made?.again ? made.orderId : null;
  useEffect(() => {
    if (!replaced) return setFresh(false);
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), READ_MS);
    return () => clearTimeout(timer);
  }, [replaced]);

  // An order nobody approved in time is taken off the card: its prices are old. No other is made
  // by itself, in this tab or a hidden one: the person asks for the prices again.
  useEffect(() => {
    if (!made || started) return;
    const left = made.expiresAt * 1000 - Date.now();
    // One that is already past its time as it arrives is a clock that disagrees: the press says it
    // ran out, and offers a new one.
    if (left <= 0) return;
    const timer = setTimeout(() => {
      asked.current = null;
      setOld(true);
      setMade(null);
    }, left);
    return () => clearTimeout(timer);
  }, [made, started]);

  // What the figures are, as the funding read says, and as the wallet's chain runs until one has; kept
  // while the wallet is read again, so the card keeps its shape (BUY-STEPS, the flake of #150).
  const [said, setSaid] = useState<Provenance | null>(null);
  if (read && read.provenance !== said) setSaid(read.provenance);
  const provenance = read?.provenance ?? said ?? (mock ? 'mock' : port.network(chain)?.provenance);
  const sample = mock || said === 'mock';

  const accepted = trustAccepted(userId, TRUST_STATUS.textVersion, keeper);
  const trustHeld = !accepted && !ticked;

  async function addMock() {
    setMockBusy(true);
    await fundMock(apiFetch, { chain, cashUsd: Math.max(amount ?? 0, MIN_USD) * 2 });
    setMockBusy(false);
    setFundsRound((n) => n + 1);
  }

  // The wallet's cash in dollars as the funding read has it, with the units this repository committed.
  const cashDecimals =
    (read ? unitsFor(chain, mock)?.tokens[read.cash.asset]?.decimals : undefined) ??
    read?.cash.decimals;
  const dollarsOf = (raw: string) =>
    cashDecimals === undefined ? null : Number(BigInt(raw)) / 10 ** cashDecimals;
  const haveUsd = read ? dollarsOf(read.cash.haveRaw) : null;
  const missingUsd = read ? dollarsOf(read.cash.missingRaw) : null;
  // The most a send may be asked to cover, so that with the server's margin it stays within one send.
  const sendCovers = Math.floor((TEST_SEND.maxUsd * 10_000) / (10_000 + TEST_SEND.marginBps));
  // Short by more than one send of test funds gives, where our server sends them: asking for the
  // whole amount would only be refused, so the card says what a send gives and what else can be done.
  const beyondOneSend =
    read !== null &&
    !read.ok &&
    read.provenance === 'sandbox' &&
    read.testFunds === true &&
    missingUsd !== null &&
    missingUsd > sendCovers;
  // What the wallet covers now, in whole dollars: offered as the amount, where the fees are covered.
  const covered =
    beyondOneSend && haveUsd !== null && read?.gas.missingRaw === '0' && haveUsd >= MIN_USD
      ? Math.floor(haveUsd)
      : null;

  async function askTestFunds() {
    if (!owner || amount === null) return;
    setTestBusy(true);
    setTestOutcome(null);
    const outcome = await requestTestFunds(apiFetch, {
      ...buyOf,
      // Beyond one send: asked for what one send covers over what the wallet holds, so that it
      // sends that much instead of refusing the whole amount.
      amountUsd: beyondOneSend && haveUsd !== null ? Math.floor(haveUsd) + sendCovers : amount,
      wallet: owner,
    });
    setTestBusy(false);
    setTestOutcome(outcome);
    // What arrived, read from the chain: the line and the table follow it.
    setFundsRound((n) => n + 1);
  }

  async function done(orderId: string) {
    if (!onDone) return;
    if ('vault' in buyOf) return onDone({ orderId, vault: buyOf.vault });
    // A buy opens its vault, or adds to the one its plan has: the portfolio says which it is.
    const portfolio = await readPortfolio(apiFetch);
    const vaults =
      portfolio.kind === 'read'
        ? (portfolio.value.chains.find((c) => c.chain === chain)?.vaults ?? [])
        : [];
    const found = made?.basketId ? vaults.find((v) => v.basketId === made.basketId) : undefined;
    onDone({ orderId, vault: found?.address ?? null });
  }

  const label = t.invest.press(dollars(amount ?? MIN_USD, lang));
  // Why there is no order to press yet, from the host and from this card, in the order a person
  // would fix them.
  const waiting = [
    ...new Set([
      ...blocked,
      ...(!owner ? [t.buy.blocked.wallet] : []),
      ...(amount === null ? [t.buy.blocked.amount] : []),
      ...(amount !== null && owner && read && !read.ok ? [t.buy.blocked.funding] : []),
      ...(trustHeld ? [t.buy.blocked.trust] : []),
    ]),
  ];
  const rows =
    holdings && amount !== null
      ? [
          ...holdings.map((h) => ({
            key: h.asset,
            name: displayName(h.asset, t.plan),
            weightBps: h.weightBps,
          })),
          ...(holdings.reduce((sum, h) => sum + h.weightBps, 0) < 10_000
            ? [
                {
                  key: 'cash',
                  name: t.invest.cash,
                  weightBps: 10_000 - holdings.reduce((sum, h) => sum + h.weightBps, 0),
                },
              ]
            : []),
        ]
      : [];

  return (
    <Card
      as="section"
      aria-label={t.invest.label}
      // On the mock: the hatch band and its one quiet line at the card's foot (MOCK-QUIET).
      mock={sample}
      mockLabels={{ announce: t.shell.mockAnnounce }}
      className="max-w-3xl"
    >
      <CardBody className="flex flex-col gap-5">
        <div data-ui="invest-card" className="flex flex-col gap-5">
          {provenance === 'sandbox' && (
            // A test network's figures are real reads, not samples: one quiet line says where they
            // are from, never a plate on a figure.
            <p
              data-ui="data-note"
              className="text-caption text-muted-foreground [overflow-wrap:anywhere]"
            >
              {t.buy.steps.note.testNetwork(chainName)}
            </p>
          )}

          {!made && rows.length > 0 && amount !== null && (
            // What the amount buys, by the weights the host's screen showed, until the order itself
            // is here with each trade and the least it may receive.
            <DataTable
              caption={t.invest.buying}
              dense
              rows={rows}
              rowKey={(row) => row.key}
              columns={[
                {
                  key: 'name',
                  header: t.invest.columns.holding,
                  rowHeader: true,
                  cell: (r) => r.name,
                },
                {
                  key: 'share',
                  header: t.invest.columns.share,
                  numeric: true,
                  cell: (r) => formatBps(r.weightBps, LOCALE[lang]),
                },
                {
                  key: 'amount',
                  header: t.invest.columns.amount,
                  numeric: true,
                  cell: (r) => dollars((amount * r.weightBps) / 10_000, lang),
                },
              ]}
            />
          )}

          {!started && owner && amount !== null && heard.kind === 'reading' && (
            // said in words, over the outline of what the check brings: what is needed and the
            // ways to add it
            <div data-ui="invest-funds-reading" className="flex flex-col gap-3">
              <p className="text-body-sm text-muted-foreground">{t.invest.checkingFunds}</p>
              <FundsWait />
            </div>
          )}
          {!started &&
            heard.kind !== 'idle' &&
            heard.kind !== 'reading' &&
            // still said once test funds were sent: what arrived, and that the wallet holds it now
            (!funded || testOutcome?.kind === 'sent') && (
              // Shown only when the wallet is short, or could not be read: what is missing and the
              // way to fill it.
              <FundingStep
                funding={heard}
                chainName={chainName}
                owner={owner}
                mock={mock}
                units={unitsFor(chain, mock)}
                gasUnits={gasUnitsFor(chain)}
                mockBusy={mockBusy}
                onReadAgain={() => setFundsRound((n) => n + 1)}
                onMock={addMock}
                testFunds={{ busy: testBusy, outcome: testOutcome, onAsk: askTestFunds }}
                capped={
                  beyondOneSend
                    ? {
                        note: t.invest.short.cap(dollars(TEST_SEND.maxUsd, lang), TEST_SEND.perDay),
                        label: t.invest.short.sendAnyway(dollars(TEST_SEND.maxUsd, lang)),
                      }
                    : undefined
                }
              />
            )}
          {!started && beyondOneSend && (
            // The other ways on: the amount the wallet covers, in one press, and how to choose another.
            <div data-ui="invest-short" className="flex flex-col items-start gap-2">
              {covered !== null && onAmount && (
                <>
                  <p className="max-w-(--tf-measure-body) text-body-sm">
                    {t.invest.short.covers(dollars(covered, lang))}
                  </p>
                  <Button variant="secondary" onClick={() => onAmount(covered)}>
                    {t.invest.short.instead(dollars(covered, lang))}
                  </Button>
                </>
              )}
              <p className="max-w-(--tf-measure-body) text-body-sm text-muted-foreground">
                {amountFrom === 'goal' ? t.invest.short.inGoal : t.invest.short.typeLess}
              </p>
            </div>
          )}

          {!accepted && !started ? (
            // Before the first deposit: the notice with its box, in the card. The press is held
            // until it is ticked, and the acceptance is kept as the person presses.
            <TrustNotice
              chain={chain}
              accepted={false}
              checked={ticked}
              onCheck={setTicked}
              keeper={keeper}
            />
          ) : (
            // Accepted before, for this text: not asked again, and still here to read.
            <details data-ui="trust-kept">
              <summary className="w-fit cursor-pointer text-body-sm font-medium text-honey-text underline decoration-1 underline-offset-4 hover:decoration-2">
                {t.trust.short.title}
              </summary>
              <div className="mt-3">
                <TrustNotice
                  chain={chain}
                  accepted
                  checked={false}
                  onCheck={setTicked}
                  keeper={keeper}
                />
              </div>
            </details>
          )}

          {made?.again && !started && (
            <p data-ui="invest-updated" aria-live="polite" className="text-body-sm font-medium">
              {t.invest.updated}
            </p>
          )}
          {made ? (
            <OrderScreen
              key={made.orderId}
              id={made.orderId}
              embed={{
                blocked: [
                  ...(trustHeld ? [t.buy.blocked.trust] : []),
                  ...(fresh ? [t.invest.updatedHold] : []),
                ],
                onApprove: () => {
                  // The order is the person's now: it is kept, whatever becomes of the card.
                  open.current = null;
                  runOf.current = made.orderId;
                  setStarted(true);
                  onProgress?.({ orderId: made.orderId, step: 0, of: 0, line: '' });
                },
                // Kept only once the run has begun: a press that could not start accepted nothing.
                onStarted: () => {
                  if (!accepted && userId) acceptTrust(userId, TRUST_STATUS.textVersion, keeper);
                },
                onAgain: () => {
                  // asked for by the person: made whatever the card has made by itself
                  asked.current = want ? `${want}|${orderRound + 1}` : null;
                  runOf.current = null;
                  setStarted(false);
                  setMade(null);
                  setOrderRound((n) => n + 1);
                },
                onProgress: (progress) => {
                  // also a run begun again after it stopped: finish, try again
                  runOf.current = progress.orderId;
                  onProgress?.(progress);
                },
                onDone: ({ orderId }) => {
                  runOf.current = null;
                  void done(orderId);
                },
                onStopped: (stopped) => {
                  runOf.current = null;
                  onStopped?.(stopped);
                },
                ...(hostEnds ? { hostEnds: true } : {}),
                // The host ends the deposit in place: the order that finishes this one takes the
                // card, to be reviewed and signed here. It deposits nothing, so no other is made.
                ...(hostEnds
                  ? {
                      onFinish: (orderId: string) => {
                        runOf.current = null;
                        setStarted(true);
                        setMade({
                          key: `finish:${orderId}`,
                          orderId,
                          expiresAt: 0,
                          again: false,
                          ...(made.basketId ? { basketId: made.basketId } : {}),
                        });
                        onFollowUp?.(orderId);
                      },
                    }
                  : {}),
              }}
            />
          ) : (
            <div className="flex flex-col items-start gap-3">
              <Button
                variant="primary"
                busy={placing}
                busyLabel={t.invest.preparing}
                disabled
                aria-describedby={waiting.length > 0 ? reasonId : undefined}
              >
                {label}
              </Button>
              {waiting.length > 0 && (
                <ul
                  id={reasonId}
                  className="flex max-w-(--tf-measure-body) flex-col gap-1 text-body-sm"
                >
                  {waiting.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {paused && old && !failure && (
                <p data-ui="invest-old" className="max-w-(--tf-measure-body) text-body-sm">
                  {t.invest.old}
                </p>
              )}
              {paused && !failure && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    asked.current = want ? `${want}|${orderRound + 1}` : null;
                    setOld(false);
                    mustAsk.current = false;
                    setOrderRound((n) => n + 1);
                  }}
                >
                  {t.invest.again}
                </Button>
              )}
              {failure && (
                <>
                  <p
                    role="alert"
                    className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm text-destructive"
                  >
                    <StatusMark status="off-track" size={12} className="mt-1.5" />
                    <span>{failure}</span>
                  </p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      asked.current = want ? `${want}|${orderRound + 1}` : null;
                      setOld(false);
                      mustAsk.current = false;
                      setOrderRound((n) => n + 1);
                    }}
                  >
                    {t.invest.again}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

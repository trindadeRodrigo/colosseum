'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { PAGE_TITLE } from '../../components/ui/heading';
import { StalePlate } from '../../components/ui/MockPlate';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { pinState } from '../../components/ui/provenance';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChainMark } from '../account/ChainName';
import { dollars, utc } from '../portfolio/figures';
import type { PlansAnswer, PlansChain } from './api';
import { PlanCard } from './PlanCard';
import { usePortfolioSection } from './PortfolioProvider';
import { ChainsOut, ReadAgain, Say, SectionGate, TITLE_OVER_CARDS, useChainName } from './parts';
import { addDecimals, snapshotPin, sumPin } from './pins';
import { useWords } from './words';

// The overview (/portfolio): the person's plans, chain by chain. For each chain, how many plans there
// are and what they are worth together, a sum of that chain's newest snapshots with the pin that says
// so; then one card a plan (PlanCard.tsx). Nothing is added across chains: plans on two chains are
// counted, each chain with its own sum. A chain that could not be read is a sentence, never a zero,
// and a vault that was never read is in no sum and shows no value. Nothing here signs.

export function OverviewPage() {
  const w = useWords();
  const { plans } = usePortfolioSection();
  // One card for each vault of the person's: the serif is the cards' once there is one.
  const vaults = plans.kind === 'read' ? plans.answer.chains.flatMap((entry) => entry.plans) : [];
  return (
    <div data-ui="portfolio-overview" className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        {/* The serif answers once per screen: with goal cards below, their sentences are it, and the
            page heading is the sans face (goal-card.md), as the monitor's is. heading.test.ts holds
            every other title to PAGE_TITLE, and lets this one be by the `vaults.length` it reads. */}
        <h1 className={vaults.length > 0 ? TITLE_OVER_CARDS : PAGE_TITLE}>{w.overview.title}</h1>
        <p className="max-w-(--tf-measure-body) text-body-lg text-foreground">{w.overview.lead}</p>
      </header>
      <SectionGate read={plans}>{(answer) => <Plans answer={answer} />}</SectionGate>
    </div>
  );
}

function Plans({ answer }: { answer: PlansAnswer }) {
  const w = useWords();
  const nameOf = useChainName();
  const held = answer.chains.filter((entry) => entry.plans.length > 0);
  const empty = answer.chains.filter((entry) => entry.plans.length === 0);
  const count = held.reduce((n, entry) => n + entry.plans.length, 0);
  return (
    <>
      <ChainsOut unavailable={answer.unavailable} />
      {count === 0 ? (
        // "No plan yet" is said only when every chain of theirs was read: one that could not be read
        // may hold one.
        answer.unavailable.length === 0 && (
          <Say
            sentence={w.shell.empty}
            action={
              <Link href="/goal" className={buttonClass({ variant: 'link' })}>
                {w.shell.startGoal}
              </Link>
            }
          />
        )
      ) : (
        <>
          <p data-ui="plans-count" className="text-body">
            {w.overview.count(count, held.length)}
          </p>
          {held.map((entry) => (
            <ChainGroup key={entry.chain} entry={entry} />
          ))}
          {empty.map((entry) => (
            <p
              key={entry.chain}
              data-ui="chain-empty"
              data-chain={entry.chain}
              className="text-body-sm text-muted-foreground"
            >
              {w.overview.chain.none(nameOf(entry.chain))}
            </p>
          ))}
        </>
      )}
      <p
        data-ui="plans-refresh"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm text-muted-foreground"
      >
        <span>{w.overview.refresh}</span>
        <ReadAgain />
      </p>
    </>
  );
}

/** A chain's plans under its heading, with what they are worth together on that chain alone. */
function ChainGroup({ entry }: { entry: PlansChain }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const heading = useId();
  const words = w.overview.chain;
  const name = nameOf(entry.chain);
  // The sum holds the vaults that were read; one that was not is said, and is never a zero in it.
  const read = entry.plans.flatMap((plan) =>
    plan.newest
      ? [
          {
            valueUsd: plan.newest.valueUsd,
            obs: snapshotPin(plan.newest, entry.provenance, plan.provenance),
          },
        ]
      : [],
  );
  const unread = entry.plans.length - read.length;
  const total =
    read.length > 0
      ? {
          valueUsd: addDecimals(read.map((part) => part.valueUsd)),
          obs: sumPin(
            read.map((part) => part.obs),
            words.method(read.length, name),
          ),
        }
      : null;
  return (
    <section
      data-ui="chain-group"
      data-chain={entry.chain}
      aria-labelledby={heading}
      className="flex flex-col gap-6"
    >
      <header className="flex flex-col gap-1 border-b border-border pb-3">
        <h2
          id={heading}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-h3 font-semibold"
        >
          <span>{name}</span>
          <ChainMark
            provenance={entry.provenance}
            labels={{ testNetwork: t.shell.testNetwork, mockAnnounce: t.shell.sampleFigure }}
            announce={false}
          />
        </h2>
        {total ? (
          <p
            data-ui="chain-total"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body"
          >
            <span>
              {words.worth(entry.plans.length, name)}{' '}
              <ProvenancePin value={dollars(lang, total.valueUsd)} obs={total.obs} labels={t.pin} />
            </span>
            {/* A sum is as stale as its stalest part. A live figure's own pin says so; one that is
                not live keeps its hatched pin, so the plate says it here (mock-plate.md). */}
            {total.obs.staleAgeSec != null && pinState(total.obs) !== 'stale' && (
              <StalePlate
                ageSec={total.obs.staleAgeSec}
                labels={{ stale: t.pin.stale, ageUnknown: t.pin.ageUnknown }}
              />
            )}
          </p>
        ) : (
          <p data-ui="chain-none-read" className="text-body">
            {words.noneRead(entry.plans.length, name)}
          </p>
        )}
        {unread > 0 && read.length > 0 && (
          <p data-ui="chain-unread" className="text-body-sm text-muted-foreground">
            {words.unread(unread)}
          </p>
        )}
        <p data-ui="chain-answered" className="text-caption text-muted-foreground">
          {entry.answeredAt
            ? words.answered(name, utc(lang, entry.answeredAt))
            : words.neverAnswered(name)}
        </p>
      </header>
      <ul className="grid list-none items-stretch gap-6 p-0 min-[980px]:grid-cols-2">
        {entry.plans.map((plan) => (
          <PlanCard key={plan.address} chain={entry} plan={plan} />
        ))}
      </ul>
    </section>
  );
}

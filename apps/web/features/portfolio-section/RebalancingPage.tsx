'use client';
import Link from 'next/link';
import { useId } from 'react';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { shorten } from '../../components/ui/format';
import { useLang, useT } from '../../i18n/I18nProvider';
import { type PlansAnswer, planIn, type RebalancesAnswer } from './api';
import { REBALANCES_ASKED, usePortfolioSection } from './PortfolioProvider';
import { href, METHODOLOGY, planHref } from './pages';
import {
  ChainsOut,
  PageHead,
  ReadAgain,
  Say,
  SectionGate,
  sampleLine,
  useChainName,
} from './parts';
import { leastLive } from './pins';
import { RebalanceStep } from './RebalanceStep';
import { groupsOf, type StepGroup } from './rebalances';
import { type VaultTitle, vaultTitle } from './vault-title';
import { StepsWait } from './waits';
import { useWords } from './words';

// The rebalancing page (/portfolio/rebalancing): the steps that traded in the person's vaults or
// adopted a version, as GET /v1/portfolio/rebalances lists them, newest first and vault by vault. A
// vault is headed as the overview names it (its goal, the portfolio it follows, its own name or its
// chain), through the plans, with its chain and the way to its own page; the steps our server could
// file under no vault come last and say so. Each step is a block (RebalanceStep.tsx). Once on the
// page, a note says what the list cannot tell yet, and leads to the methodology. A chain that could
// not be read is a sentence, never an empty list in its place. Nothing here signs.

const WAITING = { kind: 'reading' } as const;

export function RebalancingPage() {
  const w = useWords();
  const { rebalances, plans } = usePortfolioSection();
  // The vaults are named from the plans: the list waits for that read to end, however it ends, so a
  // heading never changes under the reader. A failed read of the plans leaves the list its steps.
  const named = plans.kind !== 'idle' && plans.kind !== 'reading';
  return (
    <div data-ui="portfolio-rebalancing" className="flex flex-col gap-8">
      <PageHead title={w.rebalancing.title} lead={w.rebalancing.lead} />
      <SectionGate read={named ? rebalances : WAITING} skeleton={<StepsWait />}>
        {(answer) => <Steps answer={answer} plans={plans.kind === 'read' ? plans.answer : null} />}
      </SectionGate>
    </div>
  );
}

function Steps({ answer, plans }: { answer: RebalancesAnswer; plans: PlansAnswer | null }) {
  const w = useWords();
  const nameOf = useChainName();
  const words = w.rebalancing;
  const groups = groupsOf(answer);
  // A list as long as the most one answer holds may have older steps behind it.
  const capped = answer.chains.filter((chain) => chain.entries.length >= REBALANCES_ASKED);
  return (
    <>
      <ChainsOut unavailable={answer.unavailable} />
      {groups.length === 0 ? (
        // "No steps yet" is said only when every chain of theirs was read: one that could not be
        // read may hold some.
        answer.unavailable.length === 0 ? (
          <Say sentence={words.empty} />
        ) : (
          <p data-ui="steps-none" className="text-body">
            {words.noneRead}
          </p>
        )
      ) : (
        <ul data-ui="steps" className="flex list-none flex-col gap-6 p-0">
          {groups.map((group) => (
            <VaultSteps
              key={`${group.chain.chain}:${group.vault ?? ''}`}
              group={group}
              plans={plans}
            />
          ))}
        </ul>
      )}
      {capped.map((chain) => (
        <p
          key={chain.chain}
          data-ui="steps-capped"
          data-chain={chain.chain}
          className="text-body-sm text-muted-foreground"
        >
          {words.capped(REBALANCES_ASKED, nameOf(chain.chain))}
        </p>
      ))}
      <StepsNote />
      <p
        data-ui="steps-refresh"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm text-muted-foreground"
      >
        <span className="max-w-(--tf-measure-body)">{words.refresh}</span>
        <ReadAgain />
      </p>
    </>
  );
}

/** One vault's steps under its heading, newest first; or the steps filed under no vault. */
function VaultSteps({ group, plans }: { group: StepGroup; plans: PlansAnswer | null }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const heading = useId();
  const words = w.rebalancing.group;
  const { chain, vault, entries } = group;
  const chainName = nameOf(chain.chain);
  const found = vault !== null && plans !== null ? planIn(plans, chain.chain, vault) : null;
  const title: VaultTitle =
    vault === null
      ? { sentence: words.unknown(chainName), notes: [] }
      : found
        ? vaultTitle(found.plan, { t, words: w.overview.card, lang, chainName })
        : { sentence: words.unnamed(chainName), notes: [] };
  // The card is live only when everything it shows is.
  const label = leastLive(
    chain.provenance,
    ...entries.map((entry) => entry.provenance),
    ...(found ? [found.plan.provenance] : []),
  );
  return (
    <li data-ui="vault-steps" data-chain={chain.chain} data-vault={vault ?? ''}>
      <Card
        as="article"
        aria-labelledby={heading}
        mock={label !== 'live'}
        mockLabels={{ announce: sampleLine(t.shell, label) }}
      >
        <header className="flex flex-col items-start gap-2 border-b border-border p-6">
          <h2 id={heading} className="text-h4 font-semibold text-balance">
            {title.sentence}
          </h2>
          {title.notes.map((note) => (
            <p key={note} data-ui="vault-note" className="text-caption text-muted-foreground">
              {note}
            </p>
          ))}
          {/* A vault the plans do not name is told from another by its address. */}
          {vault !== null && !found && (
            <p
              data-ui="vault-address"
              title={vault}
              className="font-mono text-source text-muted-foreground"
            >
              {shorten(vault)}
            </p>
          )}
          {vault === null && (
            <p data-ui="vault-unknown" className="max-w-(--tf-measure-body) text-body-sm">
              {words.unknownWhy}
            </p>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ChainBadge chain={chain.chain} />
            <span data-ui="steps-count" className="text-caption text-muted-foreground">
              {words.count(entries.length)}
            </span>
          </p>
          {vault !== null && (
            <Link
              href={planHref(chain.chain, vault)}
              // every vault's link reads the same: its heading says which plan it opens
              aria-describedby={heading}
              className={buttonClass({ variant: 'link' })}
            >
              {w.overview.card.open}
            </Link>
          )}
        </header>
        <ol className="list-none divide-y divide-border p-0">
          {entries.map((entry) => (
            <RebalanceStep
              key={`${entry.by}:${entry.at}:${entry.txId ?? entry.trades.map((trade) => trade.asset).join('+')}`}
              chain={chain}
              entry={entry}
            />
          ))}
        </ol>
      </Card>
    </li>
  );
}

/** What the list cannot tell yet, said once, with the way to the methodology. */
function StepsNote() {
  const w = useWords();
  const heading = useId();
  const words = w.rebalancing.note;
  return (
    <section
      data-ui="steps-note"
      aria-labelledby={heading}
      className="flex max-w-(--tf-measure-body) flex-col gap-3 border-t border-border pt-6"
    >
      <h2 id={heading} className="text-h4 font-semibold">
        {words.heading}
      </h2>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-body-sm">
        {words.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>
        <Link href={href(METHODOLOGY)} className={buttonClass({ variant: 'link' })}>
          {words.more}
        </Link>
      </p>
    </section>
  );
}

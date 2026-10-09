'use client';
import Link from 'next/link';
import { buttonClass } from '../../components/ui/button-class';
import { PAGE_TITLE } from '../../components/ui/heading';
import { useLang, useT } from '../../i18n/I18nProvider';
import {
  type ExposureAnswer,
  type Plan,
  type PlansAnswer,
  type PlansChain,
  planIn,
  readExposure,
} from './api';
import { PlanActivity } from './PlanActivity';
import { PlanExit, PlanRisk } from './PlanExposure';
import { PlanHead } from './PlanHead';
import { PlanHistory } from './PlanHistory';
import { PlanPositions } from './PlanPositions';
import { PlanTrades } from './PlanTrades';
import { PlanBlocksWait } from './PlanWait';
import { usePortfolioSection, useSectionRead } from './PortfolioProvider';
import { SECTION } from './pages';
import { ChainsOut, ReadAgain, Say, SectionGate, useChainName } from './parts';
import { goalOf } from './plan-goal';
import { useWords } from './words';

// One plan's own page (/portfolio/plan/<chain>/<address>): one plan in one vault, over time. In this
// order, the goal first: the head (the goal as the overview's card states it, where the plan stands,
// what the vault is worth and what was put in), the vault's value over time with the deposits marked,
// each part against its target, what leaving would cost, where the risk sits, the latest trades, and
// the person's own steps beside the disclaimer. Nothing here signs.
//
// `chain` and `address` are the address bar's words, as written. They are read against the person's
// plans, which the section holds, and nothing is asked with them: the page's own reads (the vault's
// history, its exposure) take the chain and the address of the vault the server answered. An address
// that is no vault of the person's is one sentence and the way back, the same whether or not such a
// vault exists. A vault that was never read says so in its head, and one sentence stands in place of
// every figure below it. Each of the page's own reads waits and fails by itself (plan-blocks.tsx).

/** The address as the bar wrote it: one that was escaped on its way is read as it was typed. */
function addressOf(written: string): string {
  try {
    return decodeURIComponent(written);
  } catch {
    return written;
  }
}

export function PlanPage({ chain, address }: { chain: string; address: string }) {
  const t = useT();
  const w = useWords();
  const lang = useLang();
  const nameOf = useChainName();
  const { plans, person } = usePortfolioSection();
  const found = plans.kind === 'read' ? planIn(plans.answer, chain, addressOf(address)) : null;
  const goal = found
    ? goalOf(found.plan, t, w.overview.card, lang, nameOf(found.plan.chain))
    : null;
  return (
    <div
      data-ui="portfolio-plan"
      data-chain={chain}
      data-address={address}
      className="flex flex-col gap-8"
    >
      <header className="flex flex-col gap-3">
        {/* The way back keeps its line while the plans are read, so the title under it does not move. */}
        {(found ||
          (person !== 'signed-out' && (plans.kind === 'idle' || plans.kind === 'reading'))) && (
          <p>
            <Link href={SECTION} data-ui="plan-back" className={buttonClass({ variant: 'link' })}>
              {w.plan.back}
            </Link>
          </p>
        )}
        {/* The serif answers once per screen: the plan's goal once it is read, as on its card; until
            then, and where there is no plan to show, the page's own title, in the same face. */}
        <h1 className={PAGE_TITLE}>{goal ? goal.sentence : w.plan.title}</h1>
        {goal?.notes.map((note) => (
          <p key={note} data-ui="plan-note" className="text-body text-muted-foreground">
            {note}
          </p>
        ))}
      </header>
      <SectionGate read={plans} skeleton={<PlanBlocksWait />}>
        {(answer) =>
          found ? (
            <Found chain={found.chain} plan={found.plan} />
          ) : (
            <Missing answer={answer} chain={chain} />
          )
        }
      </SectionGate>
    </div>
  );
}

/** No vault of the person's at the address: its chain could not be read, or there is none to show. */
function Missing({ answer, chain }: { answer: PlansAnswer; chain: string }) {
  const w = useWords();
  const nameOf = useChainName();
  const back = (
    <Link href={SECTION} className={buttonClass({ variant: 'link' })}>
      {w.plan.back}
    </Link>
  );
  // A chain of theirs that was not read may hold the plan: that is said, and never "there is none".
  const out = answer.unavailable.find((u) => u.chain === chain);
  if (out)
    return (
      <>
        <ChainsOut unavailable={[out]} />
        <Say sentence={w.plan.chainOut(nameOf(out.chain))} action={back} />
      </>
    );
  return <Say sentence={w.plan.notFound} action={back} />;
}

function Found({ chain, plan }: { chain: PlansChain; plan: Plan }) {
  const w = useWords();
  const { rebalances } = usePortfolioSection();
  const { newest } = plan;
  // A vault that was never read has no holdings to add up: nothing is asked for it.
  const exposure = useSectionRead<ExposureAnswer>(
    newest ? `exposure:${plan.chain}:${plan.address}` : null,
    (apiFetch) => readExposure(apiFetch, { chain: plan.chain, address: plan.address }),
  );
  return (
    <div data-ui="plan-blocks" className="flex flex-col gap-10">
      <PlanHead chain={chain} plan={plan} />
      {newest ? (
        <>
          <PlanHistory chain={chain} plan={plan} newest={newest} />
          <PlanPositions chain={chain} plan={plan} newest={newest} />
          <PlanExit chain={chain} plan={plan} read={exposure.reading} />
          <PlanRisk chain={chain} plan={plan} read={exposure.reading} />
        </>
      ) : (
        <Say sentence={w.plan.unread} />
      )}
      <PlanTrades chain={chain} plan={plan} read={rebalances} />
      <p
        data-ui="plan-refresh"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 text-body-sm text-muted-foreground"
      >
        <span>{w.overview.refresh}</span>
        <ReadAgain />
      </p>
      <PlanActivity plan={plan} />
    </div>
  );
}

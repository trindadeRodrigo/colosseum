'use client';
import { ChainBadge } from '../../components/ui/ChainBadge';
import { PAGE_TITLE } from '../../components/ui/heading';
import { StatusMark } from '../../components/ui/StatusMark';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars } from '../goal/sheet';
import { PlanGate } from './PlanGate';
import { PlanPane } from './PlanPane';
import { goalLine, planSummary } from './plain';
import { usePlan } from './use-plan';

// The plan's own page (/plan/{id}): a link to a plan, a plan made from a link, the way back from the
// portfolio. The goal first, in one sentence, then the plan (`PlanPane`), full width. The disclaimer
// from the one constant is the foot of every product page (components/shell/AppShell.tsx), so it is
// on this one once. "Invest $X" leads to the buy; on a chain with no deployment committed for its
// network it is off, and says why. The ways to close a gap are read as sentences.

export function PlanScreen({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const state = usePlan(id);
  const here = `/plan/${encodeURIComponent(id)}`;
  if (state.kind !== 'ready') return <PlanGate state={state} next={here} />;

  const { plan, chain } = state;
  const { proposal } = plan;
  const { sheet } = proposal;
  const chainName = t.chain.names[chain];
  const blocked = state.off
    ? t.plan.chainOff(chainName)
    : state.buyable
      ? null
      : t.plan.chainNotReady(chainName);
  const goal = goalLine(sheet, t, dollars(sheet.amountUsd, lang), (usd) => dollars(usd, lang));
  return (
    <div data-ui="plan-screen" className="flex flex-col gap-8">
      <header className="flex flex-col items-start gap-3">
        <ChainBadge chain={chain} />
        <h1 className={PAGE_TITLE}>{goal}</h1>
        <p data-ui="plan-summary" className="max-w-(--tf-measure-body) text-body-lg">
          {planSummary(proposal, t, lang, chainName)}
        </p>
        <p className="max-w-(--tf-measure-body) text-body">{t.plan.lead(chainName)}</p>
        {plan.fromLink && (
          <p
            data-ui="plan-from-link"
            className="flex max-w-(--tf-measure-body) items-start gap-1.5 text-body-sm"
          >
            <StatusMark status="watch" className="mt-1.5" />
            <span>{t.plan.fromLink}</span>
          </p>
        )}
      </header>
      <PlanPane plan={plan} chain={chain} blocked={blocked} invest={{ href: `${here}/buy` }} />
    </div>
  );
}

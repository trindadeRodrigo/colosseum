'use client';
import { GoalCard } from '../../components/ui/GoalCard';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as whole } from '../goal/sheet';
import { recallPlan } from '../order/plan-store';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import { type PortfolioChain, type Vault, vaultValueSource } from './portfolio';
import { dueOf, type VaultGoal } from './vault-goal';

// A vault as his guide's goal card (guidelines.html, "Goal card and plan"; goal-card.md): the goal in
// one serif sentence, where it stands with its date, what the vault is worth against what was put in,
// the access to cash its plan promised to keep, and one link. Where it stands is the engine's word or
// nothing: an income plan's verdict (met, or not) when it was built; for any other goal the card says
// there is no status yet. A vault this browser cannot join to a goal gets the card with what is known.

const monthYear = (lang: Lang, date: Date) =>
  new Intl.DateTimeFormat(LOCALE[lang], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  );

export function VaultGoalCard({
  chain,
  vault,
  joined,
}: {
  chain: PortfolioChain;
  vault: Vault;
  joined: VaultGoal | null;
}) {
  const t = useT();
  const lang = useLang();
  const port = useWalletPort();
  const words = t.portfolio.goalCard;
  const chainName = port.network(chain.chain)?.name ?? t.chain.names[chain.chain];
  const amount = {
    figure: dollars(lang, vault.valueUsd),
    obs: vaultValueSource(chain, vault, t.portfolio.vault.valueMethod),
  };
  const mock = vault.provenance !== 'live';

  if (!joined)
    return (
      <GoalCard
        sentence={words.unknown(chainName)}
        status={null}
        noStatus={{ sentence: words.notJoined }}
        amount={amount}
        pinLabels={t.pin}
        action={{ label: words.startGoal, href: '/goal' }}
        mock={mock}
      />
    );

  const { goal, record } = joined;
  const { sheet, verdict, card } = goal;
  const due = monthYear(lang, dueOf(goal));
  const plan = recallPlan(record.proposalId, port.userId);
  return (
    <GoalCard
      sentence={t.goal.card.sentence[sheet.goal](
        whole(sheet.amountUsd, lang),
        t.goal.card.months(sheet.horizonMonths),
      )}
      status={
        verdict
          ? {
              kind: verdict.met ? 'on-track' : 'off-track',
              word: verdict.met ? words.onTrack : words.offTrack,
              date: due,
            }
          : null
      }
      noStatus={{ sentence: words.noStatus, date: due }}
      reason={
        verdict && !verdict.met ? t.plan.verdict.gap(whole(verdict.gapUsdMonthly, lang)) : undefined
      }
      amount={amount}
      detail={`${words.putIn(whole(record.amountUsd, lang))} · ${card.exit.text}`}
      pinLabels={t.pin}
      action={
        plan
          ? { label: words.seePlan, href: `/plan/${encodeURIComponent(record.proposalId)}` }
          : { label: words.seeOrder, href: `/orders/${encodeURIComponent(record.orderId)}` }
      }
      mock={mock}
    />
  );
}

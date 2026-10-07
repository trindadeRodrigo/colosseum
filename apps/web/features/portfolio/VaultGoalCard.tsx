'use client';
import Link from 'next/link';
import { GoalCard } from '../../components/ui/GoalCard';
import { type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { dollars as whole } from '../goal/sheet';
import { goalLine } from '../order/plain';
import { useWalletPort } from '../wallet/WalletProvider';
import { dollars } from './figures';
import { type PortfolioChain, type Vault, vaultValueSource } from './portfolio';
import { dueOf, type VaultGoal } from './vault-goal';

// A vault as his guide's goal card (guidelines.html, "Goal card and plan"; goal-card.md): the goal in
// one serif sentence, where it stands with its date, what the vault is worth against what the confirmed
// deposits put in, the access to cash its plan promised to keep, and one link. Where it stands is the
// engine's word or nothing: the engine gives no status for a vault, so the card says only when the
// plan runs to, except that an income plan's verdict is said as the verdict when the plan was built, and only when
// what went in is the plan's amount. A vault this browser cannot join to a goal gets the card with what is known.

const monthYear = (lang: Lang, date: Date) =>
  new Intl.DateTimeFormat(LOCALE[lang], { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    date,
  );

export function VaultGoalCard({
  chain,
  vault,
  joined,
  putIn,
}: {
  chain: PortfolioChain;
  vault: Vault;
  joined: VaultGoal | null;
  /** What the orders confirmed on chain put in, or null when none is (vault-goal.ts, `putInto`). */
  putIn: number | null;
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
  // One line under a card that is not live: a test network's figures say so, a sample's say sample.
  const labels = {
    sample: vault.provenance === 'sandbox' ? t.shell.testNetworkFigures : t.shell.mockAnnounce,
  };

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
        chain={chain.chain}
        linkAs={Link}
        labels={labels}
      />
    );

  const { goal, record } = joined;
  const { sheet, verdict, card } = goal;
  const due = monthYear(lang, dueOf(goal));
  const builtFor = verdict && putIn === sheet.amountUsd ? verdict : null;
  const asked = sheet.incomeTargetUsdMonthly;
  return (
    <GoalCard
      // What went in leads, where the chain confirms it: a goal of $50,000 bought with $40 reads $40.
      sentence={goalLine(sheet, t, whole(putIn ?? sheet.amountUsd, lang), (usd) =>
        whole(usd, lang),
      )}
      status={
        // The engine gives no status for a vault. The one word it gave is the income plan's verdict
        // when the plan was built, for the plan's amount: it is said, as that, only when what went in
        // is that amount.
        builtFor
          ? builtFor.met
            ? { kind: 'on-track', word: words.builtMet, date: due }
            : asked !== undefined
              ? // in figures: what it paid a month of what was asked, which says the gap too
                {
                  kind: 'off-track',
                  word: words.builtPaid(
                    whole(Math.max(0, asked - builtFor.gapUsdMonthly), lang),
                    whole(asked, lang),
                  ),
                }
              : { kind: 'off-track', word: words.builtShort, date: due }
          : null
      }
      // No status is worked out for a vault: the card says when the plan runs to, and no more.
      noStatus={{ sentence: words.runsTo(due) }}
      reason={
        builtFor && !builtFor.met && asked === undefined
          ? t.plan.verdict.gap(whole(builtFor.gapUsdMonthly, lang))
          : undefined
      }
      amount={amount}
      detail={
        putIn === null ? card.exit.text : `${words.putIn(whole(putIn, lang))} · ${card.exit.text}`
      }
      pinLabels={t.pin}
      action={
        // a plan is read back from the server in any tab (use-plan.ts); an order about a shared
        // portfolio names no plan
        record.proposalId
          ? { label: words.seePlan, href: `/plan/${encodeURIComponent(record.proposalId)}` }
          : { label: words.seeOrder, href: `/orders/${encodeURIComponent(record.orderId)}` }
      }
      mock={mock}
      chain={chain.chain}
      linkAs={Link}
      labels={labels}
    />
  );
}

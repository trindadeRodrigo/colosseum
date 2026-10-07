import type { Dictionary, Lang } from '../../i18n';
import type { PortfolioDictionary } from '../../i18n/portfolio';
import { dollars as whole } from '../goal/sheet';
import { goalLine } from '../order/plain';
import type { Plan } from './api';

// What a vault is called on a page that lists several: the sentence the overview's card says for it
// (PlanCard.tsx), which keeps its naming to itself. The same rule, word for word, so a person meets a
// vault under one name on every page of the section: its goal at what was put in; else the shared
// portfolio the chain shows it following, or the one it was opened to follow; else its own name; else
// its chain. rebalancing.events.test.ts holds the two to the same sentences on the sample plans.

export type VaultTitle = {
  /** The vault in one sentence. */
  sentence: string;
  /** What is said under it: the vault's own name, and what it was opened as where that differs. */
  notes: string[];
};

export function vaultTitle(
  plan: Plan,
  a: {
    t: Dictionary;
    /** The overview's own sentences for a vault with no goal. */
    words: PortfolioDictionary['overview']['card'];
    lang: Lang;
    chainName: string;
  },
): VaultTitle {
  const { t, words, lang } = a;
  const named = plan.name ? [plan.name] : [];
  const sheet = plan.plan?.sheet;
  if (sheet) {
    // The goal at what was put in, as the card says it: a goal of $50,000 that $80,000 went into is
    // not said as $50,000, and the income asked of the plan's amount is not said of another.
    const put = plan.putIn ? Number(plan.putIn.usd) : null;
    const sentence =
      put !== null && put !== sheet.amountUsd
        ? goalLine({ ...sheet, incomeTargetUsdMonthly: undefined }, t, whole(put, lang), (usd) =>
            whole(usd, lang),
          )
        : goalLine(sheet, t, whole(sheet.amountUsd, lang), (usd) => whole(usd, lang));
    return { sentence, notes: named };
  }
  const followed = plan.follows?.name;
  const opened = plan.openedFor;
  if (followed) {
    // What the chain shows now leads; what the vault was opened as is said under it when it differs.
    const differs =
      opened !== null &&
      plan.follows?.familyId !== undefined &&
      plan.follows.familyId !== opened.familyId;
    return {
      sentence: words.follows(followed),
      notes: differs ? [words.openedAs(opened.name), ...named] : named,
    };
  }
  if (opened) return { sentence: words.openedFor(opened.name), notes: named };
  if (plan.follows || plan.plan?.kind === 'follow')
    return { sentence: words.followsShared, notes: named };
  if (plan.name) return { sentence: plan.name, notes: [] };
  return { sentence: words.unknown(a.chainName), notes: [] };
}

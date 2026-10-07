import type { Dictionary, Lang } from '../../i18n';
import type { PortfolioDictionary } from '../../i18n/portfolio';
import { dollars as whole } from '../goal/sheet';
import { goalLine } from '../order/plain';
import type { Plan } from './api';

// The goal of a plan, as its own page says it: the sentence the overview's card states (PlanCard.tsx),
// word for word, with the same words of the dictionary (overview.card), so the page a card opens is
// headed by what the card said. plan.events.test.ts mounts the two and holds them to each other.
//
// A plan made to measure says its goal from its sheet, at what was put in. A vault with no goal of its
// own says what it follows, what it was opened to follow, its own name, or its chain.

export type SaidGoal = {
  /** The one serif line. */
  sentence: string;
  /** Under it: the vault's own name, and what it was opened as where the chain shows another. */
  notes: string[];
};

type CardWords = PortfolioDictionary['overview']['card'];

function unnamed(plan: Plan, words: CardWords, chainName: string): SaidGoal {
  const named = plan.name ? [plan.name] : [];
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
  return { sentence: words.unknown(chainName), notes: [] };
}

export function goalOf(
  plan: Plan,
  t: Pick<Dictionary, 'goal'>,
  words: CardWords,
  lang: Lang,
  chainName: string,
): SaidGoal {
  const sheet = plan.plan?.sheet;
  if (!sheet) return unnamed(plan, words, chainName);
  const put = plan.putIn ? Number(plan.putIn.usd) : null;
  return {
    // The goal at what was put in: a goal of $50,000 that $80,000 went into is said of $80,000, and
    // the income asked of the plan's amount is not said of another.
    sentence:
      put !== null && put !== sheet.amountUsd
        ? goalLine({ ...sheet, incomeTargetUsdMonthly: undefined }, t, whole(put, lang), (usd) =>
            whole(usd, lang),
          )
        : goalLine(sheet, t, whole(sheet.amountUsd, lang), (usd) => whole(usd, lang)),
    notes: plan.name ? [plan.name] : [],
  };
}

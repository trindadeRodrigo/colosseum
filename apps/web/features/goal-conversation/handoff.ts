import { GOAL_HANDOFF, GOAL_HANDOFF_OWNER } from '../goal/draft';
import { GOAL_TEXT } from '../goal/read-goal';

const bounded = (words: string | null): words is string =>
  words !== null && words.trim() !== '' && words.length <= GOAL_TEXT.max;

/** Only plain person words. A known person's pending words never prefill another person's draft. */
export function readGoalHandoff(userId: string | null, verified: boolean): string | null {
  try {
    const fragment = /^#goal=(.*)$/.exec(window.location.hash)?.[1];
    if (fragment !== undefined) {
      let words: string | null = null;
      try {
        words = decodeURIComponent(fragment);
      } catch {
        return null;
      }
      if (!bounded(words)) return null;
      if (sessionStorage.getItem(GOAL_HANDOFF) !== words) {
        sessionStorage.setItem(GOAL_HANDOFF, words);
        sessionStorage.removeItem(GOAL_HANDOFF_OWNER);
      }
    }
    const words = sessionStorage.getItem(GOAL_HANDOFF);
    if (!bounded(words)) return null;
    const bound = sessionStorage.getItem(GOAL_HANDOFF_OWNER);
    if (bound !== null && bound !== userId) return null;
    if (verified && userId && bound === null) sessionStorage.setItem(GOAL_HANDOFF_OWNER, userId);
    return words;
  } catch {
    return null;
  }
}

/** A reply is not required: already-saved person words survive API failure in their scoped history. */
export function consumeGoalHandoff(words: string, userId: string): void {
  try {
    if (
      sessionStorage.getItem(GOAL_HANDOFF) !== words ||
      sessionStorage.getItem(GOAL_HANDOFF_OWNER) !== userId
    )
      return;
    sessionStorage.removeItem(GOAL_HANDOFF);
    sessionStorage.removeItem(GOAL_HANDOFF_OWNER);
    const fragment = /^#goal=(.*)$/.exec(window.location.hash)?.[1];
    if (fragment !== undefined && decodeURIComponent(fragment) === words)
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* The person words are already kept in scoped history. */
  }
}

// Where the goal a person typed, and how it was read, is kept while they sign in and come back: in the
// tab, and nowhere else. It is one person's: when they sign out, or another person signs in, it is
// forgotten (AccountProvider), so the next person at this browser does not find it.

export const GOAL_DRAFT = 'tf-goal';

/**
 * A goal typed on the landing page (`/`), handed to this screen to be read as it opens. The landing
 * page reads nothing itself: it has no sign-in and no API. Taken once, then removed.
 */
export const GOAL_HANDOFF = 'tf-goal-handoff';

export function forgetGoalDraft(): void {
  try {
    window.sessionStorage.removeItem(GOAL_DRAFT);
  } catch {
    // No storage in this browser: there is nothing to forget.
  }
}

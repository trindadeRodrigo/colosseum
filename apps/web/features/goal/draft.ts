// Where the goal a person typed, and how it was read, is kept while they sign in and come back: in the
// tab, and nowhere else. It is one person's: when they sign out, or another person signs in, it is
// forgotten (AccountProvider), so the next person at this browser does not find it.

export const GOAL_DRAFT = 'tf-goal';

export function forgetGoalDraft(): void {
  try {
    window.sessionStorage.removeItem(GOAL_DRAFT);
  } catch {
    // No storage in this browser: there is nothing to forget.
  }
}

/**
 * A goal typed on the landing page (`/`), handed to this screen to be read as it opens. The landing
 * page reads nothing itself: it has no sign-in and no API. Taken once, then removed.
 */
export const GOAL_HANDOFF = 'tf-goal-handoff';
/** Browser-only attribution for an unconsumed plain-word handoff, never financial state. */
export const GOAL_HANDOFF_OWNER = `${GOAL_HANDOFF}:owner`;

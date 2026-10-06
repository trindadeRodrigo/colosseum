// The personalization engine (DESIGN-VAULT section 7): a goal and its limits, turned into a plan made
// to measure. `compose` is the one entry; everything else here is what a caller needs to feed it and
// to read what it returns.

export { candidates } from './candidates';
export { compose, composeAs, PERSONAL_ENGINE_VERSION } from './compose';
export { draftFromRules } from './draft';
// The guided intake (gate GUIDED-INTAKE, ENG-3 slice 4): the checks after the model, the questions
// and the read-back. The model call itself is the API's (apps/api/src/llm.ts).
export {
  Disagreement,
  IntakeAnswers,
  type IntakeInput,
  IntakeQuestion,
  type IntakeResult,
  LimitsDraft,
  QUESTION_FIELDS,
  type QuestionField,
  readReply,
  runIntake,
  type ShelfPortfolio,
} from './intake';
export { amountInText, horizonsIn, mentionsIn, refusalsIn } from './intake-text';
export { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
export { readBack } from './readback';
export {
  proposeSleeveRebalances,
  SleeveBook,
  type SleeveProposal,
  type SleeveProposals,
  SleeveRebalanceContext,
  type SleeveRebalanceKind,
  type SleeveRef,
  StoredPlan,
  settleBook,
} from './rebalance';
export { eligibleForGoal, profileOfGoal, registryRowOf, sleeveOfClass } from './registry';
export {
  INPUT_NAMES,
  type InputName,
  QUESTION_TEMPLATES,
  READBACK_TEMPLATES,
  REASON_TEMPLATES,
  type RuleId,
  TEXT_TEMPLATES,
} from './templates';
export { parseThemeList, ThemeList } from './theme-list';
export * from './types';

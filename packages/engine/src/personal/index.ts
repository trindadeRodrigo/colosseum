// The personalization engine (DESIGN-VAULT section 7): a goal and its limits, turned into a plan made
// to measure. `compose` is the one entry; everything else here is what a caller needs to feed it and
// to read what it returns.

export { compose, PERSONAL_ENGINE_VERSION } from './compose';
export { draftFromRules } from './draft';
// The guided intake (gate GUIDED-INTAKE, ENG-3 slice 4): the checks after the model, the questions
// and the read-back. The model call itself is the API's (apps/api/src/llm.ts).
export {
  conversationText,
  Disagreement,
  IntakeAnswers,
  type IntakeInput,
  IntakeNarrative,
  IntakeQuestion,
  type IntakeResult,
  LimitsDraft,
  QUESTION_FIELDS,
  type QuestionField,
  readReply,
  riskForMixEstimate,
  runIntake,
  type ShelfPortfolio,
} from './intake';
export {
  amountInText,
  exitTimesIn,
  horizonsIn,
  MARKET_IDS,
  type Market,
  type MarketMention,
  marketMentionsIn,
  marketShareIn,
  marketsIn,
  mentionsIn,
  mixIn,
  NARRATIVES,
  type Narrative,
  openEndedIn,
  otherLanguageIn,
  refusalsIn,
} from './intake-text';
// The market filter (gate THEME-MATCHED): the one contract between the intake, which names a filter,
// and the theme sleeve, which fills it. A caller of the intake hands in its labels and its matches in
// these types.
export {
  attributeKey,
  type FilterMatch,
  filterOfSlug,
  isMatchedSlug,
  MARKET_FILTER_BY,
  MATCHED_PREFIX,
  MarketFilter,
  type MarketFilterBy,
  matchedSlug,
  type ShelfLabel,
} from './market-filter';
export { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
export { matchedName, readBack, type ThemeNames } from './readback';
export { eligibleForGoal, profileOfGoal, registryRowOf, sleeveOfClass } from './registry';
export {
  ASSUMPTION_TEMPLATES,
  FILTER_BY_WORDS,
  INPUT_NAMES,
  type InputName,
  MATCHED_NAME,
  QUESTION_TEMPLATES,
  READBACK_TEMPLATES,
  REASON_TEMPLATES,
  type RuleId,
  TEXT_TEMPLATES,
} from './templates';
export * from './types';

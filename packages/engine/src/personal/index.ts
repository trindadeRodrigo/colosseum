// The personalization engine (DESIGN-VAULT section 7): a goal and its limits, turned into a plan made
// to measure. `compose` is the one entry; everything else here is what a caller needs to feed it and
// to read what it returns.

export { candidates } from './candidates';
export {
  amountToMeet,
  compose,
  composeAs,
  PERSONAL_ENGINE_VERSION,
  riskForMix,
} from './compose';
export { draftFromRules } from './draft';
export { type FixedLine, type FixedMix, type FixedPick, fixedMix } from './fixed-mix';
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
// What the intake reads of a text by code. The readers of the second review (Oct 7) are here too:
// the last word on a class or a mix across messages (`classMentionsIn`, `mixSaidInTurns`,
// `TURN_BREAK`), what a message answers in words (`noneSaidIn`, `evenSplitSaidIn`), where the rest of
// the money goes (`restOfMoneyIn`, `carvedOutAfter`), a name a plan cannot leave out
// (`namesRuledOutIn`), a risk the text rules out (`risksRuledOutIn`), whether a person's words write
// a filter's value (`wordsWrite`) and how a shared portfolio's name is said (`portfolioSaidAt`).
export {
  amountInText,
  carvedOutAfter,
  classMentionsIn,
  evenSplitSaidIn,
  exitTimesIn,
  horizonsIn,
  MARKET_IDS,
  type Market,
  type MarketMention,
  type MarketShare,
  type MixSaid,
  marketMentionsIn,
  marketShareIn,
  marketsIn,
  mentionsIn,
  mixIn,
  mixSaidIn,
  mixSaidInTurns,
  NARRATIVES,
  type Narrative,
  namesRuledOutIn,
  noneSaidIn,
  openEndedIn,
  otherLanguageIn,
  portfolioSaidAt,
  type RefusalSaid,
  type Refused,
  refusalsIn,
  refusalsSaidIn,
  restOfMoneyIn,
  risksRuledOutIn,
  type ShareSaid,
  type Stance,
  shareSaidIn,
  stanceOf,
  type TimeFrame,
  TURN_BREAK,
  timeFramesIn,
  wordsWrite,
  yesOrNoSaidIn,
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
export {
  attributeVocabularyOf,
  companyNamesOf,
  type FilterRead,
  filterMatchOf,
  type MatchedList,
  matchedListOf,
  matchStocks,
  type SleeveList,
  shelfLabelsOf,
} from './matched-theme';
export { RISKS } from './mix';
export { INTAKE_LIMITS, PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
export { matchedName, readBack, type TermSaid, type ThemeNames } from './readback';
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
export { riskForSleeves } from './sleeve-risk';
export { parseStockAttributes, StockAttributes, StockAttributesFile } from './stock-attributes';
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
  reason,
  TERM_SAID,
  TEXT_TEMPLATES,
} from './templates';
export { parseThemeList, ThemeList } from './theme-list';
export * from './types';

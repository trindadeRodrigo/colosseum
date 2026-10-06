// The personalization engine (DESIGN-VAULT section 7): a goal and its limits, turned into a plan made
// to measure. `compose` is the one entry; everything else here is what a caller needs to feed it and
// to read what it returns.

export { candidates } from './candidates';
export { compose, composeAs, PERSONAL_ENGINE_VERSION, riskForMix } from './compose';
export { draftFromRules } from './draft';
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
  type FilterRead,
  filterMatchOf,
  type MatchedList,
  matchedListOf,
  matchStocks,
  type SleeveList,
  shelfLabelsOf,
} from './matched-theme';
export { growthRoomBps, RISKS } from './mix';
export { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
export { eligibleForGoal, profileOfGoal, registryRowOf, sleeveOfClass } from './registry';
export { parseStockAttributes, StockAttributes, StockAttributesFile } from './stock-attributes';
export {
  INPUT_NAMES,
  type InputName,
  REASON_TEMPLATES,
  type RuleId,
  TEXT_TEMPLATES,
} from './templates';
export { parseThemeList, ThemeList } from './theme-list';
export * from './types';

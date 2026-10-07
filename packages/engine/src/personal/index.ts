// The personalization engine (DESIGN-VAULT section 7): a goal and its limits, turned into a plan made
// to measure. `compose` is the one entry; everything else here is what a caller needs to feed it and
// to read what it returns.

export { compose, PERSONAL_ENGINE_VERSION } from './compose';
export { draftFromRules } from './draft';
export { PERSONAL_PARAMS, PERSONAL_PARAMS_STATUS } from './params';
export { eligibleForGoal, profileOfGoal, registryRowOf, sleeveOfClass } from './registry';
export {
  INPUT_NAMES,
  type InputName,
  REASON_TEMPLATES,
  type RuleId,
  TEXT_TEMPLATES,
} from './templates';
export * from './types';
export { primaryYieldsOf } from './world';

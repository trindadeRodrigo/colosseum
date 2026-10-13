import type { Lang } from '../index';
import { type BearingDictionary, bearingEn } from './en';
import { bearingPt } from './pt';

// The sentences of Bearing's analytics, by language. Only the section and its routes import this.

export type { BearingDictionary } from './en';

const BY_LANG: Record<Lang, BearingDictionary> = { en: bearingEn, pt: bearingPt };

export function bearingDictionary(lang: Lang): BearingDictionary {
  return BY_LANG[lang];
}

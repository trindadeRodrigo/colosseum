import type { Lang } from '../index';
import { type PortfolioDictionary, portfolioEn } from './en';
import { portfolioPt } from './pt';

// The sentences of the portfolio section, by language. Only the section and its routes import this.

export type { PortfolioDictionary } from './en';

const BY_LANG: Record<Lang, PortfolioDictionary> = { en: portfolioEn, pt: portfolioPt };

export function portfolioDictionary(lang: Lang): PortfolioDictionary {
  return BY_LANG[lang];
}

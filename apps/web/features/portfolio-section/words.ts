'use client';
import { useLang } from '../../i18n/I18nProvider';
import { type PortfolioDictionary, portfolioDictionary } from '../../i18n/portfolio';

/** The section's sentences, in the language of the view. */
export const useWords = (): PortfolioDictionary => portfolioDictionary(useLang());

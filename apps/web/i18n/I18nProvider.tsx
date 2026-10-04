'use client';
import { createContext, type ReactNode, useContext } from 'react';
import { DEFAULT_LANG, type Dictionary, dictionary, type Lang } from './index';

// The language of the view, for client components. The shell's layout reads it on the server and
// hands it down; a client component reads its sentences with `useT()`.

const LangContext = createContext<Lang>(DEFAULT_LANG);

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}

export function useLang(): Lang {
  return useContext(LangContext);
}

/** The sentences of the view's language. */
export function useT(): Dictionary {
  return dictionary(useContext(LangContext));
}

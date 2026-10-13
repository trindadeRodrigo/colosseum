import type { Language } from '@colosseum/schemas';
import { type Dictionary, en } from './en';
import { pt } from './pt';

// The dictionary of the product screens: one object per language, the same keys in each. A plain
// module, so a server component and a client component both read it. Only the language crosses from
// one to the other: a dictionary holds functions, and a function cannot be handed to the browser.

export type { Dictionary } from './en';
export type Lang = Language;

export const LANGS: readonly Lang[] = ['en', 'pt'];
export const DEFAULT_LANG: Lang = 'en';

/** What `<html lang>` and a number format take. Portuguese here is Brazilian. */
export const LOCALE: Record<Lang, string> = { en: 'en', pt: 'pt-BR' };

const DICTIONARIES: Record<Lang, Dictionary> = { en, pt };

export function dictionary(lang: Lang): Dictionary {
  return DICTIONARIES[lang];
}

export const isLang = (value: unknown): value is Lang =>
  typeof value === 'string' && (LANGS as readonly string[]).includes(value);

/** The cookies the shell reads on the server. Each holds a choice the person made, and nothing else. */
export const LANG_COOKIE = 'tf-lang';
export const THEME_COOKIE = 'tf-theme';
/**
 * That a person is signed in on this browser, and nothing else: no id, no token. The landing page
 * (`/`) reads it on the server to send them straight to their goal. It is a hint for where to go,
 * never a proof of who someone is: the API checks the sign-in on every call.
 */
export const SIGNED_IN_COOKIE = 'tf-in';

/**
 * The language of a request: the person's own choice if they made one, or the first of ours that
 * their browser asks for, or English. `accept` is the Accept-Language header.
 */
export function pickLang(chosen: string | undefined, accept: string | null | undefined): Lang {
  if (isLang(chosen)) return chosen;
  const wanted = (accept ?? '')
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      const weight = q === undefined ? 1 : Number(q);
      return { tag: tag.toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag !== '' && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of wanted) {
    const base = tag.split('-')[0];
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}

export type Theme = 'light' | 'dark';
/** `auto` follows the system; the other two are the person's choice. */
export type ThemeChoice = Theme | 'auto';

export const themeChoice = (chosen: string | undefined): ThemeChoice =>
  chosen === 'light' || chosen === 'dark' ? chosen : 'auto';

/** The class `<html>` carries for a choice: `tf-auto` follows the system with no script. */
export const THEME_CLASS: Record<ThemeChoice, string> = {
  auto: 'tf-auto',
  light: 'light',
  dark: 'dark',
};

/** `{n}` filled in. The primitives' own labels use this form. */
export const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );

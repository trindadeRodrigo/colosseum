import { cookies, headers } from 'next/headers';
import {
  LANG_COOKIE,
  type Lang,
  pickLang,
  THEME_COOKIE,
  type ThemeChoice,
  themeChoice,
} from './index';

/**
 * What the person chose, read on the server so the first paint is already right: no script decides
 * the language or the theme in the browser, so nothing flashes. Reading a cookie makes the route
 * dynamic, which the product's screens are anyway: each is about one person's wallet.
 */
export async function readPreferences(): Promise<{ lang: Lang; theme: ThemeChoice }> {
  const [jar, head] = await Promise.all([cookies(), headers()]);
  return {
    lang: pickLang(jar.get(LANG_COOKIE)?.value, head.get('accept-language')),
    theme: themeChoice(jar.get(THEME_COOKIE)?.value),
  };
}

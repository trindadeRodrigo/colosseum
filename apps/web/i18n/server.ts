import { cookies } from 'next/headers';
import { type Lang, THEME_COOKIE, type ThemeChoice, themeChoice } from './index';

/**
 * What the person chose, read on the server so the first paint is already right: no script decides
 * the language or the theme in the browser, so nothing flashes. Reading a cookie makes the route
 * dynamic, which the product's screens are anyway: each is about one person's wallet.
 */
export async function readPreferences(): Promise<{ lang: Lang; theme: ThemeChoice }> {
  const jar = await cookies();
  return {
    // English only (Rodrigo, Oct 8: "no need for a pt-br version"): no switch, and the browser's
    // language is not read. The Portuguese dictionary stays until it is removed with its tests.
    lang: 'en',
    theme: themeChoice(jar.get(THEME_COOKIE)?.value),
  };
}

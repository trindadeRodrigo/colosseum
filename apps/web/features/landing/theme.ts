import { cookies } from 'next/headers';
import { THEME_COOKIE, type ThemeChoice } from '../../i18n';

/**
 * The landing's ground: dark unless the visitor chose (token-mapping.md, section 6). A choice of
 * "System" is stored as the word `auto` here (ThemeSwitch `keepSystem`), so it follows the system on
 * the next visit too, where no choice at all is dark.
 */
export async function landingTheme(): Promise<ThemeChoice> {
  const chosen = (await cookies()).get(THEME_COOKIE)?.value;
  return chosen === 'light' || chosen === 'auto' ? chosen : 'dark';
}

import type { ReactNode } from 'react';
import { fontVariables } from '../fonts';
import '../globals.css';
import { dictionary, LOCALE, THEME_CLASS } from '../../i18n';
import { I18nProvider } from '../../i18n/I18nProvider';
import { readPreferences } from '../../i18n/server';

// His landing page's document (compact-nav.md, joint-stage.md): the three faces, the language, and
// the ground. Marketing is dark unless the visitor chose otherwise (token-mapping.md, section 6), so
// with no choice made the class is `dark`, not `tf-auto`. No wallet, no sign-in and no API here: the
// page sends a goal on to the product (`/goal`), which has all three.

export async function generateMetadata() {
  const { lang } = await readPreferences();
  const t = dictionary(lang).landing;
  return { title: `tenonfi · ${t.title}`, description: t.description };
}

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const { lang, theme } = await readPreferences();
  return (
    <html
      lang={LOCALE[lang]}
      className={`${fontVariables} ${theme === 'auto' ? 'dark' : THEME_CLASS[theme]}`}
    >
      <body className="tf-app">
        <I18nProvider lang={lang}>{children}</I18nProvider>
      </body>
    </html>
  );
}

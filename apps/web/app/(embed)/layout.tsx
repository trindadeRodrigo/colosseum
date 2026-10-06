import type { ReactNode } from 'react';
import '../globals.css';
import { dictionary, LOCALE } from '../../i18n';
import { I18nProvider } from '../../i18n/I18nProvider';
import { readPreferences } from '../../i18n/server';

// The partner embed's document (embed-shell.md, "Routing fix"): a bare root. No bar, no wallet, no
// providers, no font of ours: the partner's face, colours and radius take over (features/embed), and
// the system's colours follow the host's colour scheme where the partner names none.

export async function generateMetadata() {
  const { lang } = await readPreferences();
  return { title: dictionary(lang).embed.label, robots: { index: false } };
}

export default async function EmbedLayout({ children }: { children: ReactNode }) {
  const { lang } = await readPreferences();
  return (
    <html lang={LOCALE[lang]} style={{ colorScheme: 'light dark' }}>
      <body style={{ margin: 0, background: 'transparent' }}>
        <I18nProvider lang={lang}>{children}</I18nProvider>
      </body>
    </html>
  );
}

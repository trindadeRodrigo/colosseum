import type { ReactNode } from 'react';
import { AppDocument } from '../../components/shell/AppDocument';
import { dictionary } from '../../i18n';
import { readPreferences } from '../../i18n/server';

// The product's routes share one layout: the shell on the design system (components/shell). The pages
// written before it are in app/(structurer), with the layout they had.

export async function generateMetadata() {
  const { lang } = await readPreferences();
  return { title: 'tenonfi', description: dictionary(lang).goal.title };
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppDocument>{children}</AppDocument>;
}

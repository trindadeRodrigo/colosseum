import { portfolioDictionary } from '../../i18n/portfolio';
import { readPreferences } from '../../i18n/server';
import type { SectionPage } from './pages';

/**
 * What a browser tab and a link preview say about a page of the section, in the language of the
 * view: the page's name, then the section's, and the page's one line.
 */
export async function sectionMetadata(page: SectionPage) {
  const t = portfolioDictionary((await readPreferences()).lang);
  return { title: `${t[page].label} · ${t.shell.head}`, description: t[page].title };
}

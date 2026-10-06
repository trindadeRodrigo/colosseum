import { notFound } from 'next/navigation';
import { BearingPage } from '../../../../features/bearing/BearingPage';
import { isPageId, PAGES } from '../../../../features/bearing/pages';
import { bearingDictionary } from '../../../../i18n/bearing';
import { readPreferences } from '../../../../i18n/server';

// One of Bearing's five analytics pages: stocks, commodities, stablecoins, lending, simulation. The
// figures are read in the browser from the risk API (features/bearing/data.ts).

export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ page: p.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const t = bearingDictionary((await readPreferences()).lang);
  if (!isPageId(page)) return { title: t.head };
  return { title: `${t.pages[page].label} · ${t.head}`, description: t.pages[page].lede };
}

export default async function AnalyticsPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!isPageId(page)) notFound();
  return <BearingPage page={page} />;
}

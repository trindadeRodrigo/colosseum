import { notFound } from 'next/navigation';
import { BearingPage } from '../../../../features/bearing/BearingPage';
import { isPageId, PAGES } from '../../../../features/bearing/pages';

// One of Bearing's five analytics pages: stocks, commodities, stablecoins, lending, simulation. The
// figures are read in the browser from the risk API (features/bearing/data.ts).

export const dynamicParams = false;

export function generateStaticParams() {
  return PAGES.map((p) => ({ page: p.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const p = PAGES.find((x) => x.id === page);
  return { title: p ? `${p.label}, Bearing analytics` : 'Bearing analytics', description: p?.lede };
}

export default async function AnalyticsPage({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  if (!isPageId(page)) notFound();
  return <BearingPage page={page} />;
}

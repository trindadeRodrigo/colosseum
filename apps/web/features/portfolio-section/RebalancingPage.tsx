'use client';
import { PageHead, Say } from './parts';
import { useWords } from './words';

// The rebalancing page (/portfolio/rebalancing): not built yet. It says so, and shows nothing in its
// place. The page's builder replaces this file whole; the frame hands it the section's reads
// (`usePortfolioSection().rebalances`) and its words (i18n/portfolio/<lang>/rebalancing.ts).

export function RebalancingPage() {
  const w = useWords();
  return (
    <div data-ui="portfolio-rebalancing" className="flex flex-col gap-8">
      <PageHead title={w.rebalancing.title} />
      <Say sentence={w.shell.soon} />
    </div>
  );
}

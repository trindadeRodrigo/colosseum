'use client';
import { PageHead, Say } from './parts';
import { useWords } from './words';

// One plan's own page (/portfolio/plan/<chain>/<address>): not built yet. It says so, and shows
// nothing in its place. The page's builder replaces this file whole. `chain` and `address` are the
// address bar's words, as written: the page reads them before it asks anything with them. The frame
// hands it the person's plans (`usePortfolioSection().plans`), a read of its own for the vault's
// history (`useSectionRead` with `readHistory`), and its words (i18n/portfolio/<lang>/plan.ts).

export function PlanPage({ chain, address }: { chain: string; address: string }) {
  const w = useWords();
  return (
    <div
      data-ui="portfolio-plan"
      data-chain={chain}
      data-address={address}
      className="flex flex-col gap-8"
    >
      <PageHead title={w.plan.title} />
      <Say sentence={w.shell.soon} />
    </div>
  );
}

'use client';
import { PageHead, Say } from './parts';
import { useWords } from './words';

// The exposure page (/portfolio/exposure): not built yet. It says so, and shows nothing in its place.
// The page's builder replaces this file whole; the frame hands it the section's reads
// (`usePortfolioSection().exposure`) and its words (i18n/portfolio/<lang>/exposure.ts).

export function ExposurePage() {
  const w = useWords();
  return (
    <div data-ui="portfolio-exposure" className="flex flex-col gap-8">
      <PageHead title={w.exposure.title} />
      <Say sentence={w.shell.soon} />
    </div>
  );
}

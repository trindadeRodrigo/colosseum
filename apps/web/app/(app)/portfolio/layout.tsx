import type { ReactNode } from 'react';
import { QuietPins } from '../../../components/ui/ProvenancePin';
import { PortfolioProvider } from '../../../features/portfolio-section/PortfolioProvider';
import { PortfolioShell } from '../../../features/portfolio-section/PortfolioShell';

// The portfolio section (PORT-3): a person's plans over time, behind one side menu. The provider
// holds the reads of the signed-in person while they move between its pages; the shell is the menu,
// the page and the disclaimer under it. Additive: the monitor (/monitor) is as it was.

export default function PortfolioLayout({ children }: { children: ReactNode }) {
  return (
    <PortfolioProvider>
      <QuietPins>
        <PortfolioShell>{children}</PortfolioShell>
      </QuietPins>
    </PortfolioProvider>
  );
}

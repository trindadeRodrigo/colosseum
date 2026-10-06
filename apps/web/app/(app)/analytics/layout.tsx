import type { ReactNode } from 'react';
import { BearingProvider } from '../../../features/bearing/BearingProvider';
import { BearingShell } from '../../../features/bearing/BearingShell';

// Bearing's analytics (Rodrigo's Analytics 2.0): five pages behind one side menu, and the methodology.
// The provider holds the reads of the risk API and the person's choices while they move between pages.

export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  return (
    <BearingProvider>
      <BearingShell>{children}</BearingShell>
    </BearingProvider>
  );
}

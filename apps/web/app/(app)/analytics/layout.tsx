import type { ReactNode } from 'react';
import { BearingFromBar } from '../../../features/bearing/BearingFromBar';
import { BearingShell } from '../../../features/bearing/BearingShell';

// Bearing's analytics (Rodrigo's Analytics 2.0): five pages behind one side menu, and the methodology.
// The provider holds the reads of the risk API and the person's choices while they move between pages,
// and the chain they are read for, which follows the app's bar.

export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  return (
    <BearingFromBar>
      <BearingShell>{children}</BearingShell>
    </BearingFromBar>
  );
}

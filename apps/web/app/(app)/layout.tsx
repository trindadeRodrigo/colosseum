import type { ReactNode } from 'react';
import { AppDocument } from '../../components/shell/AppDocument';
import { shellMetadata } from '../../components/shell/metadata';
import { productThemeColor } from '../../lib/brand-grounds';

// The product's routes share one layout: the shell on the design system (components/shell). The pages
// written before it are in app/(structurer), with the layout they had.

export const viewport = { themeColor: productThemeColor };

export function generateMetadata() {
  return shellMetadata();
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppDocument>{children}</AppDocument>;
}

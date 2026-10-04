import type { ReactNode } from 'react';
import { AppDocument } from '../../components/shell/AppDocument';

// `layout.dev.tsx` is a layout only under `next dev` (next.config.ts adds the extension in that phase
// and in no other). The development pages sit in the product's shell, so the showcase and the wallet
// check are seen on the same ground, in the same faces, as the screens they are for.
export const metadata = { title: 'Development' };

export default function DevLayout({ children }: { children: ReactNode }) {
  return <AppDocument>{children}</AppDocument>;
}

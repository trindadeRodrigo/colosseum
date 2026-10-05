import type { ReactNode } from 'react';

/** Unbranded partner frame: no nav, no wallet button; the host app owns the chrome. Named partner branding only with written permission. */
export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-gray-300 p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-gray-400">
        Partner embed · unbranded
      </p>
      {children}
    </div>
  );
}

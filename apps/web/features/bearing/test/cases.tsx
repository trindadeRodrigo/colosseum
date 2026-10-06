import type { ReactNode } from 'react';
import { I18nProvider } from '../../../i18n/I18nProvider';
import { BearingProvider } from '../BearingProvider';
import { BearingShell } from '../BearingShell';
import { CAPTURED, snapshotReader } from './snapshot';

// Bearing mounted on Rodrigo's recording of the risk API, its clock three hours after the capture: the
// time of week is his (weekend) and every figure is stale, as his snapshot shows them.

export const NOW = CAPTURED + 3 * 3600e3;

export function onSnapshot(children: ReactNode, reader = snapshotReader()) {
  return (
    <BearingProvider reader={reader} now={NOW}>
      <BearingShell>{children}</BearingShell>
    </BearingProvider>
  );
}

/** The same, for a reader whose language is Portuguese. */
export function inPortuguese(node: ReactNode) {
  return <I18nProvider lang="pt">{node}</I18nProvider>;
}

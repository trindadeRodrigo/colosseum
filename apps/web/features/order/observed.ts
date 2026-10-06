import type { ObservationRef } from '@colosseum/schemas';
import type { PinSource } from '../../components/ui/provenance';

/** The first observation of a kind, as a pin takes it. Null when the plan names none: the pin shows a dash. */
export const observed = (
  observations: readonly ObservationRef[],
  kind: ObservationRef['kind'],
): PinSource | null => {
  const o = observations.find((x) => x.kind === kind);
  return o
    ? { source: o.source, fetchedAt: o.fetchedAt, method: o.method, provenance: o.provenance }
    : null;
};

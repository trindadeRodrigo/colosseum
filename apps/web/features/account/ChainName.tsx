import type { Provenance } from '@colosseum/schemas';
import { MockPlate, TestNetworkPlate } from '../../components/ui/MockPlate';

// A chain's name as a screen shows it, with what a person has to know about where it runs. A chain the
// API runs on the mock, and a chain on a test network, are not live, and they are not the same thing:
// a mock carries the MOCK plate, a test network the plate that says "test network" and no MOCK
// (DESIGN-VAULT section 2, "Test networks"). Only `live` has no mark; a label this build does not know
// is shown as a mock.

export type ChainMarkLabels = { testNetwork: string; mockAnnounce: string };

export type ChainMarkProps = {
  /** How the chain is run here: `port.network(chain).provenance`. */
  provenance: Provenance;
  labels: ChainMarkLabels;
  /** The hidden sentence for screen readers goes once per panel: false on a second mark in it. */
  announce?: boolean;
};

/** The mark alone, for beside a control that already says the name. Nothing for a live chain. */
export function ChainMark({ provenance, labels, announce = true }: ChainMarkProps) {
  if (provenance === 'live') return null;
  return (
    <span data-ui="chain-mark" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {provenance === 'sandbox' ? (
        <TestNetworkPlate label={labels.testNetwork} />
      ) : (
        <MockPlate announce={announce} labels={{ announce: labels.mockAnnounce }} />
      )}
    </span>
  );
}

/** The name, then the mark. */
export function ChainName({ name, ...mark }: ChainMarkProps & { name: string }) {
  return (
    <span data-ui="chain-name" className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{name}</span>
      <ChainMark {...mark} />
    </span>
  );
}

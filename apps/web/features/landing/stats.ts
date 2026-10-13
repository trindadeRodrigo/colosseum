import type { PinSource } from '../../components/ui/provenance';
import { API } from '../../lib/api';

// The platform's numbers under the hero. Live from the API's `/stats` when it answers (plans made,
// wallets with a confirmed transaction, the value last observed in their vaults), each pinned to that
// route and the instant it answered. When it does not answer (no API, no database: a local run, a
// preview), the strip shows sample figures instead, pinned `mock`, and the strip says so in its quiet
// line (MOCK-QUIET). Sample figures are never shown as live, and live ones carry no change figure:
// the API keeps no history to compare with. The API's numbers count as live only where the app runs
// on mainnet (`NEXT_PUBLIC_CHAIN_NETWORK_SOLANA=mainnet`); anywhere else they come from a test network
// or a local copy, and are pinned `sandbox`.

export type StatKey = 'plans' | 'wallets' | 'value' | 'running' | 'depth' | 'onTrack';

export type PlatformStat = {
  key: StatKey;
  /** The figure as shown. */
  value: string;
  obs: PinSource;
  /** A change, sample strip only: the sign and the words, and which way it goes. */
  change?: { text: string; up: boolean };
};

export type PlatformStats = { live: boolean; items: PlatformStat[] };

const SAMPLE: PinSource = {
  source: 'sample',
  fetchedAt: '2026-10-08T00:00:00Z',
  method: 'illustrative platform figures, identity-reassessment.html',
  provenance: 'mock',
};

/** The sample strip: the figures of the identity sheet, marked as sample wherever they show. */
export const SAMPLE_STATS: PlatformStats = {
  live: false,
  items: [
    { key: 'running', value: '1,284', obs: SAMPLE, change: { text: '+12%', up: true } },
    { key: 'depth', value: '$41.2M', obs: SAMPLE, change: { text: '+3.1%', up: true } },
    { key: 'onTrack', value: '91%', obs: SAMPLE, change: { text: '−2 pts', up: false } },
  ],
};

type StatsReply = {
  plans?: unknown;
  wallets?: unknown;
  observedValueUsd?: unknown;
  asOf?: unknown;
};

const count = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** The strip from a reply of `/stats`, or null when the reply is not one. */
export function fromReply(reply: StatsReply): PlatformStats | null {
  const { plans, wallets, observedValueUsd, asOf } = reply;
  if (
    typeof plans !== 'number' ||
    typeof wallets !== 'number' ||
    typeof observedValueUsd !== 'number' ||
    typeof asOf !== 'string' ||
    Number.isNaN(Date.parse(asOf))
  )
    return null;
  const obs = (method: string): PinSource => ({
    source: 'tenonfi API /stats',
    fetchedAt: asOf,
    method,
    provenance: process.env.NEXT_PUBLIC_CHAIN_NETWORK_SOLANA === 'mainnet' ? 'live' : 'sandbox',
  });
  return {
    live: true,
    items: [
      { key: 'plans', value: count.format(plans), obs: obs('count of plans made') },
      {
        key: 'wallets',
        value: count.format(wallets),
        obs: obs('wallets with a confirmed transaction'),
      },
      {
        key: 'value',
        value: usd.format(observedValueUsd),
        obs: obs('sum of the latest observed position values, USD'),
      },
    ],
  };
}

/** The numbers for the strip: live if the API answers within a moment, sample otherwise. */
export async function platformStats(timeoutMs = 1500): Promise<PlatformStats> {
  try {
    const res = await fetch(`${API}/stats`, {
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 60 },
    });
    if (!res.ok) return SAMPLE_STATS;
    return fromReply((await res.json()) as StatsReply) ?? SAMPLE_STATS;
  } catch {
    return SAMPLE_STATS;
  }
}

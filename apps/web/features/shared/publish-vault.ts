import { type ChainId, Target, type VaultResponse } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import { chainNode } from '../order/chain-node';
import { deploymentsFor } from '../order/readiness';
import { assetsFor } from '../order/units';
import { derivedVault, readChainVault } from '../portfolio/chain-vault';
import { sameAddress } from '../portfolio/vault-name';
import { readVault } from './shared-api';

export type PublishSource = {
  chain: ChainId;
  owner: string;
  address: string;
  basketId: string;
  mock: boolean;
};
export type PublishVaultRead =
  | {
      kind: 'read';
      value: VaultResponse;
      components: Target[];
      source: 'chain' | 'mock';
      /** Full verified targets, including structural zeros, for stale checks. */ strategy: string;
    }
  | { kind: 'unsupported' | 'unverified' | 'missing' | 'owner' | 'unreachable' };

/** Exact positive targets only. Zero entries carry no allocation; no positive weight is changed. */
export function exactPublishTargets(chain: ChainId, raw: unknown): Target[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const targets: Target[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    if ('kind' in item && item.kind !== 'asset') return null;
    if ('weightBps' in item && item.weightBps === 0) continue;
    const parsed = Target.safeParse(item);
    if (!parsed.success || !parsed.data.asset.startsWith(`${chain}:`)) return null;
    targets.push({ ...parsed.data });
  }
  if (targets.length === 0) return null;
  if (new Set(targets.map((t) => t.asset)).size !== targets.length) return null;
  if (targets.reduce((n, t) => n + t.weightBps, 0) !== 10_000) return null;
  return targets;
}

/** Read the selected vault afresh, proving owner/address/number before taking its actual targets. */
export async function readPublishVault(
  apiFetch: ApiFetch,
  at: PublishSource,
): Promise<PublishVaultRead> {
  const read = await readVault(apiFetch, at.chain, at.address);
  if (read.kind !== 'read') return { kind: 'unreachable' };
  const { vault } = read.value;
  if (
    read.value.chain !== at.chain ||
    vault.chain !== at.chain ||
    !sameAddress(at.chain, vault.owner, at.owner) ||
    !sameAddress(at.chain, vault.address, at.address) ||
    vault.basketId !== at.basketId
  )
    return { kind: 'owner' };
  const deployment = deploymentsFor(at.chain, at.mock)?.[at.chain];
  if (!deployment) return { kind: 'unverified' };
  let raw: unknown;
  let source: 'chain' | 'mock';
  if (at.mock && deployment.family === 'mock' && read.value.provenance === 'mock') {
    // A sample API read exposes positions' targets only. A missing cash share is never invented.
    raw = vault.positions.map((p) => ({ asset: p.asset, weightBps: p.targetBps }));
    source = 'mock';
  } else {
    if (at.mock || deployment.family === 'mock') return { kind: 'unverified' };
    const node = chainNode(at.chain);
    const address = derivedVault(deployment, at.owner, at.basketId);
    if (!node || !address || !sameAddress(at.chain, address, at.address))
      return { kind: 'unverified' };
    try {
      const live = await readChainVault(node, deployment, {
        owner: at.owner,
        basketId: at.basketId,
      });
      if (!live) return { kind: 'missing' };
      if (!sameAddress(at.chain, live.address, at.address)) return { kind: 'owner' };
      raw = live.targets;
      source = 'chain';
    } catch {
      return { kind: 'unverified' };
    }
  }
  const components = exactPublishTargets(at.chain, raw);
  // The publishing registry accepts only listed non-cash assets. Refuse instead of removing one.
  const listed = new Set(assetsFor(at.chain, at.mock).map((a) => a.id));
  if (!components || components.some((t) => !listed.has(t.asset))) return { kind: 'unsupported' };
  return { kind: 'read', value: read.value, components, source, strategy: JSON.stringify(raw) };
}

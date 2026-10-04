import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The committed interface files the guard's tables are made from, read from the repository root.

export const ROOT = join(import.meta.dirname, '..', '..', '..');
const ABIS = join(ROOT, 'idl', 'evm');
/** Where `forge build` leaves the vault proxy. Not committed: it is there after a build of contracts/. */
export const PROXY_ARTIFACT = join(ROOT, 'contracts', 'out', 'BeaconProxy.sol', 'BeaconProxy.json');

export function readSources(): { idl: unknown; abis: Record<string, unknown> } {
  const abis: Record<string, unknown> = {};
  for (const file of readdirSync(ABIS)
    .filter((f) => f.endsWith('.json'))
    .sort())
    abis[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(ABIS, file), 'utf8'));
  return { idl: JSON.parse(readFileSync(join(ROOT, 'idl', 'basket.json'), 'utf8')), abis };
}

/** The build's proxy artifact: the path given, or the one in this checkout. Null when neither is there. */
export function readProxyArtifact(path = PROXY_ARTIFACT): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

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

/** Where the deployment files are: one per network, plus examples that are never read as one. */
export const DEPLOYMENTS = join(ROOT, 'packages', 'sdk', 'deployments');

/**
 * The committed deployment files by network: every `<network>.json` in the folder. A file whose name
 * ends in `.example.json` shows the shape and is not a network's file.
 */
export function readDeploymentFiles(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const file of readdirSync(DEPLOYMENTS)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.example.json'))
    .sort())
    files[file.slice(0, -'.json'.length)] = JSON.parse(
      readFileSync(join(DEPLOYMENTS, file), 'utf8'),
    );
  return files;
}

import { readDeploymentFiles } from '../scripts/sources';
import type { DeploymentFile } from '../src/guard/deployment';

// The package's deployment files with room for a test's own, for the package's tests and nothing else.
// A test file that loads a deployment of its own puts this module in place of the generated one:
//
//   vi.mock('../generated/deployment-files', () => import('../../../test/deployments'));
//
// and loads it with `withFile`. Outside it, these are the files committed under deployments/.

export const DEPLOYMENT_FILES: Record<string, unknown> = readDeploymentFiles();

/** Runs `run` with `file` as the one committed for its network, and puts the committed one back after. */
export function withFile<T>(file: DeploymentFile, run: () => T): T {
  const had = Object.hasOwn(DEPLOYMENT_FILES, file.network);
  const before = DEPLOYMENT_FILES[file.network];
  DEPLOYMENT_FILES[file.network] = file;
  try {
    return run();
  } finally {
    if (had) DEPLOYMENT_FILES[file.network] = before;
    else delete DEPLOYMENT_FILES[file.network];
  }
}

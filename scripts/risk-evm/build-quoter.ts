import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Rebuilds cl-quoter.json from ClQuoter.sol. Needs forge; run only after the contract changes:
//   pnpm exec tsx scripts/risk-evm/build-quoter.ts
// The collector reads the committed JSON, and a test fails when its source hash is stale.
const root = import.meta.dirname;
const forge = (...args: string[]) =>
  execFileSync('forge', args, {
    encoding: 'utf8',
    env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' },
  }).trim();

forge('build', '--root', root);
const deployedBytecode = forge('inspect', '--root', root, 'ClQuoter', 'deployedBytecode');
if (!/^0x[0-9a-f]+$/.test(deployedBytecode)) throw new Error('forge returned no bytecode');
for (const d of ['out', 'cache']) rmSync(join(root, d), { recursive: true, force: true });
const out = {
  contract: 'ClQuoter',
  source: 'scripts/risk-evm/ClQuoter.sol',
  sourceSha256: createHash('sha256')
    .update(readFileSync(join(root, 'ClQuoter.sol')))
    .digest('hex'),
  compiler:
    'solc 0.8.28, evm cancun, optimizer 200 runs, no metadata (scripts/risk-evm/foundry.toml)',
  deployedBytecode,
};
writeFileSync(join(root, 'cl-quoter.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(
  JSON.stringify({
    wrote: 'scripts/risk-evm/cl-quoter.json',
    bytes: deployedBytecode.length / 2 - 1,
  }),
);

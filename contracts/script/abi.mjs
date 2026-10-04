#!/usr/bin/env node
// Writes the ABIs of the contracts into idl/evm/, beside the Solana interface files, for the adapter and
// anything else that talks to them without Foundry.
//
//   cd contracts && forge build && node script/abi.mjs
//
// `test/Abi.t.sol` fails when a committed file is not what the build gives, so a change to a contract's
// interface comes with a fresh run of this in the same pull request.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '..', 'idl', 'evm');
// VaultConfig is the settings half of VaultFactory, on its own for what only reads settings.
const CONTRACTS = ['BasketVault', 'VaultFactory', 'VaultConfig', 'IndexRegistry', 'VaultBeacon'];

mkdirSync(target, { recursive: true });
for (const name of CONTRACTS) {
  const artifact = JSON.parse(
    readFileSync(join(root, 'out', `${name}.sol`, `${name}.json`), 'utf8'),
  );
  writeFileSync(join(target, `${name}.json`), `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`idl/evm/${name}.json: ${artifact.abi.length} entries`);
}

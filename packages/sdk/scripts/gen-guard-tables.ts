import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProxyArtifact, readSources } from './sources';
import {
  interfaceTable,
  programTable,
  proxyCreationCode,
  renderInterfaceTable,
  renderProgramTable,
  renderProxyCode,
} from './tables';

// Writes the guard's tables from the committed interface files. Run it whenever idl/basket.json or a
// file under idl/evm/ changes:
//
//   pnpm --filter @colosseum/sdk tables
//
// The vault proxy's creation code is not in a committed file: it comes from a build of the contracts.
// It is written again only when that build is there (`cd contracts && forge build`), or when a path to
// the artifact is given as the one argument; otherwise the committed value stays. tables.test.ts holds
// it to the hash the contracts' own test pins.
//
// It reads nothing but those files and writes nothing but src/guard/generated/.

const OUT = join(import.meta.dirname, '..', 'src', 'guard', 'generated');
const { idl, abis } = readSources();
writeFileSync(join(OUT, 'basket-program.ts'), renderProgramTable(programTable(idl)));
writeFileSync(join(OUT, 'evm-interface.ts'), renderInterfaceTable(interfaceTable(abis)));
const artifact = readProxyArtifact(process.argv[2]);
if (artifact)
  writeFileSync(join(OUT, 'vault-proxy.ts'), renderProxyCode(proxyCreationCode(artifact)));

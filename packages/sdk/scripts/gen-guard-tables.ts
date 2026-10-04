import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSources } from './sources';
import { interfaceTable, programTable, renderInterfaceTable, renderProgramTable } from './tables';

// Writes the guard's two tables from the committed interface files. Run it whenever idl/basket.json or
// a file under contracts/src/interfaces changes:
//
//   pnpm --filter @colosseum/sdk tables
//
// It reads nothing but those files and writes nothing but src/guard/generated/.

const OUT = join(import.meta.dirname, '..', 'src', 'guard', 'generated');
const { idl, interfaces } = readSources();
writeFileSync(join(OUT, 'basket-program.ts'), renderProgramTable(programTable(idl)));
writeFileSync(join(OUT, 'evm-interface.ts'), renderInterfaceTable(interfaceTable(interfaces)));

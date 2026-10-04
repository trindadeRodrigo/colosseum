import { hexEncode, utf8Encode } from '../src/bytes';
import type { InterfaceTable } from '../src/guard/evm/table';
import type { IdlField, IdlInstruction, IdlType, ProgramTable } from '../src/guard/solana/table';
import { keccak256 } from '../src/hash';

// What the guard's two tables are made from, as pure functions of the committed interface files:
//   idl/basket.json                     the Solana program: its id, and every instruction's
//                                       discriminator, accounts and arguments
//   idl/evm/*.json                      the EVM contracts' ABIs: every function's signature and selector
// gen-guard-tables.ts writes the result; tables.test.ts fails when the committed tables are not what
// these functions make of the files as they stand.

const PRIMITIVES = ['bool', 'u8', 'u16', 'u32', 'u64', 'i64', 'pubkey', 'bytes'] as const;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${what}: expected a list`);
  return v;
};
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`${what}: expected a name`);
  return v;
};

/** One IDL type as the table writes it. `used` collects the structs it names. */
function idlType(raw: unknown, where: string, used: Set<string>): IdlType {
  if (typeof raw === 'string') {
    const known = PRIMITIVES.find((p) => p === raw);
    if (!known) throw new Error(`${where}: the guard does not read the type ${raw}`);
    return known;
  }
  if (isRecord(raw)) {
    if ('vec' in raw) return { vec: idlType(raw.vec, where, used) };
    if ('option' in raw) return { option: idlType(raw.option, where, used) };
    if ('array' in raw) {
      const [item, length] = list(raw.array, where);
      if (!Number.isInteger(length)) throw new Error(`${where}: an array has a fixed length`);
      return { array: [idlType(item, where, used), length as number] };
    }
    if ('defined' in raw && isRecord(raw.defined)) {
      const name = text(raw.defined.name, where);
      used.add(name);
      return { defined: name };
    }
  }
  throw new Error(`${where}: the guard does not read this type`);
}

const fields = (raw: unknown, where: string, used: Set<string>): IdlField[] =>
  list(raw, where).map((f) => {
    if (!isRecord(f)) throw new Error(`${where}: expected a field`);
    const name = text(f.name, where);
    return { name, type: idlType(f.type, `${where}.${name}`, used) };
  });

/** The table of idl/basket.json. Throws on anything in an instruction that the guard could not read. */
export function programTable(idl: unknown): ProgramTable {
  if (!isRecord(idl)) throw new Error('the IDL is not an object');
  const used = new Set<string>();
  const instructions: Record<string, IdlInstruction> = {};
  for (const raw of list(idl.instructions, 'instructions')) {
    if (!isRecord(raw)) throw new Error('instructions: expected an instruction');
    const name = text(raw.name, 'instruction');
    const discriminator = list(raw.discriminator, name).map(Number);
    if (discriminator.length !== 8 || discriminator.some((b) => !(b >= 0 && b <= 255)))
      throw new Error(`${name}: a discriminator is eight bytes`);
    instructions[name] = {
      discriminator,
      accounts: list(raw.accounts, name).map((a) => {
        // A nested account group would change the order of the list: none exists, and one is refused.
        if (!isRecord(a) || 'accounts' in a)
          throw new Error(`${name}: expected a flat account list`);
        return {
          name: text(a.name, name),
          signer: a.signer === true,
          writable: a.writable === true,
          optional: a.optional === true,
        };
      }),
      args: fields(raw.args, name, used),
    };
  }
  const defined = new Map(
    list(idl.types ?? [], 'types').map((t) => [isRecord(t) ? String(t.name) : '', t] as const),
  );
  const types: Record<string, IdlField[]> = {};
  // A struct can name another: keep going until every one reached from an argument is written out.
  for (const queue = [...used]; queue.length; ) {
    const name = queue.shift() as string;
    if (types[name]) continue;
    const raw = defined.get(name);
    if (!isRecord(raw) || !isRecord(raw.type) || raw.type.kind !== 'struct')
      throw new Error(`${name}: an argument's type is a struct`);
    // A zero-copy struct is laid out by the compiler, not by Borsh.
    if ('serialization' in raw) throw new Error(`${name}: not a Borsh struct`);
    const inner = new Set<string>();
    types[name] = fields(raw.type.fields, name, inner);
    queue.push(...inner);
  }
  const sorted = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return {
    address: text(idl.address, 'address'),
    instructions: sorted(instructions),
    types: sorted(types),
  };
}

// ---- the EVM contracts

/** The standard functions a step calls on a token. They are in no interface file of ours. */
export const ERC20_FUNCTIONS = [
  'approve(address,uint256)',
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
] as const;

/** A parameter's type in its canonical form, a struct written out as a tuple of its fields. */
function canonical(input: unknown, where: string): string {
  if (!isRecord(input)) throw new Error(`${where}: expected a parameter`);
  const type = text(input.type, where);
  if (!type.startsWith('tuple')) return type;
  const fields = list(input.components, where).map((c) => canonical(c, where));
  return `(${fields.join(',')})${type.slice('tuple'.length)}`;
}

export function selectorOf(signature: string): string {
  return `0x${hexEncode(keccak256(utf8Encode(signature)).slice(0, 4))}`;
}

/**
 * Every function of every contract in the given ABIs, by contract, with its selector. `abis` is the
 * contract's name to its ABI, as the files in idl/evm/ hold it. A signature names tuples, never a
 * struct, so it is the text the selector is the hash of.
 */
export function interfaceTable(abis: Record<string, unknown>): InterfaceTable {
  const table: Record<string, Record<string, string>> = {};
  for (const [contract, abi] of Object.entries(abis)) {
    const functions: Record<string, string> = {};
    for (const entry of list(abi, contract)) {
      if (!isRecord(entry) || entry.type !== 'function') continue;
      const name = text(entry.name, contract);
      const where = `${contract}.${name}`;
      const signature = `${name}(${list(entry.inputs, where)
        .map((i) => canonical(i, where))
        .join(',')})`;
      functions[signature] = selectorOf(signature);
    }
    table[contract] = functions;
  }
  table.ERC20 = Object.fromEntries(ERC20_FUNCTIONS.map((s) => [s, selectorOf(s)]));
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return Object.fromEntries(
    Object.entries(table)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([contract, functions]) => [contract, sorted(functions)]),
  );
}

// ---- the files

const HEADER = (from: string) =>
  `// Generated from ${from} by packages/sdk/scripts/gen-guard-tables.ts.\n// Do not edit: run \`pnpm --filter @colosseum/sdk tables\`. tables.test.ts fails when this file and its source disagree.\n`;

/**
 * The vault proxy's creation code, from a build of the contracts (`out/BeaconProxy.sol/BeaconProxy.json`).
 * A vault's address is derived from it, so the guard carries it.
 */
export function proxyCreationCode(artifact: unknown): string {
  const code = isRecord(artifact) && isRecord(artifact.bytecode) ? artifact.bytecode.object : null;
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code))
    throw new Error('the artifact holds no creation code');
  return code;
}

export function renderProxyCode(code: string): string {
  return `${HEADER("the contracts' build (contracts/out/BeaconProxy.sol/BeaconProxy.json)")}\n/** The creation code of the proxy every vault is, as \`VaultFactory\` holds it. */\nexport const VAULT_PROXY_CREATION_CODE =\n  '${code}';\n`;
}

export function renderProgramTable(table: ProgramTable): string {
  return `${HEADER('idl/basket.json')}import type { ProgramTable } from '../solana/table';\n\nexport const BASKET_PROGRAM: ProgramTable = ${JSON.stringify(table, null, 2)};\n`;
}

export function renderInterfaceTable(table: InterfaceTable): string {
  return `${HEADER('idl/evm/*.json')}import type { InterfaceTable } from '../evm/table';\n\nexport const EVM_INTERFACE: InterfaceTable = ${JSON.stringify(table, null, 2)};\n`;
}

/** The committed deployment files, by network, as the package carries them (deployment.ts reads them). */
export function renderDeploymentFiles(files: Record<string, unknown>): string {
  return `${HEADER('packages/sdk/deployments/*.json')}\n/** One file per network, as committed. \`deploymentsOf\` reads and checks them. */\nexport const DEPLOYMENT_FILES: Readonly<Record<string, unknown>> = ${JSON.stringify(files, null, 2)};\n`;
}

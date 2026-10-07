import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The snapshot worker reads and never signs (docs/vault/PROMPT-BUILD-PORTFOLIO.md, "Settled"). The import
// table (tests/boundaries.test.ts) grants the worker the whole of each chain package, and the readers'
// entry ('/vault') also exports the adapters, the builders and the probes. So this reads the worker's own
// source: every file that is not a test may take from a real chain package only what reads, and names no
// builder, no relay, no signer and no send. The one file that builds and lands a transaction is
// mock-world.ts, and it may import no real chain at all: what it lands, lands in memory.

const DIR = fileURLToPath(new URL('../../apps/snapshot/src/', import.meta.url));
const MOCK_WORLD = 'mock-world.ts';

/** What the worker may take from each real chain package's readers' entry. Everything else is refused. */
const READS: Record<string, readonly string[]> = {
  '@colosseum/chain-solana/vault': [
    'assertNode',
    'ConfigAccount',
    'createSolanaVaultReader',
    'createVaultRpc',
    'deploymentAddresses',
    'deploymentAssets',
    'SolanaDeploymentRecord',
    'SolanaVaultReader',
    'VaultNodeRpc',
    'VaultRpc',
  ],
  '@colosseum/chain-evm/vault': [
    'assertNode',
    'createEvmRpc',
    'createEvmVaultReader',
    'deploymentAddresses',
    'deploymentAssets',
    'EvmDeploymentRecord',
    'EvmRpc',
    'EvmVaultReader',
    'PlatformState',
  ],
};
const REAL_CHAIN = /^@colosseum\/chain-(solana|evm)(\/|$)/;
/** A signing entry of any package: '/server', and the files behind it. */
const SIGNING_ENTRY = /\/(server|sign|signer|wallet)$/;

/** Names of what builds, signs, relays or sends, as the adapters, the probes and the signing entries have them. */
const WRITES: readonly [RegExp, string][] = [
  [/^create(Solana|Evm)VaultAdapter$/, 'an adapter of a real chain'],
  [/^create(Solana|Evm)Probe$/, 'a probe, which relays'],
  [/^build[A-Z]\w*$/, 'a builder'],
  [/^compose$/, 'the transaction composer'],
  [/^relay\w*$/, 'a relay'],
  // "signal" is not a signature: AbortSignal.timeout, process signals.
  [/^[sS]ign(?!al)\w*$/, 'a signer'],
  [/^send\w*$/, 'a send'],
  // The same by JSON-RPC method, which a node's client takes as a string: the EVM client the worker
  // holds would relay `eth_sendRawTransaction` through its `request`. Held to the three namespaces
  // that send or sign, and to the start of the name, so that "signal" stays a word.
  [/^(eth|personal|wallet)_(send|sign)\w*$/, 'a JSON-RPC send or sign'],
  // What viem writes to a chain with, by name.
  [/^(writeContract|deployContract|createWalletClient|walletActions)$/, 'a wallet client'],
  [/^load\w*Key\w*$/, 'a key loader'],
];

/** `x.getSlot(...).send(...)`: how @solana/kit runs a read. The only `send` the worker makes. */
function isSlotRead(node: ts.Identifier): boolean {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node) return false;
  const call = access.expression;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'getSlot'
  );
}

/** Why a file of the worker is not held to reading, one line each; empty when it is. */
function problems(name: string, text: string): string[] {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const at = (node: ts.Node) =>
    `${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  const say = (node: ts.Node, what: string) => found.push(`${at(node)} ${what}`);

  /** A module the file loads, by any of the ways a file can load one. */
  const loads = (node: ts.Node, module: string, names: string[] | '*') => {
    if (SIGNING_ENTRY.test(module)) return say(node, `loads a signing entry: ${module}`);
    if (!REAL_CHAIN.test(module)) return;
    if (name === MOCK_WORLD) return say(node, `the mock's world loads a real chain: ${module}`);
    const reads = READS[module];
    if (!reads) return say(node, `loads ${module}: only the readers' entry, '/vault'`);
    if (names === '*') return say(node, `takes all of ${module}`);
    for (const taken of names)
      if (!reads.includes(taken)) say(node, `takes ${taken} from ${module}: not a read`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const named =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
          : null;
      // A default or a namespace import, or an import for its effects alone, is the whole module.
      const whole = !clause || clause.name !== undefined || named === null;
      loads(node, node.moduleSpecifier.text, whole ? '*' : named);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : '*';
      loads(node, node.moduleSpecifier.text, named);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const dynamic =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      if (dynamic) {
        if (arg && ts.isStringLiteralLike(arg)) loads(node, arg.text, '*');
        else say(node, 'loads a module it does not name');
      }
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
      if (literal && ts.isStringLiteral(literal)) loads(node, literal.text, '*');
    }

    // Every name in the code, and every string a name could be reached through (`adapter['relay']`).
    // Comments are not code and are not read.
    if (name !== MOCK_WORLD && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))) {
      const write = WRITES.find(([pattern]) => pattern.test(node.text));
      if (write && !(ts.isIdentifier(node) && isSlotRead(node)))
        say(node, `names ${node.text}: ${write[1]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const sources = (readdirSync(DIR, { recursive: true }) as string[])
  .map((name) => name.split('\\').join('/'))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort()
  .map((name) => ({ name, text: readFileSync(`${DIR}${name}`, 'utf8') }));

describe('the snapshot worker reads only', () => {
  it('names no adapter, builder, relay, signer or send, and loads no signing entry', () => {
    // The walk found the worker: its entry, its chains, its pass and the mock's world among them.
    expect(sources.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'chains.ts',
        'main.ts',
        MOCK_WORLD,
        'pass.ts',
        'run.ts',
        'source.ts',
      ]),
    );
    expect(sources.flatMap((s) => problems(s.name, s.text))).toEqual([]);
  });

  it('takes its real chains through their readers, and the mock’s world takes no real chain', () => {
    const chains = sources.find((s) => s.name === 'chains.ts')?.text ?? '';
    expect(chains).toMatch(/\bcreateSolanaVaultReader\(/);
    expect(chains).toMatch(/\bcreateEvmVaultReader\(/);
    expect(chains).toMatch(/trade: 'readonly'/);
    const world = sources.find((s) => s.name === MOCK_WORLD)?.text ?? '';
    // It is the file that builds and lands, and only on the chain in memory.
    expect(world).toMatch(/from '@colosseum\/chain-mock'/);
    expect(world).toMatch(/\bbuildCreateVault\(/);
    expect(problems(MOCK_WORLD, world)).toEqual([]);
  });

  it('the check itself: each way to write to a chain is seen and refused', () => {
    const caught = (text: string, name = 'planted.ts') => problems(name, text);
    // What the worker does today is allowed.
    expect(
      caught(
        [
          "import { assertNode, createSolanaVaultReader, type VaultNodeRpc } from '@colosseum/chain-solana/vault';",
          "import { createEvmRpc, createEvmVaultReader } from '@colosseum/chain-evm/vault';",
          "import { createMockAdapter } from '@colosseum/chain-mock';",
          "import type { GetSlotApi, Rpc } from '@solana/kit';",
          "const height = () => slots.getSlot({ commitment: 'confirmed' }).send();",
          'const signal = AbortSignal.timeout(10_000);',
          "process.once('SIGINT', stop);",
          // A read by its JSON-RPC method is a read still.
          "const block = await rpc.request({ method: 'eth_blockNumber' });",
          "const answer = await rpc.request({ method: 'eth_call', params: [call, 'latest'] });",
          '// Nothing is built, signed or sent: buildDeposit, relay and sendTransaction are not names here.',
        ].join('\n'),
      ),
    ).toEqual([]);

    const bad: [text: string, problem: string][] = [
      [
        "import { loadKeypair } from '@colosseum/chain-solana/server';",
        'loads a signing entry: @colosseum/chain-solana/server',
      ],
      [
        "const { signBuilt } = await import('@colosseum/chain-evm/server');",
        'loads a signing entry: @colosseum/chain-evm/server',
      ],
      ["const s = require('../../../packages/chain-solana/src/sign');", 'loads a signing entry'],
      [
        "import { createSolanaVaultAdapter } from '@colosseum/chain-solana/vault';",
        'takes createSolanaVaultAdapter from @colosseum/chain-solana/vault: not a read',
      ],
      [
        "import { createEvmVaultAdapter as make } from '@colosseum/chain-evm/vault';",
        'takes createEvmVaultAdapter from @colosseum/chain-evm/vault: not a read',
      ],
      [
        "import { createEvmProbe } from '@colosseum/chain-evm/vault';",
        'takes createEvmProbe from @colosseum/chain-evm/vault: not a read',
      ],
      [
        "import * as solana from '@colosseum/chain-solana/vault';",
        'takes all of @colosseum/chain-solana/vault',
      ],
      ["export * from '@colosseum/chain-evm/vault';", 'takes all of @colosseum/chain-evm/vault'],
      [
        "import { getQuote } from '@colosseum/chain-solana';",
        "loads @colosseum/chain-solana: only the readers' entry, '/vault'",
      ],
      [
        "type A = import('@colosseum/chain-evm/vault').EvmVaultAdapter;",
        'takes all of @colosseum/chain-evm/vault',
      ],
      ['const m = await import(where);', 'loads a module it does not name'],
      ['const tx = await adapter.buildDeposit(args);', 'names buildDeposit: a builder'],
      ['await adapter.buildKeeperLeg(vault, trade);', 'names buildKeeperLeg: a builder'],
      ['await probe.relay(signed);', 'names relay: a relay'],
      ["await probe['relay'](signed);", 'names relay: a relay'],
      ['const signed = sign(tx);', 'names sign: a signer'],
      ['const wire = await signBase64(payload, key);', 'names signBase64: a signer'],
      ['const who = signer.address;', 'names signer: a signer'],
      ['await adapter.mock.send(tx);', 'names send: a send'],
      ['await rpc.sendTransaction(wire).send();', 'names sendTransaction: a send'],
      ['await rpc.getBalance(owner).send();', 'names send: a send'],
      ['await wallet.sendRawTransaction({ serializedTransaction });', 'names sendRawTransaction'],
      [
        "await rpc.request({ method: 'eth_sendRawTransaction', params: [wire] });",
        'names eth_sendRawTransaction: a JSON-RPC send or sign',
      ],
      [
        "const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction' });",
        'names eth_sendTransaction: a JSON-RPC send or sign',
      ],
      [
        "await rpc.request({ method: 'personal_sign', params: [text, who] });",
        'names personal_sign: a JSON-RPC send or sign',
      ],
      [
        "await rpc.request({ method: 'eth_signTypedData_v4', params: [who, typed] });",
        'names eth_signTypedData_v4: a JSON-RPC send or sign',
      ],
      [
        "await rpc.request({ method: 'wallet_sendCalls', params: [calls] });",
        'names wallet_sendCalls: a JSON-RPC send or sign',
      ],
      ['await client.writeContract(request);', 'names writeContract: a wallet client'],
      ['await client.deployContract({ abi, bytecode });', 'names deployContract: a wallet client'],
      [
        'const client = createWalletClient({ transport });',
        'names createWalletClient: a wallet client',
      ],
      ['const client = rpc.extend(walletActions);', 'names walletActions: a wallet client'],
      ['const key = loadEvmKey(path);', 'names loadEvmKey: a key loader'],
      ['const built = await compose(input);', 'names compose: the transaction composer'],
    ];
    for (const [text, problem] of bad) {
      const said = caught(text);
      expect(said.length, text).toBeGreaterThan(0);
      expect(said.join('\n'), text).toContain(problem);
    }
    // The mock's world may build and land, and may not load a real chain to do it on.
    expect(caught('await mock.send(await adapter.buildCreateVault(a));', MOCK_WORLD)).toEqual([]);
    expect(
      caught("import { createVaultRpc } from '@colosseum/chain-solana/vault';", MOCK_WORLD),
    ).toEqual([
      `${MOCK_WORLD}:1 the mock's world loads a real chain: @colosseum/chain-solana/vault`,
    ]);
    expect(caught("import '@colosseum/chain-evm/server';", MOCK_WORLD).join()).toContain(
      'loads a signing entry',
    );
  });
});

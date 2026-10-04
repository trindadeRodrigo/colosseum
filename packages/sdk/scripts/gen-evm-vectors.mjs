// Writes test/fixtures/evm-vectors.json: hashes, selectors, call data and vault addresses worked out by
// viem, for the tests that hold this package's own keccak, ABI codec and address rule to another
// implementation. The package itself does not depend on viem: this script borrows the copy the web app
// pins, so it runs only where the workspace is installed.
//
//   node packages/sdk/scripts/gen-evm-vectors.mjs
//
// The input is fixed, so a second run writes the same file.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const viem = createRequire(join(root, 'apps', 'web', 'package.json'))('viem');
const {
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  pad,
  parseAbiParameters,
  toHex,
} = viem;

// A small generator with a fixed seed: the same bytes every run.
let seed = 0x5eed1234;
const next = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const bytes = (n) => toHex(Uint8Array.from({ length: n }, () => Math.floor(next() * 256)));
const address = () => bytes(20);

const keccak = [0, 1, 3, 31, 32, 33, 55, 56, 64, 135, 136, 137, 200, 271, 272, 273, 1000].map(
  (n) => {
    const input = bytes(n);
    return { input, hash: keccak256(input) };
  },
);

// Every signature in the generated table, with the selector viem's keccak gives it.
const table = readFileSync(
  join(root, 'packages', 'sdk', 'src', 'guard', 'generated', 'evm-interface.ts'),
  'utf8',
);
const selectors = [...table.matchAll(/'([A-Za-z]\w*\([^']*\))':/g)].map(([, signature]) => ({
  signature,
  selector: keccak256(toHex(signature)).slice(0, 10),
}));

// Values as JSON carries them: { u: decimal } for a uint, { b: hex } for bytes, hex for an address or
// fixed bytes, true or false, and a list for a tuple or an array.
const live = (v) =>
  Array.isArray(v)
    ? v.map(live)
    : v !== null && typeof v === 'object'
      ? 'u' in v
        ? BigInt(v.u)
        : v.b
      : v;
const u = (n) => ({ u: String(n) });
const b = (n) => ({ b: bytes(n) });
const amount = () => u(Math.floor(next() * 1e15));
const swap = (dataLength) => [address(), address(), address(), amount(), amount(), b(dataLength)];
const weight = () => [address(), u(Math.floor(next() * 10_000))];
const WEIGHTS = '(address,uint16)[]';
const SWAPS = '(address,address,address,uint256,uint256,bytes)[]';
const MAX = (1n << 256n) - 1n;

const CALLS = [
  ['approve(address,uint256)', [address(), u(1_000_000_000)]],
  ['approve(address,uint256)', [address(), u(MAX)]],
  ['deposit(uint256)', [u(0)]],
  ['deposit(uint256)', [u(123_456_789_012)]],
  ['withdraw(address,uint256)', [address(), u(42)]],
  ['withdrawAll()', []],
  ['setOperator(address)', [address()]],
  ['setAutoFollow(bool)', [true]],
  ['setAutoFollow(bool)', [false]],
  ['acceptVersion(bytes32,uint32)', [bytes(32), u(7)]],
  [`setTargets(${WEIGHTS})`, [[]]],
  [`setTargets(${WEIGHTS})`, [[weight()]]],
  [`setTargets(${WEIGHTS})`, [[weight(), weight(), weight()]]],
  [`ownerSwap(${SWAPS})`, [[swap(0)]]],
  [`ownerSwap(${SWAPS})`, [[swap(5), swap(32), swap(100)]]],
  ['multicall(bytes[])', [[b(36), b(0), b(133)]]],
  [
    `createVault(bytes32,${WEIGHTS},bytes32,uint32,bool)`,
    [bytes(32), [weight(), weight()], bytes(32), u(0), false],
  ],
  [
    `createVaultAndBuy(bytes32,${WEIGHTS},bytes32,uint32,bool,uint256,${SWAPS})`,
    [
      bytes(32),
      [weight(), weight(), weight()],
      pad('0x', { size: 32 }),
      u(0),
      false,
      u(1_000_000_000),
      [swap(64), swap(1)],
    ],
  ],
  [
    `createVaultAndBuy(bytes32,${WEIGHTS},bytes32,uint32,bool,uint256,${SWAPS})`,
    [bytes(32), [], bytes(32), u(3), true, u(0), []],
  ],
];
const calls = CALLS.map(([signature, args]) => {
  const inputs = signature.slice(signature.indexOf('(') + 1, -1);
  return {
    signature,
    args,
    data: inputs ? encodeAbiParameters(parseAbiParameters(inputs), live(args)) : '0x',
  };
});

// A vault's address as the factory derives it (contracts/src/VaultFactory.sol on the EVM branch):
// CREATE2 from the factory, with the salt keccak256(abi.encode(owner, planId)) and the proxy's creation
// code followed by abi.encode(beacon, initialize(owner, planId)).
const INITIALIZE = keccak256(toHex('initialize(address,bytes32)')).slice(0, 10);
const vaultOf = (basketId, proxyCreationCode) => {
  const [factory, beacon, owner] = [address(), address(), address()];
  const planId = pad(toHex(basketId), { size: 32 });
  const init = concatHex([
    INITIALIZE,
    encodeAbiParameters(parseAbiParameters('address, bytes32'), [owner, planId]),
  ]);
  const vault = getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt: keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [owner, planId])),
    bytecode: concatHex([
      proxyCreationCode,
      encodeAbiParameters(parseAbiParameters('address, bytes'), [beacon, init]),
    ]),
  }).toLowerCase();
  return { factory, beacon, proxyCreationCode, owner, basketId: String(basketId), vault };
};
const vaults = [1n, 255n, 18_446_744_073_709_551_615n, 9_876_543_210_123n].map((basketId) =>
  vaultOf(basketId, bytes(40 + Math.floor(next() * 400))),
);
// And with the proxy's real creation code, as the guard carries it.
const proxy = /'(0x[0-9a-f]+)'/.exec(
  readFileSync(
    join(root, 'packages', 'sdk', 'src', 'guard', 'generated', 'vault-proxy.ts'),
    'utf8',
  ),
)[1];
const { proxyCreationCode: _, ...deployed } = vaultOf(7_234_567_890_123_456_789n, proxy);

// Addresses in mixed case with their checksum (EIP-55), as viem writes them. Drawn last, so every
// vector above is the same as before these were added.
const checksums = [deployed.factory, deployed.beacon, ...Array.from({ length: 14 }, address)].map(
  (lower) => ({ lower, checksummed: viem.getAddress(lower) }),
);

const version = createRequire(join(root, 'apps', 'web', 'package.json'))(
  'viem/package.json',
).version;
writeFileSync(
  join(root, 'packages', 'sdk', 'test', 'fixtures', 'evm-vectors.json'),
  `${JSON.stringify({ madeWith: `viem ${version}`, keccak, selectors, calls, vaults, deployed, checksums }, null, 2)}\n`,
);

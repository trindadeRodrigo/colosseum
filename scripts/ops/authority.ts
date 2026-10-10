import { z } from 'zod';

// Who holds every role of the EVM vault contracts on one chain, read from the chain and held against
// that chain's committed deployment record (ledger row SEC-1). This file is the check itself and
// touches no network: it asks a `Reader`, which the CLI beside it builds over JSON-RPC and the tests
// build over a model in memory. It takes no key and sends nothing.
//
// Selectors and topics are written out, as the other scripts do; the test recomputes each from its
// signature.

// ---- the contract surface

/** Function selectors, each with the signature it is the first four bytes of the hash of. */
export const SELECTORS = {
  // VaultFactory
  admin: ['admin()', '0xf851a440'],
  pendingAdmin: ['pendingAdmin()', '0x26782247'],
  guardian: ['guardian()', '0x452a9320'],
  keeper: ['keeper()', '0xaced1661'],
  launched: ['launched()', '0x8091f3bf'],
  beacon: ['beacon()', '0x59659e90'],
  registry: ['registry()', '0x7b103999'],
  keeperPaused: ['keeperPaused()', '0xc7696763'],
  depositsPaused: ['depositsPaused()', '0x60da3e83'],
  depositCaps: ['depositCaps()', '0x8cc65ee7'],
  totalDeposited: ['totalDeposited()', '0xff50abdc'],
  assets: ['assets()', '0x71a97305'],
  asset: ['asset(address)', '0x9c4667a2'],
  cashToken: ['cashToken()', '0xa7224687'],
  sessionPriceAge: ['sessionPriceAge()', '0x0872c2e0'],
  priceDevBps: ['priceDevBps()', '0xef36787a'],
  creationRestricted: ['creationRestricted()', '0x5957e754'],
  mayCreate: ['mayCreate(address)', '0x2d40ceb8'],
  // VaultBeacon
  owner: ['owner()', '0x8da5cb5b'],
  pendingOwner: ['pendingOwner()', '0xe30c3978'],
  implementation: ['implementation()', '0x5c60da1b'],
  // IndexRegistry
  publishDelay: ['publishDelay()', '0xa1211d4b'],
  factory: ['factory()', '0xc45a0155'],
  // TimelockController
  getMinDelay: ['getMinDelay()', '0xf27a0c92'],
  hasRole: ['hasRole(bytes32,address)', '0x91d14854'],
  getTimestamp: ['getTimestamp(bytes32)', '0xd45c4435'],
  // The timelock's own calls that a queued operation is read for
  updateDelay: ['updateDelay(uint256)', '0x64d62353'],
  grantRole: ['grantRole(bytes32,address)', '0x2f2ff15d'],
  revokeRole: ['revokeRole(bytes32,address)', '0xd547741f'],
  // Safe
  getThreshold: ['getThreshold()', '0xe75235b8'],
  getOwners: ['getOwners()', '0xa0e67e2b'],
  getModulesPaginated: ['getModulesPaginated(address,uint256)', '0xcc2f8452'],
  // TestPriceFeed: the mark of a price one key writes
  writer: ['writer()', '0x453a2abc'],
} as const satisfies Record<string, readonly [string, string]>;

/** Event topics of the timelock, each with its signature. */
export const TOPICS = {
  roleGranted: [
    'RoleGranted(bytes32,address,address)',
    '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d',
  ],
  roleRevoked: [
    'RoleRevoked(bytes32,address,address)',
    '0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b',
  ],
  callScheduled: [
    'CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)',
    '0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca',
  ],
} as const satisfies Record<string, readonly [string, string]>;

/** The timelock's role ids: the hash of each name, and zero for the admin of the roles. */
export const ROLES = {
  PROPOSER_ROLE: '0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1',
  EXECUTOR_ROLE: '0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63',
  CANCELLER_ROLE: '0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783',
  DEFAULT_ADMIN_ROLE: `0x${'0'.repeat(64)}`,
} as const;

/** Where an ERC-1967 proxy keeps its implementation. */
export const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** 48 hours: the least a mainnet's timelock and publish delay may be (`MIN_MAINNET_DELAY`). */
export const MIN_MAINNET_DELAY = 172_800n;
/** The least signatures a mainnet's Safe may need, unless the record asks for more. */
export const MIN_SAFE_THRESHOLD = 2;
/** The chains that are not held to the mainnet rules: local, Robinhood Chain's test network, Base Sepolia. */
export const TEST_CHAIN_IDS = [31337, 46630, 84532];

/** `isMainnet` of `contracts/script/Deploy.s.sol`: any chain id that is not a known test network. */
export function isMainnet(chainId: number): boolean {
  return !TEST_CHAIN_IDS.includes(chainId);
}

// ---- the record

const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const Uint = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

// Tolerant on purpose: it reads the fields this check needs and ignores the rest, so it reads a test
// network's record and a mainnet's alike. The strict schema of the record is chain-evm's, which
// refuses a mainnet.
const Record_ = z.object({
  evmChainId: z.number().int().positive(),
  deployBlock: z.number().int().nonnegative().nullable().optional(),
  contracts: z.object({
    factory: Address,
    registry: Address,
    beacon: Address,
    vaultLogic: Address,
    factoryLogic: Address,
    registryLogic: Address,
  }),
  roles: z.object({ admin: Address, guardian: Address, keeper: Address }),
  timelock: z
    .object({
      address: Address,
      minDelay: Uint,
      proposers: z.array(Address),
      cancellers: z.array(Address),
      executors: z.array(Address),
      /** What the Safe behind the three roles is: compared with the chain when stated. */
      safe: z
        .object({ threshold: z.number().int().nonnegative(), owners: z.array(Address) })
        .optional(),
    })
    .optional(),
  expected: z
    .object({
      launched: z.boolean(),
      publishDelay: Uint,
      keeperEnabled: z.boolean(),
      /**
       * The most one vault and all vaults may take in, in the cash token's units; zero is no cap.
       * No cap is required anywhere: stated, it is compared with the chain; absent, the chain's is printed.
       */
      depositCaps: z.object({ perVault: Uint, total: Uint }).optional(),
      /** The least signatures a role holder's Safe needs. Absent is 2; under 2 is refused on a mainnet. */
      safeMinThreshold: z.number().int().nonnegative().optional(),
      /** Who may create a vault while creation is restricted. Optional: none listed, none checked. */
      creators: z.array(Address).optional(),
    })
    .optional(),
});

export type AuthorityRecord = z.infer<typeof Record_> & {
  /** The file still holds the word that marks a value nobody has confirmed. */
  placeholder: boolean;
};

/** Reads a record's text. Throws when a field this check needs is missing or malformed. */
export function parseRecord(text: string): AuthorityRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('the record is not JSON');
  }
  const parsed = Record_.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Error(`the record is not one this check reads: ${where}`);
  }
  return { ...parsed.data, placeholder: /todo/i.test(text) };
}

// ---- the reader

/** The node answered and the call reverted. Anything else a reader throws is a read that failed. */
export class CallReverted extends Error {
  constructor() {
    super('reverted');
  }
}

export type LogFilter = {
  address: string;
  fromBlock: number;
  toBlock: number;
  /** Position by position; an array is any of. */
  topics: (string | string[] | null)[];
};
export type ChainLog = { topics: string[]; data: string };

/** The reads this check makes, and nothing else: no method here can change anything. */
export interface Reader {
  chainId(): Promise<number>;
  /** The block the reads are made at: the upper end of the log range. */
  blockNumber(): Promise<number>;
  /** `eth_call`. Throws `CallReverted` when the contract refuses. */
  call(to: string, data: string): Promise<string>;
  code(address: string): Promise<string>;
  storageAt(address: string, slot: string): Promise<string>;
  logs(filter: LogFilter): Promise<ChainLog[]>;
}

// ---- the report

export type Status = 'OK' | 'DIFFERS' | 'FAIL' | 'INFO' | 'WARN';
export type Line = {
  status: Status;
  /** The fact: a role, a read, a rule. */
  what: string;
  live?: string;
  expected?: string;
  note?: string;
};
export type AuthorityResult = { lines: Line[]; failures: string[] };

/** One line of the report, tab-separated: status, fact, live value, expected value, note. */
export function formatLine(line: Line): string {
  return [
    line.status,
    line.what,
    line.live ?? '',
    line.expected === undefined ? '' : `expected ${line.expected}`,
    line.note ?? '',
  ]
    .join('\t')
    .trimEnd();
}

export type Options = {
  /** Blocks per `eth_getLogs` when the node refuses the whole range at once. */
  logChunk?: number;
};

// ---- encoding

const strip = (hex: string) => (hex.startsWith('0x') ? hex.slice(2) : hex);
const pad = (hex: string) => strip(hex).toLowerCase().padStart(64, '0');
const wordAt = (data: string, i: number) => strip(data).slice(i * 64, (i + 1) * 64);
const words = (data: string) => Math.floor(strip(data).length / 64);
const asAddress = (word: string) => `0x${strip(word).slice(-40).toLowerCase()}`;
const asUint = (word: string) => BigInt(`0x${strip(word) || '0'}`);
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
/** EIP-7702: the code of a key that delegates is exactly `0xef0100` and an address, 23 bytes. */
const isDelegation = (code: string) =>
  strip(code).length === 46 && strip(code).toLowerCase().startsWith('ef0100');
const roleName = (role: string) =>
  Object.entries(ROLES).find(([, id]) => id === role.toLowerCase())?.[0] ?? role;

type Asset = { token: string; feed: string; flags: bigint; averageFeed: string };

// ---- the check

/**
 * Reads the chain through `reader` and holds it against `record`. Every fact is a line; every line
 * that differs, breaks a rule, or could not be read is also a failure. Fails closed: a read that does
 * not answer is a failure that names the read.
 */
export async function checkAuthority(
  record: AuthorityRecord,
  reader: Reader,
  options: Options = {},
): Promise<AuthorityResult> {
  const lines: Line[] = [];
  const failures: string[] = [];
  const say = (line: Line) => {
    lines.push(line);
    if (line.status === 'DIFFERS' || line.status === 'FAIL')
      failures.push(
        [
          line.what,
          line.note,
          line.live && `live ${line.live}`,
          line.expected && `expected ${line.expected}`,
        ]
          .filter(Boolean)
          .join(': '),
      );
  };
  const result = () => ({ lines, failures });

  // A record with a placeholder is not a record of anything: nothing is read against it.
  if (record.placeholder) {
    say({
      status: 'FAIL',
      what: 'record',
      note: 'refused: it still holds a placeholder (todo); every value must be confirmed by a person',
    });
    return result();
  }

  /** Runs one read. A read that fails is a failure naming it, and `undefined` to the caller. */
  async function read<T>(what: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (e) {
      say({
        status: 'FAIL',
        what,
        note: `could not be read: ${e instanceof CallReverted ? 'the call reverted' : 'the node did not answer'}`,
      });
      return undefined;
    }
  }
  /** One word of a call's answer. An answer shorter than a word is a read that failed. */
  async function callWords(what: string, to: string, data: string, atLeast = 1) {
    return read(what, async () => {
      const out = await reader.call(to, data);
      if (words(out) < atLeast) throw new CallReverted();
      return out;
    });
  }
  const callAddress = async (what: string, to: string, data: string) => {
    const out = await callWords(what, to, data);
    return out === undefined ? undefined : asAddress(wordAt(out, 0));
  };
  const callUint = async (what: string, to: string, data: string) => {
    const out = await callWords(what, to, data);
    return out === undefined ? undefined : asUint(wordAt(out, 0));
  };
  const codeOf = new Map<string, string | undefined>();
  async function codeAt(address: string): Promise<string | undefined> {
    if (!codeOf.has(address))
      codeOf.set(address, await read(`code of ${address}`, () => reader.code(address)));
    return codeOf.get(address);
  }
  async function hasCode(address: string): Promise<boolean | undefined> {
    const code = await codeAt(address);
    return code === undefined ? undefined : strip(code).length > 0;
  }
  const kind = async (address: string) => {
    if (address === ZERO_ADDRESS) return 'zero';
    const code = await codeAt(address);
    if (code === undefined) return 'unread';
    if (isDelegation(code)) return 'delegated key';
    return strip(code).length > 0 ? 'contract' : 'no code';
  };
  const shown = async (address: string) => `${address} (${await kind(address)})`;
  /** Live against expected: one line, OK or DIFFERS. `undefined` live was already reported. */
  const compare = (what: string, live: string | undefined, expected: string, note?: string) => {
    if (live === undefined) return;
    say({ status: live === expected ? 'OK' : 'DIFFERS', what, live, expected, note });
  };
  const compareAddress = async (what: string, live: string | undefined, expected: string) => {
    if (live === undefined) return;
    say({
      status: live === expected ? 'OK' : 'DIFFERS',
      what,
      live: await shown(live),
      expected,
    });
  };

  // ---- the chain
  const chainId = await read('eth_chainId', () => reader.chainId());
  if (chainId === undefined) return result();
  compare('chain id', String(chainId), String(record.evmChainId));
  // Another chain's answers would say nothing about this record.
  if (chainId !== record.evmChainId) return result();
  const mainnet = isMainnet(chainId);
  say({
    status: 'INFO',
    what: 'rules',
    live: mainnet ? 'mainnet' : 'test network',
    note: mainnet
      ? 'the mainnet rules of checkMainnet apply'
      : 'the mainnet rules are not applied on this chain',
  });
  /** A read that is only printed: a failure on a mainnet, a warning elsewhere. */
  async function info(
    what: string,
    to: string,
    data: string,
    show: (out: string) => string,
    atLeast = 1,
  ) {
    try {
      const out = await reader.call(to, data);
      if (words(out) < atLeast) throw new CallReverted();
      say({ status: 'INFO', what, live: show(out) });
      return out;
    } catch (e) {
      say({
        status: mainnet ? 'FAIL' : 'WARN',
        what,
        note: `could not be read: ${e instanceof CallReverted ? 'the call reverted' : 'the node did not answer'}`,
      });
      return undefined;
    }
  }

  const { contracts, roles, timelock, expected } = record;
  const sel = (name: keyof typeof SELECTORS, ...args: string[]) =>
    SELECTORS[name][1] + args.map(pad).join('');

  // ---- what the record itself must say on a mainnet
  if (mainnet) {
    if (!timelock)
      say({ status: 'FAIL', what: 'record.timelock', note: 'missing: a mainnet has a timelock' });
    if (!expected)
      say({
        status: 'FAIL',
        what: 'record.expected',
        note: 'missing: a mainnet states what it expects',
      });
    const required: [string, string][] = [
      ...Object.entries(contracts).map(
        ([k, v]) => [`record.contracts.${k}`, v] as [string, string],
      ),
      ['record.roles.admin', roles.admin],
      ['record.roles.guardian', roles.guardian],
    ];
    if (timelock) {
      required.push(['record.timelock.address', timelock.address]);
      for (const list of ['proposers', 'cancellers', 'executors'] as const) {
        if (timelock[list].length === 0)
          say({ status: 'FAIL', what: `record.timelock.${list}`, note: 'empty' });
        timelock[list].forEach((a, i) => {
          required.push([`record.timelock.${list}[${i}]`, a]);
        });
      }
    }
    expected?.creators?.forEach((a, i) => {
      required.push([`record.expected.creators[${i}]`, a]);
    });
    timelock?.safe?.owners.forEach((a, i) => {
      required.push([`record.timelock.safe.owners[${i}]`, a]);
    });
    if (expected?.safeMinThreshold !== undefined && expected.safeMinThreshold < MIN_SAFE_THRESHOLD)
      say({
        status: 'FAIL',
        what: 'record.expected.safeMinThreshold',
        live: `${expected.safeMinThreshold}`,
        note: 'under 2: one signature is a key, not a Safe',
      });
    for (const [what, address] of required)
      if (address === ZERO_ADDRESS)
        say({ status: 'FAIL', what, note: 'the zero address where a mainnet needs an address' });
  }

  // ---- the contracts
  for (const [name, address] of Object.entries(contracts)) {
    const code = await hasCode(address);
    if (code === undefined) continue;
    say({
      status: code ? 'OK' : 'FAIL',
      what: `contracts.${name}`,
      live: `${address} (${code ? 'contract' : 'no code'})`,
      note: code ? undefined : 'no code at the address the record names',
    });
  }
  await compareAddress(
    'factory.beacon()',
    await callAddress('factory.beacon()', contracts.factory, sel('beacon')),
    contracts.beacon,
  );
  await compareAddress(
    'factory.registry()',
    await callAddress('factory.registry()', contracts.factory, sel('registry')),
    contracts.registry,
  );
  await compareAddress(
    'registry.factory()',
    await callAddress('registry.factory()', contracts.registry, sel('factory')),
    contracts.factory,
  );
  await compareAddress(
    'beacon.implementation()',
    await callAddress('beacon.implementation()', contracts.beacon, sel('implementation')),
    contracts.vaultLogic,
  );
  for (const [proxy, logic] of [
    ['factory', 'factoryLogic'],
    ['registry', 'registryLogic'],
  ] as const) {
    const what = `${proxy} implementation slot`;
    const slot = await read(what, () => reader.storageAt(contracts[proxy], IMPLEMENTATION_SLOT));
    await compareAddress(what, slot === undefined ? undefined : asAddress(slot), contracts[logic]);
  }

  // ---- who holds what
  const admin = await callAddress('factory.admin()', contracts.factory, sel('admin'));
  await compareAddress('factory.admin()', admin, roles.admin);
  const owner = await callAddress('beacon.owner()', contracts.beacon, sel('owner'));
  // Finding L3: the two are handed over by separate calls and can part after launch.
  if (admin !== undefined && owner !== undefined)
    say({
      status: owner === admin ? 'OK' : 'DIFFERS',
      what: 'beacon.owner()',
      live: await shown(owner),
      expected: admin,
      note: owner === admin ? 'the factory admin' : 'the beacon owner is not the factory admin',
    });
  for (const [what, to, data] of [
    ['factory.pendingAdmin()', contracts.factory, sel('pendingAdmin')],
    ['beacon.pendingOwner()', contracts.beacon, sel('pendingOwner')],
  ] as const) {
    const pending = await callAddress(what, to, data);
    if (pending === undefined) continue;
    say({
      status: pending === ZERO_ADDRESS ? 'OK' : 'DIFFERS',
      what,
      live: pending === ZERO_ADDRESS ? pending : await shown(pending),
      expected: ZERO_ADDRESS,
      note: pending === ZERO_ADDRESS ? undefined : 'a hand-over is proposed and not accepted',
    });
  }
  const guardian = await callAddress('factory.guardian()', contracts.factory, sel('guardian'));
  await compareAddress('factory.guardian()', guardian, roles.guardian);
  const keeper = await callAddress('factory.keeper()', contracts.factory, sel('keeper'));
  await compareAddress('factory.keeper()', keeper, roles.keeper);

  // ---- what the record expects
  const needLaunch = expected !== undefined;
  const bool = (out: string) => String(asUint(wordAt(out, 0)) !== 0n);
  if (needLaunch) {
    const launched = await callUint('factory.launched()', contracts.factory, sel('launched'));
    compare(
      'factory.launched()',
      launched === undefined ? undefined : String(launched !== 0n),
      String(expected.launched),
    );
  } else await info('factory.launched()', contracts.factory, sel('launched'), bool);
  const publishDelay = await callUint(
    'registry.publishDelay()',
    contracts.registry,
    sel('publishDelay'),
  );
  if (expected)
    compare('registry.publishDelay()', publishDelay?.toString(), `${expected.publishDelay}`);
  else if (publishDelay !== undefined)
    say({ status: 'INFO', what: 'registry.publishDelay()', live: `${publishDelay}` });
  if (mainnet && publishDelay !== undefined && publishDelay < MIN_MAINNET_DELAY)
    say({
      status: 'FAIL',
      what: 'registry.publishDelay()',
      live: `${publishDelay}`,
      note: 'the publish delay is under 172,800 s',
    });
  // A cap of zero is no cap, and no cap is required on any chain: only "as the record says" is held.
  const cap = (v: bigint) => (v === 0n ? 'none' : `${v}`);
  const showCaps = (out: string) =>
    `perVault ${cap(asUint(wordAt(out, 0)))}, total ${cap(asUint(wordAt(out, 1)))}`;
  if (expected?.depositCaps) {
    const out = await callWords('factory.depositCaps()', contracts.factory, sel('depositCaps'), 2);
    if (out !== undefined) {
      compare(
        'factory.depositCaps().perVault',
        cap(asUint(wordAt(out, 0))),
        cap(expected.depositCaps.perVault),
      );
      compare(
        'factory.depositCaps().total',
        cap(asUint(wordAt(out, 1))),
        cap(expected.depositCaps.total),
      );
    }
  } else await info('factory.depositCaps()', contracts.factory, sel('depositCaps'), showCaps, 2);

  await info('factory.cashToken()', contracts.factory, sel('cashToken'), (out) =>
    asAddress(wordAt(out, 0)),
  );
  const restrictedOut = await info(
    'factory.creationRestricted()',
    contracts.factory,
    sel('creationRestricted'),
    bool,
  );
  const restricted =
    restrictedOut === undefined ? undefined : asUint(wordAt(restrictedOut, 0)) !== 0n;

  await checkCreation();

  // ---- the timelock
  if (timelock) await checkTimelock(timelock);

  // ---- the mainnet rules
  if (mainnet) {
    if (admin !== undefined && admin !== ZERO_ADDRESS && (await hasCode(admin)) === false)
      say({
        status: 'FAIL',
        what: 'factory.admin()',
        live: `${admin} (no code)`,
        note: 'the admin has no code: on a mainnet it is the timelock, not a key',
      });
    if (guardian !== undefined) {
      if (guardian === ZERO_ADDRESS)
        say({ status: 'FAIL', what: 'factory.guardian()', live: guardian, note: 'no guardian' });
      else
        say({
          status: 'INFO',
          what: 'guardian',
          live: await shown(guardian),
          note: 'a key or a contract, either is allowed',
        });
      if (guardian !== ZERO_ADDRESS && guardian === keeper)
        say({
          status: 'FAIL',
          what: 'factory.guardian()',
          live: guardian,
          note: 'the guardian is the keeper: the key that stops the keeper must not be the keeper',
        });
    }
    if (expected && keeper !== undefined) {
      if (!expected.keeperEnabled && keeper !== ZERO_ADDRESS)
        say({
          status: 'FAIL',
          what: 'factory.keeper()',
          live: keeper,
          note: 'a keeper is set while keeperEnabled is false',
        });
      if (expected.keeperEnabled && keeper === ZERO_ADDRESS)
        say({
          status: 'FAIL',
          what: 'factory.keeper()',
          live: keeper,
          note: 'keeperEnabled with no keeper',
        });
    }
    await checkAssets(expected?.keeperEnabled);
  } else {
    const list = await info('factory.assets()', contracts.factory, sel('assets'), (out) =>
      words(out) >= 2 ? `${asUint(wordAt(out, 1))} listed` : 'unreadable',
    );
    if (list !== undefined && guardian !== undefined && guardian !== ZERO_ADDRESS)
      say({ status: 'INFO', what: 'guardian', live: await shown(guardian) });
  }

  // ---- printed, never a failure of the rules
  const uint = (out: string) => `${asUint(wordAt(out, 0))}`;
  await info('factory.keeperPaused()', contracts.factory, sel('keeperPaused'), bool);
  await info('factory.depositsPaused()', contracts.factory, sel('depositsPaused'), bool);
  await info('factory.totalDeposited()', contracts.factory, sel('totalDeposited'), uint);
  await info('factory.priceDevBps()', contracts.factory, sel('priceDevBps'), uint);
  await info('factory.sessionPriceAge()', contracts.factory, sel('sessionPriceAge'), uint);

  return result();

  // ---- the parts

  /** True when `address` answers `selector` with at least a word, as `_word` of the deploy script. */
  async function answers(what: string, address: string, selector: string) {
    try {
      return words(await reader.call(address, selector)) >= 1;
    } catch (e) {
      if (e instanceof CallReverted) return false;
      say({ status: 'FAIL', what, note: 'could not be read: the node did not answer' });
      return undefined;
    }
  }

  /**
   * A call whose answer may rightly be missing. `'none'`: the contract does not answer it. `undefined`:
   * the node did not answer, which is a failure on a mainnet and silence elsewhere.
   */
  async function probe(what: string, to: string, data: string, atLeast: number) {
    try {
      const out = await reader.call(to, data);
      return words(out) >= atLeast ? out : ('none' as const);
    } catch (e) {
      if (e instanceof CallReverted) return 'none' as const;
      if (mainnet)
        say({ status: 'FAIL', what, note: 'could not be read: the node did not answer' });
      return undefined;
    }
  }

  /** Who may create a vault, against what the record says of it. */
  async function checkCreation() {
    // Listing creators is the record's choice, on any chain: listed, creation must be restricted and
    // each of them let through.
    const creators = expected?.creators ?? [];
    if (creators.length === 0) return;
    if (restricted === false)
      say({
        status: 'FAIL',
        what: 'factory.creationRestricted()',
        live: 'false',
        expected: 'true',
        note: 'anyone may create a vault while the record lists creators',
      });
    for (const creator of creators) {
      const what = `factory.mayCreate(${creator})`;
      const may = await callUint(what, contracts.factory, sel('mayCreate', creator));
      if (may === undefined) continue;
      say({
        status: may !== 0n ? 'OK' : 'DIFFERS',
        what,
        live: String(may !== 0n),
        expected: 'true',
        note: may !== 0n ? undefined : 'the record lists it as a creator and it may not create',
      });
    }
  }

  /**
   * What stands behind a role of the timelock: having code is not being a Safe. On a mainnet it must
   * answer as a Safe with enough owners and signatures; elsewhere what it answers is only printed.
   */
  async function checkSafe(
    account: string,
    stated: { threshold: number; owners: string[] } | undefined,
  ) {
    const what = `safe ${account}`;
    const code = await codeAt(account);
    if (code === undefined || strip(code).length === 0) return; // no code is reported with the role
    if (isDelegation(code)) {
      if (mainnet)
        say({
          status: 'FAIL',
          what,
          live: `${account} (delegated key)`,
          note: 'its code is an EIP-7702 delegation: a key that delegates, not a Safe',
        });
      return;
    }
    const t = await probe(`${what} getThreshold()`, account, sel('getThreshold'), 1);
    const o = await probe(`${what} getOwners()`, account, sel('getOwners'), 2);
    if (t === undefined || o === undefined) return;
    const count = o === 'none' ? 0 : Number(asUint(wordAt(o, 1)));
    if (t === 'none' || o === 'none' || words(o) < 2 + count) {
      if (mainnet)
        say({
          status: 'FAIL',
          what,
          live: `${account} (contract)`,
          note: 'not a Safe: it does not answer getThreshold() and getOwners()',
        });
      return;
    }
    const threshold = asUint(wordAt(t, 0));
    const owners = Array.from({ length: count }, (_, i) => asAddress(wordAt(o, 2 + i)));
    // A module may make the Safe act with no signature of its owners. Up to ten are read, from the
    // list's sentinel; one is enough to fail a mainnet.
    const m = await probe(
      `${what} getModulesPaginated()`,
      account,
      sel('getModulesPaginated', `0x${'0'.repeat(39)}1`, '0xa'),
      3,
    );
    let modules: string[] | undefined;
    if (m !== undefined && m !== 'none') {
      const at = Number(asUint(wordAt(m, 0)) / 32n);
      const n = Number(asUint(wordAt(m, at)));
      if (words(m) >= at + 1 + n)
        modules = Array.from({ length: n }, (_, i) => asAddress(wordAt(m, at + 1 + i)));
    }
    const moduleWords =
      modules === undefined ? 'not answered' : modules.length ? modules.join(', ') : 'none';
    const live = `${threshold} of ${owners.length}: ${owners.join(', ')}; modules: ${moduleWords}`;
    say({ status: 'INFO', what, live, note: 'compare the owners with the people who hold them' });
    if (!mainnet) return;
    if (modules === undefined) {
      // A node that did not answer was already reported as a failure by the probe.
      if (m !== undefined)
        say({
          status: 'WARN',
          what: `${what} modules`,
          note: 'getModulesPaginated() is not answered (an older Safe?): its modules cannot be ruled out',
        });
    } else if (modules.length > 0)
      say({
        status: 'FAIL',
        what: `${what} modules`,
        live: modules.join(', '),
        note: 'a module can move the Safe without its signers',
      });
    const least = BigInt(expected?.safeMinThreshold ?? MIN_SAFE_THRESHOLD);
    if (threshold < least)
      say({ status: 'FAIL', what, live, note: `the threshold is under ${least}` });
    if (owners.length < 2) say({ status: 'FAIL', what, live, note: 'fewer than two owners' });
    if (BigInt(owners.length) < threshold)
      say({ status: 'FAIL', what, live, note: 'the threshold is above the number of owners' });
    if (stated) {
      compare(`${what} threshold`, `${threshold}`, `${stated.threshold}`);
      const sorted = (list: string[]) => [...new Set(list)].sort().join(', ');
      compare(`${what} owners`, sorted(owners), sorted(stated.owners));
    }
  }

  /** Every listed asset: its keeper switch against `keeperEnabled`, and feeds that are not ours. */
  async function checkAssets(keeperEnabled: boolean | undefined) {
    const out = await callWords('factory.assets()', contracts.factory, sel('assets'), 2);
    if (out === undefined) return;
    const count = Number(asUint(wordAt(out, 1)));
    if (words(out) < 2 + count) {
      say({ status: 'FAIL', what: 'factory.assets()', note: 'could not be read: a short answer' });
      return;
    }
    say({ status: 'INFO', what: 'factory.assets()', live: `${count} listed` });
    for (let i = 0; i < count; i++) {
      const token = asAddress(wordAt(out, 2 + i));
      const what = `asset ${token}`;
      // AssetConfig, fifteen words in the order of Types.sol: feed 0, flags 11, averageFeed 12.
      const raw = await callWords(`${what} config`, contracts.factory, sel('asset', token), 15);
      if (raw === undefined) continue;
      const asset: Asset = {
        token,
        feed: asAddress(wordAt(raw, 0)),
        flags: asUint(wordAt(raw, 11)),
        averageFeed: asAddress(wordAt(raw, 12)),
      };
      const keeperOn = (asset.flags & 1n) !== 0n;
      if (keeperOn && keeperEnabled === false)
        say({
          status: 'FAIL',
          what,
          live: `flags ${asset.flags}`,
          note: "an asset's keeper switch is on while keeperEnabled is false",
        });
      else say({ status: 'INFO', what, live: `keeper switch ${keeperOn ? 'on' : 'off'}` });
      for (const [name, feed] of [
        ['feed', asset.feed],
        ['averageFeed', asset.averageFeed],
      ] as const) {
        if (feed === ZERO_ADDRESS) continue;
        const code = await hasCode(feed);
        if (code === undefined) continue;
        if (!code) {
          say({
            status: 'FAIL',
            what: `${what} ${name}`,
            live: `${feed} (no code)`,
            note: 'has no code',
          });
          continue;
        }
        const ours = await answers(`${what} ${name} writer()`, feed, sel('writer'));
        if (ours === undefined) continue;
        say({
          status: ours ? 'FAIL' : 'OK',
          what: `${what} ${name}`,
          live: `${feed} (contract)`,
          note: ours ? 'answers writer(): a test feed, one key writes it' : 'not a test feed',
        });
      }
    }
  }

  /** The timelock's logs from the deploy block to the head: whole, or in chunks if the node refuses. */
  async function timelockLogs(address: string): Promise<ChainLog[]> {
    if (record.deployBlock === null || record.deployBlock === undefined)
      throw new Error('the record has no deployBlock');
    const from = record.deployBlock;
    const head = await reader.blockNumber();
    const topics = [[TOPICS.roleGranted[1], TOPICS.roleRevoked[1], TOPICS.callScheduled[1]]];
    try {
      return await reader.logs({ address, fromBlock: from, toBlock: head, topics });
    } catch {
      const chunk = Math.max(1, options.logChunk ?? 50_000);
      const all: ChainLog[] = [];
      for (let start = from; start <= head; start += chunk)
        all.push(
          ...(await reader.logs({
            address,
            fromBlock: start,
            toBlock: Math.min(head, start + chunk - 1),
            topics,
          })),
        );
      return all;
    }
  }

  async function checkTimelock(tl: NonNullable<AuthorityRecord['timelock']>) {
    if (admin !== undefined)
      say({
        status: admin === tl.address ? 'OK' : 'DIFFERS',
        what: 'timelock is the admin',
        live: admin,
        expected: tl.address,
      });
    const code = await hasCode(tl.address);
    if (code === false) {
      say({
        status: 'FAIL',
        what: 'timelock',
        live: `${tl.address} (no code)`,
        note: 'no code at the timelock the record names',
      });
      return;
    }
    const minDelay = await callUint('timelock.getMinDelay()', tl.address, sel('getMinDelay'));
    compare('timelock.getMinDelay()', minDelay?.toString(), `${tl.minDelay}`);
    if (mainnet && minDelay !== undefined && minDelay < MIN_MAINNET_DELAY)
      say({
        status: 'FAIL',
        what: 'timelock.getMinDelay()',
        live: `${minDelay}`,
        note: 'the timelock delay is under 48 hours',
      });

    // Role holders cannot be listed on chain: every account a role was ever granted to is found in
    // the logs, and each is then asked of the contract, which is what decides.
    let logs: ChainLog[] | undefined;
    try {
      logs = await timelockLogs(tl.address);
    } catch (e) {
      say({
        status: mainnet ? 'FAIL' : 'WARN',
        what: 'timelock logs',
        note: `could not be read (${e instanceof Error && e.message === 'the record has no deployBlock' ? e.message : 'eth_getLogs refused or failed'}): a holder outside the record cannot be ruled out`,
      });
    }
    // The constructor's first event is the timelock granting itself the admin of the roles. A range
    // without it starts after the timelock was created, and would miss whoever was granted a role then.
    if (
      logs &&
      !logs.some(
        (l) =>
          l.topics[0] === TOPICS.roleGranted[1] &&
          l.topics[1] === ROLES.DEFAULT_ADMIN_ROLE &&
          asAddress(l.topics[2] ?? '') === tl.address,
      )
    )
      say({
        status: mainnet ? 'FAIL' : 'WARN',
        what: 'timelock logs',
        note: "the range from the record's deployBlock does not hold the timelock's creation: a holder granted before it cannot be ruled out",
      });
    const granted = (role: string) =>
      (logs ?? [])
        .filter((l) => l.topics[0] === TOPICS.roleGranted[1] && l.topics[1] === role)
        .map((l) => asAddress(l.topics[2] ?? ''));
    const holds = async (name: string, role: string, account: string) => {
      const out = await callUint(
        `timelock.hasRole(${name}, ${account})`,
        tl.address,
        sel('hasRole', role, account),
      );
      return out === undefined ? undefined : out !== 0n;
    };

    const behind = new Set<string>();
    for (const [name, list] of [
      ['PROPOSER_ROLE', tl.proposers],
      ['CANCELLER_ROLE', tl.cancellers],
      ['EXECUTOR_ROLE', tl.executors],
    ] as const) {
      const role = ROLES[name];
      const open = await holds(name, role, ZERO_ADDRESS);
      if (open)
        say({
          status: 'FAIL',
          what: name,
          live: ZERO_ADDRESS,
          note: 'held by the zero address: the role is open to anyone',
        });
      const candidates = [...new Set([...list, ...granted(role)])].filter(
        (a) => a !== ZERO_ADDRESS,
      );
      for (const account of candidates) {
        const held = await holds(name, role, account);
        if (held === undefined) continue;
        const inRecord = list.includes(account);
        if (!held && !inRecord) continue; // granted once and revoked since
        behind.add(account);
        const live = await shown(account);
        if (held && inRecord) say({ status: 'OK', what: name, live, expected: 'holds it' });
        else if (held)
          say({
            status: 'DIFFERS',
            what: name,
            live,
            note: 'holds the role and is not in the record',
          });
        else
          say({
            status: 'DIFFERS',
            what: name,
            live,
            expected: 'holds it',
            note: 'the record names it and it does not hold the role',
          });
        if (mainnet && (await hasCode(account)) === false)
          say({
            status: 'FAIL',
            what: name,
            live,
            note: 'has no code: on a mainnet it must be a contract (a Safe), not a key',
          });
      }
    }

    // The record states one Safe: it is compared with the holders the record names, and a holder it
    // does not name is already a finding of its own.
    const named = new Set([...tl.proposers, ...tl.cancellers, ...tl.executors]);
    for (const account of behind)
      await checkSafe(account, named.has(account) ? tl.safe : undefined);

    // The admin of the roles: the timelock itself, so that a role changes only through the delay.
    const name = 'DEFAULT_ADMIN_ROLE';
    const role = ROLES[name];
    const self = await holds(name, role, tl.address);
    if (self !== undefined)
      say({
        status: self ? 'OK' : 'DIFFERS',
        what: name,
        live: `${tl.address} (timelock)`,
        expected: 'holds it',
        note: self ? undefined : 'the timelock does not hold the admin of its own roles',
      });
    const others = new Set([
      ZERO_ADDRESS,
      ...granted(role),
      ...tl.proposers,
      ...tl.cancellers,
      ...tl.executors,
      roles.guardian,
      roles.keeper,
    ]);
    others.delete(tl.address);
    for (const account of others) {
      if (await holds(name, role, account))
        say({
          status: 'FAIL',
          what: name,
          live: account === ZERO_ADDRESS ? account : await shown(account),
          note: 'holds the admin of the roles: it can grant itself any role with no delay',
        });
    }

    // What is queued: scheduled, and neither run nor cancelled. Printed. One call is more than
    // printed: the timelock's delay has no floor of its own (OpenZeppelin's, unmodified), so a queued
    // `updateDelay` under 48 hours is a failure on a mainnet, and any other change the timelock makes
    // to itself is a warning for a person to read.
    const scheduled = (logs ?? []).filter((l) => l.topics[0] === TOPICS.callScheduled[1]);
    const timestamps = new Map<string, bigint | undefined>();
    let pending = 0;
    for (const log of scheduled) {
      const id = log.topics[1] ?? '';
      if (!timestamps.has(id))
        timestamps.set(
          id,
          await callUint(`timelock.getTimestamp(${id})`, tl.address, sel('getTimestamp', id)),
        );
      const at = timestamps.get(id);
      // 0: cancelled. 1: done.
      if (at === undefined || at <= 1n) continue;
      pending++;
      // target, value, offset of data, predecessor, delay; then the data's length and bytes.
      const target = asAddress(wordAt(log.data, 0));
      const offset = Number(asUint(wordAt(log.data, 2))) * 2;
      const body = strip(log.data);
      const length = Number(asUint(body.slice(offset, offset + 64)));
      const selector = length >= 4 ? `0x${body.slice(offset + 64, offset + 72)}` : '(no data)';
      const args = body.slice(offset + 72, offset + 64 + length * 2);
      let status: Status = 'INFO';
      let meaning = '';
      if (target === tl.address && selector === SELECTORS.updateDelay[1]) {
        if (args.length < 64) {
          status = mainnet ? 'FAIL' : 'WARN';
          meaning = 'updateDelay with a delay that cannot be read; ';
        } else {
          const delay = asUint(args.slice(0, 64));
          status = mainnet && delay < MIN_MAINNET_DELAY ? 'FAIL' : 'WARN';
          meaning = `updateDelay(${delay}): the timelock's delay becomes ${delay} s${delay < MIN_MAINNET_DELAY ? ', under 48 hours' : ''}; `;
        }
      } else if (
        target === tl.address &&
        (selector === SELECTORS.grantRole[1] || selector === SELECTORS.revokeRole[1])
      ) {
        status = 'WARN';
        const call = selector === SELECTORS.grantRole[1] ? 'grantRole' : 'revokeRole';
        meaning =
          args.length < 128
            ? `${call} with arguments that cannot be read; `
            : `${call}(${roleName(`0x${args.slice(0, 64)}`)}, ${asAddress(args.slice(64, 128))}); `;
      }
      say({
        status,
        what: 'pending operation',
        live: `${id} call ${Number(asUint(log.topics[2] ?? '0'))}: target ${target}, selector ${selector}`,
        note: `${meaning}may run at ${iso(at)} (${at})`,
      });
    }
    if (logs) say({ status: 'INFO', what: 'pending operations', live: `${pending}` });
  }
}

/** The last line: what was found, in one sentence. */
export function verdict(result: AuthorityResult): string {
  const warned = result.lines.filter((l) => l.status === 'WARN').length;
  const warnings = warned ? `, ${warned} warning${warned === 1 ? '' : 's'}` : '';
  return result.failures.length === 0
    ? `VERDICT: OK, the chain is as the record says${warnings}`
    : `VERDICT: FAILED, ${result.failures.length} finding${result.failures.length === 1 ? '' : 's'}${warnings}`;
}

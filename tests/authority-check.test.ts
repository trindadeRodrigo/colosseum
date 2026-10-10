import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AuthorityRecord,
  type AuthorityResult,
  CallReverted,
  type ChainLog,
  checkAuthority,
  formatLine,
  IMPLEMENTATION_SLOT,
  isMainnet,
  type LogFilter,
  parseRecord,
  type Reader,
  ROLES,
  SELECTORS,
  TOPICS,
  verdict,
  ZERO_ADDRESS,
} from '../scripts/ops/authority';

// The authority check (SEC-1) against a chain in memory: a healthy timelocked mainnet passes, and each
// thing that must not be true is one change to the chain or to the record, and fails. No node is asked.

const ROOT = join(import.meta.dirname, '..');

// ---- a chain in memory

const at = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const FACTORY = at(0xf1);
const REGISTRY = at(0xf2);
const BEACON = at(0xf3);
const VAULT_LOGIC = at(0xa1);
const FACTORY_LOGIC = at(0xa2);
const REGISTRY_LOGIC = at(0xa3);
const TIMELOCK = at(0x71);
const SAFE = at(0x5afe);
const OTHER_SAFE = at(0x5aff);
const GUARDIAN = at(0x60); // a key
const KEEPER = at(0x6e); // a key
const DEPLOYER = at(0xde); // a key
const CASH = at(0xc0);
const STOCK = at(0xc1);
const CASH_FEED = at(0xfe0);
const STOCK_FEED = at(0xfe1);
const STOCK_AVERAGE = at(0xfe2);
const MAX = (1n << 256n) - 1n;
const DAYS_2 = 172_800n;

type ModelAsset = { token: string; feed: string; flags: number; averageFeed: string };
type Model = {
  chainId: number;
  head: number;
  code: Set<string>;
  factory: {
    admin: string;
    pendingAdmin: string;
    guardian: string;
    keeper: string;
    launched: boolean;
    beacon: string;
    registry: string;
    implementation: string;
    caps: { perVault: bigint; total: bigint };
  };
  beacon: { owner: string; pendingOwner: string; implementation: string };
  registry: { publishDelay: bigint; factory: string; implementation: string };
  assets: ModelAsset[];
  /** Feeds that answer `writer()`: ours, written by one key. */
  testFeeds: Set<string>;
  timelock?: {
    address: string;
    minDelay: bigint;
    /** role id -> who holds it now */
    holders: Record<string, Set<string>>;
    logs: (ChainLog & { block: number })[];
    timestamps: Map<string, bigint>;
  };
  /** `<address>:<selector>` of calls that revert. */
  reverting: Set<string>;
  /** `all`: eth_getLogs never answers. `whole`: it refuses a range over 50,000 blocks. */
  logsFail?: 'all' | 'whole';
  logCalls: number;
};

const word = (v: bigint | number | boolean | string) =>
  (typeof v === 'string' ? v.replace(/^0x/, '') : BigInt(v).toString(16)).padStart(64, '0');
const hex = (...parts: (bigint | number | boolean | string)[]) => `0x${parts.map(word).join('')}`;
const selector = (name: keyof typeof SELECTORS) => SELECTORS[name][1];

function readerOf(model: Model): Reader {
  const f = model.factory;
  const answers: Record<string, Record<string, () => string>> = {
    [FACTORY]: {
      [selector('admin')]: () => hex(f.admin),
      [selector('pendingAdmin')]: () => hex(f.pendingAdmin),
      [selector('guardian')]: () => hex(f.guardian),
      [selector('keeper')]: () => hex(f.keeper),
      [selector('launched')]: () => hex(f.launched),
      [selector('beacon')]: () => hex(f.beacon),
      [selector('registry')]: () => hex(f.registry),
      [selector('keeperPaused')]: () => hex(false),
      [selector('depositsPaused')]: () => hex(false),
      [selector('depositCaps')]: () => hex(f.caps.perVault, f.caps.total),
      [selector('totalDeposited')]: () => hex(0),
      [selector('assets')]: () => hex(32, model.assets.length, ...model.assets.map((a) => a.token)),
      [selector('cashToken')]: () => hex(CASH),
      [selector('sessionPriceAge')]: () => hex(3600),
      [selector('priceDevBps')]: () => hex(200),
    },
    [BEACON]: {
      [selector('owner')]: () => hex(model.beacon.owner),
      [selector('pendingOwner')]: () => hex(model.beacon.pendingOwner),
      [selector('implementation')]: () => hex(model.beacon.implementation),
    },
    [REGISTRY]: {
      [selector('publishDelay')]: () => hex(model.registry.publishDelay),
      [selector('factory')]: () => hex(model.registry.factory),
    },
  };
  return {
    chainId: async () => model.chainId,
    blockNumber: async () => model.head,
    code: async (address) => (model.code.has(address) ? '0x60806040' : '0x'),
    storageAt: async (address, slot) => {
      if (slot !== IMPLEMENTATION_SLOT) return hex(0);
      if (address === FACTORY) return hex(f.implementation);
      if (address === REGISTRY) return hex(model.registry.implementation);
      return hex(0);
    },
    call: async (to, data) => {
      const sel = data.slice(0, 10);
      const args = data.slice(10);
      if (model.reverting.has(`${to}:${sel}`)) throw new CallReverted();
      if (!model.code.has(to)) return '0x';
      if (to === FACTORY && sel === selector('asset')) {
        const token = `0x${args.slice(24, 64)}`;
        const a = model.assets.find((x) => x.token === token);
        if (!a) throw new CallReverted();
        // feed, tokenDecimals, feedDecimals, maxAge, session, source, maxWeightBps, pauseProbe,
        // pauseSelector, scheduleSelector, haltUntil, flags, averageFeed, minPrice, maxPrice
        return hex(a.feed, 18, 8, 93600, 1, 1, 5000, 0, 0, 0, 0, a.flags, a.averageFeed, 1, 2);
      }
      const tl = model.timelock;
      if (tl && to === tl.address) {
        if (sel === selector('getMinDelay')) return hex(tl.minDelay);
        if (sel === selector('hasRole')) {
          const role = `0x${args.slice(0, 64)}`;
          const account = `0x${args.slice(88, 128)}`;
          return hex(tl.holders[role]?.has(account) ?? false);
        }
        if (sel === selector('getTimestamp'))
          return hex(tl.timestamps.get(`0x${args.slice(0, 64)}`) ?? 0n);
      }
      if (sel === selector('writer')) {
        if (model.testFeeds.has(to)) return hex(DEPLOYER);
        throw new CallReverted();
      }
      const answer = answers[to]?.[sel];
      if (!answer) throw new CallReverted();
      return answer();
    },
    logs: async (filter: LogFilter) => {
      model.logCalls++;
      if (model.logsFail === 'all') throw new Error('eth_getLogs refused');
      if (model.logsFail === 'whole' && filter.toBlock - filter.fromBlock >= 50_000)
        throw new Error('range too wide');
      const first = filter.topics[0];
      const wanted = Array.isArray(first) ? first : first ? [first] : null;
      return (model.timelock?.address === filter.address ? model.timelock.logs : []).filter(
        (l) =>
          l.block >= filter.fromBlock &&
          l.block <= filter.toBlock &&
          (!wanted || wanted.includes(l.topics[0] ?? '')),
      );
    },
  };
}

const DEPLOY_BLOCK = 1_000;
const grant = (role: string, account: string, block = DEPLOY_BLOCK) => ({
  topics: [TOPICS.roleGranted[1], role, hex(account), hex(DEPLOYER)],
  data: '0x',
  block,
});
const revoke = (role: string, account: string, block = DEPLOY_BLOCK + 1) => ({
  topics: [TOPICS.roleRevoked[1], role, hex(account), hex(TIMELOCK)],
  data: '0x',
  block,
});
/** `CallScheduled(id, index, target, value, data, predecessor, delay)` with `data` a bare selector. */
const scheduled = (id: string, target: string, callSelector: string, block: number) => ({
  topics: [TOPICS.callScheduled[1], id, hex(0)],
  data: `${hex(target, 0, 0xa0, 0, DAYS_2, 4)}${callSelector.slice(2).padEnd(64, '0')}`,
  block,
});

const THREE = ['PROPOSER_ROLE', 'CANCELLER_ROLE', 'EXECUTOR_ROLE'] as const;

/** A mainnet deploy as `Deploy.s.sol` leaves it: the Safe behind a 48 hour timelock, the deployer with nothing. */
function mainnetModel(): Model {
  return {
    chainId: 4663,
    head: 5_000,
    code: new Set([
      FACTORY,
      REGISTRY,
      BEACON,
      VAULT_LOGIC,
      FACTORY_LOGIC,
      REGISTRY_LOGIC,
      TIMELOCK,
      SAFE,
      OTHER_SAFE,
      CASH,
      STOCK,
      CASH_FEED,
      STOCK_FEED,
      STOCK_AVERAGE,
    ]),
    factory: {
      admin: TIMELOCK,
      pendingAdmin: ZERO_ADDRESS,
      guardian: GUARDIAN,
      keeper: ZERO_ADDRESS,
      launched: false,
      beacon: BEACON,
      registry: REGISTRY,
      implementation: FACTORY_LOGIC,
      caps: { perVault: 10_000_000_000n, total: 10_000_000_000n },
    },
    beacon: { owner: TIMELOCK, pendingOwner: ZERO_ADDRESS, implementation: VAULT_LOGIC },
    registry: { publishDelay: DAYS_2, factory: FACTORY, implementation: REGISTRY_LOGIC },
    assets: [
      { token: CASH, feed: CASH_FEED, flags: 0, averageFeed: ZERO_ADDRESS },
      { token: STOCK, feed: STOCK_FEED, flags: 0, averageFeed: STOCK_AVERAGE },
    ],
    testFeeds: new Set(),
    timelock: {
      address: TIMELOCK,
      minDelay: DAYS_2,
      holders: {
        [ROLES.PROPOSER_ROLE]: new Set([SAFE]),
        [ROLES.CANCELLER_ROLE]: new Set([SAFE]),
        [ROLES.EXECUTOR_ROLE]: new Set([SAFE]),
        [ROLES.DEFAULT_ADMIN_ROLE]: new Set([TIMELOCK]),
      },
      // The constructor grants; the hand-over batch takes the deployer's three roles away.
      logs: [
        grant(ROLES.DEFAULT_ADMIN_ROLE, TIMELOCK),
        ...THREE.flatMap((r) => [grant(ROLES[r], SAFE), grant(ROLES[r], DEPLOYER)]),
        ...THREE.map((r) => revoke(ROLES[r], DEPLOYER)),
      ],
      timestamps: new Map(),
    },
    reverting: new Set(),
    logCalls: 0,
  };
}

const mainnetRecordJson = () => ({
  network: 'robinhood-mainnet',
  evmChainId: 4663,
  deployBlock: DEPLOY_BLOCK,
  contracts: {
    factory: FACTORY,
    registry: REGISTRY,
    beacon: BEACON,
    vaultLogic: VAULT_LOGIC,
    factoryLogic: FACTORY_LOGIC,
    registryLogic: REGISTRY_LOGIC,
  },
  roles: { admin: TIMELOCK, guardian: GUARDIAN, keeper: ZERO_ADDRESS },
  timelock: {
    address: TIMELOCK,
    minDelay: 172800,
    proposers: [SAFE],
    cancellers: [SAFE],
    executors: [SAFE],
  },
  expected: {
    launched: false,
    publishDelay: 172800,
    keeperEnabled: false,
    depositCaps: { perVault: '10000000000', total: '10000000000' },
  },
});
type RecordJson = ReturnType<typeof mainnetRecordJson> & { todo?: string };

/** Runs the check on the healthy mainnet after one change to the chain, the record, or both. */
async function run(
  change: { model?: (m: Model) => void; record?: (r: RecordJson) => void } = {},
): Promise<AuthorityResult & { model: Model; record: AuthorityRecord }> {
  const model = mainnetModel();
  const json: RecordJson = mainnetRecordJson();
  change.model?.(model);
  change.record?.(json);
  const record = parseRecord(JSON.stringify(json));
  return { ...(await checkAuthority(record, readerOf(model))), model, record };
}
const text = (r: AuthorityResult) => r.lines.map(formatLine).join('\n');
const tl = (m: Model) => {
  if (!m.timelock) throw new Error('the model has no timelock');
  return m.timelock;
};

describe('the selectors and topics the check is written with', () => {
  // viem is chain-evm's dependency, not the root's: it is asked for from there, for this one check.
  const { keccak256, toBytes } = createRequire(join(ROOT, 'packages/chain-evm/package.json'))(
    'viem',
  ) as { keccak256: (b: Uint8Array) => string; toBytes: (s: string) => Uint8Array };
  const hash = (s: string) => keccak256(toBytes(s));

  it('are each the hash of the signature beside them', () => {
    for (const [signature, sel] of Object.values(SELECTORS))
      expect([signature, sel]).toEqual([signature, hash(signature).slice(0, 10)]);
    for (const [signature, topic] of Object.values(TOPICS))
      expect([signature, topic]).toEqual([signature, hash(signature)]);
    for (const name of THREE) expect(ROLES[name]).toBe(hash(name));
    expect(BigInt(ROLES.DEFAULT_ADMIN_ROLE)).toBe(0n);
    expect(BigInt(IMPLEMENTATION_SLOT)).toBe(BigInt(hash('eip1967.proxy.implementation')) - 1n);
  });

  it('treat every chain as a mainnet but the three test networks, as the deploy script does', () => {
    expect([31337, 46630, 84532].map(isMainnet)).toEqual([false, false, false]);
    expect([4663, 8453, 1].map(isMainnet)).toEqual([true, true, true]);
  });
});

describe('a healthy timelocked mainnet', () => {
  it('passes with no failure and no warning, and says who holds what', async () => {
    const r = await run();
    expect(r.failures).toEqual([]);
    expect(r.lines.filter((l) => l.status !== 'OK' && l.status !== 'INFO')).toEqual([]);
    expect(verdict(r)).toBe('VERDICT: OK, the chain is as the record says');
    const out = text(r);
    expect(out).toContain(`OK\tfactory.admin()\t${TIMELOCK} (contract)\texpected ${TIMELOCK}`);
    expect(out).toContain(`OK\tbeacon.owner()\t${TIMELOCK} (contract)`);
    for (const role of THREE)
      expect(out).toContain(`OK\t${role}\t${SAFE} (contract)\texpected holds it`);
    expect(out).toContain(`OK\tDEFAULT_ADMIN_ROLE\t${TIMELOCK} (timelock)`);
    expect(out).toContain(`INFO\tguardian\t${GUARDIAN} (no code)`);
    expect(out).toContain('INFO\tpending operations\t0');
    for (const fact of [
      'keeperPaused',
      'depositsPaused',
      'totalDeposited',
      'priceDevBps',
      'sessionPriceAge',
      'cashToken',
    ])
      expect(out).toContain(`INFO\tfactory.${fact}()`);
    // The deployer was granted three roles and holds none: revoked is not a finding.
    expect(out).not.toContain(DEPLOYER);
    expect(r.model.logCalls).toBe(1);
  });

  it('passes with the keeper on, a key that is not the guardian', async () => {
    const r = await run({
      model: (m) => {
        m.factory.keeper = KEEPER;
        m.assets[1] = { ...(m.assets[1] as ModelAsset), flags: 1 };
      },
      record: (j) => {
        j.roles.keeper = KEEPER;
        j.expected.keeperEnabled = true;
      },
    });
    expect(r.failures).toEqual([]);
  });

  it('reads the logs in chunks when the node refuses the whole range', async () => {
    const r = await run({
      model: (m) => {
        m.logsFail = 'whole';
        m.head = DEPLOY_BLOCK + 150_000;
      },
    });
    expect(r.failures).toEqual([]);
    // The whole range once, then four chunks of 50,000 blocks.
    expect(r.model.logCalls).toBe(1 + 4);
  });

  it('prints a scheduled operation that has not run, and does not fail on it', async () => {
    const queued = `0x${'ab'.repeat(32)}`;
    const done = `0x${'cd'.repeat(32)}`;
    const cancelled = `0x${'ef'.repeat(32)}`;
    const r = await run({
      model: (m) => {
        // upgradeTo(address) on the beacon, queued; one that ran; one that was cancelled.
        tl(m).logs.push(
          scheduled(queued, BEACON, '0x3659cfe6', 2_000),
          scheduled(done, FACTORY, '0x704b6c02', 2_001),
          scheduled(cancelled, FACTORY, '0x704b6c02', 2_002),
        );
        tl(m).timestamps.set(queued, 1_800_000_000n).set(done, 1n);
      },
    });
    expect(r.failures).toEqual([]);
    const pending = r.lines.filter((l) => l.what === 'pending operation');
    expect(pending.map(formatLine)).toEqual([
      `INFO\tpending operation\t${queued} call 0: target ${BEACON}, selector 0x3659cfe6\t\tmay run at 2027-01-15T08:00:00.000Z (1800000000)`,
    ]);
    expect(text(r)).toContain('INFO\tpending operations\t1');
  });
});

describe('what fails on a mainnet, one change each', () => {
  const cases: [string, Parameters<typeof run>[0], RegExp][] = [
    [
      'the admin is another address than the record names',
      {
        model: (m) => {
          m.factory.admin = OTHER_SAFE;
        },
      },
      /^factory\.admin\(\): live 0x0+5aff \(contract\): expected 0x0+71$/,
    ],
    [
      'the beacon owner is not the factory admin',
      {
        model: (m) => {
          m.beacon.owner = OTHER_SAFE;
        },
      },
      /^beacon\.owner\(\): the beacon owner is not the factory admin/,
    ],
    [
      'a pending admin',
      {
        model: (m) => {
          m.factory.pendingAdmin = OTHER_SAFE;
        },
      },
      /^factory\.pendingAdmin\(\): a hand-over is proposed and not accepted/,
    ],
    [
      'a pending beacon owner',
      {
        model: (m) => {
          m.beacon.pendingOwner = DEPLOYER;
        },
      },
      /^beacon\.pendingOwner\(\): a hand-over is proposed and not accepted/,
    ],
    [
      'no guardian',
      {
        model: (m) => {
          m.factory.guardian = ZERO_ADDRESS;
        },
      },
      /^factory\.guardian\(\): no guardian/,
    ],
    [
      'the guardian is the keeper',
      {
        model: (m) => {
          m.factory.keeper = GUARDIAN;
        },
        record: (j) => {
          j.roles.keeper = GUARDIAN;
          j.expected.keeperEnabled = true;
        },
      },
      /^factory\.guardian\(\): the guardian is the keeper/,
    ],
    [
      'a keeper is set while keeperEnabled is false',
      {
        model: (m) => {
          m.factory.keeper = KEEPER;
        },
        record: (j) => {
          j.roles.keeper = KEEPER;
        },
      },
      /^factory\.keeper\(\): a keeper is set while keeperEnabled is false/,
    ],
    [
      "an asset's keeper switch is on while keeperEnabled is false",
      {
        model: (m) => {
          m.assets[1] = { ...(m.assets[1] as ModelAsset), flags: 1 };
        },
      },
      /^asset 0x0+c1: an asset's keeper switch is on while keeperEnabled is false/,
    ],
    [
      'keeperEnabled with no keeper',
      {
        record: (j) => {
          j.expected.keeperEnabled = true;
        },
      },
      /^factory\.keeper\(\): keeperEnabled with no keeper/,
    ],
    [
      'the admin has no code',
      { model: (m) => void m.code.delete(TIMELOCK) },
      /^factory\.admin\(\): the admin has no code/,
    ],
    [
      'a proposer has no code',
      { model: (m) => void m.code.delete(SAFE) },
      /^PROPOSER_ROLE: has no code: on a mainnet it must be a contract \(a Safe\), not a key/,
    ],
    [
      'a proposer that is not in the record, granted in the logs',
      {
        model: (m) => {
          tl(m).logs.push(grant(ROLES.PROPOSER_ROLE, OTHER_SAFE, 3_000));
          tl(m).holders[ROLES.PROPOSER_ROLE]?.add(OTHER_SAFE);
        },
      },
      /^PROPOSER_ROLE: holds the role and is not in the record: live 0x0+5aff \(contract\)$/,
    ],
    [
      'a proposer the record names does not hold the role',
      { model: (m) => void tl(m).holders[ROLES.PROPOSER_ROLE]?.delete(SAFE) },
      /^PROPOSER_ROLE: the record names it and it does not hold the role/,
    ],
    [
      'the deployer still holds EXECUTOR',
      { model: (m) => void tl(m).holders[ROLES.EXECUTOR_ROLE]?.add(DEPLOYER) },
      /^EXECUTOR_ROLE: holds the role and is not in the record: live 0x0+de \(no code\)$/,
    ],
    [
      'the executor is open to the zero address',
      { model: (m) => void tl(m).holders[ROLES.EXECUTOR_ROLE]?.add(ZERO_ADDRESS) },
      /^EXECUTOR_ROLE: held by the zero address: the role is open to anyone/,
    ],
    [
      'the Safe holds DEFAULT_ADMIN',
      {
        model: (m) => {
          tl(m).logs.push(grant(ROLES.DEFAULT_ADMIN_ROLE, SAFE));
          tl(m).holders[ROLES.DEFAULT_ADMIN_ROLE]?.add(SAFE);
        },
      },
      /^DEFAULT_ADMIN_ROLE: holds the admin of the roles.*live 0x0+5afe \(contract\)$/,
    ],
    [
      'the timelock does not hold DEFAULT_ADMIN',
      { model: (m) => void tl(m).holders[ROLES.DEFAULT_ADMIN_ROLE]?.delete(TIMELOCK) },
      /^DEFAULT_ADMIN_ROLE: the timelock does not hold the admin of its own roles/,
    ],
    [
      'the delay is lower than the record says',
      {
        record: (j) => {
          j.timelock.minDelay = 259200;
        },
      },
      /^timelock\.getMinDelay\(\): live 172800: expected 259200$/,
    ],
    [
      'the delay is under 48 hours',
      {
        model: (m) => {
          tl(m).minDelay = 3600n;
        },
        record: (j) => {
          j.timelock.minDelay = 3600;
        },
      },
      /^timelock\.getMinDelay\(\): the timelock delay is under 48 hours/,
    ],
    [
      "the beacon's implementation differs",
      {
        model: (m) => {
          m.beacon.implementation = OTHER_SAFE;
        },
      },
      /^beacon\.implementation\(\): live 0x0+5aff \(contract\): expected 0x0+a1$/,
    ],
    [
      "the factory's implementation slot differs",
      {
        model: (m) => {
          m.factory.implementation = OTHER_SAFE;
        },
      },
      /^factory implementation slot: live 0x0+5aff \(contract\): expected 0x0+a2$/,
    ],
    [
      "the registry's implementation slot differs",
      {
        model: (m) => {
          m.registry.implementation = OTHER_SAFE;
        },
      },
      /^registry implementation slot: live 0x0+5aff \(contract\): expected 0x0+a3$/,
    ],
    [
      'the factory names another beacon',
      {
        model: (m) => {
          m.factory.beacon = OTHER_SAFE;
        },
      },
      /^factory\.beacon\(\): live/,
    ],
    [
      'the registry names another factory',
      {
        model: (m) => {
          m.registry.factory = OTHER_SAFE;
        },
      },
      /^registry\.factory\(\): live/,
    ],
    [
      'a contract of the record has no code',
      { model: (m) => void m.code.delete(VAULT_LOGIC) },
      /^contracts\.vaultLogic: no code at the address the record names/,
    ],
    [
      'launched differs',
      {
        model: (m) => {
          m.factory.launched = true;
        },
      },
      /^factory\.launched\(\): live true: expected false$/,
    ],
    [
      'the publish delay differs',
      {
        model: (m) => {
          m.registry.publishDelay = 259_200n;
        },
      },
      /^registry\.publishDelay\(\): live 259200: expected 172800$/,
    ],
    [
      'the publish delay is under 48 hours',
      {
        model: (m) => {
          m.registry.publishDelay = 3600n;
        },
        record: (j) => {
          j.expected.publishDelay = 3600;
        },
      },
      /^registry\.publishDelay\(\): the publish delay is under 172,800 s/,
    ],
    [
      'the caps differ',
      {
        model: (m) => {
          m.factory.caps.total = 20_000_000_000n;
        },
      },
      /^factory\.depositCaps\(\)\.total: live 20000000000: expected 10000000000$/,
    ],
    [
      'the caps are 2^256-1, which is no cap',
      {
        model: (m) => {
          m.factory.caps = { perVault: MAX, total: MAX };
        },
        record: (j) => {
          j.expected.depositCaps = { perVault: MAX.toString(), total: MAX.toString() };
        },
      },
      /^factory\.depositCaps\(\): a deposit cap of 2\^256-1 is no cap/,
    ],
    [
      'a cap of zero',
      {
        model: (m) => {
          m.factory.caps.perVault = 0n;
        },
        record: (j) => {
          j.expected.depositCaps.perVault = '0';
        },
      },
      /^factory\.depositCaps\(\): a deposit cap of zero/,
    ],
    [
      "one vault's cap is above the total",
      {
        model: (m) => {
          m.factory.caps.perVault = 10_000_000_001n;
        },
        record: (j) => {
          j.expected.depositCaps.perVault = '10000000001';
        },
      },
      /^factory\.depositCaps\(\): the cap of one vault is above the total/,
    ],
    [
      'a feed has no code',
      { model: (m) => void m.code.delete(STOCK_FEED) },
      /^asset 0x0+c1 feed: has no code/,
    ],
    [
      'a feed answers writer()',
      { model: (m) => void m.testFeeds.add(STOCK_FEED) },
      /^asset 0x0+c1 feed: answers writer\(\): a test feed, one key writes it/,
    ],
    [
      'an average feed answers writer()',
      { model: (m) => void m.testFeeds.add(STOCK_AVERAGE) },
      /^asset 0x0+c1 averageFeed: answers writer\(\)/,
    ],
    [
      'the logs cannot be read',
      {
        model: (m) => {
          m.logsFail = 'all';
        },
      },
      /^timelock logs: could not be read \(eth_getLogs refused or failed\)/,
    ],
    [
      "the record's deploy block is after the timelock was created",
      {
        record: (j) => {
          j.deployBlock = DEPLOY_BLOCK + 1;
        },
      },
      /^timelock logs: the range from the record's deployBlock does not hold the timelock's creation/,
    ],
    [
      'a read reverts',
      { model: (m) => void m.reverting.add(`${FACTORY}:${SELECTORS.guardian[1]}`) },
      /^factory\.guardian\(\): could not be read: the call reverted$/,
    ],
    [
      'the record has no timelock',
      { record: (j) => void delete (j as Partial<RecordJson>).timelock },
      /^record\.timelock: missing: a mainnet has a timelock/,
    ],
    [
      'the record does not say what it expects',
      { record: (j) => void delete (j as Partial<RecordJson>).expected },
      /^record\.expected: missing/,
    ],
    [
      'the record names the zero address as guardian',
      {
        record: (j) => {
          j.roles.guardian = ZERO_ADDRESS;
        },
      },
      /^record\.roles\.guardian: the zero address where a mainnet needs an address/,
    ],
  ];

  it.each(cases)('%s', async (_name, change, failure) => {
    const r = await run(change);
    expect(r.failures.filter((f) => failure.test(f))).toHaveLength(1);
    expect(verdict(r)).toMatch(/^VERDICT: FAILED, \d+ finding/);
  });

  // Where one change is one finding, nothing else is reported with it.
  it.each(
    cases.filter(([name]) =>
      [
        'the beacon owner is not the factory admin',
        'a pending admin',
        'a pending beacon owner',
        'the guardian is the keeper',
        "an asset's keeper switch is on while keeperEnabled is false",
        'a proposer that is not in the record, granted in the logs',
        'the executor is open to the zero address',
        'the Safe holds DEFAULT_ADMIN',
        'the delay is lower than the record says',
        'the delay is under 48 hours',
        "the beacon's implementation differs",
        "the factory's implementation slot differs",
        "the registry's implementation slot differs",
        'launched differs',
        'the publish delay differs',
        'the caps differ',
        'a feed has no code',
        'a feed answers writer()',
        'the logs cannot be read',
        'a read reverts',
      ].includes(name),
    ),
  )('%s, and that is the only finding', async (_name, change) => {
    expect((await run(change)).failures).toHaveLength(1);
  });

  it('the node answers another chain id, and nothing more is read', async () => {
    const r = await run({
      model: (m) => {
        m.chainId = 46630;
      },
    });
    expect(r.failures).toEqual(['chain id: live 46630: expected 4663']);
    expect(r.lines).toHaveLength(1);
  });

  it('the node does not answer a read: the failure names the read', async () => {
    const model = mainnetModel();
    const reader = readerOf(model);
    const r = await checkAuthority(parseRecord(JSON.stringify(mainnetRecordJson())), {
      ...reader,
      storageAt: async () => {
        throw new Error('https://node.example/secret-key did not answer');
      },
    });
    expect(r.failures).toEqual([
      'factory implementation slot: could not be read: the node did not answer',
      'registry implementation slot: could not be read: the node did not answer',
    ]);
    // What the reader threw is never passed on: it can carry the URL.
    expect(text(r)).not.toContain('node.example');
  });

  it('a feed whose writer() cannot be asked is a failure, not a pass', async () => {
    const reader = readerOf(mainnetModel());
    const r = await checkAuthority(parseRecord(JSON.stringify(mainnetRecordJson())), {
      ...reader,
      call: async (to, data) => {
        if (to === STOCK_FEED) throw new Error('timeout');
        return reader.call(to, data);
      },
    });
    expect(r.failures).toEqual([
      `asset ${STOCK} feed writer(): could not be read: the node did not answer`,
    ]);
  });

  it('a record with a placeholder is refused before anything is read', async () => {
    const r = await run({
      record: (j) => {
        j.todo = 'confirm the Safe';
      },
    });
    expect(r.failures).toEqual([
      'record: refused: it still holds a placeholder (todo); every value must be confirmed by a person',
    ]);
    expect(r.lines).toHaveLength(1);
  });

  it('the committed example of a mainnet record is refused, and reads as a record', () => {
    const example = parseRecord(
      readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.example.json'), 'utf8'),
    );
    expect(example.placeholder).toBe(true);
    expect(example.evmChainId).toBe(4663);
    expect(example.timelock?.proposers).toEqual([ZERO_ADDRESS]);
    expect(example.expected?.depositCaps.total).toBe(10_000_000_000n);
  });

  it('a record with the placeholder note removed and the zero addresses left is refused too', async () => {
    const json = JSON.parse(
      readFileSync(join(ROOT, 'deployments', 'robinhood-mainnet.example.json'), 'utf8'),
    );
    delete json.todo;
    const r = await checkAuthority(parseRecord(JSON.stringify(json)), readerOf(mainnetModel()));
    expect(r.failures).toEqual(
      expect.arrayContaining([
        'record.contracts.factory: the zero address where a mainnet needs an address',
        'record.roles.admin: the zero address where a mainnet needs an address',
        'record.timelock.address: the zero address where a mainnet needs an address',
        'record.timelock.proposers[0]: the zero address where a mainnet needs an address',
      ]),
    );
  });

  it('a record that is not one is refused by name of the field, not read', () => {
    expect(() => parseRecord('{')).toThrow('the record is not JSON');
    expect(() => parseRecord(JSON.stringify({ evmChainId: 4663 }))).toThrow(
      'the record is not one this check reads: contracts, roles',
    );
  });
});

describe('a test network is not held to the mainnet rules', () => {
  const committed = () =>
    parseRecord(readFileSync(join(ROOT, 'deployments', 'robinhood-testnet.json'), 'utf8'));

  /** The chain as the committed record of 46630 says: one key, no timelock, no guardian, our feeds. */
  function testnetModel(record: AuthorityRecord): Model {
    const m = mainnetModel();
    const c = record.contracts;
    // The model's contracts sit at fixed addresses: the record is read as naming those.
    expect(Object.keys(c)).toHaveLength(6);
    m.chainId = 46630;
    m.timelock = undefined;
    m.code.delete(TIMELOCK);
    m.factory.admin = DEPLOYER;
    m.beacon.owner = DEPLOYER;
    m.factory.guardian = ZERO_ADDRESS;
    m.factory.keeper = ZERO_ADDRESS;
    m.factory.caps = { perVault: MAX, total: MAX };
    m.registry.publishDelay = 60n;
    m.assets[1] = { ...(m.assets[1] as ModelAsset), flags: 1 };
    m.testFeeds = new Set([CASH_FEED, STOCK_FEED, STOCK_AVERAGE]);
    return m;
  }
  /** The committed record with its addresses mapped onto the model's. */
  function onModel(record: AuthorityRecord): AuthorityRecord {
    return {
      ...record,
      contracts: {
        factory: FACTORY,
        registry: REGISTRY,
        beacon: BEACON,
        vaultLogic: VAULT_LOGIC,
        factoryLogic: FACTORY_LOGIC,
        registryLogic: REGISTRY_LOGIC,
      },
      roles: { ...record.roles, admin: DEPLOYER },
    };
  }

  it('the committed record of 46630 has the shape of one key: no timelock, no guardian, no keeper', () => {
    const record = committed();
    expect(record.evmChainId).toBe(46630);
    expect(record.placeholder).toBe(false);
    expect(record.timelock).toBeUndefined();
    expect(record.expected).toBeUndefined();
    expect(record.roles.guardian).toBe(ZERO_ADDRESS);
    expect(record.roles.keeper).toBe(ZERO_ADDRESS);
  });

  it('passes: a key as admin, no guardian, test feeds, no caps and a short delay are all allowed there', async () => {
    const record = onModel(committed());
    const r = await checkAuthority(record, readerOf(testnetModel(record)));
    expect(r.failures).toEqual([]);
    const out = text(r);
    expect(out).toContain('INFO\trules\ttest network');
    expect(out).toContain(`OK\tfactory.admin()\t${DEPLOYER} (no code)\texpected ${DEPLOYER}`);
    expect(out).toContain(`OK\tfactory.guardian()\t${ZERO_ADDRESS} (zero)`);
    expect(out).toContain('INFO\tregistry.publishDelay()\t60');
  });

  it('the same chain under a mainnet chain id fails the mainnet rules', async () => {
    const record = { ...onModel(committed()), evmChainId: 4663 };
    const model = testnetModel(record);
    model.chainId = 4663;
    const r = await checkAuthority(record, readerOf(model));
    expect(r.failures).toEqual(
      expect.arrayContaining([
        'record.timelock: missing: a mainnet has a timelock',
        `factory.admin(): the admin has no code: on a mainnet it is the timelock, not a key: live ${DEPLOYER} (no code)`,
        `factory.guardian(): no guardian: live ${ZERO_ADDRESS}`,
        `factory.depositCaps(): a deposit cap of 2^256-1 is no cap: live perVault ${MAX}, total ${MAX}`,
        'registry.publishDelay(): the publish delay is under 172,800 s: live 60',
      ]),
    );
  });

  it('still fails there on what differs from the record: a keeper the record does not name', async () => {
    const record = onModel(committed());
    const model = testnetModel(record);
    model.factory.keeper = KEEPER;
    const r = await checkAuthority(record, readerOf(model));
    expect(r.failures).toEqual([
      `factory.keeper(): live ${KEEPER} (no code): expected ${ZERO_ADDRESS}`,
    ]);
  });

  it('warns and does not fail on a figure an older factory does not answer', async () => {
    const record = onModel(committed());
    const model = testnetModel(record);
    for (const name of [
      'depositCaps',
      'depositsPaused',
      'totalDeposited',
      'sessionPriceAge',
    ] as const)
      model.reverting.add(`${FACTORY}:${SELECTORS[name][1]}`);
    const r = await checkAuthority(record, readerOf(model));
    expect(r.failures).toEqual([]);
    expect(r.lines.filter((l) => l.status === 'WARN').map((l) => l.what)).toEqual([
      'factory.depositCaps()',
      'factory.depositsPaused()',
      'factory.totalDeposited()',
      'factory.sessionPriceAge()',
    ]);
    expect(verdict(r)).toBe('VERDICT: OK, the chain is as the record says, 4 warnings');
  });

  it('with a timelock there, logs that cannot be read are a warning, and the record is still asked', async () => {
    const model = mainnetModel();
    model.chainId = 46630;
    model.logsFail = 'all';
    const record = parseRecord(JSON.stringify({ ...mainnetRecordJson(), evmChainId: 46630 }));
    const r = await checkAuthority(record, readerOf(model));
    expect(r.failures).toEqual([]);
    expect(r.lines.filter((l) => l.status === 'WARN').map((l) => l.what)).toEqual([
      'timelock logs',
    ]);
    expect(text(r)).toContain(`OK\tPROPOSER_ROLE\t${SAFE} (contract)\texpected holds it`);
  });
});

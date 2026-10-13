import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvmDeploymentRecord } from '@colosseum/chain-evm/vault';
import { readDeploymentFile } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';
import { parseRecord } from '../scripts/ops/authority';
import { buildRecords, validate, writeBoth } from '../scripts/ops/mainnet-records';

// The two files the app runs on after a mainnet deploy, written from what the deploy left behind. The
// broadcast here is forge's own, from a run of the deploy script against a local fork of Robinhood
// Chain mainnet: nothing in it reached a network. The deploy file is the committed one.

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const broadcast = read('tests/fixtures/mainnet-records/run-latest.json');
const config = read('contracts/script/config/4663.json');
// The guard's file as it stood before the deploy: marked a placeholder, with no contract named.
const guard = (() => {
  const g = JSON.parse(read('packages/sdk/deployments/mainnet.json'));
  const zero = `0x${'0'.repeat(40)}`;
  Object.assign(g.chains.robinhood, { factory: zero, beacon: zero, registry: zero });
  return JSON.stringify({ placeholder: true, todo: 'not deployed', ...g });
})();
// biome-ignore lint/suspicious/noExplicitAny: files as they are read, edited field by field
type Json = any;
const edit = (text: string, change: (j: Json) => void) => {
  const j = JSON.parse(text);
  change(j);
  return JSON.stringify(j);
};

describe('the records of a mainnet deploy', () => {
  it('are built from the broadcast and the deploy file, and every reader takes them', () => {
    const built = buildRecords({ broadcast, config, guard });
    validate(built);
    const record = EvmDeploymentRecord.parse(built.record);
    expect([record.network, record.provenance, record.evmChainId]).toEqual([
      'robinhood-mainnet',
      'live',
      4663,
    ]);
    // The deploy creates seven contracts; the two proxies are the factory, then the registry.
    const b = JSON.parse(broadcast);
    const made = (name: string) =>
      b.transactions
        .filter((t: Json) => t.transactionType === 'CREATE' && t.contractName === name)
        .map((t: Json) => t.contractAddress.toLowerCase());
    expect(record.contracts).toEqual({
      factory: made('ERC1967Proxy')[0],
      registry: made('ERC1967Proxy')[1],
      beacon: made('VaultBeacon')[0],
      vaultLogic: made('BasketVault')[0],
      factoryLogic: made('VaultFactory')[0],
      registryLogic: made('IndexRegistry')[0],
    });
    expect(record.roles.admin).toBe(made('TimelockController')[0]);
    expect(record.roles.priceWriter).toBeNull();
    expect(record.deployBlock).toBeGreaterThan(80_000_000);

    // The authority check reads the same file: the timelock, the Safe as its one holder, what to expect.
    const authority = parseRecord(JSON.stringify(built.record));
    const file = JSON.parse(config);
    expect(authority.timelock?.address).toBe(record.roles.admin);
    expect(Number(authority.timelock?.minDelay)).toBe(file.timelock.delay);
    expect(authority.timelock?.proposers).toEqual([file.timelock.owner.toLowerCase()]);
    expect(authority.roles.guardian).toBe(file.guardian.toLowerCase());
    expect(authority.expected?.keeperEnabled).toBe(false);
  });

  it('list every token of the deploy file with its feed, pool and largest trade, and nothing else', () => {
    const { record } = buildRecords({ broadcast, config, guard });
    const file = JSON.parse(config);
    const tokens = file.assets.filter((a: Json) => a.token !== file.cashToken);
    const assets = (record as Json).assets as Json[];
    expect(assets.map((a) => a.address)).toEqual(tokens.map((a: Json) => a.token.toLowerCase()));
    for (const [i, a] of assets.entries()) {
      expect(a.feed).toBe(tokens[i].feed.toLowerCase());
      expect(a.pool).toEqual(tokens[i].pool);
      expect(a.maxTradeUsd).toBe(tokens[i].maxTradeUsd);
      expect(a.keeperOn).toBe(false);
      expect(a.id).toBe(`robinhood:${a.symbol.toLowerCase()}`);
    }
    expect((record as Json).cash).toMatchObject({
      id: 'robinhood:usdg',
      symbol: 'USDG',
      decimals: 6,
    });
  });

  it('fill the guard’s file with the three addresses and take its placeholder mark away', () => {
    expect(() => readDeploymentFile(JSON.parse(guard))).toThrow(/placeholder/);
    const built = buildRecords({ broadcast, config, guard });
    const filled = built.guard as Json;
    expect(filled.placeholder).toBeUndefined();
    expect(filled.todo).toBeUndefined();
    const record = built.record as Json;
    expect(filled.chains.robinhood).toMatchObject({
      factory: record.contracts.factory,
      beacon: record.contracts.beacon,
      registry: record.contracts.registry,
    });
    // Its tokens and pools are untouched: they were reviewed where they are.
    expect(filled.chains.robinhood.assets).toEqual(JSON.parse(guard).chains.robinhood.assets);
    const loaded = readDeploymentFile(filled).robinhood;
    expect(loaded).toMatchObject({ family: 'evm', provenance: 'live', evmChainId: 4663 });
  });

  const isCreate = (name: string) => (t: Json) =>
    t.transactionType === 'CREATE' && t.contractName === name;
  /** Takes a transaction out of the broadcast together with its receipt. */
  const drop = (b: Json, at: number) => {
    const [gone] = b.transactions.splice(at, 1);
    b.receipts = b.receipts.filter((r: Json) => r.transactionHash !== gone.hash);
  };
  const callOnFactory = (b: Json, selector: string) =>
    b.transactions.find(
      (t: Json) => t.transactionType === 'CALL' && t.transaction.input?.startsWith(selector),
    );
  const refused = (
    input: Partial<{ broadcast: string; config: string; guard: string }>,
    why: RegExp,
  ) => expect(() => buildRecords({ broadcast, config, guard, ...input })).toThrow(why);

  it('tell the two proxies apart by the logic each was created for, not by which came first', () => {
    const straight = buildRecords({ broadcast, config, guard }).record as Json;
    const swapped = edit(broadcast, (b) => {
      const [first, second] = b.transactions
        .map((t: Json, i: number) => (isCreate('ERC1967Proxy')(t) ? i : -1))
        .filter((i: number) => i !== -1);
      [b.transactions[first], b.transactions[second]] = [
        b.transactions[second],
        b.transactions[first],
      ];
    });
    expect(JSON.parse(swapped).transactions).not.toEqual(JSON.parse(broadcast).transactions);
    expect((buildRecords({ broadcast: swapped, config, guard }).record as Json).contracts).toEqual(
      straight.contracts,
    );
    const b = JSON.parse(broadcast);
    const factoryProxy = b.transactions.find(
      (t: Json) => t.contractAddress?.toLowerCase() === straight.contracts.factory,
    );
    expect(factoryProxy.arguments[0].toLowerCase()).toBe(straight.contracts.factoryLogic);

    // Both proxies made for one logic, or one that does not say what it was made for.
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          const proxies = b.transactions.filter(isCreate('ERC1967Proxy'));
          proxies[1].arguments[0] = proxies[0].arguments[0];
        }),
      },
      /2 proxies were created for the factory logic/,
    );
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          b.transactions.find(isCreate('ERC1967Proxy')).arguments = null;
        }),
      },
      /0 proxies were created for the factory logic/,
    );
  });

  it('take a transaction as done only on its own receipt saying so', () => {
    refused(
      { broadcast: edit(broadcast, (b) => (b.receipts[3].status = '0x0')) },
      /did not succeed/,
    );
    refused({ broadcast: edit(broadcast, (b) => delete b.receipts[3].status) }, /does not say/);
    refused({ broadcast: edit(broadcast, (b) => b.receipts.pop()) }, /has 0 receipts, not one/);
    // As many receipts as transactions, but one transaction has two and another none.
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          b.receipts[5].transactionHash = b.receipts[4].transactionHash;
        }),
      },
      /has 2 receipts, not one/,
    );
    refused(
      {
        broadcast: edit(broadcast, (b) =>
          b.receipts.push({ ...b.receipts[0], transactionHash: `0x${'ab'.repeat(32)}` }),
        ),
      },
      /1 receipts are of no transaction/,
    );
    refused(
      { broadcast: edit(broadcast, (b) => (b.transactions[2].hash = null)) },
      /has no hash: it was not sent/,
    );
    refused(
      { broadcast: edit(broadcast, (b) => delete b.receipts[0].transactionHash) },
      /names no/,
    );
  });

  it('take the guardian, the routers and the timelock from what the deploy did, and refuse another deploy file', () => {
    const { record } = buildRecords({ broadcast, config, guard }) as Json;
    const b = JSON.parse(broadcast);
    const timelock = b.transactions.find(isCreate('TimelockController'));
    expect(timelock.arguments[1].toLowerCase()).toContain(record.timelock.proposers[0]);
    expect(callOnFactory(b, '0x8a0dac4a').transaction.input).toContain(
      record.roles.guardian.slice(2),
    );
    expect(record.routers.length).toBeGreaterThan(0);

    const other = `0x${'7'.repeat(40)}`;
    const not = (what: string) => new RegExp(`not the one this deploy ran from: ${what}`);
    refused({ config: edit(config, (c) => (c.guardian = other)) }, not('the guardian'));
    refused({ config: edit(config, (c) => (c.keeper = other)) }, not('the keeper'));
    refused({ config: edit(config, (c) => (c.timelock.delay += 1)) }, not("the timelock's delay"));
    refused(
      { config: edit(config, (c) => (c.timelock.owner = other)) },
      not("the timelock's proposers"),
    );
    refused({ config: edit(config, (c) => (c.routers[0].router = other)) }, not('the routers'));
    refused({ config: edit(config, (c) => c.routers.pop()) }, not('the routers'));
    refused({ config: edit(config, (c) => c.assets.pop()) }, not('the listed tokens'));
    // The same from the other side: a broadcast that set another guardian than the file names.
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          const call = callOnFactory(b, '0x8a0dac4a');
          call.transaction.input = `0x8a0dac4a${'0'.repeat(24)}${other.slice(2)}`;
        }),
      },
      not('the guardian'),
    );
    refused(
      {
        broadcast: edit(broadcast, (b) => {
          const batch = b.transactions.find((t: Json) => t.function?.startsWith('executeBatch('));
          batch.arguments[2] = '[]';
        }),
      },
      /did not set the timelock's delay/,
    );
  });

  it('carry the Safe as it was read from the chain, when given', () => {
    const owners = [`0x${'A'.repeat(40)}`, `0x${'b'.repeat(40)}`];
    const built = buildRecords({ broadcast, config, guard, safe: { threshold: 2, owners } });
    validate(built);
    expect(parseRecord(JSON.stringify(built.record)).timelock?.safe).toEqual({
      threshold: 2,
      owners: owners.map((a) => a.toLowerCase()),
    });
    expect(
      (buildRecords({ broadcast, config, guard }).record as Json).timelock.safe,
    ).toBeUndefined();
  });

  it('write both files or neither', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mainnet-records-'));
    const one = join(dir, 'record.json');
    const two = join(dir, 'guard.json');
    writeFileSync(one, 'old record');
    writeFileSync(two, 'old guard');
    // The second cannot be written: its folder is not there.
    expect(() =>
      writeBoth([
        [one, 'new record'],
        [join(dir, 'absent', 'guard.json'), 'new guard'],
      ]),
    ).toThrow();
    expect(readFileSync(one, 'utf8')).toBe('old record');
    expect(readdirSync(dir).sort()).toEqual(['guard.json', 'record.json']);

    writeBoth([
      [one, 'new record'],
      [two, 'new guard'],
    ]);
    expect([readFileSync(one, 'utf8'), readFileSync(two, 'utf8')]).toEqual([
      'new record',
      'new guard',
    ]);
    expect(existsSync(`${one}.writing`)).toBe(false);
  });

  it('refuse rather than guess', () => {
    // A deploy file with a value nobody confirmed still marked.
    refused({ config: edit(config, (c) => (c.guardian = 'TODO')) }, /still holds a TODO/);
    refused({ broadcast: edit(broadcast, (b) => (b.chain = 46_630)) }, /both must be 4663/);
    refused(
      {
        broadcast: edit(broadcast, (b) =>
          drop(b, b.transactions.findIndex(isCreate('TimelockController'))),
        ),
      },
      /created 0 TimelockController/,
    );
    refused(
      {
        broadcast: edit(broadcast, (b) =>
          drop(b, b.transactions.findIndex(isCreate('ERC1967Proxy'))),
        ),
      },
      /created 1 proxies/,
    );
    refused(
      { guard: edit(guard, (g) => (g.chains.robinhood.assets['robinhood:nvda'].pool.fee = 500)) },
      /NVDA: the guard's file and the deploy file name different pools/,
    );
    refused(
      { guard: edit(guard, (g) => delete g.chains.robinhood.assets['robinhood:spy']) },
      /lists no token at/,
    );
    refused(
      {
        guard: edit(guard, (g) => {
          g.chains.robinhood.assets['robinhood:fake'] = {
            address: `0x${'9'.repeat(40)}`,
            decimals: 18,
            pool: { fee: 100, tickSpacing: 1 },
          };
        }),
      },
      /lists a token the deploy did not/,
    );
    refused(
      { guard: edit(guard, (g) => (g.chains.robinhood.assets['robinhood:nvda'].decimals = 6)) },
      /NVDA: the guard's file says 6 decimals/,
    );
  });

  it('a record with a trade left unchecked does not pass the readers', () => {
    const built = buildRecords({
      broadcast,
      config: edit(config, (c) => (c.priceBoundBps = null)),
      guard,
    });
    expect(() => validate(built)).toThrow();
  });
});

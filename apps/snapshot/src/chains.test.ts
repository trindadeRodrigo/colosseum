import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EvmRpc } from '@colosseum/chain-evm/vault';
import type { VaultNodeRpc } from '@colosseum/chain-solana/vault';
import { ChainId, type EnvLike, envKey, KNOWN_ENV_KEYS } from '@colosseum/schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALSO_KNOWN,
  mainnetRefusal,
  NO_CHAIN,
  rulesOfConfig,
  rulesOfPlatform,
  type SourceOptions,
  sandboxOnly,
  sourcesFromEnv,
} from './chains';
import { sampleVault } from './mock-world';

// Which chains the worker reads and how each is wired, from the environment alone. No test here opens a
// connection: the node's client and the node check are handed in, and a refusal comes before either.

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOLANA_URL = 'https://Solana.example.invalid/?api-key=SolKey123';
const ROBINHOOD_URL = 'https://rh.example.invalid/v2/RhKey456';
const T0 = new Date('2026-10-06T15:00:00.000Z');

/** Stand-ins for the two nodes, and a record of what was asked of whom. */
function seam(over: Partial<SourceOptions> = {}) {
  const connected: string[] = [];
  const checked: string[] = [];
  const solanaRpc = { getSlot: () => ({ send: async () => 1234n }) } as unknown as VaultNodeRpc;
  const evmRpc = { getBlockNumber: async () => 99n } as unknown as EvmRpc;
  const options: SourceOptions = {
    now: () => T0,
    connectSolana: (url) => {
      connected.push(url);
      return solanaRpc;
    },
    connectEvm: (url) => {
      connected.push(url);
      return evmRpc;
    },
    checkSolana: async (_rpc, record) => {
      checked.push(record.network);
    },
    checkEvm: async (_rpc, record) => {
      checked.push(record.network);
    },
    warn: () => {},
    ...over,
  };
  return { options, connected, checked };
}

const SOLANA: EnvLike = { CHAIN_MODE_SOLANA: 'readonly', SOLANA_RPC_URL: SOLANA_URL };
const ROBINHOOD: EnvLike = { CHAIN_MODE_ROBINHOOD: 'readonly', ROBINHOOD_RPC_URL: ROBINHOOD_URL };
const READS = ['getPrices', 'getVault', 'getVaults', 'height', 'listAssets', 'rules'];
const LABELS = ['chain', 'name', 'provenance', 'source'];

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker and mainnet', () => {
  it('stops on a chain set to mainnet, whichever chain and whatever its mode, naming the variable', async () => {
    for (const chain of ChainId.options) {
      const key = envKey('CHAIN_NETWORK', chain);
      for (const mode of ['live', 'readonly', 'mock', 'off', undefined]) {
        const s = seam();
        const env = {
          ...SOLANA,
          ...ROBINHOOD,
          [envKey('CHAIN_MODE', chain)]: mode,
          [key]: 'mainnet',
        };
        await expect(sourcesFromEnv(env, s.options), `${chain} ${mode}`).rejects.toThrow(
          `${key} is mainnet, and the snapshot worker reads the test networks only until a person says otherwise`,
        );
        expect(s.connected, `${chain} ${mode}`).toEqual([]);
        expect(s.checked).toEqual([]);
      }
    }
    expect(mainnetRefusal('CHAIN_NETWORK_SOLANA')).toContain('CHAIN_NETWORK_SOLANA is mainnet');
  });

  it('reads the setting as the chain configs do, and says it before anything else that is wrong', async () => {
    const s = seam();
    await expect(
      sourcesFromEnv({ CHAIN_NETWORK_ROBINHOOD: '  MainNet ' }, s.options),
    ).rejects.toThrow(mainnetRefusal('CHAIN_NETWORK_ROBINHOOD'));
    // A chain it would not read, a name the flags do not know and a list that names nothing.
    await expect(
      sourcesFromEnv(
        { CHAIN_NETWORK_BASE: 'mainnet', KEEPER_TYPO: 'x', SNAPSHOT_CHAINS: 'nowhere' },
        s.options,
      ),
    ).rejects.toThrow(mainnetRefusal('CHAIN_NETWORK_BASE'));
  });

  it('labels a real chain sandbox, and refuses a network whose figures would be labelled live', () => {
    expect(sandboxOnly('solana', 'testnet')).toBe('sandbox');
    expect(sandboxOnly('robinhood', 'local')).toBe('sandbox');
    expect(() => sandboxOnly('solana', 'mainnet')).toThrow(
      'CHAIN_NETWORK_SOLANA is mainnet, whose figures would be labelled live',
    );
  });
});

describe('which chains the worker reads', () => {
  it('refuses to start with no chain to read, and says both ways to name one', async () => {
    const s = seam();
    await expect(sourcesFromEnv({}, s.options)).rejects.toThrow(NO_CHAIN);
    expect(NO_CHAIN).toContain('CHAIN_MODE_<CHAIN>');
    expect(NO_CHAIN).toContain('SNAPSHOT_CHAINS');
    // A list that names nothing is no list.
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: ' , ' }, s.options)).rejects.toThrow(NO_CHAIN);
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: '  ' }, s.options)).rejects.toThrow(NO_CHAIN);
  });

  it('reads a chain on the mock only when SNAPSHOT_CHAINS names it', async () => {
    const s = seam();
    // The default modes are mock, mock and off: nothing is read by omission.
    await expect(sourcesFromEnv({ CHAIN_MODE_SOLANA: 'mock' }, s.options)).rejects.toThrow(
      NO_CHAIN,
    );
    const named = await sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana' }, s.options);
    expect(named.map((x) => [x.chain, x.provenance])).toEqual([['solana', 'mock']]);
    // Beside a real chain, the mock one is still left out unless named.
    const real = await sourcesFromEnv({ ...SOLANA, CHAIN_MODE_ROBINHOOD: 'mock' }, s.options);
    expect(real.map((x) => [x.chain, x.provenance])).toEqual([['solana', 'sandbox']]);
    const both = await sourcesFromEnv(
      { ...SOLANA, SNAPSHOT_CHAINS: 'Robinhood, solana ,solana' },
      s.options,
    );
    expect(both.map((x) => [x.chain, x.provenance])).toEqual([
      ['solana', 'sandbox'],
      ['robinhood', 'mock'],
    ]);
  });

  it('reads every chain that is live or readonly when no list is given, and only the list when one is', async () => {
    const s = seam();
    const all = await sourcesFromEnv(
      { ...SOLANA, ...ROBINHOOD, CHAIN_MODE_ROBINHOOD: 'live' },
      s.options,
    );
    expect(all.map((x) => x.chain)).toEqual(['solana', 'robinhood']);
    const one = await sourcesFromEnv(
      { ...SOLANA, ...ROBINHOOD, SNAPSHOT_CHAINS: 'robinhood' },
      seam().options,
    );
    expect(one.map((x) => x.chain)).toEqual(['robinhood']);
  });

  it('refuses a chain it does not know, without repeating what was typed', async () => {
    const s = seam();
    const typed = 'solana,something-pasted-by-mistake';
    const refusal = await sourcesFromEnv({ SNAPSHOT_CHAINS: typed }, s.options).catch(
      (e: Error) => e.message,
    );
    expect(refusal).toBe(
      'SNAPSHOT_CHAINS: expected chain ids separated by commas, from solana, base, robinhood',
    );
    expect(refusal).not.toContain('pasted');
  });

  it('refuses a named chain that is off, and Base on a real network, by name', async () => {
    const s = seam();
    await expect(sourcesFromEnv({ SNAPSHOT_CHAINS: 'base' }, s.options)).rejects.toThrow(
      'SNAPSHOT_CHAINS names base, and CHAIN_MODE_BASE is off',
    );
    await expect(
      sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana', CHAIN_MODE_SOLANA: 'off' }, s.options),
    ).rejects.toThrow('SNAPSHOT_CHAINS names solana, and CHAIN_MODE_SOLANA is off');
    for (const mode of ['live', 'readonly'])
      for (const list of [undefined, 'base'])
        await expect(
          sourcesFromEnv({ CHAIN_MODE_BASE: mode, SNAPSHOT_CHAINS: list }, s.options),
          `${mode} ${list}`,
        ).rejects.toThrow(
          `CHAIN_MODE_BASE is ${mode}, and the snapshot worker has no reader for Base on a real network yet`,
        );
    // On the mock, Base is a chain like the others.
    const mock = await sourcesFromEnv(
      { CHAIN_MODE_BASE: 'mock', SNAPSHOT_CHAINS: 'base' },
      s.options,
    );
    expect(mock.map((x) => x.name)).toEqual(['Base (mock)']);
    expect(s.connected).toEqual([]);
  });

  it('does not stop on the names the keeper reads, and still stops on a name nobody reads', async () => {
    const s = seam();
    const shared = Object.fromEntries(ALSO_KNOWN.map((name) => [name, '/some/where']));
    await expect(
      sourcesFromEnv({ ...shared, KEEPER_ENABLED: 'on', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).resolves.toHaveLength(1);
    await expect(
      sourcesFromEnv({ KEEPER_SOLANA_KEYPIAR: '/x', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).rejects.toThrow('unknown variable: KEEPER_SOLANA_KEYPIAR');
    await expect(
      sourcesFromEnv({ CHAIN_MODE_SOLANA: 'reads', SNAPSHOT_CHAINS: 'solana' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_SOLANA: expected live, readonly, mock, off');
  });

  it('knows every KEEPER_ name the keeper and its run script mention', () => {
    const keeper = `${REPO}apps/keeper/src/`;
    const texts = [
      ...readdirSync(keeper)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => readFileSync(`${keeper}${name}`, 'utf8')),
      readFileSync(`${REPO}scripts/keeper/run.sh`, 'utf8'),
    ];
    const names = new Set(texts.flatMap((text) => text.match(/\bKEEPER_[A-Z][A-Z0-9_]*\b/g) ?? []));
    expect(names.size).toBeGreaterThan(5);
    const known = new Set([...KNOWN_ENV_KEYS, ...ALSO_KNOWN]);
    expect([...names].filter((name) => !known.has(name))).toEqual([]);
  });
});

describe('a chain on the mock', () => {
  it('is labelled mock, has a band and no other rule, and its height is its clock', async () => {
    const [source] = await sourcesFromEnv(
      { SNAPSHOT_CHAINS: 'robinhood', CHAIN_MODE_ROBINHOOD: 'mock' },
      seam().options,
    );
    if (!source) throw new Error('no source');
    expect(source.name).toBe('Robinhood Chain (mock)');
    expect(source.provenance).toBe('mock');
    expect(source.source).toBe('chain-mock');
    expect(await source.rules()).toEqual({ paused: null, lossCapBps: null, bandBps: 50 });
    expect(await source.height()).toBe(BigInt(Math.floor(T0.getTime() / 1000)));
    const assets = await source.listAssets();
    expect(assets.every((a) => a.provenance === 'mock')).toBe(true);
    const prices = await source.getPrices(assets.map((a) => a.id));
    expect(prices.every((p) => p.provenance === 'mock' && p.source === 'chain-mock')).toBe(true);
  });

  it('carries the reads and the sample world, and nothing that builds or lands a transaction', async () => {
    const [source] = await sourcesFromEnv({ SNAPSHOT_CHAINS: 'solana' }, seam().options);
    if (!source) throw new Error('no source');
    expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS, 'prepare'].sort());
    // The sample world behind `prepare`: with nothing named, the height follows the pass.
    const at = new Date(T0.getTime() + 600_000);
    // It answers the sample vault's address, which the database does not name: the pass reads it.
    const made = await source.prepare?.([], at);
    expect(made).toEqual([sampleVault('solana')]);
    expect(await source.getVault(sampleVault('solana'))).not.toBeNull();
    expect(await source.height()).toBe(BigInt(Math.floor(at.getTime() / 1000)));
  });
});

describe('Solana on its test network', () => {
  it('is its reader on the record of devnet, labelled sandbox, behind the node check', async () => {
    for (const mode of ['readonly', 'live']) {
      const s = seam();
      const [source] = await sourcesFromEnv({ ...SOLANA, CHAIN_MODE_SOLANA: mode }, s.options);
      if (!source) throw new Error('no source');
      expect(source.chain).toBe('solana');
      expect(source.name).toBe('Solana devnet');
      expect(source.provenance).toBe('sandbox');
      expect(source.source).toBe('Solana devnet, read over RPC by the vault reader');
      expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS].sort());
      // The URL as written: a key in it is case-sensitive.
      expect(s.connected).toEqual([SOLANA_URL]);
      expect(s.checked).toEqual(['solana-devnet']);
      const assets = await source.listAssets();
      expect(assets.filter((a) => a.cls === 'cash').map((a) => a.id)).toEqual(['solana:usdc']);
      expect(assets.length).toBeGreaterThan(5);
      expect(assets.every((a) => a.provenance === 'sandbox')).toBe(true);
      expect(await source.height()).toBe(1234n);
    }
  });

  it('says a missing node by its variable, before any node is asked', async () => {
    const s = seam();
    await expect(sourcesFromEnv({ CHAIN_MODE_SOLANA: 'readonly' }, s.options)).rejects.toThrow(
      'CHAIN_MODE_SOLANA is readonly, and SOLANA_RPC_URL is not set',
    );
    await expect(
      sourcesFromEnv({ CHAIN_MODE_SOLANA: 'live', SOLANA_RPC_URL: '  ' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_SOLANA is live, and SOLANA_RPC_URL is not set');
    // Solana is fine and Robinhood Chain is not: Solana's node is not asked either.
    await expect(
      sourcesFromEnv({ ...SOLANA, CHAIN_MODE_ROBINHOOD: 'readonly' }, s.options),
    ).rejects.toThrow('CHAIN_MODE_ROBINHOOD is readonly, and ROBINHOOD_RPC_URL is not set');
    expect(s.checked).toEqual([]);
  });

  it('does not start on a node that is not the record’s network', async () => {
    const s = seam({
      checkSolana: async () => {
        throw new Error(
          'the Solana RPC is a mainnet node, and this server runs a test network only',
        );
      },
    });
    await expect(sourcesFromEnv(SOLANA, s.options)).rejects.toThrow('is a mainnet node');
  });

  it('reads the record of the network, and refuses one that is missing, unreadable or another’s', async () => {
    const devnet = readFileSync(`${REPO}deployments/solana-devnet.json`, 'utf8');
    const asked: string[] = [];
    const reading = (text: string | null) =>
      seam({
        dir: '/records',
        read: (file) => {
          asked.push(file);
          return text;
        },
      });
    const local = { ...SOLANA, CHAIN_NETWORK_SOLANA: 'local' };
    await expect(sourcesFromEnv(local, reading(null).options)).rejects.toThrow(
      'there is no deploy record deployments/solana-local.json for CHAIN_NETWORK_SOLANA',
    );
    expect(asked).toEqual(['/records/solana-local.json']);
    await expect(sourcesFromEnv(SOLANA, reading('{"network":1}').options)).rejects.toThrow(
      'deployments/solana-devnet.json is not a Solana deployment record this worker reads',
    );
    await expect(sourcesFromEnv(SOLANA, reading('not json').options)).rejects.toThrow(
      'is not a Solana deployment record',
    );
    // A devnet record under the local name is not run as a local validator.
    await expect(sourcesFromEnv(local, reading(devnet).options)).rejects.toThrow(
      'deployments/solana-local.json is the record of solana-devnet',
    );
    const s = reading(devnet);
    await expect(sourcesFromEnv(SOLANA, s.options)).resolves.toHaveLength(1);
    expect(s.connected).toEqual([SOLANA_URL]);
  });

  it('lets the environment repeat the record’s addresses and never replace one', async () => {
    const record = JSON.parse(readFileSync(`${REPO}deployments/solana-devnet.json`, 'utf8'));
    const same = {
      ...SOLANA,
      CHAIN_ROUTER_SOLANA: record.programs.mockRouter,
      CHAIN_PRICE_SOURCE_SOLANA: record.accounts.priceAccount,
    };
    await expect(sourcesFromEnv(same, seam().options)).resolves.toHaveLength(1);
    const s = seam();
    await expect(
      sourcesFromEnv({ ...same, CHAIN_PRICE_SOURCE_SOLANA: record.accounts.config }, s.options),
    ).rejects.toThrow(
      'CHAIN_PRICE_SOURCE_SOLANA names another address than deployments/solana-devnet.json',
    );
    await expect(
      sourcesFromEnv({ ...same, CHAIN_ROUTER_SOLANA: record.accounts.config }, s.options),
    ).rejects.toThrow('CHAIN_ROUTER_SOLANA names another address than');
    expect(s.checked).toEqual([]);
  });

  it('gives no height, and no failed pass, when the node cannot say its slot', async () => {
    const without = seam({ connectSolana: () => ({}) as unknown as VaultNodeRpc });
    const [none] = await sourcesFromEnv(SOLANA, without.options);
    expect(await none?.height()).toBeNull();
    const failing = seam({
      connectSolana: () =>
        ({
          getSlot: () => ({
            send: async () => {
              throw new Error(`fetch failed on ${SOLANA_URL}`);
            },
          }),
        }) as unknown as VaultNodeRpc,
    });
    const [failed] = await sourcesFromEnv(SOLANA, failing.options);
    expect(await failed?.height()).toBeNull();
    // A node that never answers: the pass goes on without a height after ten seconds.
    vi.useFakeTimers();
    const hung = seam({
      connectSolana: () =>
        ({ getSlot: () => ({ send: () => new Promise(() => {}) }) }) as unknown as VaultNodeRpc,
    });
    const [silent] = await sourcesFromEnv(SOLANA, hung.options);
    const height = silent?.height();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await height).toBeNull();
  });

  it('reads the pause, the loss budget and the band from the program’s Config', () => {
    expect(rulesOfConfig({ keeperPaused: true, lossCapBps: 100, bandBps: 50 })).toEqual({
      paused: true,
      lossCapBps: 100,
      bandBps: 50,
    });
  });
});

describe('Robinhood Chain on its test network', () => {
  it('is the EVM reader on the record of the test network, labelled sandbox', async () => {
    const s = seam();
    const [source] = await sourcesFromEnv(ROBINHOOD, s.options);
    if (!source) throw new Error('no source');
    expect(source.chain).toBe('robinhood');
    expect(source.name).toBe('Robinhood Chain testnet');
    expect(source.provenance).toBe('sandbox');
    expect(source.source).toBe(
      'Robinhood Chain testnet, read over JSON-RPC by the EVM vault reader',
    );
    expect(Object.keys(source).sort()).toEqual([...LABELS, ...READS].sort());
    expect(s.connected).toEqual([ROBINHOOD_URL]);
    expect(s.checked).toEqual(['robinhood-testnet']);
    const assets = await source.listAssets();
    expect(assets.filter((a) => a.cls === 'cash').map((a) => a.id)).toEqual(['robinhood:tusdg']);
    expect(assets.every((a) => a.provenance === 'sandbox')).toBe(true);
    expect(await source.height()).toBe(99n);
  });

  it('gives no height when the node cannot say its block', async () => {
    const s = seam({
      connectEvm: () =>
        ({
          getBlockNumber: async () => {
            throw new Error(`HTTP request failed.\n\nURL: ${ROBINHOOD_URL}`);
          },
        }) as unknown as EvmRpc,
    });
    const [source] = await sourcesFromEnv(ROBINHOOD, s.options);
    expect(await source?.height()).toBeNull();
  });

  it('refuses a missing record, a missing node and a router that is not the record’s', async () => {
    const s = seam();
    await expect(
      sourcesFromEnv({ ...ROBINHOOD, CHAIN_NETWORK_ROBINHOOD: 'local' }, s.options),
    ).rejects.toThrow(
      'there is no deploy record deployments/robinhood-local.json for CHAIN_NETWORK_ROBINHOOD',
    );
    await expect(sourcesFromEnv({ CHAIN_MODE_ROBINHOOD: 'live' }, s.options)).rejects.toThrow(
      'CHAIN_MODE_ROBINHOOD is live, and ROBINHOOD_RPC_URL is not set',
    );
    const record = JSON.parse(readFileSync(`${REPO}deployments/robinhood-testnet.json`, 'utf8'));
    const router: string = record.routers[0].address;
    await expect(
      sourcesFromEnv({ ...ROBINHOOD, CHAIN_ROUTER_ROBINHOOD: record.contracts.factory }, s.options),
    ).rejects.toThrow(
      'CHAIN_ROUTER_ROBINHOOD names another address than deployments/robinhood-testnet.json',
    );
    expect(s.checked).toEqual([]);
    // The same router in another case is the same address.
    await expect(
      sourcesFromEnv(
        { ...ROBINHOOD, CHAIN_ROUTER_ROBINHOOD: router.toUpperCase().replace('0X', '0x') },
        s.options,
      ),
    ).resolves.toHaveLength(1);
  });

  it('reads the pause, the loss budget and the band from the factory', () => {
    expect(
      rulesOfPlatform({ keeperPaused: false, params: { lossCapBps: 200, bandBps: 75 } }),
    ).toEqual({ paused: false, lossCapBps: 200, bandBps: 75 });
  });
});

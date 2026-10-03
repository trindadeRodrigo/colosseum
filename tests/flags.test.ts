import {
  assertChainsReady,
  CHAIN_PRESETS,
  ChainConfig,
  chainProvenance,
  DEFAULT_FLAGS,
  explorerLink,
  Flags,
  KNOWN_ENV_KEYS,
  Network,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

const ROUTER = '0x204FAca1764B154221e35c0d20aBb3c525710498';
const message = (run: () => unknown) => {
  try {
    run();
    return 'no error';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe('parseFlags', () => {
  it('with nothing set: every live chain on the mock, Base off, nothing automatic', () => {
    expect(parseFlags({})).toEqual({
      chainMode: { solana: 'mock', robinhood: 'mock', base: 'off' },
      autoFollow: { solana: false, robinhood: false, base: false },
      keeperEnabled: false,
      agentSurface: false,
      // Off: the API registers the structurer's server-signing routes only when this is on.
      legacyStructurer: false,
    });
    expect(Flags.parse(parseFlags({}))).toEqual(DEFAULT_FLAGS);
  });

  it('reads every flag of the design', () => {
    const flags = parseFlags({
      CHAIN_MODE_SOLANA: 'live',
      CHAIN_MODE_ROBINHOOD: 'readonly',
      CHAIN_MODE_BASE: 'mock',
      AUTO_FOLLOW_SOLANA: 'on',
      AUTO_FOLLOW_ROBINHOOD: 'off',
      KEEPER_ENABLED: 'true',
      AGENT_SURFACE: '1',
      LEGACY_STRUCTURER: 'off',
    });
    expect(flags).toEqual({
      chainMode: { solana: 'live', robinhood: 'readonly', base: 'mock' },
      autoFollow: { solana: true, robinhood: false, base: false },
      keeperEnabled: true,
      agentSurface: true,
      legacyStructurer: false,
    });
    // Off is also what unset means, so the variable is shown to be read by turning it on.
    expect(parseFlags({ LEGACY_STRUCTURER: 'on' }).legacyStructurer).toBe(true);
  });

  it('ignores case and spaces, and treats an empty value as unset', () => {
    const flags = parseFlags({
      CHAIN_MODE_SOLANA: ' Live ',
      KEEPER_ENABLED: 'ON',
      AGENT_SURFACE: '',
      CHAIN_MODE_BASE: '  ',
    });
    expect(flags.chainMode.solana).toBe('live');
    expect(flags.keeperEnabled).toBe(true);
    expect(flags.agentSurface).toBe(false);
    expect(flags.chainMode.base).toBe('off');
  });

  it('stops on a value it does not know, naming the variable and never the value', () => {
    expect(message(() => parseFlags({ CHAIN_MODE_SOLANA: 'devnet' }))).toBe(
      'CHAIN_MODE_SOLANA: expected live, readonly, mock, off',
    );
    expect(message(() => parseFlags({ AUTO_FOLLOW_BASE: 'maybe' }))).toMatch(/^AUTO_FOLLOW_BASE:/);
    const leaked = message(() => parseFlags({ KEEPER_ENABLED: 'sk-SECRETKEY' }));
    expect(leaked).toBe('KEEPER_ENABLED: expected on or off');
  });

  it('stops on a name it does not know under its own prefixes: a typo is not a default', () => {
    expect(message(() => parseFlags({ CHAIN_MODE_ROBINHOD: 'live' }))).toBe(
      'unknown variable: CHAIN_MODE_ROBINHOD',
    );
    expect(message(() => parseFlags({ CHAIN_MODE_ARBITRUM: 'live', KEEPER_ENABLE: 'on' }))).toBe(
      'unknown variable: CHAIN_MODE_ARBITRUM, KEEPER_ENABLE',
    );
    expect(message(() => parseFlags({ AUTO_FOLLOW_SOL: 'on' }))).toMatch(/AUTO_FOLLOW_SOL/);
    // The chain config's own variables are known, other prefixes are not ours, and an app can add names.
    const env = { CHAIN_ROUTER_ROBINHOOD: ROUTER, CHAIN_NETWORK_BASE: 'local', DATABASE_URL: 'x' };
    expect(parseFlags(env)).toEqual(DEFAULT_FLAGS);
    expect(message(() => parseFlags({ KEEPER_KEY_PATH: '/k' }))).toMatch(/KEEPER_KEY_PATH/);
    expect(parseFlags({ KEEPER_KEY_PATH: '/k' }, ['KEEPER_KEY_PATH'])).toEqual(DEFAULT_FLAGS);
    expect(KNOWN_ENV_KEYS).toContain('CHAIN_PRICE_SOURCE_SOLANA');
  });

  it('is pure: it reads only its argument and changes nothing', () => {
    const saved = process.env.KEEPER_ENABLED;
    process.env.KEEPER_ENABLED = 'on';
    try {
      expect(parseFlags({}).keeperEnabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.KEEPER_ENABLED;
      else process.env.KEEPER_ENABLED = saved;
    }
    const env = Object.freeze({ CHAIN_MODE_BASE: 'live', AUTO_FOLLOW_BASE: 'on' });
    const flags = parseFlags(env);
    flags.chainMode.solana = 'off';
    expect(parseFlags({})).toEqual(DEFAULT_FLAGS);
    expect(DEFAULT_FLAGS.chainMode.base).toBe('off');
  });
});

describe('chain configs', () => {
  it('with nothing set: every chain on its test network', () => {
    const c = parseChainConfigs({});
    expect([c.solana.network, c.robinhood.network, c.base.network]).toEqual([
      'testnet',
      'testnet',
      'testnet',
    ]);
    expect(c.solana.networkName).toBe('devnet');
    expect(c.solana.evmChainId).toBeNull();
    expect(c.robinhood.evmChainId).toBe(46630);
    expect(c.base.evmChainId).toBe(84532);
    // A test network has no Jupiter and no Universal Router: the router is ours and set at deploy.
    for (const chain of Object.values(c)) expect(chain.router).toBeNull();
  });

  it('runs the same chain on mainnet by config alone', () => {
    const c = parseChainConfigs({
      CHAIN_NETWORK_ROBINHOOD: 'mainnet',
      CHAIN_NETWORK_SOLANA: 'local',
    });
    expect(c.robinhood).toMatchObject({
      network: 'mainnet',
      evmChainId: 4663,
      router: ROUTER.toLowerCase(),
    });
    // A local copy of mainnet has mainnet's addresses and no explorer.
    expect(c.solana).toMatchObject({
      network: 'local',
      router: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      explorerTx: null,
    });
    expect(c.base.network).toBe('testnet');
  });

  it("takes the router and the price source from config, in the form of the chain's own family", () => {
    const prices = 'So11111111111111111111111111111111111111112';
    const factory = '0x00000000000000000000000000000000000000BB';
    const c = parseChainConfigs(
      // As the design prints it, checksum case and all.
      { CHAIN_ROUTER_ROBINHOOD: ROUTER, CHAIN_PRICE_SOURCE_SOLANA: prices },
      { robinhood: { factory } },
    );
    expect(c.robinhood.router).toBe(ROUTER.toLowerCase());
    expect(c.solana.priceSource).toEqual({ kind: 'scope', address: prices });
    expect(c.robinhood.contracts).toEqual({ factory: factory.toLowerCase() });
    expect(c.solana.contracts).toEqual({});
  });

  it('stops on a network or an address it cannot read, and never repeats the value', () => {
    const secret = 'https://mainnet.example.invalid/?api-key=SECRETKEY';
    for (const env of [
      { CHAIN_NETWORK_BASE: 'sepolia' },
      { CHAIN_NETWORK_SOLANA: secret },
      { CHAIN_ROUTER_SOLANA: secret },
      // A Solana address on an EVM chain, and the other way round.
      { CHAIN_ROUTER_ROBINHOOD: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' },
      { CHAIN_ROUTER_SOLANA: ROUTER },
      // Tokens of the right length that are no address.
      { CHAIN_ROUTER_ROBINHOOD: 'abcdefghijkmnopqrstuvwxyzABCDEFG' },
      { CHAIN_PRICE_SOURCE_BASE: 'sk3Xy7Qm9Rt2Wv5Zb8Nc4Hd6Jf1Kg3Lp7Ma9SeUq' },
      { CHAIN_PRICE_SOURCE_SOLANA: 'abcdefghijkmnopqrstuvwxyzABCDEFG' },
    ]) {
      const [name, value] = Object.entries(env)[0] ?? [];
      const text = message(() => parseChainConfigs(env));
      expect(text.startsWith(`${name}: expected `), text).toBe(true);
      expect(text).not.toContain(value);
      expect(text).not.toMatch(/SECRET|sk3Xy/);
    }
    expect(message(() => parseChainConfigs({}, { base: { factory: 'nope' } }))).toBe(
      'contracts.base.factory: not an address of the evm family',
    );
  });

  it('labels a figure by how the chain is run: never live on the mock, and nothing when off', () => {
    expect(chainProvenance('mainnet', 'live')).toBe('live');
    expect(chainProvenance('mainnet', 'readonly')).toBe('live');
    expect(chainProvenance('testnet', 'live')).toBe('sandbox');
    expect(chainProvenance('local', 'readonly')).toBe('sandbox');
    for (const network of Network.options) {
      expect(chainProvenance(network, 'mock')).toBe('mock');
      expect(chainProvenance(network, 'off')).toBeNull();
    }
    // A config says where a chain is, not what its figures are labelled.
    expect(Object.keys(ChainConfig.shape)).not.toContain('provenance');
  });

  it('refuses to run a chain live or readonly on a config that cannot run it', () => {
    const ready = (env: Record<string, string>, contracts = {}) =>
      message(() => assertChainsReady(parseFlags(env), parseChainConfigs(env, contracts)));
    expect(ready({})).toBe('no error');
    expect(ready({ CHAIN_MODE_SOLANA: 'live' })).toBe(
      'CHAIN_MODE_SOLANA is live on devnet, but these are not set: CHAIN_ROUTER_SOLANA, CHAIN_PRICE_SOURCE_SOLANA, contracts.solana.program',
    );
    expect(ready({ CHAIN_MODE_ROBINHOOD: 'readonly', CHAIN_NETWORK_ROBINHOOD: 'mainnet' })).toBe(
      'CHAIN_MODE_ROBINHOOD is readonly on Robinhood Chain, but these are not set: contracts.robinhood.factory, contracts.robinhood.registry',
    );
    const address = '0x00000000000000000000000000000000000000aa';
    const deployed = { robinhood: { factory: address, registry: address } };
    const env = { CHAIN_MODE_ROBINHOOD: 'live', CHAIN_ROUTER_ROBINHOOD: ROUTER };
    expect(ready(env, deployed)).toBe('no error');
    // Mock and off need nothing.
    expect(ready({ CHAIN_MODE_BASE: 'mock', CHAIN_MODE_SOLANA: 'off' })).toBe('no error');
  });

  it('keeps every preset valid, with no RPC URL anywhere in a config', () => {
    for (const chain of ['solana', 'robinhood', 'base'] as const) {
      for (const network of Network.options) {
        const env = { [`CHAIN_NETWORK_${chain.toUpperCase()}`]: network };
        const config = parseChainConfigs(env)[chain];
        expect(ChainConfig.parse(config)).toEqual(config);
        expect(JSON.stringify(config)).not.toMatch(/rpc|alchemy|helius|api[-_]?key/i);
        expect(config.family).toBe(CHAIN_PRESETS[chain].family);
      }
    }
  });

  it('builds an explorer link only where there is an explorer', () => {
    const c = parseChainConfigs({ CHAIN_NETWORK_BASE: 'local' });
    expect(explorerLink(c.solana, 'abc')).toBe('https://solscan.io/tx/abc?cluster=devnet');
    expect(explorerLink(c.base, 'abc')).toBeNull();
  });
});

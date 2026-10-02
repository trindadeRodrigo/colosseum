import {
  CHAIN_PRESETS,
  ChainConfig,
  chainProvenance,
  DEFAULT_FLAGS,
  explorerTxUrl,
  Flags,
  Network,
  parseChainConfigs,
  parseFlags,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';

describe('parseFlags', () => {
  it('with nothing set: every live chain on the mock, Base off, nothing automatic, no legacy routes', () => {
    expect(parseFlags({})).toEqual({
      chainMode: { solana: 'mock', robinhood: 'mock', base: 'off' },
      autoFollow: { solana: false, robinhood: false, base: false },
      keeperEnabled: false,
      agentSurface: false,
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
      LEGACY_STRUCTURER: 'on',
    });
    expect(flags).toEqual({
      chainMode: { solana: 'live', robinhood: 'readonly', base: 'mock' },
      autoFollow: { solana: true, robinhood: false, base: false },
      keeperEnabled: true,
      agentSurface: true,
      legacyStructurer: true,
    });
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

  it('stops on a value it does not know, naming the variable', () => {
    expect(() => parseFlags({ CHAIN_MODE_SOLANA: 'mainnet' })).toThrow(/CHAIN_MODE_SOLANA/);
    expect(() => parseFlags({ AUTO_FOLLOW_BASE: 'maybe' })).toThrow(/AUTO_FOLLOW_BASE/);
    expect(() => parseFlags({ KEEPER_ENABLED: 'enabled' })).toThrow(/KEEPER_ENABLED/);
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
  it('with nothing set: every chain on its test network, labelled as one', () => {
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
    for (const chain of Object.values(c)) {
      expect(chain.provenance).toBe('sandbox');
      // A test network has no Jupiter and no Universal Router: the router is ours and set at deploy.
      expect(chain.router).toBeNull();
    }
  });

  it('runs the same chain on mainnet by config alone, and only mainnet is live', () => {
    const c = parseChainConfigs({
      CHAIN_NETWORK_ROBINHOOD: 'mainnet',
      CHAIN_NETWORK_SOLANA: 'local',
    });
    expect(c.robinhood).toMatchObject({
      network: 'mainnet',
      evmChainId: 4663,
      router: '0x204faca1764b154221e35c0d20abb3c525710498',
      provenance: 'live',
    });
    // A local copy of mainnet has mainnet's addresses and is never labelled live.
    expect(c.solana).toMatchObject({
      network: 'local',
      router: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      provenance: 'sandbox',
      explorerTx: null,
    });
    expect(c.base.network).toBe('testnet');
  });

  it('takes the router and the price source from config', () => {
    const router = '0x00000000000000000000000000000000000000aa';
    const prices = 'So11111111111111111111111111111111111111112';
    const c = parseChainConfigs(
      { CHAIN_ROUTER_ROBINHOOD: router, CHAIN_PRICE_SOURCE_SOLANA: prices },
      { robinhood: { factory: '0x00000000000000000000000000000000000000bb' } },
    );
    expect(c.robinhood.router).toBe(router);
    expect(c.solana.priceSource).toEqual({ kind: 'scope', address: prices });
    expect(c.robinhood.contracts).toEqual({
      factory: '0x00000000000000000000000000000000000000bb',
    });
    expect(c.solana.contracts).toEqual({});
  });

  it('stops on a network or an address it cannot read', () => {
    expect(() => parseChainConfigs({ CHAIN_NETWORK_BASE: 'sepolia' })).toThrow(
      /CHAIN_NETWORK_BASE/,
    );
    expect(() =>
      parseChainConfigs({ CHAIN_ROUTER_BASE: '0x204FAca1764B154221e35c0d20aBb3c525710498' }),
    ).toThrow(/CHAIN_ROUTER_BASE/);
  });

  it('labels a figure by how the chain is run: the mock wins, and only mainnet is live', () => {
    expect(chainProvenance('mainnet', 'live')).toBe('live');
    expect(chainProvenance('mainnet', 'readonly')).toBe('live');
    expect(chainProvenance('testnet', 'live')).toBe('sandbox');
    expect(chainProvenance('local', 'live')).toBe('sandbox');
    for (const network of Network.options) expect(chainProvenance(network, 'mock')).toBe('mock');
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
    expect(explorerTxUrl(c.solana, 'abc')).toBe('https://solscan.io/tx/abc?cluster=devnet');
    expect(explorerTxUrl(c.base, 'abc')).toBeNull();
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { forgeArgs, parseArgs, readKey, roundLines } from '../scripts/testnet/robinhood/prices';
import {
  buildRecord,
  type ChainView,
  type FactoryAsset,
  type KitConfig,
  type KitState,
  recordJson,
} from '../scripts/testnet/robinhood/record';
import { rangeAround, vaultAssets } from '../scripts/testnet/robinhood/vault-config';

// The Robinhood Chain test network's two scripts (TNET-2): the price copier's loop and the vault config
// filled from the kit's record. The copier's rules are in contracts/script/testnet/CopyPrices.s.sol and
// tested there.

describe('the price copier loop', () => {
  it('takes exactly one of --dry-run, --once and --loop', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true, loop: false, everySeconds: 60 });
    expect(parseArgs(['--loop', '--every', '30'])).toEqual({
      dryRun: false,
      loop: true,
      everySeconds: 30,
    });
    expect(() => parseArgs([])).toThrow('say one of');
    expect(() => parseArgs(['--once', '--loop'])).toThrow('say one of');
    expect(() => parseArgs(['--loop', '--every', '5'])).toThrow('15 or more');
  });

  it('a dry run names the price writer and sends nothing; a round sends one transaction at a time', () => {
    const writer = '0x000000000000000000000000000000000000bEEF';
    const dry = forgeArgs(true, writer);
    expect(dry).toContain('--sender');
    expect(dry).toContain(writer);
    expect(dry).not.toContain('--broadcast');
    const real = forgeArgs(false, writer);
    expect(real).toContain('--broadcast');
    expect(real).toContain('--slow');
    expect(real.join(' ')).not.toMatch(/private-key/);
  });

  it('reads one hex key from its file and never quotes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rh-key-'));
    const key = `0x${'ab'.repeat(32)}`;
    writeFileSync(join(dir, 'ok'), `${key}\n`);
    writeFileSync(join(dir, 'bare'), 'cd'.repeat(32));
    writeFileSync(join(dir, 'bad'), 'not a key at all');
    expect(readKey(join(dir, 'ok'))).toBe(key);
    expect(readKey(join(dir, 'bare'))).toBe(`0x${'cd'.repeat(32)}`);
    expect(() => readKey(join(dir, 'bad'))).toThrow(/does not hold one 32-byte hex key$/);
    try {
      readKey(join(dir, 'bad'));
    } catch (error) {
      expect(String(error)).not.toContain('not a key at all');
    }
    expect(() => readKey(join(dir, 'missing'))).toThrow('cannot be read');
  });

  it("keeps the lines of forge's output a person reads", () => {
    const out = [
      'Script ran successfully.',
      '== Logs ==',
      '  source: Robinhood Chain mainnet, block 1234',
      '    tSPY: wrote price 776.16661047 at 1791222309 average 776.10000000 at 1791222400',
      '    tGLD: unchanged',
      '  round: wrote 1, unchanged 1, refused 0, pools re-centred 1',
      'SIMULATION COMPLETE.',
    ].join('\n');
    expect(roundLines(out)).toEqual([
      'source: Robinhood Chain mainnet, block 1234',
      '  tSPY: wrote price 776.16661047 at 1791222309 average 776.10000000 at 1791222400',
      '  tGLD: unchanged',
      'round: wrote 1, unchanged 1, refused 0, pools re-centred 1',
    ]);
  });
});

describe("the vault's config from the kit's record", () => {
  const spy = {
    symbol: 'tSPY',
    address: '0x3333333333333333333333333333333333333333',
    decimals: 18,
    feed: '0x4444444444444444444444444444444444444444',
    average: '0x5555555555555555555555555555555555555555',
    feedDecimals: 8,
  };
  const record = {
    chainId: 46630,
    cash: '0x1111111111111111111111111111111111111111',
    cashDecimals: 6,
    router: '0x2222222222222222222222222222222222222222',
    routerPull: 2,
    tokens: [spy],
  };

  it('sets each range from 0.775 to 1.25 times the price, within a factor two', () => {
    expect(rangeAround(77_616_661_047n)).toEqual({
      minPrice: 60_152_912_311,
      maxPrice: 97_020_826_308,
    });
  });

  it('lists the cash unpriced and each stock with its price, average, pause, schedule and the keeper on', () => {
    const assets = vaultAssets(record, new Map([[spy.feed, 77_616_661_047n]]));
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({ token: record.cash, source: 0, flags: 0, tokenDecimals: 6 });
    expect(assets[1]).toMatchObject({
      token: spy.address,
      feed: spy.feed,
      averageFeed: spy.average,
      pauseProbe: spy.address,
      pauseSelector: '0x5c975abb',
      scheduleSelector: '0x97a4064f',
      session: 1,
      source: 1,
      flags: 1,
      maxAge: 93600,
    });
  });

  it('refuses a token whose price contract holds no price', () => {
    expect(() => vaultAssets(record, new Map())).toThrow("tSPY's price contract holds no price");
  });
});

describe("the API's record from the chain and the kit", () => {
  const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
  const kit: KitState = {
    chainId: 46630,
    admin: a(1),
    priceWriter: a(2),
    cash: a(3),
    cashSymbol: 'tUSDG',
    router: a(4),
    tokens: [
      { symbol: 'tSPY', modelOf: 'SPY', address: a(5) },
      { symbol: 'tNVDA', modelOf: 'NVDA', address: a(6) },
    ],
  };
  const config: KitConfig = {
    cash: { symbol: 'tUSDG', name: 'Test USDG (test network)' },
    tokens: [
      { symbol: 'tSPY', name: 'Test SPDR S&P 500 ETF (test network)', kind: 'etf' },
      { symbol: 'tNVDA', name: 'Test NVIDIA (test network)', kind: 'stock' },
    ],
  };
  const listed = (feed: number, flags: number, min: bigint, max: bigint): FactoryAsset => ({
    feed: a(feed),
    tokenDecimals: 18,
    feedDecimals: 8,
    maxAge: 93600,
    session: 1,
    maxWeightBps: 5000,
    flags,
    averageFeed: a(feed + 1),
    minPrice: min,
    maxPrice: max,
  });
  const chain = (): ChainView => ({
    chainId: 46630,
    deployBlock: 129_500_000,
    contracts: {
      factory: a(20),
      registry: a(21),
      beacon: a(22),
      vaultLogic: a(23),
      factoryLogic: a(24),
      registryLogic: a(25),
    },
    admin: a(1),
    guardian: a(0),
    keeper: a(0),
    sequencerFeed: a(0),
    cashToken: a(3),
    routerPull: 2,
    assets: new Map([
      [
        a(3),
        { ...listed(0, 0, 0n, 0n), tokenDecimals: 6, session: 0, maxAge: 0, averageFeed: a(0) },
      ],
      [a(5), listed(10, 1, 60_152_912_311n, 97_020_826_308n)],
      [a(6), listed(12, 0, 0n, 0n)],
    ]),
    removed: [a(6)],
  });

  it('writes the record in ADE-1 shape, as EvmDeploymentRecord parses it', () => {
    const record = buildRecord(kit, config, chain());
    expect(record.network).toBe('robinhood-testnet');
    expect(record.evmChainId).toBe(46630);
    expect(record.roles).toMatchObject({ priceWriter: a(2), tokenIssuer: a(1) });
    expect(record.sequencerFeed).toBeNull();
    expect(record.routers).toEqual([{ address: a(4), pull: 2 }]);
    expect(record.cash).toMatchObject({ id: 'robinhood:tusdg', decimals: 6 });
    expect(record.assets[0]).toMatchObject({
      id: 'robinhood:tspy',
      kind: 'etf',
      keeperOn: true,
      range: { minPrice: '60152912311', maxPrice: '97020826308' },
      averageFeed: a(11),
    });
    expect(record.assets[1]).toMatchObject({ keeperOn: false, range: null });
    expect(record.retired).toEqual([{ id: 'robinhood:tnvda', symbol: 'tNVDA', address: a(6) }]);
    expect(recordJson(record)).not.toMatch(/"token":/);
  });

  it('refuses a node on another chain, another cash token, a router not at pull 2, an unlisted token', () => {
    expect(() => buildRecord(kit, config, { ...chain(), chainId: 4663 })).toThrow('not 46630');
    expect(() => buildRecord(kit, config, { ...chain(), cashToken: a(9) })).toThrow('cash token');
    expect(() => buildRecord(kit, config, { ...chain(), routerPull: 1 })).toThrow('pull 2');
    const c = chain();
    c.assets.delete(a(5));
    expect(() => buildRecord(kit, config, c)).toThrow('does not list tSPY');
  });
});

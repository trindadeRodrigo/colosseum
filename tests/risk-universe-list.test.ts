import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AssetList, TrackedAsset } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import {
  CLASS_BY_UNDERLYING,
  LIST_METHOD,
  type ListInputs,
  pairMismatch,
  robinhoodList,
  type SolanaInputs,
  solanaList,
} from '../scripts/risk/universe/list';
import { FUNDS } from '../scripts/risk-evm/feeds';

// PLAN-UNIVERSE RU.4 (gate UNIVERSE, DU2): the asset list, one file per chain. The inputs are frozen
// under fixtures/ (pnpm risk:freeze-list-fixtures): the cut, the oracle map and the token list of
// Robinhood Chain of 2026-10-05 cut to what the list reads, and the Solana registry of 2026-10-01 with
// the Scope table. No test calls the network, and the list itself reads no chain.
const gz = (path: string) => JSON.parse(gunzipSync(readFileSync(path)).toString());
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const SOLANA_NAMES = {
  registry: 'fixtures/risk/universe/solana-registry-20261001T0139.json.gz',
  detail: 'fixtures/risk/universe/solana-registry-detail-20261001T0139.json.gz',
  scope: 'fixtures/solana-vault/scope-indexes.json',
};
const solanaInputs = (): SolanaInputs => ({
  registry: gz(SOLANA_NAMES.registry),
  detail: gz(SOLANA_NAMES.detail),
  scope: json(SOLANA_NAMES.scope),
  names: SOLANA_NAMES,
});
const robinhoodInputs = (): ListInputs =>
  gz('fixtures/risk/universe/robinhood-list-inputs-20261005T1947.json.gz');
const committed = (chain: string) => json(`scripts/risk/universe/${chain}.json`);
const bySymbol = (list: AssetList, symbol: string) => {
  const a = list.assets.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`no row for ${symbol}`);
  return a;
};

const NO_FEED = ['AMC', 'COST', 'DJT', 'HIMS', 'LLY', 'RDDT'];
const SCOPE = 'AAPLx CRCLx GOOGLx HOODx METAx MSTRx NVDAx QQQx SPYx TSLAx'.split(' ');
const NO_SCOPE = 'AMZNx COINx GLDx GMEx MCDx MSFTx SPCXx STRCx'.split(' ');

describe('the committed lists', () => {
  it('both parse with the schema', () => {
    for (const chain of ['solana', 'robinhood']) {
      const list = AssetList.parse(committed(chain));
      expect(list.chain).toBe(chain);
      expect(list.method).toBe(LIST_METHOD);
      expect(Object.keys(list.stated)).toContain('later');
    }
  });

  it('Solana is the list its frozen inputs give, key for key', () => {
    expect(committed('solana')).toEqual(solanaList(solanaInputs()));
  });

  it('Robinhood is the list its frozen inputs give; only the cut`s provenance differs', () => {
    const file = committed('robinhood');
    const fx = robinhoodInputs();
    // a new run of the list is frozen again: pnpm risk:freeze-list-fixtures robinhood <cut> <oracles> <universe>
    expect(file.inputs).toEqual(fx.names);
    const fromFixture = robinhoodList(fx);
    const asLive = JSON.parse(JSON.stringify(fromFixture)) as AssetList;
    asLive.provenance = 'live';
    for (const a of asLive.assets) a.provenance = 'live';
    expect(file).toEqual(asLive);
  });

  it('carries no price, no answer and no multiplier (ORACLE-VS-DEX)', () => {
    for (const chain of ['solana', 'robinhood']) {
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (v && typeof v === 'object')
          for (const [k, x] of Object.entries(v)) {
            keys.add(k);
            if (k !== 'stated') walk(x);
          }
      };
      walk(committed(chain));
      for (const k of ['price', 'answer', 'round', 'multiplier', 'registryMultiplier'])
        expect(keys.has(k)).toBe(false);
    }
  });
});

describe('the Solana list (RU.10)', () => {
  const list = solanaList(solanaInputs());

  it('has 18 rows, 10 with a Scope oracle and 8 with no_scope_entry', () => {
    expect(list.assets).toHaveLength(18);
    expect(list.counts).toMatchObject({
      assets: 18,
      withOracle: 10,
      withoutOracle: 8,
      withoutOracleByReason: { no_scope_entry: 8 },
      autoRebalance: 10,
      rankedPools: 869,
      reachablePools: null,
      twoStockPools: 22,
    });
    const scope = list.assets.filter((a) => a.oracle?.kind === 'scope').map((a) => a.symbol);
    expect(scope).toEqual(SCOPE);
    expect(list.assets.filter((a) => !a.oracle).map((a) => a.symbol)).toEqual(NO_SCOPE);
    for (const a of list.assets.filter((x) => !x.oracle)) {
      expect(a.oracleReason).toBe('no_scope_entry');
      expect(a.autoRebalance).toBe(false);
      expect(a.autoRebalanceReason).toBe('no_scope_entry');
    }
  });

  it('keys each row on the mint, with the Scope entry of that mint', () => {
    const scope = solanaInputs().scope;
    const nvda = bySymbol(list, 'NVDAx');
    expect(nvda).toMatchObject({
      id: 'solana:nvdax',
      address: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
      decimals: 8,
      cls: 'stock',
      clsSource: 'default_stock',
      underlying: 'NVDA',
      session: 'us_equity',
      inCut: true,
      autoRebalance: true,
      autoRebalanceReason: null,
    });
    for (const a of list.assets.filter((x) => x.oracle)) {
      const entry = scope.assets.find((e) => e.mint === a.address);
      expect(a.oracle).toMatchObject({
        kind: 'scope',
        ref: String(entry?.priceIndex),
        twapRef: String(entry?.twapIndex),
        account: scope.priceAccount,
        method: 'kamino_reserve_decode',
        fetchedAt: scope.fetchedAt,
      });
    }
    // PAXG is in the Scope table and not in the registry of Oct 1: it is not a row
    expect(list.assets.some((a) => a.symbol === 'PAXG')).toBe(false);
  });

  it('counts the 869 pools by venue and by the way out, and says reach is not recorded', () => {
    const venue: Record<string, number> = {};
    const exit: Record<string, number> = {};
    for (const a of list.assets) {
      expect(a.pools.reachable).toBeNull();
      expect(a.pools.reachableReason).toBe('reach_is_not_recorded_per_pool_on_solana');
      expect(a.reachableUsd).toBeNull();
      for (const [v, n] of Object.entries(a.pools.byVenue)) venue[v] = (venue[v] ?? 0) + n.pools;
      for (const [e, n] of Object.entries(a.pools.byExitPath ?? {})) exit[e] = (exit[e] ?? 0) + n;
    }
    // PLAN-UNIVERSE section 2
    expect(venue).toEqual({
      raydium_cpmm: 610,
      raydium_clmm: 163,
      orca_whirlpool: 60,
      meteora_dlmm: 36,
    });
    expect(exit).toEqual({ direct_usd: 71, via_sol: 58, via_xstock: 22, other: 718 });
  });

  it('sets the class of the funds from the table', () => {
    expect(bySymbol(list, 'SPYx')).toMatchObject({ cls: 'etf', clsSource: 'class_table' });
    expect(bySymbol(list, 'QQQx')).toMatchObject({ cls: 'etf', clsSource: 'class_table' });
    expect(bySymbol(list, 'GLDx')).toMatchObject({ cls: 'gold', underlying: 'GLD' });
  });

  it('refuses a Scope entry whose mint is another stock`s, and registry files of two reads', () => {
    const wrong = solanaInputs();
    const nvda = wrong.scope.assets.find((a) => a.symbol === 'NVDAx');
    if (!nvda) throw new Error('fixture');
    nvda.symbol = 'AAPLy';
    expect(() => solanaList(wrong)).toThrow(/Scope table calls its mint AAPLy/);
    // the right symbol under another mint is refused too, never read as "no entry"
    const moved = solanaInputs();
    const entry = moved.scope.assets.find((a) => a.symbol === 'NVDAx');
    if (!entry) throw new Error('fixture');
    entry.mint = '11111111111111111111111111111111';
    expect(() => solanaList(moved)).toThrow(/NVDAx: the Scope table has it under another mint/);
    const twice = solanaInputs();
    twice.scope.assets.push({ ...(twice.scope.assets[0] as (typeof twice.scope.assets)[number]) });
    expect(() => solanaList(twice)).toThrow(/names a mint twice/);
    const two = solanaInputs();
    two.detail.fetched_at = '2026-10-02T00:00:00.000Z';
    expect(() => solanaList(two)).toThrow(/not of the same read/);
  });
});

describe('the Robinhood list', () => {
  const fx = robinhoodInputs();
  const list = robinhoodList(fx);

  it('has one row per tracked stock, keyed on the token address in the vault`s form', () => {
    expect(list.assets).toHaveLength(30);
    expect(list.assets.map((a) => a.address)).toEqual(
      fx.cut.tracked.map((t) => t.address.toLowerCase()),
    );
    expect(bySymbol(list, 'NVDA')).toMatchObject({
      id: 'robinhood:nvda',
      chain: 'robinhood',
      address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
      decimals: 18,
      cls: 'stock',
      underlying: 'NVDA',
      issuer: 'Robinhood',
      session: 'us_equity',
      inCut: true,
    });
    for (const a of list.assets) expect(a.method).toBe('evm-cut-0.1');
  });

  it('every row with a feed names the proxy the oracle map confirmed', () => {
    const withFeed = list.assets.filter((a) => a.oracle);
    expect(withFeed).toHaveLength(24);
    for (const a of withFeed) {
      const row = fx.oracles.tracked.find((r) => r.address.toLowerCase() === a.address);
      expect(row?.feed).not.toBeNull();
      expect(a.oracle).toMatchObject({
        kind: 'chainlink',
        ref: row?.feed?.address.toLowerCase(),
        description: row?.feed?.description,
        decimals: 8,
        method: 'evm-oracles-0.1',
        fetchedAt: row?.fetchedAt,
      });
      expect(a.autoRebalance).toBe(true);
    }
  });

  it('a stock with no feed is a row with oracle null (no_feed) and autoRebalance false', () => {
    const none = list.assets.filter((a) => !a.oracle);
    expect(none.map((a) => a.symbol).sort()).toEqual(NO_FEED);
    for (const a of none)
      expect(a).toMatchObject({
        oracle: null,
        oracleReason: 'no_feed',
        autoRebalance: false,
        autoRebalanceReason: 'no_feed',
        autoRebalanceOpen: null,
        inCut: true,
      });
    expect(list.counts.withoutOracleByReason).toEqual({ no_feed: 6 });
  });

  it('a stock whose feed the oracle map refused carries that reason, not no_feed', () => {
    const refused = robinhoodInputs();
    const row = refused.oracles.tracked.find((r) => r.symbol === 'NVDA');
    if (!row) throw new Error('fixture');
    row.feed = null;
    row.reason = 'description_does_not_name_the_token';
    const nvda = bySymbol(robinhoodList(refused), 'NVDA');
    expect(nvda).toMatchObject({
      oracle: null,
      oracleReason: 'description_does_not_name_the_token',
      autoRebalance: false,
      autoRebalanceReason: 'description_does_not_name_the_token',
    });
    row.reason = null;
    expect(() => robinhoodList(refused)).toThrow(/no feed and no reason/);
    const both = robinhoodInputs();
    const amd = both.oracles.tracked.find((r) => r.symbol === 'AMD');
    if (!amd) throw new Error('fixture');
    amd.reason = 'answer_not_positive';
    expect(() => robinhoodList(both)).toThrow(/a feed and a reason/);
  });

  it('refuses a cut and an oracle map that do not name the same token addresses', () => {
    const missing = robinhoodInputs();
    missing.oracles.tracked = missing.oracles.tracked.filter((r) => r.symbol !== 'AMD');
    expect(() => robinhoodList(missing)).toThrow(
      /not of this cut.*AMD .* in the cut and not in the map/,
    );

    const extra = robinhoodInputs();
    extra.cut.tracked = extra.cut.tracked.filter((t) => t.symbol !== 'DELL');
    extra.cut.pools = extra.cut.pools.filter(
      (p) => p.asset !== fx.cut.tracked.find((t) => t.symbol === 'DELL')?.address,
    );
    expect(() => robinhoodList(extra)).toThrow(/DELL .* in the map and not in the cut/);

    const other = robinhoodInputs();
    const row = other.oracles.tracked.find((r) => r.symbol === 'AMD');
    if (!row) throw new Error('fixture');
    row.address = `0x${'12'.repeat(20)}`;
    expect(pairMismatch(other.cut, other.oracles)).toHaveLength(2);
    expect(() => robinhoodList(other)).toThrow(/refused/);

    const renamed = robinhoodInputs();
    const amd = renamed.oracles.tracked.find((r) => r.symbol === 'AMD');
    if (!amd) throw new Error('fixture');
    amd.symbol = 'AMDX';
    expect(() => robinhoodList(renamed)).toThrow(/is AMD in the cut and AMDX in the map/);
    expect(pairMismatch(fx.cut, fx.oracles)).toEqual([]);

    // the same addresses, and a map that says it was made from another cut or token list
    const older = robinhoodInputs();
    older.oracles.inputs.cut = 'cut-robinhood-20261004T1947.json';
    expect(() => robinhoodList(older)).toThrow(/was made from cut-robinhood-20261004T1947.json/);
    const otherList = robinhoodInputs();
    otherList.oracles.inputs.universe = 'universe-robinhood-20261004T1805.json';
    expect(() => robinhoodList(otherList)).toThrow(/refused/);
    const dup = robinhoodInputs();
    dup.oracles.tracked.push({
      ...(dup.oracles.tracked[0] as (typeof dup.oracles.tracked)[number]),
    });
    expect(pairMismatch(dup.cut, dup.oracles)).toContain(
      'the oracle map names a token address twice',
    );
  });

  it('GLD and SGOV: the rule writes them true and names the open question; no multiplier', () => {
    expect(bySymbol(list, 'GLD')).toMatchObject({
      cls: 'gold',
      autoRebalance: true,
      autoRebalanceOpen: 'oracle_prices_from_pools',
      oracle: { prices: 'token_from_pools', pricesReason: null },
    });
    expect(bySymbol(list, 'SGOV')).toMatchObject({
      cls: 'dollar_yield',
      autoRebalance: true,
      autoRebalanceOpen: 'what_the_oracle_prices_is_not_stated',
      oracle: { prices: null, pricesReason: 'not_stated_in_directory' },
    });
    for (const s of ['SPY', 'QQQ', 'SLV', 'USO'])
      expect(bySymbol(list, s)).toMatchObject({
        autoRebalanceOpen: null,
        oracle: { prices: 'token_with_multiplier' },
      });
    expect(bySymbol(list, 'NVDA').oracle).toMatchObject({
      prices: null,
      pricesReason: 'oracle_map_says_it_for_funds_only',
    });
    expect(list.assets.filter((a) => a.autoRebalanceOpen).map((a) => a.symbol)).toEqual([
      'GLD',
      'SGOV',
    ]);
    // the question is read from the map's funds row: a fund without one is refused, not written plain
    const lost = robinhoodInputs();
    lost.oracles.funds = lost.oracles.funds.filter((f) => f.symbol !== 'GLD');
    expect(() => robinhoodList(lost)).toThrow(/GLD is a fund and the oracle map has no funds row/);
  });

  it('the class of every fund of the oracle map comes from the table (DU7)', () => {
    for (const s of FUNDS) expect(CLASS_BY_UNDERLYING[s]).toBeDefined();
    const tabled = list.assets.filter((a) => a.clsSource === 'class_table');
    expect(tabled.map((a) => `${a.symbol} ${a.cls}`).sort()).toEqual([
      'GLD gold',
      'QQQ etf',
      'SGOV dollar_yield',
      'SLV commodity',
      'SPY etf',
      'USO commodity',
    ]);
    for (const a of list.assets.filter((x) => x.clsSource === 'default_stock'))
      expect(a.cls).toBe('stock');
  });

  it('counts every pool once: unreachable ones stay in, a pool of two stocks is under one stock', () => {
    expect(list.counts.rankedPools).toBe(427);
    expect(list.counts.reachablePools).toBe(274);
    expect(fx.cut.pools).toHaveLength(427);
    const twoStock = fx.cut.pools.filter((p) => p.otherIsStock).length;
    expect(list.counts.twoStockPools).toBe(twoStock);
    let asOther = 0;
    for (const a of list.assets) {
      const venues = Object.values(a.pools.byVenue);
      expect(venues.reduce((s, v) => s + v.pools, 0)).toBe(a.pools.ranked);
      expect(venues.reduce((s, v) => s + (v.reachable ?? 0), 0)).toBe(a.pools.reachable);
      expect(a.pools.inCut).toBeLessThanOrEqual(a.pools.ranked);
      expect(a.reachableUsd as number).toBeLessThanOrEqual(a.tvlUsd);
      asOther += a.pools.twoStockAsOther;
    }
    // a two-stock pool whose other side is not tracked is nobody's twoStockAsOther
    expect([twoStock, asOther]).toEqual([46, 42]);
    const spy = bySymbol(list, 'SPY');
    expect(spy.pools).toMatchObject({ ranked: 57, inCut: 27, reachable: 38, twoStock: 32 });
    expect(spy.pools.byVenue['uniswap-v4']).toEqual({ pools: 38, reachable: 30 });
    expect(spy.pools.byVenue['ramses-v3']).toEqual({ pools: 4, reachable: 0 });
  });

  it('share is the row`s money over the chain`s ranked money', () => {
    for (const a of list.assets) expect(a.share).toBe(a.tvlUsd / list.rankedUsd);
    const sum = list.assets.reduce((s, a) => s + a.share, 0);
    expect(sum).toBeGreaterThan(0.9);
    expect(sum).toBeLessThan(1);
  });

  it('refuses a cut by another rule, pools that do not add up, and a token the list does not confirm', () => {
    const wide = robinhoodInputs();
    wide.cut.rule.share = 0.9;
    expect(() => robinhoodList(wide)).toThrow(/not the rule's/);
    const short = robinhoodInputs();
    short.cut.pools.pop();
    expect(() => robinhoodList(short)).toThrow(/do not add up/);
    const unconfirmed = robinhoodInputs();
    (unconfirmed.universe.tokens[0] as { confirmed: boolean }).confirmed = false;
    expect(() => robinhoodList(unconfirmed)).toThrow(/does not confirm/);
    const twice = robinhoodInputs();
    twice.universe.tokens.push({
      ...(twice.universe.tokens[0] as (typeof twice.universe.tokens)[number]),
    });
    expect(() => robinhoodList(twice)).toThrow(/names an address twice/);
    const money = robinhoodInputs();
    (money.cut.tracked[0] as { cutUsd: number }).cutUsd = 9e12;
    expect(() => robinhoodList(money)).toThrow(/contradict each other/);
    const stray = robinhoodInputs();
    (stray.cut.pools[0] as { asset: string }).asset = `0x${'34'.repeat(20)}`;
    expect(() => robinhoodList(stray)).toThrow(/filed under an untracked token/);
    const gone = robinhoodInputs();
    gone.universe.tokens.pop();
    expect(() => robinhoodList(gone)).toThrow(/not in the token list/);
  });
});

describe('the schema', () => {
  const row = () => JSON.parse(JSON.stringify(bySymbol(robinhoodList(robinhoodInputs()), 'AMC')));

  it('takes a row with no oracle, and refuses one that rebalances without it', () => {
    expect(TrackedAsset.safeParse(row()).success).toBe(true);
    expect(TrackedAsset.safeParse({ ...row(), autoRebalance: true }).success).toBe(false);
    expect(
      TrackedAsset.safeParse({ ...row(), autoRebalance: true, autoRebalanceReason: null }).success,
    ).toBe(false);
  });

  it('refuses a missing oracle with no reason, and a false with no reason', () => {
    expect(TrackedAsset.safeParse({ ...row(), oracleReason: null }).success).toBe(false);
    expect(TrackedAsset.safeParse({ ...row(), autoRebalanceReason: null }).success).toBe(false);
  });

  it('refuses an address of another chain`s form, an unknown field and a row with no source', () => {
    expect(TrackedAsset.safeParse({ ...row(), chain: 'solana', id: 'solana:amc' }).success).toBe(
      false,
    );
    expect(TrackedAsset.safeParse({ ...row(), price: '1' }).success).toBe(false);
    const { source: _source, ...bare } = row();
    expect(TrackedAsset.safeParse(bare).success).toBe(false);
  });

  it('holds the oracle to its chain, the counts to the rows and the pools to each other', () => {
    const nvda = () =>
      JSON.parse(
        JSON.stringify(bySymbol(robinhoodList(robinhoodInputs()), 'NVDA')),
      ) as TrackedAsset;
    const bad = (change: (a: TrackedAsset) => void) => {
      const a = nvda();
      change(a);
      return TrackedAsset.safeParse(a).success;
    };
    expect(TrackedAsset.safeParse(nvda()).success).toBe(true);
    expect(bad((a) => Object.assign(a.oracle ?? {}, { ref: 'banana' }))).toBe(false);
    expect(bad((a) => Object.assign(a.oracle ?? {}, { kind: 'scope', ref: '317' }))).toBe(false);
    expect(bad((a) => Object.assign(a.oracle ?? {}, { pricesReason: null }))).toBe(false);
    expect(bad((a) => Object.assign(a, { inCut: false }))).toBe(false);
    expect(bad((a) => Object.assign(a.pools, { inCut: a.pools.ranked + 1 }))).toBe(false);
    expect(bad((a) => Object.assign(a, { cutUsd: a.tvlUsd * 2 }))).toBe(false);
    const scope = JSON.parse(
      JSON.stringify(bySymbol(solanaList(solanaInputs()), 'NVDAx')),
    ) as TrackedAsset;
    expect(TrackedAsset.safeParse(scope).success).toBe(true);
    Object.assign(scope.oracle ?? {}, { ref: '512' });
    expect(TrackedAsset.safeParse(scope).success).toBe(false);

    const list = () => JSON.parse(JSON.stringify(robinhoodList(robinhoodInputs()))) as AssetList;
    const counted = list();
    counted.counts.withOracle = 25;
    expect(AssetList.safeParse(counted).success).toBe(false);
    const sameId = list();
    (sameId.assets[1] as TrackedAsset).id = (sameId.assets[0] as TrackedAsset).id;
    expect(AssetList.safeParse(sameId).success).toBe(false);
    expect(AssetList.safeParse(list()).success).toBe(true);
  });
});

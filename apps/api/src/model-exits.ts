import type { AssetTier, BasketAsset, LiquidityProvider } from '@colosseum/schemas';

// A test-network token stands in for the mainnet token it models (model-yields.ts carries over its
// yield). Bearing measures mainnet pools only, so nothing is ever stored under a test token's address,
// and without this every stand-in took its tier's ceiling: on devnet tier C, $1,500 a token, which left a
// $20,000 plan mostly cash. Here a stand-in reads the sell depth of its model's mainnet token instead,
// found by the model's symbol in Bearing's registry (risk_pools), and the whole provider is labelled
// `sandbox` with a source that names whose depth it is and that it is applied to test tokens. A
// stand-in whose model Bearing does not measure (the dollar-yield stand-ins: non-stock depth is not
// collected yet) takes the tier its model has on the mainnet launch shelf instead of the test
// network's blanket C, and the plan says whose tier it is; with neither it keeps C, and says so.

/**
 * A mainnet asset a stand-in may model, on its chain: from the Solana price index (a mint by symbol), from
 * Bearing's pool registry (the asset of each pool, with its TVL), or from the seeded EVM stock rows.
 */
export type RegistryAsset = {
  chain: string;
  assetSymbol: string;
  assetMint: string;
  tvlUsd: number | null;
  /** From the price index: the model's own mint, which wins over any registry row of the same name. */
  pinned?: boolean;
};

/** A stand-in and the mainnet asset whose measured depth it reads. */
export type ExitTwin = { id: string; symbol: string; twinSymbol: string; twinMint: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const family = (address: string) => (EVM_ADDRESS.test(address) ? 'evm' : 'solana');

/**
 * The test-network tokens that may read a model's depth or tier: not cash, labelled sandbox, with a
 * model, on a chain that runs as a test network (its own provenance `sandbox`, which the caller says).
 */
export function standIns(
  assets: BasketAsset[],
  chainProvenance: string | undefined,
): BasketAsset[] {
  if (chainProvenance !== 'sandbox') return [];
  return assets.filter((a) => a.provenance === 'sandbox' && a.cls !== 'cash' && !!a.underlying);
}

/**
 * The symbols a stand-in's model may go by, in the order they are tried. On Solana the deploy record's
 * `modelOf` loses its trailing x on the way to `underlying` (SPYx models SPY): the xStock's name comes
 * first, the bare one only where nothing goes by it.
 */
export function twinSymbols(a: Pick<BasketAsset, 'underlying' | 'address'>): string[] {
  const u = a.underlying;
  return family(a.address) === 'solana' ? [`${u}x`, u] : [u];
}

/**
 * Each stand-in's mainnet twin, on the stand-in's own chain: its model's names tried in order, and for a
 * name the asset the price index pins, else the registry asset of that name with the most pool TVL (on
 * EVM the name in any case, since EVM symbols are not spelled one way). A stand-in with no match has no
 * twin.
 */
export function exitTwins(tokens: BasketAsset[], registry: RegistryAsset[]): ExitTwin[] {
  const tvl = new Map<string, RegistryAsset & { tvl: number }>();
  for (const r of registry) {
    const k = `${r.chain}\u0000${r.assetSymbol}\u0000${r.assetMint}`;
    const t = tvl.get(k) ?? { ...r, tvl: 0 };
    t.tvl += r.pinned ? Number.POSITIVE_INFINITY : (r.tvlUsd ?? 0);
    tvl.set(k, t);
  }
  const assets = [...tvl.values()].sort((x, y) => y.tvl - x.tvl);
  return tokens.flatMap((t) => {
    const evm = family(t.address) === 'evm';
    const same = (a: string, b: string) => (evm ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const name of twinSymbols(t)) {
      const hit = assets.find(
        (a) =>
          a.chain === t.chain &&
          family(a.assetMint) === family(t.address) &&
          same(a.assetSymbol, name),
      );
      if (hit)
        return [
          { id: t.id, symbol: t.symbol, twinSymbol: hit.assetSymbol, twinMint: hit.assetMint },
        ];
    }
    return [];
  });
}

/** The provider's source when stand-ins read their twins' depth: whose depth, applied to which tokens. */
export function twinSource(base: string, twins: ExitTwin[]): string {
  const pairs = twins.map((t) => `${t.twinSymbol} for ${t.symbol}`).join(', ');
  return `${base}; mainnet depth applied to the test-network tokens that model it (${pairs})`;
}

/**
 * The same provider, labelled as a test network's: its figures are a mainnet token's, read for a test
 * token. The one figure that carries its own label, a leg's entry, is relabelled too.
 */
export function asSandbox<P extends LiquidityProvider>(provider: P): P {
  return {
    ...provider,
    provenance: 'sandbox',
    entry: (id, ctx) => {
      const e = provider.entry(id, ctx);
      return e && { ...e, provenance: 'sandbox' };
    },
  };
}

/** A mainnet token's tier on the launch shelf: what a leg of it may hold where nothing is measured. */
export type ShelfTier = { chain: string; symbol: string; tier: AssetTier; issuer?: string };

/** A stand-in with no measured twin, and the tier of its model on the mainnet shelf. */
export type TierTwin = { id: string; symbol: string; twinSymbol: string; tier: AssetTier };

/**
 * The tier each stand-in reads where Bearing measures nothing for its model: the model's tier on the
 * mainnet launch shelf, by the same symbols its depth is looked for under. A stand-in whose model the
 * shelf does not list keeps its own tier (C on a test network).
 */
export function tierTwins(tokens: BasketAsset[], shelf: ShelfTier[]): TierTwin[] {
  return tokens.flatMap((t) => {
    for (const name of twinSymbols(t)) {
      const hit = shelf.find(
        (s) => s.chain === t.chain && s.symbol.toLowerCase() === name.toLowerCase(),
      );
      if (hit)
        return hit.tier !== t.tier
          ? [{ id: t.id, symbol: t.symbol, twinSymbol: hit.symbol, tier: hit.tier }]
          : [];
    }
    return [];
  });
}

/** The launch shelf's tiers as `fixtures/risk/launch-shelf-tiers.json` keeps them, by chain. */
export function shelfTiers(file: {
  rows: Array<{ chain: string; symbol: string; tier: string; issuer?: string }>;
}): ShelfTier[] {
  return file.rows.flatMap((r) =>
    r.tier === 'A' || r.tier === 'B' || r.tier === 'C'
      ? [
          {
            chain: r.chain,
            symbol: r.symbol,
            tier: r.tier,
            ...(r.issuer ? { issuer: r.issuer } : {}),
          },
        ]
      : [],
  );
}

/** A stand-in and the issuer of the mainnet token it models. */
export type IssuerTwin = { id: string; symbol: string; twinSymbol: string; issuer: string };

/**
 * The issuer each stand-in is counted under: its model's on the mainnet shelf, in place of the test
 * network's one name for every token, under which the cap on one issuer held all of a plan's dollar
 * yield and gold to half together. A stand-in whose model the shelf names no issuer for keeps its own.
 */
export function issuerTwins(tokens: BasketAsset[], shelf: ShelfTier[]): IssuerTwin[] {
  return tokens.flatMap((t) => {
    for (const name of twinSymbols(t)) {
      const hit = shelf.find(
        (s) => s.chain === t.chain && s.symbol.toLowerCase() === name.toLowerCase(),
      );
      if (hit)
        return hit.issuer && hit.issuer !== t.issuer
          ? [{ id: t.id, symbol: t.symbol, twinSymbol: hit.symbol, issuer: hit.issuer }]
          : [];
    }
    return [];
  });
}

import type { BasketAsset, LiquidityProvider } from '@colosseum/schemas';

// A test-network token stands in for the mainnet token it models (model-yields.ts carries over its
// yield). Bearing measures mainnet pools only, so nothing is ever stored under a test token's address,
// and without this every stand-in took its tier's ceiling: on devnet tier C, $1,500 a token, which left a
// $20,000 plan mostly cash. Here a stand-in reads the sell depth of its model's mainnet token instead,
// found by the model's symbol in Bearing's registry (risk_pools), and the whole provider is labelled
// `sandbox` with a source that names whose depth it is and that it is applied to test tokens. A
// stand-in whose model Bearing does not measure keeps its tier's ceiling, and the plan says so.

/** A row of Bearing's registry: the asset a pool trades, under the registry's spelling. */
export type RegistryAsset = { assetSymbol: string; assetMint: string; tvlUsd: number | null };

/** A stand-in and the mainnet asset whose measured depth it reads. */
export type ExitTwin = { id: string; symbol: string; twinSymbol: string; twinMint: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const family = (address: string) => (EVM_ADDRESS.test(address) ? 'evm' : 'solana');

/** The test-network tokens that may read a model's depth: not cash, labelled sandbox, with a model. */
export function standIns(assets: BasketAsset[]): BasketAsset[] {
  return assets.filter((a) => a.provenance === 'sandbox' && a.cls !== 'cash' && !!a.underlying);
}

/**
 * The registry symbols a stand-in's model may go by. On Solana the deploy record's `modelOf` loses its
 * trailing x on the way to `underlying` (SPYx models SPY), and Bearing's registry keeps the x.
 */
export function twinSymbols(a: Pick<BasketAsset, 'underlying' | 'address'>): string[] {
  const u = a.underlying;
  return family(a.address) === 'solana' ? [`${u}x`, u] : [u];
}

/**
 * Each stand-in's mainnet twin: the registry asset of the same family of chains whose symbol is one of
 * its model's (on EVM in any case, since EVM symbols and addresses are not spelled one way), the one with
 * the most pool TVL where several match. A stand-in with no match has no twin.
 */
export function exitTwins(tokens: BasketAsset[], registry: RegistryAsset[]): ExitTwin[] {
  const tvl = new Map<string, { symbol: string; mint: string; tvl: number }>();
  for (const r of registry) {
    const k = `${r.assetSymbol}\u0000${r.assetMint}`;
    const t = tvl.get(k) ?? { symbol: r.assetSymbol, mint: r.assetMint, tvl: 0 };
    t.tvl += r.tvlUsd ?? 0;
    tvl.set(k, t);
  }
  const assets = [...tvl.values()].sort((x, y) => y.tvl - x.tvl);
  return tokens.flatMap((t) => {
    const fam = family(t.address);
    const names = twinSymbols(t).map((s) => (fam === 'evm' ? s.toLowerCase() : s));
    const hit = assets.find(
      (a) =>
        family(a.mint) === fam && names.includes(fam === 'evm' ? a.symbol.toLowerCase() : a.symbol),
    );
    return hit ? [{ id: t.id, symbol: t.symbol, twinSymbol: hit.symbol, twinMint: hit.mint }] : [];
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

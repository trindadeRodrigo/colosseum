import { Asset, type AssetList } from '@colosseum/schemas';

// The `assets` rows of the tracked EVM stocks (PLAN-UNIVERSE RU.8), from the chain's asset list
// (scripts/risk/universe/<chain>.json) and the cut that list names. No I/O: seed-assets.ts reads the files.
//
// What a row says the structurer may do with the stock: nothing (decision of 2026-10-05, docs/GATES.md,
// gate UNIVERSE). `eligibleProfiles` is empty, so the registry's `isEligible` refuses it under every
// profile; the cap is 0 and the mint path `unavailable`. The row exists so the risk layer's curves and
// prices have an asset to answer under. Every row is `equity`, the funds too: the stock rule covers
// every token of the issuer's shelf, and the list's own class is kept in the label.

/** What the seed reads of a cut: the tracked tokens with the address as the issuer's registry spells it. */
export type CutForSeed = { chain: string; tracked: Array<{ address: string; symbol: string }> };
export type ListForSeed = Pick<AssetList, 'chain' | 'inputs' | 'assets'>;

const fail = (message: string): never => {
  throw new Error(`seed: ${message}`);
};

/**
 * One row per tracked stock of the list. `mint` is the token address as the cut spells it (the issuer
 * registry's mixed case): the spelling the collector writes in `asset_mint` of risk_asset_snapshots and in
 * `mint` of risk_price_observations (`listRun` in scripts/risk-evm/listed.ts takes it from the same
 * place). The list holds the lower-case form, which would not join. A cut that is not the one the list
 * names, or that does not track a row of the list under the same symbol, is refused.
 */
export function evmAssetRows(list: ListForSeed, cut: CutForSeed, cutName: string): Asset[] {
  if (cut.chain !== list.chain)
    fail(`the list is for ${list.chain} and ${cutName} for ${cut.chain}`);
  if (list.inputs.cut !== cutName)
    fail(`the ${list.chain} list was written from ${list.inputs.cut}, not from ${cutName}`);
  const spelled = new Map(cut.tracked.map((t) => [t.address.toLowerCase(), t]));
  return list.assets.map((a) => {
    const t =
      spelled.get(a.address) ?? fail(`${a.symbol} of the list is not tracked in ${cutName}`);
    if (t.symbol !== a.symbol)
      fail(`${a.address} is ${a.symbol} in the list and ${t.symbol} in the cut`);
    return Asset.parse({
      id: a.id,
      symbol: a.symbol,
      name: `${a.symbol} stock token on ${chainName(list.chain)}`,
      kind: 'equity',
      chain: 'evm',
      mint: t.address,
      decimals: a.decimals,
      eligibleProfiles: [],
      capWeight: 0,
      mintPath: 'unavailable',
      metadata: {
        issuer: a.issuer,
        oracle: a.oracle
          ? `${a.oracle.kind} ${a.oracle.ref}${a.oracle.description ? ` (${a.oracle.description})` : ''}`
          : `none (${a.oracleReason ?? 'no reason given'})`,
        gates: [],
        label: `${chainName(list.chain)}, class ${a.cls}: measured by the risk layer, not offered in a plan`,
      },
      provenance: a.provenance,
    });
  });
}

const chainName = (chain: string) =>
  chain === 'robinhood' ? 'Robinhood Chain' : chain.charAt(0).toUpperCase() + chain.slice(1);

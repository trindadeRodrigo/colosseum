import type { AssetId, BasketLine, ChainId, Target } from '@colosseum/schemas';

// What a vault holds, from the plan the screen showed: the lines on the plan's chain, without the cash
// it keeps, with the weight of an asset that comes through more than one line added up. The guard holds
// a vault's targets in the bytes to these, so they come from the plan the person read and never from an
// order the API answered. `cash` is the chain's cash token as the committed deployment names it.

/** Null when a line names another chain. A plan that is all cash holds nothing: an empty list. */
export function targetsOfPlan(
  lines: readonly BasketLine[],
  chain: ChainId,
  cash: AssetId,
): Target[] | null {
  if (lines.some((line) => line.chain !== chain)) return null;
  const weights = new Map<AssetId, number>();
  for (const line of lines) {
    if (line.assetId === cash || line.weightBps <= 0) continue;
    weights.set(line.assetId, (weights.get(line.assetId) ?? 0) + line.weightBps);
  }
  return [...weights].map(([asset, weightBps]) => ({ asset, weightBps }));
}

import {
  type ChainId,
  type ChainStatus,
  ConfigResponse,
  chainProvenance,
  DEFAULT_FLAGS,
  parseChainConfigs,
} from '@colosseum/schemas';

/**
 * What GET /v1/config answers, built the way apps/api builds it (the web cannot import the API), with
 * some fields of some chains replaced. With nothing replaced it is the API with no variable set.
 */
export function buildConfigForTest(
  over: Partial<Record<ChainId, Partial<ChainStatus>>>,
): ConfigResponse {
  const configs = parseChainConfigs({});
  const ids: ChainId[] = ['solana', 'robinhood', 'base'];
  return ConfigResponse.parse({
    flags: DEFAULT_FLAGS,
    chains: ids.map((id) => {
      const mode = DEFAULT_FLAGS.chainMode[id];
      return {
        ...configs[id],
        mode,
        provenance: chainProvenance(configs[id].network, mode),
        ...over[id],
      };
    }),
  });
}

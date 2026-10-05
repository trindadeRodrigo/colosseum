// The EVM adapter for vaults (DESIGN-VAULT 3.2): the reader (ADE-1). One codebase for every EVM chain,
// a `ChainConfig` per chain. It holds no key. Its own entry: '@colosseum/chain-evm/vault'.
export { displayAmount, fromScaled, multiplierString, toScaled } from './amounts';
export * from './deployment';
export { revertDataOf, revertToChainError } from './errors';
export {
  BASKET_VAULT_ABI,
  INDEX_REGISTRY_ABI,
  VAULT_BEACON_ABI,
  VAULT_FACTORY_ABI,
} from './generated/abi';
export { dayOf, marketAt } from './market';
export * from './reader';
export { createEvmRpc, type EvmRpc, isRevert } from './rpc';
export { unlistedAssetId, unlistedToken } from './unlisted';

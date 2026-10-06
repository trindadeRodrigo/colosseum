// @colosseum/sdk: what stands between an order the API prepared and a wallet that signs it.
//   the guard      reads the bytes of a transaction and refuses anything that is not the approved step
//   the executor   walks an order step by step: build, guard, sign, report, wait for the chain
//   the client     the API's routes over fetch, typed from its OpenAPI document (src/api/types.ts)
// The built package carries no workspace code: the shared types are imported as types only.

export * from './api';
export * from './executor';
export * from './guard';
export { basketIdOfPlan, familyIdOf } from './plan';
export {
  type ChainRecipe,
  type ChainRecipeLine,
  type ChainRecipeVersion,
  RECIPE_ACCOUNT_SIZE,
  readSolanaRecipe,
  vaultOf,
} from './registry';

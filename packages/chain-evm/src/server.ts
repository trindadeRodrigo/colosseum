// The signing entry: '@colosseum/chain-evm/server' (DESIGN-VAULT section 2, rule 5). The code that holds
// a key lives behind it. The other entries do not re-export it, so nothing the API loads can reach a
// key. Only apps/keeper and scripts/ import this, and tests/boundaries.test.ts fails on anything else.
export * from './sign';

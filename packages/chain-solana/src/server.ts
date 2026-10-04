// The signing entry: '@colosseum/chain-solana/server' (DESIGN-VAULT section 2, rule 5). The code that
// holds a key lives behind it: the keypair loader, and the signer that sends what it signed. The root
// entry does not re-export it, so nothing the API loads at start can reach a key. Only apps/keeper and
// scripts/ import this, and tests/boundaries.test.ts fails on anything else.
export * from './sign';
export * from './wallet';

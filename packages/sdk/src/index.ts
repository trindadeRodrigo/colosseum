// @colosseum/sdk: what stands between an order the API prepared and a wallet that signs it.
//   the guard      reads the bytes of a transaction and refuses anything that is not the approved step
//   the executor   (execute) walks an order step by step: build, guard, sign, report, track
// The built package carries no workspace code: the shared types are imported as types only.

export * from './guard';

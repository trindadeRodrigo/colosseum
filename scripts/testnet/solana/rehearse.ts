// The rehearsal for a test-network deploy, on a local validator: deploys the two built programs with
// a key that holds 10 SOL, runs the set-up (a dry run, the real run, a second run that sends
// nothing), then carries a vault through create, deposit, a swap, a keeper leg and an accept.
//
//   pnpm exec tsx scripts/testnet/solana/rehearse.ts <dir outside the repo> <rpc port>
//
// The work is in programs/tests/testnet-rehearse.ts (see setup.ts beside this file for why).
const entry = new URL('../../../programs/tests/testnet-rehearse.ts', import.meta.url).href;

import(entry).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

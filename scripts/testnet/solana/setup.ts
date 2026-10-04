// Sets up a Solana test network after the two programs are deployed: the test tokens, the test
// exchange with its price account, pairs and reserves, the vault program's Config and asset list,
// and the platform's lookup table. The runbook is "Deploying to a test network" in programs/README.md.
//
//   SOLANA_RPC_URL=<cluster> SOLANA_KEYPAIR=<path> pnpm exec tsx scripts/testnet/solana/setup.ts [--dry-run]
//
// The work is in programs/tests/testnet-setup.ts, beside the builders the program's tests check
// against the interface files: it needs that package's Solana libraries, which the root does not
// have (`pnpm --dir programs/tests install` once). This file only starts it.
const entry = new URL('../../../programs/tests/testnet-setup.ts', import.meta.url).href;

import(entry).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

// Copies real prices from mainnet, read only, onto the Solana test network's price account (TNET-5).
// The run script and how to stop it are in programs/README.md, "Copying prices onto the test network".
//
//   SOLANA_RPC_URL=<devnet> SOLANA_PRICE_WRITER_KEYPAIR=<path> pnpm exec tsx scripts/testnet/solana/prices.ts --once
//
// The work is in programs/tests/testnet-prices.ts, beside the builders the program's tests check
// against the interface files (see setup.ts beside this file for why). This file only starts it.
const entry = new URL('../../../programs/tests/testnet-prices.ts', import.meta.url).href;

import(entry).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

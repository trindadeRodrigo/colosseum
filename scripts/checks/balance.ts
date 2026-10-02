// Read-only check: prints the demo wallet's SOL and USDC balances.
import 'dotenv/config';
import { createRpc, loadKeypair } from '@colosseum/chain-solana';
import { address } from '@solana/kit';

const rpc = createRpc();
const kp = await loadKeypair();
const sol = await rpc.getBalance(kp.address).send();
const usdc = await rpc
  .getTokenAccountsByOwner(
    kp.address,
    { mint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') },
    { encoding: 'jsonParsed' },
  )
  .send();
const bal = usdc.value.map((a) => (a.account.data as any).parsed.info.tokenAmount.uiAmountString);
console.log(JSON.stringify({ address: kp.address, sol: Number(sol.value) / 1e9, usdc: bal }));

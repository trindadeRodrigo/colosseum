import 'dotenv/config';
import { createRpc, KAMINO_MAIN_MARKET } from '@colosseum/chain-solana';
import { loadKeypair } from '@colosseum/chain-solana/server';
import { REGISTRY } from '@colosseum/engine';
import { address } from '@solana/kit';

// Prints the demo wallet's SOL, token balances for every registry mint, and its Kamino obligation deposits.
const rpc = createRpc();
const kp = await loadKeypair();
const out: Record<string, unknown> = {
  wallet: kp.address,
  sol: Number((await rpc.getBalance(kp.address).send()).value) / 1e9,
};
for (const a of REGISTRY.filter((x) => x.mint && x.mintPath === 'dex_swap')) {
  const accts = await rpc
    .getTokenAccountsByOwner(
      kp.address,
      { mint: address(a.mint as string) },
      { encoding: 'jsonParsed' },
    )
    .send();
  const bal = accts.value.reduce(
    (s, t) =>
      s +
      Number(
        (t.account.data as { parsed: { info: { tokenAmount: { uiAmount: number | null } } } })
          .parsed.info.tokenAmount.uiAmount ?? 0,
      ),
    0,
  );
  if (bal > 0) out[a.id] = bal;
}
const sdk = await import('@kamino-finance/klend-sdk');
const market = await sdk.KaminoMarket.load(
  rpc,
  KAMINO_MAIN_MARKET,
  sdk.DEFAULT_RECENT_SLOT_DURATION_MS,
);
if (market) {
  try {
    const ob = await market.getUserVanillaObligation(kp.address);
    out['kamino-usdc'] = Object.fromEntries(
      [...ob.deposits.values()].map((d) => [
        market.getReserveByAddress(d.reserveAddress)?.symbol ?? d.reserveAddress,
        { amount: d.amount.toString(), marketValueUsd: d.marketValueRefreshed.toString() },
      ]),
    );
  } catch (e) {
    out['kamino-usdc'] = `no obligation: ${String(e).slice(0, 80)}`;
  }
}
console.log(JSON.stringify(out, null, 1));

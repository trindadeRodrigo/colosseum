import 'dotenv/config';
import { existsSync } from 'node:fs';
import { buildSwapTx, createRpc, getQuote, simulateBase64 } from '@colosseum/chain-solana';
import { loadKeypair } from '@colosseum/chain-solana/server';
import { REGISTRY_BY_ID } from '@colosseum/engine';
import { address, createSolanaRpc } from '@solana/kit';

// D1-PM check: a USDC→USDY swap for a few dollars builds and simulates successfully.
// Uses the demo wallet if it holds USDC; otherwise a large public USDC holder as a labelled proxy signer
// (sigVerify=false), which exercises the same build path without needing funds.
const rpc = createRpc();
const usdc = REGISTRY_BY_ID.get('usdc');
const usdy = REGISTRY_BY_ID.get('usdy');
if (!usdc?.mint || !usdy?.mint) throw new Error('registry missing usdc/usdy');
const amountBase = 5_000_000n;

let user: string;
let signerLabel: string;
const walletPath = process.env.DEMO_WALLET_KEYPAIR_PATH ?? './secrets/demo-wallet.json';
let demoUsdc = 0;
if (existsSync(walletPath)) {
  const kp = await loadKeypair(walletPath);
  const accts = await rpc
    .getTokenAccountsByOwner(kp.address, { mint: address(usdc.mint) }, { encoding: 'jsonParsed' })
    .send();
  demoUsdc = accts.value.reduce(
    (s, a) =>
      s +
      Number(
        (a.account.data as { parsed: { info: { tokenAmount: { uiAmount: number } } } }).parsed.info
          .tokenAmount.uiAmount ?? 0,
      ),
    0,
  );
  user = kp.address;
  signerLabel = `demo wallet ${kp.address} (USDC balance ${demoUsdc})`;
} else {
  user = '';
  signerLabel = 'no demo wallet file';
}
if (demoUsdc < 5) {
  // Known large USDC holders (exchange hot wallets) as a labelled proxy signer; getTokenLargestAccounts is
  // forbidden on Chainstack (403) and rate-limited on the public RPC (429), so candidates are checked directly.
  const CANDIDATES = [
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
    'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',
  ];
  let picked: { owner: string; usdc: number } | null = null;
  for (const owner of CANDIDATES) {
    const accts = await rpc
      .getTokenAccountsByOwner(
        address(owner),
        { mint: address(usdc.mint) },
        { encoding: 'jsonParsed' },
      )
      .send();
    const bal = accts.value.reduce(
      (s, a) =>
        s +
        Number(
          (a.account.data as { parsed: { info: { tokenAmount: { uiAmount: number | null } } } })
            .parsed.info.tokenAmount.uiAmount ?? 0,
        ),
      0,
    );
    if (bal >= 5) {
      picked = { owner, usdc: bal };
      break;
    }
  }
  if (!picked) throw new Error('no proxy USDC holder found; fund the demo wallet instead');
  user = picked.owner;
  signerLabel = `PROXY (labelled): USDC holder ${picked.owner} (balance ${picked.usdc}), sigVerify=false — demo wallet not funded yet`;
}

const quote = await getQuote({ inputMint: usdc.mint, outputMint: usdy.mint, amountBase });
const built = await buildSwapTx({ quote, userPublicKey: user });
const sim = await simulateBase64(rpc, built.swapTransaction);
console.log(
  JSON.stringify(
    {
      check: 'D1-PM simulate USDC→USDY',
      signer: signerLabel,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
        routes: quote.routePlan.length,
      },
      simulation: {
        ok: sim.ok,
        err: sim.err,
        unitsConsumed: sim.unitsConsumed,
        lastLog: sim.logs.at(-1),
      },
      fetchedAt: new Date().toISOString(),
    },
    null,
    1,
  ),
);
process.exit(sim.ok ? 0 : 1);

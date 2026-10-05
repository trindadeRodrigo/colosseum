import 'dotenv/config';
import { jupQuote, MINTS, RPC_URL, rpc, sleep } from '../lib';

// VR probe (risk layer): which pools Jupiter routes SPYx/QQQx through, which programs own them,
// and how far back the RPC serves signatures and transactions for the busiest pool.
const host = new URL(RPC_URL).host;
console.log(JSON.stringify({ rpcHost: host }));

type Route = { swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string } };
const pools = new Map<string, string>();
for (const [sym, mint] of [
  ['SPYx', MINTS.SPYx],
  ['QQQx', MINTS.QQQx],
] as const) {
  for (const usd of [1_000n, 100_000n]) {
    const q = await jupQuote(MINTS.USDC, mint, usd * 1_000_000n);
    const plan = (q.body.routePlan ?? []) as Route[];
    for (const r of plan) pools.set(r.swapInfo.ammKey, `${sym} ${r.swapInfo.label}`);
    console.log(
      JSON.stringify({
        sym,
        usd: Number(usd),
        status: q.status,
        hops: plan.map((r) => r.swapInfo.label),
      }),
    );
    await sleep(1500);
  }
}

for (const [pool, what] of pools) {
  const info = await rpc<{
    value: { owner: string; data: [string, string]; lamports: number } | null;
  }>('getAccountInfo', [pool, { encoding: 'base64' }]);
  const owner = info.value?.owner ?? null;
  const size = info.value ? Buffer.from(info.value.data[0], 'base64').length : 0;
  // walk signatures back a few pages to see depth and rate
  let before: string | undefined;
  let n = 0;
  let oldest: { signature: string; blockTime: number | null } | undefined;
  let newestTime: number | null = null;
  for (let page = 0; page < 5; page++) {
    const sigs = await rpc<Array<{ signature: string; blockTime: number | null }>>(
      'getSignaturesForAddress',
      [pool, { limit: 1000, ...(before ? { before } : {}) }],
    );
    if (!sigs.length) break;
    if (newestTime === null) newestTime = sigs[0]?.blockTime ?? null;
    n += sigs.length;
    oldest = sigs[sigs.length - 1];
    before = oldest?.signature;
    if (sigs.length < 1000) break;
  }
  let oldestTx: string = 'n/a';
  if (oldest) {
    try {
      const tx = await rpc<{ meta: { preTokenBalances: unknown[] } } | null>('getTransaction', [
        oldest.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]);
      oldestTx = tx ? `ok, ${tx.meta.preTokenBalances.length} token balances` : 'null';
    } catch (e) {
      oldestTx = `error ${String(e).slice(0, 120)}`;
    }
  }
  console.log(
    JSON.stringify({
      pool,
      what,
      owner,
      size,
      sigsWalked: n,
      newest: newestTime ? new Date(newestTime * 1000).toISOString() : null,
      oldestWalked: oldest?.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null,
      oldestTx,
    }),
  );
}

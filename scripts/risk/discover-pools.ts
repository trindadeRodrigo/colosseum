import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, sleep } from '../lib';

// Pool discovery for every verified xStock. Sources: Jupiter verified token list (the asset universe)
// and DexScreener token-pairs (pool candidates with liquidity and 24h volume). Discovery only: every pool
// is later confirmed on-chain (owner program + decoded mints) before it is used. Output is JSONL with
// source and fetchedAt per row; the summary prints the Pareto structure by liquidity and by volume.
const OUT = process.env.RISK_DATA_DIR ?? 'data/risk';
mkdirSync(OUT, { recursive: true });
const stamp = nowIso().slice(0, 16).replace(/[-:]/g, '');

const listUrl = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified';
const list = (await (await fetch(listUrl)).json()) as Array<{
  id: string;
  symbol: string;
  tags?: string[];
  mintAuthority?: string;
}>;
const xs = list.filter((t) => (t.tags ?? []).includes('xstocks') || t.id.startsWith('Xs'));
const authorities = new Set(xs.map((t) => t.mintAuthority));
writeFileSync(
  join(OUT, `xstocks-${stamp}.json`),
  JSON.stringify({
    source: listUrl,
    fetchedAt: nowIso(),
    authorities: [...authorities],
    tokens: xs,
  }),
);

const file = join(OUT, `pools-dexscreener-${stamp}.jsonl`);
const done = new Set<string>();
for (const f of readdirSync(OUT).filter((n) => n.startsWith(`pools-dexscreener-${stamp}`))) {
  for (const l of readFileSync(join(OUT, f), 'utf8').split('\n').filter(Boolean))
    done.add(JSON.parse(l).assetMint);
}
let errors = 0;
for (const [i, t] of xs.entries()) {
  if (done.has(t.id)) continue;
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${t.id}`;
  let status = 0;
  let pairs: unknown[] = [];
  let error: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      status = res.status;
      if (status === 429) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      pairs = (await res.json()) as unknown[];
      error = null;
      break;
    } catch (e) {
      error = String(e);
      await sleep(2000);
    }
  }
  if (status !== 200) {
    errors++;
    error ??= `status ${status}`;
  }
  appendFileSync(
    file,
    `${JSON.stringify({ assetMint: t.id, symbol: t.symbol, source: url, fetchedAt: nowIso(), status, error, pairs })}\n`,
  );
  if (i % 100 === 0) console.log(JSON.stringify({ i, of: xs.length, errors }));
  await sleep(220);
}
console.log(JSON.stringify({ file, assets: xs.length, errors }));

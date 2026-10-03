import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { LENDING_HISTORY_DIR, RISK_HOME } from './lib-lending';
import { pseudonymise } from './lib-pseudonymise';

// PLAN-ANALYTICS item 13 — freezes the transactions behind tests/risk-layer/lending-follow.test.ts from the latest
// `pnpm risk:lending-follow` run: for the first liquidation of each outcome, its liquidation transaction (raw
// history) and its outflow transaction (follow cache), with the liquidation row and the registry vaults of the pools
// they touch. Owners, liquidators and signatures are replaced by stand-ins (DA4, lib-pseudonymise.ts).
// `pnpm risk:lending-freeze-follow-fixtures`.
const DIR = join(LENDING_HISTORY_DIR, 'follow');
const rowsFile = readdirSync(DIR)
  .filter((f) => f.startsWith('rows-'))
  .sort()
  .at(-1) as string;
const rows = readFileSync(join(DIR, rowsFile), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { signature: string; outcome: string; outSignature?: string });
const liqs = new Map(
  readFileSync(join(LENDING_HISTORY_DIR, 'decoded', 'liquidations.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { s: string; time: string })
    .map((l) => [l.s, l] as const),
);
const cache = new Map<string, unknown>();
for (const l of readFileSync(join(DIR, 'tx-cache.jsonl'), 'utf8').split('\n'))
  if (l) {
    const r = JSON.parse(l) as { s: string; tx: unknown };
    cache.set(r.s, r.tx);
  }
const picked = [...new Set(rows.map((r) => r.outcome))]
  .filter((o) => o !== 'held' && o !== 'not_traced')
  .map((o) => rows.find((r) => r.outcome === o) as (typeof rows)[number]);
const held = rows.find((r) => r.outcome === 'held');
if (held) picked.push(held);
const raw = (sig: string, day: string) => {
  const f = join(LENDING_HISTORY_DIR, 'raw', `${day}.jsonl.gz`);
  if (!existsSync(f)) return null;
  for (const line of gunzipSync(readFileSync(f)).toString('utf8').split('\n'))
    if (line.startsWith(`{"s":"${sig}"`)) return (JSON.parse(line) as { tx: unknown }).tx;
  return null;
};
const cases = picked.map((r) => {
  // the borrower's position is not needed and stays out
  const { position: _position, ...l } = liqs.get(r.signature) as {
    s: string;
    time: string;
    position?: string;
  };
  return {
    outcome: r.outcome,
    liquidation: l,
    liquidationTx: raw(r.signature, l.time.slice(0, 10)),
    outTx: r.outSignature ? cache.get(r.outSignature) : null,
  };
});
const registry = (
  JSON.parse(readFileSync(join(RISK_HOME, 'registry.json'), 'utf8')) as {
    pools: Array<{ address: string; program: string; vault0: string; vault1: string }>;
  }
).pools;
const text = JSON.stringify(cases);
const vaults = registry
  .filter((p) => text.includes(p.vault0) || text.includes(p.vault1))
  .map((p) => ({ address: p.address, vault0: p.vault0, vault1: p.vault1 }));
writeFileSync(
  'fixtures/risk/lending/follow.json',
  `${pseudonymise(JSON.stringify({ frozenFrom: rowsFile, programs: [...new Set(registry.map((p) => p.program))], vaults, cases }))}\n`,
);
console.log(JSON.stringify({ cases: cases.map((c) => c.outcome), vaults: vaults.length }));

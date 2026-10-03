import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectFacts, LendingPoolFacts } from '@colosseum/schemas';
import { LENDING_HISTORY_DIR } from '../lib-lending';

// Prints one lending pool's fact sheet from the latest `pnpm risk:lending-report` (PLAN-ANALYTICS item 10; the report
// builds the sheets, item 11 imports them for the API). Read-only.
// Usage: tsx scripts/risk/facts/lending-facts.ts [account | symbol | market words] [--json]
const args = process.argv.slice(2);
const q = args
  .filter((a) => !a.startsWith('--'))
  .join(' ')
  .toLowerCase();
const dir = join(LENDING_HISTORY_DIR, 'report');
const file = readdirSync(dir)
  .filter((f) => /^lending-report-.*\.json$/.test(f))
  .sort()
  .at(-1);
if (!file) throw new Error(`no lending report in ${dir}: run pnpm risk:lending-report`);
const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
  fetched_at: string;
  lendingPoolFacts?: { sheets: LendingPoolFacts[] };
};
const sheets = report.lendingPoolFacts?.sheets ?? [];
if (!sheets.length) throw new Error(`${file} has no lending pool facts (older than item 10)`);
const match = sheets.filter(
  (s) => !q || s.account.toLowerCase() === q || `${s.symbol} ${s.market}`.toLowerCase().includes(q),
);
if (!q || match.length !== 1) {
  console.log(`${file}: ${sheets.length} sheets${q ? `, ${match.length} match "${q}"` : ''}`);
  for (const s of match.length ? match : sheets)
    console.log(`  ${s.account}  ${s.symbol}  ${s.market}`);
  process.exit(q && !match.length ? 1 : 0);
}
const sheet = match[0] as LendingPoolFacts;
const parsed = LendingPoolFacts.safeParse(sheet);
const { facts, invalid } = collectFacts(sheet);
if (args.includes('--json')) console.log(JSON.stringify(sheet, null, 2));
else {
  console.log(
    `${sheet.symbol} — ${sheet.market} (${sheet.venue}, ${sheet.account}); report ${report.fetched_at}`,
  );
  console.table(
    facts
      .filter(({ path }) => !path.includes('.routes['))
      .map(({ path, fact }) => ({
        fact: path,
        value:
          fact.value === null
            ? null
            : fact.unit === 'fraction'
              ? `${(fact.value * 100).toFixed(3)}%`
              : fact.unit === 'usd'
                ? `$${fact.value.toFixed(0)}`
                : fact.unit === 'ratio'
                  ? fact.value.toFixed(2)
                  : `${fact.value}`,
        regime: fact.regime ?? '',
        quality: fact.value === null ? fact.reason : fact.quality,
      })),
  );
}
console.log(
  `${facts.filter((f) => f.fact.value !== null).length} of ${facts.length} facts measured (routes included); ${invalid.length} invalid; schema ${parsed.success ? 'ok' : 'FAILED'}`,
);
if (!parsed.success || invalid.length) process.exit(1);

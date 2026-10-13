import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ByrealValidationFile } from './lib';

// PLAN-UNIVERSE RU.15 — `pnpm risk:byreal-freeze-fixture <validation.json> <pool> <out.json.gz>`: one quoted pool of
// a validation run, cut out whole for the tests: its fee config, every account it owns (both kinds of tick array and
// the accounts that are neither), and each of its quotes with the pool account it was set against. No network: the
// file of `pnpm risk:byreal-validate` already holds the bytes. The earlier tries of a trade that were asked again
// are left out; the validation file keeps them.
const [from, pool, out] = process.argv.slice(2);
if (!from || !pool || !out)
  throw new Error('usage: freeze-fixture.ts <validation.json> <pool> <out.json.gz>');
const file = JSON.parse(readFileSync(from, 'utf8')) as ByrealValidationFile;
const p = file.quoted.find((q) => q.pool === pool);
if (!p) throw new Error(`${pool}: not one of the pools quoted in ${from}`);
const { retaken: _retaken, ...kept } = p;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  gzipSync(
    JSON.stringify({
      method: file.method,
      source: file.source,
      fetchedAt: file.fetchedAt,
      provenance: file.provenance,
      program: file.program,
      tolerance: file.tolerance,
      ...kept,
    }),
  ),
);
console.log(
  JSON.stringify({
    out,
    pool,
    stock: p.stock,
    accounts: p.accounts,
    quotes: p.quotes.length,
    withAJupiterQuote: p.quotes.filter((q) => q.jupiter).length,
    fetchedAt: file.fetchedAt,
  }),
);

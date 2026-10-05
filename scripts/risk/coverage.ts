import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Collection health: runs per hour, failures, RPC 429 retries, rows per pool tier, stale-tick-map events,
// and whether the old depth job (com.colosseum.depth-snapshot) is still writing. Prints JSON.
const HOME = join(homedir(), '.colosseum');
const risk = join(HOME, 'risk');
const readJsonl = (f: string) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

const runs = readJsonl(join(risk, 'runs.jsonl'));
const byHour = new Map<
  string,
  { runs: number; rows: number; failures: number; retries429: number }
>();
for (const r of runs) {
  const h = String(r.fetchedAt).slice(0, 13);
  const v = byHour.get(h) ?? { runs: 0, rows: 0, failures: 0, retries429: 0 };
  v.runs++;
  v.rows += Number(r.rows ?? 0);
  v.failures += Number(r.failures ?? 0);
  v.retries429 += Number((r.rpc as { retries429?: number })?.retries429 ?? 0);
  byHour.set(h, v);
}
const days = existsSync(join(risk, 'pools'))
  ? readdirSync(join(risk, 'pools')).filter((n) => n.endsWith('.jsonl'))
  : [];
const latestDay = days.sort().at(-1);
const rows = latestDay ? readJsonl(join(risk, 'pools', latestDay)) : [];
const pools = new Set(rows.map((r) => r.pool));
const invBad = rows.filter(
  (r) => typeof r.invariantRelErr === 'number' && (r.invariantRelErr as number) > 1e-9,
);
const events = readJsonl(join(risk, 'events.jsonl'));
const oldFile = join(HOME, 'depth', `${new Date().toISOString().slice(0, 10)}.jsonl`);
const oldAgeMin = existsSync(oldFile) ? (Date.now() - statSync(oldFile).mtimeMs) / 60_000 : null;
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      oldDepthJob: {
        file: oldFile,
        minutesSinceLastWrite: oldAgeMin === null ? null : Math.round(oldAgeMin),
        ok: oldAgeMin !== null && oldAgeMin < 20,
      },
      poolCollector: {
        runsTotal: runs.length,
        lastRun: runs.at(-1) ?? null,
        lastHours: [...byHour.entries()].slice(-6).map(([hour, v]) => ({ hour, ...v })),
        latestDay,
        rowsLatestDay: rows.length,
        poolsLatestDay: pools.size,
        rowsWithInvariantBreach: invBad.length,
        tickMapStaleEvents: events.filter((e) => e.kind === 'tick_map_stale').length,
      },
    },
    null,
    1,
  ),
);

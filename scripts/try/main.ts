import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intakeModelFromEnv } from '../../apps/api/src/llm';
import { type DataMode, type DataSource, dbSource, fixturesSource, type ShelfName } from './data';
import { toJson } from './json';
import { PromptFileError, parsePromptFile } from './prompt-file';
import { renderReport, summary } from './report';
import { type GoalRun, runGoal } from './run';

// `pnpm plan:try <file> [--data fixtures|db] [--shelf launch|extended] [--now ISO] [--no-open] [--json]`:
// the plan playground (try/README.md). Reads the goals of a prompt file, runs each through the real
// pipeline, writes one HTML report to try/out/ and opens it. With `--json`, prints one JSON document
// to stdout instead (scripts/try/json.ts): no page is written and nothing is opened. `--shelf` picks
// the fixture shelf: the launch shelf, or it with the fixed-income test tokens added.
//
// The model reads the goals only when ANTHROPIC_API_KEY is set in the environment of this process. No
// file is read for it (never .env), and the key is never printed.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const USAGE =
  'usage: pnpm plan:try <file.md> [--data fixtures|db] [--shelf launch|extended] [--now 2026-10-06T12:00:00Z] [--no-open] [--json]';

type Args = {
  file: string;
  data: DataMode;
  shelf: ShelfName;
  now: Date;
  open: boolean;
  json: boolean;
};

export function parseArgs(argv: string[], clock: () => Date = () => new Date()): Args {
  let file: string | null = null;
  let data: DataMode = 'fixtures';
  let shelf: ShelfName | null = null;
  let now: Date | null = null;
  let open = true;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') {
      const v = argv[++i];
      if (v !== 'fixtures' && v !== 'db') throw new Error(`--data is fixtures or db\n${USAGE}`);
      data = v;
    } else if (a === '--shelf') {
      const v = argv[++i];
      if (v !== 'launch' && v !== 'extended')
        throw new Error(`--shelf is launch or extended\n${USAGE}`);
      shelf = v;
    } else if (a === '--now') {
      const v = argv[++i] ?? '';
      const d = new Date(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(d.getTime()))
        throw new Error(`--now takes an ISO time, such as 2026-10-06T12:00:00Z\n${USAGE}`);
      now = d;
    } else if (a === '--no-open') open = false;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') throw new Error(USAGE);
    else if (a?.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (a && file === null) file = a;
    else throw new Error(`one prompt file at a time\n${USAGE}`);
  }
  if (!file) throw new Error(USAGE);
  // The database mode lists the mock chain's tokens: the fixture shelves are not read there.
  if (shelf !== null && data === 'db')
    throw new Error(`--shelf picks a fixture shelf, so it goes with --data fixtures\n${USAGE}`);
  return { file, data, shelf: shelf ?? 'launch', now: now ?? clock(), open, json };
}

const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = readFileSync(args.file, 'utf8');
  const goals = parsePromptFile(source, args.file);
  const model = intakeModelFromEnv({ ...process.env });
  const data: DataSource = args.data === 'db' ? dbSource() : fixturesSource(args.shelf);
  const runs: GoalRun[] = [];
  try {
    for (const goal of goals) runs.push(await runGoal(goal, { data, model, now: args.now }));
  } finally {
    await data.close();
  }
  const meta = {
    file: basename(args.file),
    mode: args.data,
    shelf: args.shelf,
    now: args.now.toISOString(),
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(toJson(runs, meta), null, 2)}\n`);
    return;
  }
  const html = renderReport(runs, meta);
  const outDir = join(ROOT, 'try/out');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(args.file, extname(args.file))}-${stamp(new Date())}.html`);
  writeFileSync(out, html);

  console.log(
    `Intake: ${model ? 'the model, where it answers (ANTHROPIC_API_KEY is set)' : 'the rules parser (no ANTHROPIC_API_KEY in the environment)'}`,
  );
  console.log(
    `Data: ${args.data}${args.data === 'fixtures' ? `, the ${args.shelf} shelf (every figure MOCK)` : ''}`,
  );
  for (const line of summary(runs)) console.log(line);
  console.log(`Report: ${relative(process.cwd(), out) || out}`);
  if (args.open && process.platform === 'darwin') execFile('open', [out]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    if (e instanceof PromptFileError || e instanceof Error) console.error(e.message);
    else console.error(e);
    process.exit(1);
  });
}

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersonalProposal } from '@colosseum/engine/personal';
import { ChainId } from '@colosseum/schemas';
import { fixturesSource, type ShelfName } from './data';
import { PromptFileError, parsePromptFile } from './prompt-file';
import { incomeOf } from './report';
import { type GoalRun, runGoal } from './run';

// `pnpm plan:compare <file.md>... --chain solana|robinhood [--now ISO]`: the same goals on the launch
// shelf and on the extended shelf, side by side, as Markdown on stdout. Every goal of the files is
// run on the one chain named, whatever its own `chain:` line says, so the two shelves of a chain are
// compared on the same goals. The rules parser reads the goals (no model), and every figure is a
// fixture: the page this prints into says MOCK. It is how docs/vault/research/yield-shelf/comparison.md
// is made; the same files, chain and `--now` give the same text.

const USAGE =
  'usage: pnpm plan:compare <file.md>... --chain solana|robinhood [--now 2026-10-06T12:00:00Z]';
const SHELVES: ShelfName[] = ['launch', 'extended'];

type Args = { files: string[]; chain: ChainId; now: Date };

export function parseCompareArgs(argv: string[], clock: () => Date = () => new Date()): Args {
  const files: string[] = [];
  let chain: ChainId | null = null;
  let now: Date | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chain') {
      const v = ChainId.safeParse(argv[++i]);
      if (!v.success) throw new Error(`--chain is one of ${ChainId.options.join(', ')}\n${USAGE}`);
      chain = v.data;
    } else if (a === '--now') {
      const v = argv[++i] ?? '';
      const d = new Date(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(d.getTime()))
        throw new Error(`--now takes an ISO time, such as 2026-10-06T12:00:00Z\n${USAGE}`);
      now = d;
    } else if (a?.startsWith('--')) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (a) files.push(a);
  }
  if (files.length === 0 || chain === null) throw new Error(USAGE);
  return { files, chain, now: now ?? clock() };
}

/** One goal on one shelf, with the class of each token there, to tell cash from the rest. */
export type ShelfRun = { run: GoalRun; cls: Record<string, string> };
/** One goal on both shelves. */
export type Compared = { title: string; file: string; launch: ShelfRun; extended: ShelfRun };

export async function compareGoals(
  files: { name: string; source: string }[],
  chain: ChainId,
  now: Date,
): Promise<Compared[]> {
  const out: Compared[] = [];
  for (const file of files) {
    for (const goal of parsePromptFile(file.source, file.name)) {
      const on = { ...goal, chain };
      const each = {} as Record<ShelfName, ShelfRun>;
      for (const shelf of SHELVES) {
        const data = fixturesSource(shelf);
        const listed = (await data.forChain(chain)).shelf.assets;
        each[shelf] = {
          run: await runGoal(on, { data, model: null, now }),
          cls: Object.fromEntries(listed.map((a) => [a.id, a.cls])),
        };
      }
      out.push({ title: goal.title, file: file.name, ...each });
    }
  }
  return out;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export const cashBps = (plan: PersonalProposal, cls: Record<string, string>): number =>
  plan.lines.reduce((n, l) => n + (cls[l.assetId] === 'cash' ? l.weightBps : 0), 0);

const linesOf = (plan: PersonalProposal, run: GoalRun): string =>
  plan.lines.map((l) => `${run.symbols[l.assetId] ?? l.assetId} ${pct(l.weightBps)}`).join(', ');

function incomeWord(plan: PersonalProposal): string {
  const inc = incomeOf(plan);
  if (!inc) return '';
  return inc.met ? `met (${usd(inc.targetUsd)} a month)` : `short by ${usd(inc.gapUsd)} a month`;
}

function row(name: string, shelf: ShelfName, plan: PersonalProposal, s: ShelfRun): string {
  const card = plan.scorecard;
  return `| ${[
    name,
    shelf,
    cell(linesOf(plan, s.run)),
    pct(cashBps(plan, s.cls)),
    card ? String(card.carryObservedBps) : '',
    card ? String(card.concentration.issuers) : '',
    card ? pct(card.concentration.largestIssuerBps) : '',
    card ? pct(card.creditBasisBps) : '',
    card ? pct(card.exit.measuredShareBps) : '',
    card?.monthsCovered == null ? '' : String(card.monthsCovered),
    incomeWord(plan),
  ].join(' | ')} |`;
}

/** What one shelf made of a goal, in a word: the candidates shown, the questions open, or the error. */
function made(s: ShelfRun): string {
  const r = s.run;
  if (r.error) return `no plan: ${r.error}`;
  if (!r.made) return `${r.open.length} question(s) open: ${r.open.map((q) => q.key).join(', ')}`;
  const hidden = r.made.notShown.map((n) => `${n.id} (${n.why})`).join('; ');
  return `${r.made.shown.map((c) => c.id).join(', ')}${hidden ? `; not shown: ${hidden}` : ''}`;
}

const same = (a: PersonalProposal | undefined, b: PersonalProposal | undefined) =>
  JSON.stringify(a?.lines.map((l) => [l.assetId, l.weightBps])) ===
  JSON.stringify(b?.lines.map((l) => [l.assetId, l.weightBps]));

/** The comparison as Markdown. A function of what was run: nothing here reads a clock. */
export function compareMarkdown(goals: Compared[], chain: ChainId, now: string): string {
  const out: string[] = [
    `Chain: ${chain}. Plans made at ${now}. Every figure is MOCK: it comes from the engine's fixtures, and none is live. "Carry" is the plan's observed carry in basis points after haircut, from the fixture yields; "Measured exit" is the share of the plan whose exit capacity is measured (the rest takes its tier ceiling, a labelled fallback).`,
    '',
  ];
  const cash: { title: string; launch: number; extended: number }[] = [];
  let unchanged = 0;
  for (const g of goals) {
    out.push(`#### ${g.title}`, '');
    out.push(`- Launch shelf: ${cell(made(g.launch))}`);
    out.push(`- Extended shelf: ${cell(made(g.extended))}`);
    const [a, b] = [g.launch.run, g.extended.run];
    const ids = ['cover', 'spread', 'carry'].filter(
      (id) => a.made?.shown.some((c) => c.id === id) || b.made?.shown.some((c) => c.id === id),
    );
    if (ids.length === 0) {
      out.push('');
      continue;
    }
    const plans = (r: GoalRun, id: string) => r.made?.shown.find((c) => c.id === id)?.plan;
    const changed = ids.filter((id) => !same(plans(a, id), plans(b, id)));
    if (changed.length === 0 && same(a.plain ?? undefined, b.plain ?? undefined)) unchanged += 1;
    out.push(`- Lines changed in: ${changed.length ? changed.join(', ') : 'none'}`, '');
    out.push(
      '| Candidate | Shelf | Lines | Cash | Carry (bps) | Issuers | Largest issuer | Credit and basis | Measured exit | Months covered | Income |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const id of ids)
      for (const shelf of SHELVES) {
        const plan = plans(g[shelf].run, id);
        out.push(
          plan
            ? row(id, shelf, plan, g[shelf])
            : `| ${id} | ${shelf} | not shown | | | | | | | | |`,
        );
      }
    out.push('');
    if (a.plain && b.plain)
      cash.push({
        title: g.title,
        launch: cashBps(a.plain, g.launch.cls),
        extended: cashBps(b.plain, g.extended.cls),
      });
  }
  if (cash.length) {
    const mean = (pick: (c: (typeof cash)[number]) => number) =>
      Math.round(cash.reduce((n, c) => n + pick(c), 0) / cash.length);
    out.push('#### Cash share of the plain plan, by goal', '');
    out.push('| Goal | Launch | Extended |', '|---|---|---|');
    for (const c of cash) out.push(`| ${cell(c.title)} | ${pct(c.launch)} | ${pct(c.extended)} |`);
    out.push(
      `| Mean of ${cash.length} goals | ${pct(mean((c) => c.launch))} | ${pct(mean((c) => c.extended))} |`,
    );
    out.push(
      '',
      `Goals with no line changed on any candidate: ${unchanged} of ${goals.length}.`,
      '',
    );
  }
  return out.join('\n');
}

async function main() {
  const args = parseCompareArgs(process.argv.slice(2));
  const files = args.files.map((f) => ({ name: basename(f), source: readFileSync(f, 'utf8') }));
  const goals = await compareGoals(files, args.chain, args.now);
  process.stdout.write(`${compareMarkdown(goals, args.chain, args.now.toISOString())}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    if (e instanceof PromptFileError || e instanceof Error) console.error(e.message);
    else console.error(e);
    process.exit(1);
  });
}

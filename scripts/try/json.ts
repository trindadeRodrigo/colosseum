import type { PersonalProposal } from '@colosseum/engine/personal';
import { DISCLAIMER, type Provenance } from '@colosseum/schemas';
import { WORDS } from '../../packages/engine/src/personal/templates';
import type { DataMode } from './data';
import { incomeOf, type ReportMeta } from './report';
import type { GoalRun } from './run';

// The playground's output for a program (`pnpm plan:try <file> --json`): what the HTML report shows,
// as one JSON document, for a chat session to read (.claude/skills/plan-chat). Like the report, it is a
// function of the runs, the file name, the mode and the time: the same file and `--now` give the same
// document. Every figure carries its plate: in fixtures mode all are MOCK.

/** The words a figure is plated with: MOCK, "MOCK · test network", or live. */
export function plateText(
  provenance: Provenance | 'fixture-mode',
): 'live' | 'MOCK' | 'MOCK · test network' {
  if (provenance === 'live') return 'live';
  if (provenance === 'sandbox') return 'MOCK · test network';
  return 'MOCK';
}

/** A plan's own plate: MOCK when any figure behind it is not live. */
function planPlate(plan: PersonalProposal, mode: DataMode) {
  if (mode === 'fixtures') return 'MOCK';
  const plates = plan.observations.map((o) => plateText(o.provenance));
  if (plates.includes('MOCK')) return 'MOCK';
  if (plates.includes('MOCK · test network')) return 'MOCK · test network';
  return 'live';
}

function planJson(plan: PersonalProposal, run: GoalRun, mode: DataMode) {
  return {
    plate: planPlate(plan, mode),
    lines: plan.lines.map((l) => ({
      assetId: l.assetId,
      symbol: run.symbols[l.assetId] ?? l.assetId,
      weightBps: l.weightBps,
      amountUsd: l.amountUsd,
      reasons: l.reasons.map((r) => r.text),
    })),
    leftOut: plan.removed.map((r) => ({ ref: r.ref, reasons: r.reasons.map((x) => x.text) })),
    card: plan.card,
    scorecard: plan.scorecard ?? null,
    status: plan.status ?? null,
    verdict: plan.verdict ?? null,
    income: incomeOf(plan),
    flags: plan.flags,
    observations: plan.observations.map((o) => ({
      ...o,
      plate: mode === 'fixtures' ? 'MOCK' : plateText(o.provenance),
    })),
  };
}

function goalJson(run: GoalRun, mode: DataMode) {
  const i = run.intake;
  const lang = run.plain?.sheet.language ?? i.draft.language ?? 'en';
  const nonNull = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  const carry = run.made?.shown.find((c) => c.id === 'carry');
  return {
    title: run.goal.title,
    chain: run.goal.chain,
    line: run.goal.line,
    text: run.goal.text,
    reader: run.reader,
    read: { draft: nonNull(i.draft), limits: nonNull(i.limits) },
    flags: i.flags,
    disagreements: i.disagreements,
    questions: run.open.map((q) => ({
      field: q.field,
      key: q.key,
      text: q.text,
      options: q.options ?? null,
      read: q.read ?? null,
    })),
    readBack: i.readBack,
    assumptions: i.assumptions,
    sheetWhole: i.sheet !== null,
    error: run.error,
    candidates: (run.made?.shown ?? []).map((c) => ({
      id: c.id,
      name: WORDS[lang].candidate[c.id] ?? c.id,
      ...planJson(c.plan, run, mode),
    })),
    notShown: (run.made?.notShown ?? []).map((n) => ({
      id: n.id,
      name: WORDS[lang].candidate[n.id] ?? n.id,
      why: n.why,
    })),
    plain: run.plain
      ? {
          sameAsCarry:
            carry !== undefined &&
            JSON.stringify(carry.plan.lines.map((l) => [l.assetId, l.weightBps])) ===
              JSON.stringify(run.plain.lines.map((l) => [l.assetId, l.weightBps])),
          ...planJson(run.plain, run, mode),
        }
      : null,
    sources: run.sources,
  };
}

/** The document for one run. The same runs and meta give the same document. */
export function toJson(runs: GoalRun[], meta: ReportMeta) {
  return {
    tool: 'plan-playground',
    file: meta.file,
    data: meta.mode,
    now: meta.now,
    plate:
      meta.mode === 'fixtures'
        ? 'MOCK: every figure comes from the engine fixtures, written by hand for tests. None is live.'
        : 'Figures from the local database; each keeps its own plate.',
    disclaimer: DISCLAIMER,
    goals: runs.map((r) => goalJson(r, meta.mode)),
  };
}

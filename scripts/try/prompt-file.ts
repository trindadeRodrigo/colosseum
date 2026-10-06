import { type HeldPosition, IntakeAnswers } from '@colosseum/engine/personal';
import { ChainId, type Obligation, type PlanSleeve } from '@colosseum/schemas';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// The plan playground's prompt file (try/README.md): Markdown, one goal per `## heading`. The body is
// the goal as a person would type it. An optional fenced block with the info string `yaml answers`
// holds answers to the intake's questions, by field, and an optional `chain: <id>` line names the
// chain of the wallet (Solana when left out). Everything before the first `##` is notes and is not
// read, and so are HTML comments.
//
// The answers are turned here into the intake's own `IntakeAnswers` (the shape the route's `answers`
// takes), plus two things the route gets from elsewhere: the chain of the wallet, and what the person
// already holds (`ComposeContext.holdings`). A few shorthands make them quicker to write by hand:
// `amount`, `income`, `horizon` ("10y", "18m" or months), `withdrawals` (a monthly amount over a run
// of months) and `sleeves` as a map of percentages (`goal: 50`, `ai: 50`).

export type PromptGoal = {
  /** The text of the `##` heading. */
  title: string;
  /** The line the heading is on, from 1. */
  line: number;
  /** The goal, as typed. */
  text: string;
  /** The chain of the wallet: the `chain:` line or `answers.chain`, else Solana. */
  chain: ChainId;
  /** The answers, held to the intake's schema. Empty when the goal has none. */
  answers: IntakeAnswers;
  /** What the person already holds, in dollars. */
  holdings: HeldPosition[];
  /** The answers block as written, for the report. Empty when the goal has none. */
  answersText: string;
  /**
   * A model's reply to the goal, pasted in a ```json reply <who>``` block: what a model read when it
   * was run outside this tool (in a chat, say). It goes through the same checks as a reply from the
   * API, and the report says who wrote it.
   */
  reply?: { value: unknown; by: string };
};

export class PromptFileError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'PromptFileError';
    this.problems = problems;
  }
}

/** The answer keys a file may use, each with the intake field it fills. */
const ALIASES: Record<string, keyof IntakeAnswers> = {
  amount: 'amountUsd',
  amountUsd: 'amountUsd',
  income: 'incomeTargetUsdMonthly',
  incomeTargetUsdMonthly: 'incomeTargetUsdMonthly',
  horizon: 'horizonMonths',
  horizonMonths: 'horizonMonths',
  goal: 'goal',
  risk: 'risk',
  currency: 'currency',
  language: 'language',
  themes: 'themes',
  portfolios: 'themes',
  rules: 'rules',
  obligations: 'obligations',
  sleeves: 'sleeves',
  restoreSplit: 'restoreSplit',
  limits: 'limits',
  horizonOpen: 'horizonOpen',
};
/** Keys read here and not passed to the intake as they are. */
// `country` is still accepted, so older files run, and read by nothing (gate COUNTRY-REMOVED, Oct 6).
const OWN_KEYS = ['chain', 'country', 'holdings', 'withdrawals'] as const;
export const ANSWER_KEYS = [...Object.keys(ALIASES), ...OWN_KEYS].sort();

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is written YYYY-MM');
const Withdrawals = z
  .object({
    monthly: z.number().positive(),
    from: Month,
    months: z.number().int().min(1).max(480),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();
const Holding = z
  .object({
    asset: z.string().min(1).optional(),
    underlying: z.string().min(1).optional(),
    valueUsd: z.number().nonnegative(),
  })
  .strict()
  .refine((h) => h.asset !== undefined || h.underlying !== undefined, {
    message: 'a holding names an `asset` (solana:nvdax) or an `underlying` (NVDA)',
  });

/** "10y", "10 years", "18m", "18 months", "10 anos", "18 meses", or a number of months. */
export function monthsOf(value: unknown): number | string {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return String(value);
  const m = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(y|yr|yrs|years?|anos?|m|mo|months?|mes|meses)?$/);
  if (!m?.[1]) return value;
  const n = Number(m[1]);
  return m[2] && /^(y|yr|yrs|year|years|ano|anos)$/.test(m[2]) ? Math.round(n * 12) : n;
}

const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

/** `withdrawals: { monthly, from, months, currency? }`, one or a list, as dated obligations. */
function expandWithdrawals(value: unknown, currency: string, at: string, problems: string[]) {
  const list = Array.isArray(value) ? value : [value];
  const out: Obligation[] = [];
  for (const item of list) {
    const parsed = Withdrawals.safeParse(item);
    if (!parsed.success) {
      problems.push(
        `${at}: withdrawals: ${issues(parsed.error)} (write { monthly: 300, from: 2026-11, months: 24 })`,
      );
      continue;
    }
    const w = parsed.data;
    for (let i = 0; i < w.months; i++)
      out.push({
        month: addMonths(w.from, i),
        amount: w.monthly,
        currency: w.currency ?? currency,
      });
  }
  return out;
}

/** `sleeves` as a list (the sheet's own shape) or a map of percentages: goal, safe_yield, a theme. */
function sleevesOf(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.entries(value as Record<string, unknown>).map(
    ([name, pct]): PlanSleeve | unknown => {
      const shareBps = typeof pct === 'number' ? Math.round(pct * 100) : pct;
      if (name === 'goal' || name === 'safe_yield') return { kind: name, shareBps };
      return { kind: 'theme', shareBps, theme: name };
    },
  );
}

/** `holdings` as a list of { asset | underlying, valueUsd }, or a map: `NVDA: 3000`, `solana:spyx: 1000`. */
function holdingsOf(value: unknown, at: string, problems: string[]): HeldPosition[] {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([k, v]) =>
          k.includes(':') ? { asset: k, valueUsd: v } : { underlying: k, valueUsd: v },
        )
      : null;
  if (!list) {
    problems.push(
      `${at}: holdings: write a map (NVDA: 3000) or a list of { underlying, valueUsd }`,
    );
    return [];
  }
  const parsed = z.array(Holding).safeParse(list);
  if (!parsed.success) {
    problems.push(`${at}: holdings: ${issues(parsed.error)}`);
    return [];
  }
  return parsed.data as HeldPosition[];
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

const FENCE = /^(```+|~~~+)\s*(.*)$/;
/** Whether a fence line closes a block opened with `open`: same character, as long, nothing after. */
const closes = (m: RegExpMatchArray, open: string) =>
  (m[2] ?? '').trim() === '' && m[1]?.[0] === open[0] && (m[1]?.length ?? 0) >= open.length;
const CHAIN_LINE = /^chain:\s*(\S+)\s*$/i;

/** The goals of a prompt file. Throws `PromptFileError` naming every problem, by line. */
export function parsePromptFile(source: string, file = 'prompt file'): PromptGoal[] {
  const problems: string[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  type Section = { title: string; line: number; body: { n: number; text: string }[] };
  const sections: Section[] = [];
  let current: Section | null = null;
  let fence: string | null = null;
  for (const [i, text] of lines.entries()) {
    const f = text.match(FENCE);
    if (f?.[1]) {
      if (fence === null) fence = f[1];
      else if (closes(f, fence)) fence = null;
    }
    const heading = fence === null ? text.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (heading?.[1] && !text.startsWith('###')) {
      current = { title: heading[1], line: i + 1, body: [] };
      sections.push(current);
    } else if (current) current.body.push({ n: i + 1, text });
  }
  if (fence !== null) problems.push(`a fenced block is never closed (\`${fence}\`)`);
  if (sections.length === 0)
    problems.push('no goal found: start each goal with a line `## <a short name>`');

  const goals: PromptGoal[] = [];
  for (const s of sections) {
    const at = `line ${s.line} (## ${s.title})`;
    const textLines: string[] = [];
    let answersYaml: { n: number; lines: string[] } | null = null;
    let chainLine: string | null = null;
    let reply: { n: number; by: string; lines: string[] } | null = null;
    for (let k = 0; k < s.body.length; k++) {
      const row = s.body[k];
      if (!row) continue;
      const f = row.text.match(FENCE);
      if (f?.[1]) {
        const info = (f[2] ?? '').trim();
        const inner: string[] = [];
        let closed = false;
        for (k = k + 1; k < s.body.length; k++) {
          const r = s.body[k];
          if (!r) continue;
          const g = r.text.match(FENCE);
          if (g?.[1] && closes(g, f[1])) {
            closed = true;
            break;
          }
          inner.push(r.text);
        }
        if (!closed) continue; // said once above
        const replied = info.match(/^json\s+reply(?:\s+(\S+))?$/i);
        if (replied) {
          if (reply) problems.push(`line ${row.n}: a goal has one \`json reply\` block`);
          else reply = { n: row.n, by: replied[1] ?? 'unnamed', lines: inner };
          continue;
        }
        if (/^ya?ml\s+answers$/i.test(info)) {
          if (answersYaml) problems.push(`line ${row.n}: a goal has one \`yaml answers\` block`);
          else answersYaml = { n: row.n, lines: inner };
        } else
          problems.push(
            `line ${row.n}: only a \`\`\`yaml answers or a \`\`\`json reply block is read in a goal (this one is \`${info || 'no name'}\`)`,
          );
        continue;
      }
      const c = row.text.match(CHAIN_LINE);
      if (c?.[1]) {
        if (chainLine) problems.push(`line ${row.n}: a goal has one \`chain:\` line`);
        chainLine = c[1].toLowerCase();
        continue;
      }
      textLines.push(row.text);
    }
    const text = textLines
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length < 3) problems.push(`${at}: the goal has no text under its heading`);
    if (text.length > 2000) problems.push(`${at}: the goal is over 2,000 characters`);

    let raw: Record<string, unknown> = {};
    if (answersYaml) {
      try {
        const doc = parseYaml(answersYaml.lines.join('\n')) as unknown;
        if (doc === null || doc === undefined) raw = {};
        else if (typeof doc !== 'object' || Array.isArray(doc))
          problems.push(`line ${answersYaml.n}: the answers block is \`field: value\` lines`);
        else raw = doc as Record<string, unknown>;
      } catch (e) {
        problems.push(
          `line ${answersYaml.n}: the answers block is not valid YAML: ${(e as Error).message.split('\n')[0]}`,
        );
      }
    }
    const where = answersYaml ? `line ${answersYaml.n} (answers of ## ${s.title})` : at;

    const unknown = Object.keys(raw).filter((k) => !ANSWER_KEYS.includes(k));
    for (const k of unknown)
      problems.push(
        `${where}: \`${k}\` is not an answer field. The fields: ${ANSWER_KEYS.join(', ')}`,
      );

    // The chain: the line, or the answer; the two must agree.
    const answerChain = raw.chain === undefined ? null : String(raw.chain).toLowerCase();
    if (chainLine && answerChain && chainLine !== answerChain)
      problems.push(
        `${at}: the \`chain:\` line says ${chainLine} and the answers say ${answerChain}`,
      );
    const chainParsed = ChainId.safeParse(chainLine ?? answerChain ?? 'solana');
    if (!chainParsed.success)
      problems.push(
        `${at}: chain \`${chainLine ?? answerChain}\` is not one of ${ChainId.options.join(', ')}`,
      );

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const field = ALIASES[k];
      if (!field) continue;
      if (field in out) problems.push(`${where}: \`${k}\` answers ${field} a second time`);
      out[field] = field === 'horizonMonths' ? monthsOf(v) : field === 'sleeves' ? sleevesOf(v) : v;
    }
    if (typeof out.currency === 'string') out.currency = out.currency.toUpperCase();
    if (raw.withdrawals !== undefined) {
      if (out.obligations !== undefined)
        problems.push(`${where}: write \`withdrawals\` or \`obligations\`, not both`);
      else
        out.obligations = expandWithdrawals(
          raw.withdrawals,
          typeof out.currency === 'string' ? out.currency : 'USD',
          where,
          problems,
        );
    }
    const holdings = raw.holdings === undefined ? [] : holdingsOf(raw.holdings, where, problems);

    const answers = IntakeAnswers.safeParse(out);
    if (!answers.success)
      for (const i of answers.error.issues)
        problems.push(`${where}: ${i.path.join('.') || 'answers'}: ${i.message}`);

    let replyValue: { value: unknown; by: string } | undefined;
    if (reply) {
      try {
        replyValue = { value: JSON.parse(reply.lines.join('\n')) as unknown, by: reply.by };
      } catch (e) {
        problems.push(`line ${reply.n}: the json reply is not JSON (${(e as Error).message})`);
      }
    }
    goals.push({
      ...(replyValue ? { reply: replyValue } : {}),
      title: s.title,
      line: s.line,
      text,
      chain: chainParsed.success ? chainParsed.data : 'solana',
      answers: answers.success ? answers.data : {},
      holdings,
      answersText: answersYaml ? answersYaml.lines.join('\n').trim() : '',
    });
  }
  const titles = goals.map((g) => g.title);
  for (const [i, t] of titles.entries())
    if (titles.indexOf(t) !== i)
      problems.push(`line ${goals[i]?.line}: a second goal named "${t}"`);
  if (problems.length) throw new PromptFileError(file, problems);
  return goals;
}

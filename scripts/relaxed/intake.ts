import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// The model key: from the shell, else from the first env file that has it. The file is only loaded,
// never printed. From a worktree the main checkout's .env is the usual place.
if (!process.env.ANTHROPIC_API_KEY) {
  for (const f of [process.env.DOTENV_CONFIG_PATH, '.env', '../Colosseum/.env'].filter((x): x is string => Boolean(x))) {
    loadEnv({ path: resolve(f), quiet: true });
    if (process.env.ANTHROPIC_API_KEY) break;
  }
}

// The relaxed intake, as a terminal MVP (docs/vault/PROMPT-RELAXED-INTAKE.md, sections 2 to 5).
// The model reads the person's words with the whole shelf of one chain in front of it and answers a
// small JSON. Pure code then checks every id against the table, applies the equal split, and prints the
// read-back. The model never sets a weight and never states a figure: the only numbers printed are the
// weights the code computed. Model: Anthropic's, with ANTHROPIC_API_KEY (load it with
// DOTENV_CONFIG_PATH=<main checkout>/.env from a worktree). With no key, or with --recorded, the reply
// comes from scripts/relaxed/recorded.json, so the demo runs offline; --record saves live replies there.
//
//   pnpm tsx scripts/relaxed/intake.ts "I want to invest in Elon"
//   pnpm tsx scripts/relaxed/intake.ts --chain solana --recorded "metade em algo seguro, metade em Tesla"

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const chain = flag('--chain') ?? 'robinhood';
const useRecorded = has('--recorded');
const record = has('--record');
const chat = has('--chat');
const text = args.join(' ').trim();
if (!text && !chat) {
  console.error('usage: pnpm tsx scripts/relaxed/intake.ts [--chain robinhood|solana] [--recorded] [--record] "<what the person wants>"\n       pnpm tsx scripts/relaxed/intake.ts --chat [--chain robinhood|solana]');
  process.exit(2);
}

// ---------- 1. The tables the model reads: stocks, themes, yield shelf, of one chain ----------

type Row = { id: string; text: string; cls: string };
const root = process.cwd();
const stocks = JSON.parse(readFileSync(join(root, `content/stocks/${chain}.json`), 'utf8')).stocks as {
  symbol: string; company: string; kind: string; sector: string | null; industry: string | null;
  keywords: string[]; tracks: string | null; sets: string[];
}[];
const themeDir = join(root, `content/themes/${chain}`);
const themes = readdirSync(themeDir).filter((f) => f.endsWith('.json')).map((f) =>
  JSON.parse(readFileSync(join(themeDir, f), 'utf8')) as { slug: string; name: { en: string }; members: { symbol: string }[] },
);
const themesOf = (symbol: string) => themes.filter((t) => t.members.some((m) => m.symbol === symbol)).map((t) => t.slug);
const yieldShelf = JSON.parse(
  readFileSync(join(root, `packages/engine/src/personal/fixtures/shelves/${chain}-yield.json`), 'utf8'),
).rows as { asset: { symbol: string; cls: string; underlying: string; issuer: string; tier: string } }[];

// A fund is classed by what it tracks: Treasury bills are dollar yield, bullion is gold or a commodity,
// an index is an etf. The engine's registry does the same by class (registry.ts, SLEEVE_OF_CLASS).
const fundClass = (tracks: string | null) => {
  const t = (tracks ?? '').toLowerCase();
  if (/treasury|t-bill|bills?\b|bond/.test(t)) return 'dollar_yield';
  if (/gold/.test(t)) return 'gold';
  if (/silver|oil|crude|commodit/.test(t)) return 'commodity';
  return 'etf';
};
const rows: Row[] = [
  ...stocks.filter((s) => s.sets.includes('shelf') || s.sets.includes('universe') || s.sets.includes('cut')).map((s) => ({
    id: `${chain}:${s.symbol}`,
    cls: s.kind === 'fund' ? fundClass(s.tracks) : 'stock',
    text: [
      `${chain}:${s.symbol}`, s.company, s.kind === 'fund' ? `${fundClass(s.tracks)} fund tracking ${s.tracks ?? '?'}` : `stock | ${s.sector ?? ''} / ${s.industry ?? ''}`,
      `keywords: ${s.keywords.join(', ')}`, themesOf(s.symbol).length ? `themes: ${themesOf(s.symbol).join(', ')}` : '',
    ].filter(Boolean).join(' | '),
  })),
  ...yieldShelf.map((r) => ({
    id: `${chain}:${r.asset.symbol}`,
    cls: r.asset.cls,
    text: `${chain}:${r.asset.symbol} | ${r.asset.cls} | ${r.asset.underlying} by ${r.asset.issuer} | tier ${r.asset.tier}`,
  })),
].sort((a, b) => a.id.localeCompare(b.id));
const ids = new Set(rows.map((r) => r.id));
const clsOf = new Map(rows.map((r) => [r.id, r.cls]));
const shelfText = rows.map((r) => r.text).join('\n');

// ---------- 2. The relaxed prompt (section 4) ----------

const SYSTEM = `You help a person turn what they want into a list of holdings from one table. You see the whole table below.

Read what the person wrote. Work out what they mean, including people, companies, themes and nicknames. A person named means the companies they are known for. A theme means the holdings on the table that belong to it.

Then write one JSON object:
  understood: one sentence in the person's language saying what you understood.
  shape: "pick" unless the words call for another (for every shape, still fill \`lines\` with what fits: yield rows and Treasury funds for "protect" and "income", growth holdings for "grow"; the plan rules are applied after you): "grow" when they want the money to grow over time, "income" when they want to live off it or want monthly money, "protect" when they want to keep it safe, "split" when they want part safe and part risky or state two shares.
  lines: holdings from the table, each {id, why}. \`why\` is one short clause, in the person's language, on what the company does and why it fits what they said; never just the theme's name. Only ids that appear in the table. If a thing they named is not on the table, do not pick a stand-in; put it in not_available with one line on why.
  buckets: only for "split": each {name, share, lines}. Shares as stated, else equal.
  stated: only what the person actually said, across the whole conversation: amount (a number), currency (a code such as USD or BRL), when (their words for when they need the money or how long they will invest), monthly (a number, the income they want each month), weights (their words), and risk as "low" | "medium" | "high" when they used a risk word (conservative, safe, careful = low; aggressive, high risk = high). Leave out anything they did not say. Never guess a number.
  not_available: names you understood but could not place on the table.
  questions: what you still need before the plan can be built, asked as one or two friendly sentences in the person's language, never more than two things per turn. Every plan needs the amount. A "grow" plan also needs when they will need the money. An "income" plan also needs the income they want each month. A "protect" plan also needs when they might need the money. A "split" plan needs the amount and the two shares if not stated. Keep picking lines while you ask. When nothing is missing, questions is an empty list. Never ask what is already in stated, and never ask about risk, themes or assets you can decide yourself.

Rules:
- Never state a yield, price, return or any figure that is not on the table row you are quoting.
- Never choose weights. Equal split is applied after you, unless \`stated\` holds a preference.
- Answer in the person's language. Keep \`understood\` to one sentence.
- Output only the JSON.
- If the person answers a read-back with a correction, write the whole JSON again with the correction applied. If they only agree, write it again unchanged.

Today is ${new Date().toISOString().slice(0, 10)}.

TABLE
${shelfText}`;

// ---------- 3. The reply, checked by zod; ids checked against the table ----------

const Line = z.object({ id: z.string(), why: z.string() });
const Reply = z.object({
  understood: z.string().min(1),
  shape: z.enum(['pick', 'grow', 'income', 'protect', 'split']),
  lines: z.array(Line).nullish().transform((v) => v ?? []),
  buckets: z
    .array(z.object({ name: z.string(), share: z.number().min(0).max(1).nullish(), lines: z.array(Line).nullish().transform((v) => v ?? []) }))
    .nullish()
    .transform((v) => v ?? undefined),
  stated: z
    .object({
      amount: z.number().positive().nullish(),
      currency: z.string().nullish(),
      when: z.union([z.string(), z.number()]).nullish(),
      monthly: z.number().positive().nullish(),
      weights: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
      risk: z.enum(['low', 'medium', 'high']).nullish(),
    })
    .passthrough()
    .nullish()
    .transform((v) => v ?? {}),
  not_available: z
    .array(z.union([z.string(), z.object({ name: z.string(), why: z.string().nullish() })]))
    .nullish()
    .transform((v) => v ?? []),
  question: z.string().nullish(),
  questions: z.array(z.string()).nullish().transform((v) => v ?? []),
});
type Reply = z.infer<typeof Reply>;

const recordedPath = join(root, 'scripts/relaxed/recorded.json');
const recorded = (() => { try { return JSON.parse(readFileSync(recordedPath, 'utf8')) as Record<string, unknown>; } catch { return {}; } })();
const key = `${chain}|${text}`;

type Turn = { role: 'user' | 'assistant'; content: string };
async function ask(turns: Turn[]): Promise<{ reply: unknown; provenance: 'live' | 'recorded' | 'mock' }> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (useRecorded || !apiKey) {
    if (!(key in recorded)) {
      console.error(`no recorded reply for "${text}" on ${chain}, and ${apiKey ? '--recorded was asked' : 'ANTHROPIC_API_KEY is not set'}.`);
      process.exit(1);
    }
    return { reply: recorded[key], provenance: recorded.provenance === 'mock' ? 'mock' : 'recorded' };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.RELAXED_MODEL ?? 'claude-haiku-4-5',
      max_tokens: 1200,
      temperature: 0,
      system: SYSTEM,
      messages: turns,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) { console.error(`model call failed: ${res.status} ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  const body = (await res.json()) as { content: { type: string; text?: string }[] };
  const raw = body.content.map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const reply = JSON.parse(raw);
  if (record && turns.length === 1) {
    recorded[key] = reply;
    recorded.provenance = 'live-recorded';
    writeFileSync(recordedPath, JSON.stringify(recorded, null, 2) + '\n');
  }
  return { reply, provenance: 'live' };
}

// ---------- 4. Pure code after the model: id check, equal split, the exit cap placeholder ----------

const dropped: string[] = [];
const keep = (lines: { id: string; why: string }[]) =>
  lines.filter((l) => { if (ids.has(l.id)) return true; dropped.push(l.id); return false; });

const equalSplit = (n: number): number[] => {
  // Basis points, summing to 10,000 to the unit: the remainder goes to the first lines.
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
};
const leftOut: string[] = [];
const noStocks = <L extends { id: string }>(shape: string, lines: L[]): L[] =>
  shape === 'income' || shape === 'protect'
    ? lines.filter((l) => {
        const ok = !['stock', 'etf'].includes(clsOf.get(l.id) ?? '');
        if (!ok) leftOut.push(`${l.id} (${clsOf.get(l.id)}, no stock tokens in a plan to ${shape === 'protect' ? 'protect' : 'pay income'})`);
        return ok;
      })
    : lines;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

const REQUIRED: Record<Reply['shape'], (keyof Reply['stated'])[]> = {
  pick: ['amount'],
  grow: ['amount', 'when'],
  income: ['amount', 'monthly'],
  protect: ['amount', 'when'],
  split: ['amount'],
};
const SAID: Record<string, string> = { amount: 'the amount', when: 'when you need the money', monthly: 'the income you want each month' };

type Plan = {
  shape: Reply['shape'];
  understood: string;
  buckets: { name: string; shareBps: number; lines: { id: string; cls: string; weightBps: number; why: string }[] }[];
  stated: Reply['stated'];
  notAvailable: Reply['not_available'];
  leftOut: string[];
  assumptions: string[];
  missing: string[];
  questions: string[];
};

function render(rawReply: unknown, provenance: 'live' | 'recorded' | 'mock'): Plan | null {
  const parsed = Reply.safeParse(rawReply);
  if (!parsed.success) {
    console.error('the model\'s reply did not fit the sheet:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    console.error(JSON.stringify(rawReply, null, 2));
    return null;
  }
  const r: Reply = parsed.data;
  const assumptions: string[] = [];
  dropped.length = 0;
  leftOut.length = 0;

  const plate = provenance === 'live' ? 'LIVE' : provenance === 'recorded' ? 'RECORDED from a live run' : 'MOCK · reply written by hand, not by a model';
  console.log(`\n[${plate} · ${chain} · shape: ${r.shape}]\n`);
  console.log(r.understood, '\n');

  const buckets: Plan['buckets'] = [];
  function bucket(title: string | null, shareBps: number, lines: { id: string; why: string }[], shape: string) {
    const kept = noStocks(shape, keep(lines));
    if (title) console.log(`— ${title}`);
    const weights = kept.length ? equalSplit(kept.length) : [];
    const out = kept.map((l, i) => ({ id: l.id, cls: clsOf.get(l.id) ?? '', weightBps: weights[i] ?? 0, why: l.why }));
    if (out.length === 0) console.log('  (no line yet)');
    for (const l of out) console.log(`  ${pct(l.weightBps).padStart(7)}  ${l.id.padEnd(22)} ${l.cls.padEnd(13)} ${l.why}`);
    buckets.push({ name: title ?? r.shape, shareBps, lines: out });
  }

  if (r.shape === 'split' && r.buckets?.length) {
    const n = r.buckets.length;
    const allShares = r.buckets.every((b) => b.share != null);
    const shares = allShares ? r.buckets.map((b) => Math.round((b.share as number) * 10_000)) : equalSplit(n);
    assumptions.push(allShares ? 'two pots, shares as you said' : 'two pots, equal shares (none stated)');
    r.buckets.forEach((b, i) => bucket(`${b.name} · ${pct(shares[i] ?? 0)} of the money · one vault`, shares[i] ?? 0, b.lines, 'pick'));
  } else {
    bucket(null, 10_000, r.lines, r.shape);
    if (r.shape === 'pick') assumptions.push(r.stated.weights ? `weights as you said: ${String(r.stated.weights)}` : 'equal split (no weights stated)');
    else {
      assumptions.push(`a plan to ${r.shape === 'grow' ? 'grow' : r.shape === 'income' ? 'pay income' : 'protect'}: these lines start it; the solver sizes them on the parameter table`);
      if (r.stated.risk) assumptions.push(`risk ${r.stated.risk} (you said so)`);
      else assumptions.push(r.shape === 'protect' ? 'risk low (a plan to protect)' : 'risk medium (not stated)');
    }
  }
  if (r.not_available.length) {
    console.log('\nNot available here:');
    for (const n of r.not_available) console.log(`  · ${typeof n === 'string' ? n : `${n.name}${n.why ? ` (${n.why})` : ''}`}`);
  }
  if (dropped.length) console.log(`\nDropped, not on the table: ${dropped.join(', ')}`);
  if (leftOut.length) { console.log('\nLeft out by the plan rules:'); for (const l of leftOut) console.log(`  · ${l}`); }

  const said = Object.entries(r.stated).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  if (said.length) console.log(`\nYou said: ${said.join(' · ')}`);
  console.log('\nAssumed:'); for (const a of assumptions) console.log(`  · ${a}`);

  const missing = REQUIRED[r.shape].filter((k) => r.stated[k] == null || r.stated[k] === '');
  const questions = [...r.questions, ...(r.question ? [r.question] : [])];
  if (questions.length) console.log(`\n${questions.join(' ')}\n`);
  else if (missing.length) console.log(`\nBefore this can be built I still need ${missing.map((m) => SAID[m] ?? m).join(' and ')}.\n`);
  else console.log('\nIs that right? (yes / tell me what to change)\n');

  return { shape: r.shape, understood: r.understood, buckets, stated: r.stated, notAvailable: r.not_available, leftOut: [...leftOut], assumptions, missing, questions };
}

const YES = /^(y|yes|yep|ok|sure|right|correct|sim|isso|certo|pode|ok[ae]y?)[.! ]*$/i;

if (!chat) {
  const { reply, provenance } = await ask([{ role: 'user', content: text }]);
  if (!render(reply, provenance)) process.exit(1);
} else {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error('chat needs a model: no ANTHROPIC_API_KEY in the shell, in ./.env or in ../Colosseum/.env. Add the line ANTHROPIC_API_KEY=<key> to ~/Documents/Colosseum/.env, or run: export ANTHROPIC_API_KEY=<key>');
    process.exit(1);
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const turns: Turn[] = [];
  console.log(`\nTenonfi · relaxed intake · ${chain} · ${rows.length} assets on the table. Say what you want; "yes" confirms; empty line quits.\n`);
  let last: Plan | null = null;
  let line = text || (await rl.question('you > ')).trim();
  while (line) {
    if (last && YES.test(line)) {
      if (last.questions.length === 0 && last.missing.length === 0) {
        const payload = { shape: last.shape, understood: last.understood, stated: last.stated, buckets: last.buckets, assumptions: last.assumptions, leftOut: last.leftOut };
        console.log(`\nConfirmed. This is what would go to POST /v1/baskets/personalize, one call per vault:\n${JSON.stringify(payload, null, 2)}\n`);
        break;
      }
      if (last.questions.length === 0) {
        console.log(`\nNot yet: I still need ${last.missing.map((m) => SAID[m] ?? m).join(' and ')}.\n`);
        line = (await rl.question('you > ')).trim();
        continue;
      }
    }
    turns.push({ role: 'user', content: line });
    const { reply, provenance } = await ask(turns);
    turns.push({ role: 'assistant', content: JSON.stringify(reply) });
    last = render(reply, provenance);
    line = (await rl.question('you > ')).trim();
  }
  rl.close();
}

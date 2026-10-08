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

const rows: Row[] = [
  ...stocks.filter((s) => s.sets.includes('shelf') || s.sets.includes('universe') || s.sets.includes('cut')).map((s) => ({
    id: `${chain}:${s.symbol}`,
    cls: s.kind === 'fund' ? 'etf' : 'stock',
    text: [
      `${chain}:${s.symbol}`, s.company, s.kind === 'fund' ? `fund tracking ${s.tracks ?? '?'}` : `${s.sector ?? ''} / ${s.industry ?? ''}`,
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
  shape: "pick" unless the words call for another: "grow" when they want the money to grow over time, "income" when they want to live off it or want monthly money, "protect" when they want to keep it safe, "split" when they want part safe and part risky or state two shares.
  lines: holdings from the table, each {id, why}. \`why\` is one short clause, in the person's language, on what the company does and why it fits what they said; never just the theme's name. Only ids that appear in the table. If a thing they named is not on the table, do not pick a stand-in; put it in not_available with one line on why.
  buckets: only for "split": each {name, share, lines}. Shares as stated, else equal.
  stated: only what the person actually said, in their own numbers: amount, currency, preferred weights, horizon, risk words. Leave out anything they did not say.
  not_available: names you understood but could not place on the table.
  question: at most one, only when you cannot pick without it. Prefer an assumption you state in \`understood\` over a question.

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
  stated: z.record(z.string(), z.unknown()).nullish().transform((v) => v ?? {}),
  not_available: z
    .array(z.union([z.string(), z.object({ name: z.string(), why: z.string().nullish() })]))
    .nullish()
    .transform((v) => v ?? []),
  question: z.string().nullish(),
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
const noStocks = <L extends { id: string }>(shape: string, lines: L[]): L[] =>
  shape === 'income' || shape === 'protect' ? lines.filter((l) => !['stock', 'etf'].includes(clsOf.get(l.id) ?? '')) : lines;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

function render(rawReply: unknown, provenance: 'live' | 'recorded' | 'mock'): Reply | null {
  const parsed = Reply.safeParse(rawReply);
  if (!parsed.success) {
    console.error('the model\'s reply did not fit the sheet:', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    console.error(JSON.stringify(rawReply, null, 2));
    return null;
  }
  const r: Reply = parsed.data;
  const assumptions: string[] = [];
  dropped.length = 0;

  const plate = provenance === 'live' ? 'LIVE' : provenance === 'recorded' ? 'RECORDED from a live run' : 'MOCK · reply written by hand, not by a model';
  console.log(`\n[${plate} · ${chain} · shape: ${r.shape}]\n`);
  console.log(r.understood, '\n');

  function printBucket(title: string | null, lines: { id: string; why: string }[], shape: string) {
    const kept = noStocks(shape, keep(lines));
    if (kept.length !== lines.length && (shape === 'income' || shape === 'protect')) assumptions.push(`${shape}: stock tokens left out (gate PROTECT-NO-STOCKS)`);
    if (title) console.log(`— ${title}`);
    if (kept.length === 0) { console.log('  (no line yet)'); return; }
    const weights = equalSplit(kept.length);
    kept.forEach((l, i) => console.log(`  ${pct(weights[i] ?? 0).padStart(7)}  ${l.id.padEnd(26)} ${l.why}`));
  }

  if (r.shape === 'split' && r.buckets?.length) {
    const n = r.buckets.length;
    const shares = r.buckets.every((b) => b.share != null) ? r.buckets.map((b) => Math.round((b.share as number) * 10_000)) : equalSplit(n);
    assumptions.push(r.buckets.every((b) => b.share != null) ? 'two pots, shares as you said' : 'two pots, equal shares (none stated)');
    r.buckets.forEach((b, i) => printBucket(`${b.name} · ${pct(shares[i] ?? 0)} of the money · one vault`, b.lines, 'pick'));
  } else {
    printBucket(null, r.lines, r.shape);
    if (r.shape === 'pick') assumptions.push('equal split (no weights stated)');
    else {
      assumptions.push(`${r.shape} plan: the solver runs on the parameter table`);
      if (!('risk' in r.stated)) assumptions.push('risk medium (not stated)');
      if (!('horizon' in r.stated)) assumptions.push('no date set (none stated)');
    }
  }
  if (r.not_available.length) {
    console.log('\nNot available here:');
    for (const n of r.not_available) console.log(`  · ${typeof n === 'string' ? n : `${n.name}${n.why ? ` (${n.why})` : ''}`}`);
  }
  if (dropped.length) console.log(`\nDropped, not on the table: ${dropped.join(', ')}`);
  if (Object.keys(r.stated).length) console.log('\nYou said:', JSON.stringify(r.stated));
  console.log('\nAssumed:'); for (const a of assumptions) console.log(`  · ${a}`);
  console.log(`\n${r.question ? `Question: ${r.question}` : 'Is that right? (yes / tell me what to change)'}\n`);
  return r;
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
  let last: Reply | null = null;
  let line = text || (await rl.question('you > ')).trim();
  while (line) {
    if (last && YES.test(line)) {
      console.log(`\nConfirmed. This is what would go to POST /v1/baskets/personalize:\n${JSON.stringify(last, null, 2)}\n`);
      break;
    }
    turns.push({ role: 'user', content: line });
    const { reply, provenance } = await ask(turns);
    turns.push({ role: 'assistant', content: JSON.stringify(reply) });
    last = render(reply, provenance);
    line = (await rl.question('you > ')).trim();
  }
  rl.close();
}

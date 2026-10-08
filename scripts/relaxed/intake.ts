import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  buildShelf,
  confirmedProposal,
  formatPlan,
  LIMITS,
  type Plan,
  Reply,
  render,
  type Seed,
  type Shelf,
  type Stock,
  type Theme,
  validateMessages,
  type YieldRow,
} from './core';

// Standalone terminal experiment. Importing this module does not read files, environment, or call a
// provider. Offline flags are parsed first. Credentials are read only from the explicitly set shell.
export function parseArgs(input: string[]) {
  const args = [...input];
  const take = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    args.splice(index, 2);
    return value;
  };
  const has = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  };
  const chain = take('--chain') ?? 'robinhood';
  if (chain !== 'robinhood' && chain !== 'solana')
    throw new Error('chain must be robinhood or solana');
  const recorded = has('--recorded');
  const record = has('--record');
  const chat = has('--chat');
  if (recorded && (record || chat))
    throw new Error('--recorded cannot be combined with --record or --chat');
  if (args.some((a) => a.startsWith('--'))) throw new Error('unknown flag');
  const text = args.join(' ').trim();
  if (!text && !chat)
    throw new Error(
      'usage: intake.ts [--chain robinhood|solana] [--recorded | --record] [--chat] "person text"',
    );
  return { chain, recorded, record, chat, text };
}
export function loadShelf(root: string, chain: string): Shelf {
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const themes = readdirSync(join(root, `content/themes/${chain}`))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => read(`content/themes/${chain}/${f}`) as Theme);
  return buildShelf(
    chain,
    read('docs/vault/research/open-questions/launch-shelf.seed.json') as Seed,
    read(`content/stocks/${chain}.json`).stocks as Stock[],
    themes,
    read(`packages/engine/src/personal/fixtures/shelves/${chain}-yield.json`).rows as YieldRow[],
  );
}
export function systemPrompt(shelf: Shelf, today: string): string {
  return `You help a person discuss a non-executable allocation proposal from a static fixture table on one chain. Respond naturally in their language. Admiration alone ("I like Elon") is discussion, not an allocation instruction: ask what they would like to do; choose no holdings. Explicit investment instructions can pick named holdings. Do not replace unavailable requests with alternatives.
Use exact catalog IDs. No yields, returns, prices, guarantees or numeric financial observations are supplied. Never invent these. Numbers in prose may only repeat the person's own money or preferences. Never choose weights: code uses equal weights only where no preference is stated. Preserve explicit percentages verbatim in stated.weights, or in each bucket.weights. Ranges, floors, partial or unsupported preferences remain unresolved; never replace them with equal weights.
Goals: pick, grow, income, protect, split, discussion. Income only holds dollar_yield/cash. Protect only holds dollar_yield/gold/cash. Split pots each require an explicit goal (pick/grow/income/protect); never rely on the pot name. Pot shares must be the person's explicit fractions totaling one. Do not guess money/currency/dates/monthly income. Ask at most two relevant missing things; never repeat answered questions. Currency conversion and compose are not implemented. This is proposal acknowledgment only, never an API request or order.
Return JSON with say, shape, lines [{id,why}], buckets [{name,goal,share,weights,lines}] or null, stated {amount,currency,when,monthly,weights,risk}, not_available [{name,why}], question or null, questions, open (amount/currency/when/monthly/shares/intent). All optional/unused fields are null or empty. Weights are verbatim text, not your numeric choices. Today: ${today}.
TABLE (fixture; live availability unverified)
${shelf.text}`;
}
type Turn = { role: 'user' | 'assistant'; content: string };
export function recordedReply(
  entry: unknown,
  fileProvenance: unknown,
): { raw: unknown; provenance: Plan['modelProvenance'] } {
  if (entry && typeof entry === 'object' && 'reply' in entry && 'provenance' in entry) {
    if (entry.provenance === 'mock') return { raw: entry.reply, provenance: 'mock' };
    if (entry.provenance === 'live-recorded' || entry.provenance === 'live')
      return { raw: entry.reply, provenance: 'recorded' };
    throw new Error('unknown recorded reply provenance');
  }
  return { raw: entry, provenance: fileProvenance === 'mock' ? 'mock' : 'recorded' };
}
// Keep provider output simple and closed: numeric maps are accepted by pure offline helpers only.
// Every field is present and nullable, matching the original provider structured-output contract.
const ProviderLine = z.strictObject({ id: z.string(), why: z.string() });
export const ProviderReply = z.strictObject({
  say: z.string(),
  shape: z.enum(['pick', 'grow', 'income', 'protect', 'split', 'discussion']),
  lines: z.array(ProviderLine),
  buckets: z
    .array(
      z.strictObject({
        name: z.string(),
        goal: z.enum(['pick', 'grow', 'income', 'protect']),
        share: z.number().nullable(),
        weights: z.string().nullable(),
        lines: z.array(ProviderLine),
      }),
    )
    .nullable(),
  stated: z.strictObject({
    amount: z.number().nullable(),
    currency: z.string().nullable(),
    when: z.string().nullable(),
    monthly: z.number().nullable(),
    weights: z.string().nullable(),
    risk: z.enum(['low', 'medium', 'high']).nullable(),
  }),
  not_available: z.array(z.strictObject({ name: z.string(), why: z.string().nullable() })),
  question: z.string().nullable(),
  questions: z.array(z.string()),
  open: z.array(z.enum(['amount', 'currency', 'when', 'monthly', 'shares', 'intent'])),
});
export async function main(input = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(input);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const shelf = loadShelf(root, options.chain);
  const recordedPath = join(root, 'scripts/relaxed/recorded.json');
  const recordings = JSON.parse(readFileSync(recordedPath, 'utf8')) as Record<string, unknown>;
  const offline = options.recorded || (!options.chat && !process.env.ANTHROPIC_API_KEY);
  const apiKey = offline ? undefined : process.env.ANTHROPIC_API_KEY?.trim();
  const model = offline ? undefined : process.env.RELAXED_MODEL?.trim();
  if (!offline && (!apiKey || !model))
    throw new Error(
      'live mode needs ANTHROPIC_API_KEY and RELAXED_MODEL explicitly in the shell; no env files are loaded',
    );
  if (options.record && offline)
    throw new Error('--record requires a live model configured in the shell');
  console.log(
    'Standalone CLI budget: at most 12 calls, 1200 output tokens per call, 20-second timeout. No production API quota or route is invoked.',
  );
  const userMessages: string[] = [];
  const turns: Turn[] = [];
  async function ask(text: string): Promise<{ raw: unknown; provenance: Plan['modelProvenance'] }> {
    userMessages.push(text);
    validateMessages(userMessages);
    turns.push({ role: 'user', content: text });
    if (offline) {
      const key = `${options.chain}|${text}`;
      if (!(key in recordings)) throw new Error('no recorded reply for this text and chain');
      return recordedReply(recordings[key], recordings.provenance);
    }
    const schema = z.toJSONSchema(ProviderReply);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey as string,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: LIMITS.outputTokens,
        system: systemPrompt(shelf, new Date().toISOString().slice(0, 10)),
        messages: turns,
        output_config: { format: { type: 'json_schema', schema } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const body = (await res.json()) as {
      stop_reason?: string;
      content: { type: string; text?: string }[];
    };
    if (body.stop_reason === 'refusal' || body.stop_reason === 'max_tokens')
      throw new Error(`model response stopped: ${body.stop_reason}`);
    const responseText = body.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    if (responseText.length > LIMITS.replyChars) throw new Error('reply too long');
    const raw: unknown = JSON.parse(responseText);
    return { raw, provenance: 'live' };
  }
  async function next(text: string): Promise<Plan> {
    const { raw, provenance } = await ask(text);
    const plan = render(raw, shelf, provenance, userMessages);
    turns.push({ role: 'assistant', content: JSON.stringify(Reply.parse(raw)) });
    if (options.record && userMessages.length === 1) {
      // Explicit opt-in only; private person text should never be recorded into repository fixtures.
      recordings[`${options.chain}|${text}`] = { reply: raw, provenance: 'live-recorded' };
      writeFileSync(recordedPath, `${JSON.stringify(recordings, null, 2)}\n`);
    }
    console.log(formatPlan(plan));
    return plan;
  }
  if (!options.chat) {
    await next(options.text);
    return;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `Tenonfi terminal experiment · ${options.chain} · fixture catalog · ${model}. Empty line quits.`,
    );
    let last: Plan | undefined;
    let personTurns = 0;
    let text = options.text || (await rl.question('you > ')).trim();
    while (text) {
      personTurns += 1;
      validateMessages([text]);
      if (last && /^(y|yes|yep|ok|sure|sim|isso|certo|pode)[.! ]*$/i.test(text)) {
        if (last.ready) {
          console.log(
            `Acknowledged non-executable proposal. This is not a /v1/baskets/personalize payload and nothing was submitted:\n${JSON.stringify(confirmedProposal(last), null, 2)}`,
          );
          break;
        }
        console.log(
          `Still open: ${last.missing.join('; ')}. Acknowledgment requires these to be resolved.`,
        );
      } else last = await next(text);
      if (personTurns >= LIMITS.turns) {
        console.log('Standalone conversation budget reached.');
        break;
      }
      text = (await rl.question('you > ')).trim();
    }
  } finally {
    rl.close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'intake failed');
    process.exitCode = 1;
  });
}

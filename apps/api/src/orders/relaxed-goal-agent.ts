import Anthropic from '@anthropic-ai/sdk';
import type { BasketAsset } from '@colosseum/schemas';
import {
  type VaultAgentSource as AgentSource,
  VaultAgentReply,
  VaultAgentRequest,
  type VaultAgentResult,
} from '@colosseum/schemas';
import { z } from 'zod';
import type { ModelQuota } from '../model-quota';
import { goalFit } from './mix';
import { ORDER_POLICY } from './prepare';
import { catalogCap, holdingConstraints } from './relaxed-limits';
import { project, type Reading, readingsOf, series } from './relaxed-projection';
import { type GoalAgentContext, requestedStocks, statedPurposeIn } from './vault-agent';

// The relaxed intake (gate RELAXED-INTAKE, from scripts/relaxed/intake.ts and RELAXED-1): the goal
// agent behind /goal whenever a model key is set (`relaxedGoalAgentFromEnv`). The model is free where
// it talks and constrained where it touches money: it reads intent against this chain's live catalog,
// says what it understood in its own words (the person's own numbers included) and names holdings by
// id. Code then keeps only ids on the catalog, holds every line to the rule `goal/accept` applies
// (`goalFit`: a stock in a plan to protect or pay income only when the person asked for it, as the
// server reads their words, and warned), splits equally or by the shares the person gave (applied
// exactly, the rest in cash and said), names any line above its cap in a warning on the plan, and
// cites the server's own sources. Never a weight from the model, never a source from it.

/** The `GOAL_AGENT` values: unset or `relaxed` is the relaxed intake; `model-led` opts out of it. */
export const GOAL_AGENT_RELAXED = 'relaxed';
export const GOAL_AGENT_MODEL_LED = 'model-led';

/**
 * The goal agent behind /goal from the environment: the relaxed intake whenever `ANTHROPIC_API_KEY` is
 * set, unless `GOAL_AGENT=model-led` asks for the model-led conversation (`replyToVaultConversation`)
 * instead. No key: null, and the route answers as it does with no model. Any other value stops the app,
 * so a misspelt opt-out is never silently ignored. `RELAXED_MODEL` names its model.
 */
export function relaxedGoalAgentFromEnv(
  env: Record<string, string | undefined>,
  quota: ModelQuota,
): RelaxedGoalAgent | null {
  const choice = env.GOAL_AGENT?.trim() || GOAL_AGENT_RELAXED;
  if (choice !== GOAL_AGENT_RELAXED && choice !== GOAL_AGENT_MODEL_LED)
    throw new Error(
      `GOAL_AGENT must be "${GOAL_AGENT_RELAXED}" (the default) or "${GOAL_AGENT_MODEL_LED}", not "${choice}".`,
    );
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (choice === GOAL_AGENT_MODEL_LED || !apiKey) return null;
  const model = env.RELAXED_MODEL?.trim();
  return createRelaxedGoalAgent({ apiKey, quota, ...(model ? { model } : {}) });
}

const SHAPES = ['pick', 'grow', 'income', 'protect', 'split'] as const;
type Shape = (typeof SHAPES)[number];
const POT_SHAPES = ['pick', 'grow', 'income', 'protect'] as const;

const nul = (t: object) => ({ anyOf: [t, { type: 'null' }] });
const LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'why', 'share'],
  properties: {
    id: { type: 'string' },
    why: { type: 'string' },
    share: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  },
};
const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'shape', 'lines', 'buckets', 'stated', 'not_available', 'open'],
  properties: {
    say: { type: 'string' },
    shape: { type: 'string', enum: [...SHAPES] },
    lines: { type: 'array', items: LINE },
    buckets: nul({
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'shape', 'share', 'lines'],
        properties: {
          name: { type: 'string' },
          shape: { type: 'string', enum: [...POT_SHAPES] },
          share: nul({ type: 'number' }),
          lines: { type: 'array', items: LINE },
        },
      },
    }),
    stated: {
      type: 'object',
      additionalProperties: false,
      required: [
        'amount',
        'currency',
        'when',
        'need_by',
        'monthly',
        'withdraw_months',
        'withdraw_start',
        'weights',
        'risk',
      ],
      properties: {
        amount: nul({ type: 'number' }),
        currency: nul({ type: 'string' }),
        when: nul({ type: 'string' }),
        monthly: nul({ type: 'number' }),
        weights: nul({ type: 'string' }),
        risk: nul({ type: 'string', enum: ['low', 'medium', 'high'] }),
        need_by: nul({ type: 'string' }),
        withdraw_months: nul({ type: 'number' }),
        withdraw_start: nul({ type: 'string' }),
      },
    },
    not_available: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'why'],
        properties: { name: { type: 'string' }, why: nul({ type: 'string' }) },
      },
    },
    open: {
      type: 'array',
      items: { type: 'string', enum: ['amount', 'when', 'monthly', 'shares'] },
    },
  },
} as const;

const Line = z.object({
  id: z.string(),
  why: z.string(),
  share: z.number().min(0).max(1).nullish(),
});
const Reply = z.object({
  say: z.string().trim().min(1),
  shape: z.enum(SHAPES),
  lines: z.array(Line).default([]),
  buckets: z
    .array(
      z.object({
        name: z.string(),
        shape: z.enum(POT_SHAPES).nullish(),
        share: z.number().min(0).max(1).nullish(),
        lines: z.array(Line).default([]),
      }),
    )
    .nullish(),
  stated: z
    .object({
      amount: z.number().positive().nullish(),
      currency: z.string().nullish(),
      when: z.string().nullish(),
      monthly: z.number().positive().nullish(),
      weights: z.string().nullish(),
      risk: z.enum(['low', 'medium', 'high']).nullish(),
      need_by: z.string().nullish(),
      withdraw_months: z.number().int().positive().nullish(),
      withdraw_start: z.string().nullish(),
    })
    .default({}),
  not_available: z.array(z.object({ name: z.string(), why: z.string().nullish() })).default([]),
  open: z.array(z.string()).default([]),
});
type Reply = z.infer<typeof Reply>;

const REQUIRED: Record<Shape, (keyof Reply['stated'])[]> = {
  pick: ['amount'],
  grow: ['amount', 'when'],
  income: ['amount', 'monthly'],
  protect: ['amount', 'when'],
  split: ['amount'],
};

function systemPrompt(table: string, language: 'en' | 'pt', today: string) {
  return `You are the planner at Tenonfi. A person tells you what they want to do with their money and you turn it into holdings from one table, the catalog of their chain, which you see in full below. You talk to them the way a sharp, warm friend who knows markets would: plainly, briefly, in their language, with real reasoning. You are not a form. Answer in ${language === 'pt' ? 'Portuguese' : 'English'} unless the person writes in another language.

What you are free to do: read intent, including people, companies, themes, nicknames and half-sentences; decide which holdings on the table fit and why; notice when something they named is not on the table and say so; ask what you genuinely need, in a natural sentence, one or two things at a time; keep the whole conversation in mind; change course when they do; explain, compare, and give your view of the shape of the plan. You may repeat the person's own numbers back to them.

Four rules, which the code after you also enforces:
1. You may only name holdings that appear on the table, by their exact id. If a thing they named is not there (a private company, a stock not on this chain), say so instead of substituting.
2. You never choose weights yourself. When the person gives a share for a pot or for a holding ("80% in yield", "all of the income part in syrupUSDC", "20% in big tech"), you pass it on as that pot's or that line's "share" (0 to 1, of the pot for a line, of the money for a pot) and the code applies it exactly. Lines with no share stated split equally. Each holding has a cap on the table: the most of the money the vault lets it hold today. A cap never stops you: if the person asks for more, pass their share on as asked; the code applies it and shows a warning that the vault would refuse that split until the cap is lifted. Mention it in one short sentence, no more.
3. You never compute or estimate a return, a projection, a price or how long money lasts, and you never promise a return. A yield may be named only as the table shows it, with its read date. The code computes every projection from the table's readings and prints it under your message as soon as the amount and the date or the monthly withdrawals are in the sheet; refer to it ("the projection below") instead of doing sums. A holding with no yield on the table earns nothing in that projection.
4. Nothing is built until the person confirms. Before that, you need: the amount for any plan; when they will need the money for a plan to grow or to protect; the monthly income they want for an income plan; the shares for a split, if not stated. Ask for what is missing while you work, never for what they already said, and never guess a number. Propose lines as soon as you know enough of the intent; the person sees the plan build beside the chat.

Shapes: "pick" for named things, equal split; "grow", "income" or "protect" when the words call for it; "split" when they want part of the money doing one thing and part another (for example a liquid reserve and a growth pot), one pot per bucket with its own shape (a bucket with no shape takes the plan's). A plan or pot to protect holds cash, dollar-yield rows and gold: no stock tokens, no crypto. A plan or pot to pay income holds cash and dollar-yield rows: no stock tokens, no crypto, no gold. The code holds to the asset registry on this and leaves out what does not fit. A stock token goes into a plan to protect or pay income only when the person plainly asked for that stock, or for stocks, in their own words; the code reads their words itself and warns them. Never add one on your own.

Direct instructions: when the person tells you what to hold or how to split ("make all the income part syrupUSDC", "put 80% in the highest yield"), do it in this turn. Do not ask permission and do not argue. A cap does not stop it: do exactly what they asked and add one short sentence that the vault caps that holding today, so this split would need the cap lifted to be bought. Only the rule on what a plan to protect or pay income may hold still applies: if that stops part of the instruction, do the closest version and say why in one sentence. Do not offer alternatives unless they ask. Ask at most one question per turn, and only for something rule 4 still needs, at the end of your message.

Every turn you answer with the JSON object the API holds you to:
- "say": the message the person reads. Your words, your reasoning, your questions. One short paragraph, or two when there is a lot to say. Mention holdings by name, not by id. Do not list weights; the code shows the lines beside your message.
- "shape", "lines" (for every shape but split), "buckets" (only for split, else null; a bucket's "share" is the pot's share of the money as 0 to 1, only when the person gave the number, else null). Each line has "id", "why" and "share": that holding's share of its pot (or of the plan when there are no pots) as 0 to 1, only when the person gave it ("all of it" is 1), else null.
- "stated": only what the person said, nothing guessed. "need_by" is the day they need the money, as YYYY-MM-DD, read from their words ("March 2027" is 2027-03-01; a term such as "for retirement in 30 years" or "in five years" is that many years from today; ask if it is unclear; null when they gave no term). "monthly" is a monthly withdrawal or income they want; "withdraw_months" how many months of it, when they said or it follows from their words (a three-month trip is 3); "withdraw_start" the day of the first withdrawal as YYYY-MM-DD, when they said it. Say back the dates you read so they can correct them.
- "not_available": things they named that are not on the table.
- "open": what rule 4 still needs for this shape; empty when the plan is ready to confirm.

Today is ${today}.

A holding's cap is the most of the money the vault lets it hold today. When you choose holdings yourself (no share stated), pick enough for each pot to stay within the caps. When the person states a share above a cap, follow them.

TABLE (id | symbol | what it is | class | tier | issuer | cap | yield | more)
${table}`;
}

function tableOf(
  assets: BasketAsset[],
  context: GoalAgentContext,
  caps: Map<string, number>,
  readings: Map<string, Reading>,
) {
  const stocks = new Map((context.stockAttributes?.stocks ?? []).map((row) => [row.symbol, row]));
  return assets
    .map((asset) => {
      const row = stocks.get(asset.symbol);
      return [
        asset.id,
        asset.symbol,
        asset.underlying,
        asset.cls,
        `tier ${asset.tier}`,
        asset.issuer,
        `cap ${pct(caps.get(asset.id) ?? 0)}`,
        yieldText(readings.get(asset.id)),
        row
          ? `${row.company} | ${row.kind} | ${[row.sector, row.industry].filter(Boolean).join(' / ')} | keywords: ${row.keywords.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' | ');
    })
    .join('\n');
}

const yieldText = (r: Reading | undefined) =>
  r
    ? `yield ${(r.rate * 100).toFixed(2)}% a year${r.haircut != null && r.quoted != null ? ` after haircut (quoted ${(r.quoted * 100).toFixed(2)}%)` : ''}, read ${r.fetchedAt.slice(0, 10)}${r.provenance === 'sandbox' ? ', mainnet reading on a test token' : r.provenance === 'live' ? '' : ', a sample reading, not live'}`
    : 'no yield reading';

/** person/app turns as alternating user/assistant messages, consecutive turns of one side joined. */
function turnsOf(messages: VaultAgentRequest['messages']) {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of messages) {
    const role = message.who === 'person' ? 'user' : 'assistant';
    const last = turns.at(-1);
    if (last?.role === role) last.content += `\n\n${message.text}`;
    else turns.push({ role, content: message.text });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns;
}

/** `whole` basis points over `n` equally, to the unit; the remainder goes to the first. */
const equalSplit = (whole: number, n: number) => {
  const base = Math.floor(whole / n);
  return Array.from({ length: n }, (_, i) => base + (i < whole - base * n ? 1 : 0));
};
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const pctOf = (fraction: number) => pct(Math.round(fraction * 10_000));

type Goal = 'grow' | 'income' | 'protect';
const goalOfShape = (shape: Shape | null | undefined): Goal | null =>
  shape === 'income' || shape === 'protect' ? shape : null;
const GOAL_WORDS: Record<Goal, string> = { grow: 'grow', income: 'pay income', protect: 'protect' };
const CLASS_WORDS: Record<BasketAsset['cls'], string> = {
  stock: 'stock tokens',
  etf: 'stock funds',
  crypto: 'crypto',
  gold: 'gold',
  commodity: 'commodities',
  dollar_yield: 'dollar yield',
  cash: 'cash',
};

/**
 * How `whole` basis points are shared (RELAXED-INTAKE, "applied exactly"; ANY-COMPOSITION, "never
 * silent"). `given` is each entry's stated share of the whole (0 to 1), null where none was stated.
 * - none stated: an equal split (`equal`);
 * - every entry stated and the shares come to the whole: each as given (`stated`);
 * - some stated: each stated share as given, the rest equally over the others (`mixed`); stated shares
 *   that take it all leave the others at nothing (`starved`, by index);
 * - shares above the whole: scaled to it (`scaled`);
 * - every entry stated and the shares come to less: each as given, and the rest is a `gap` the caller
 *   holds as cash and says (`gap`); with `gapAllowed` false (no cash token), scaled to the whole;
 * - every share zero: an equal split (`unusable`).
 * Within 10 basis points of the whole counts as the whole ("a third each"). Rounding goes to the first
 * entry, so the parts always add up to `whole` exactly with the gap.
 */
export function splitShares(
  given: readonly (number | null)[],
  whole: number,
  gapAllowed: boolean,
): {
  bps: number[];
  sum: number;
  kind: 'equal' | 'stated' | 'mixed' | 'scaled' | 'gap' | 'unusable';
  gap: number;
  starved: number[];
} {
  const n = given.length;
  const open = given.flatMap((g, i) => (g == null ? [i] : []));
  const sum = given.reduce<number>((a, g) => a + (g ?? 0), 0);
  if (n === 0) return { bps: [], sum, kind: 'equal', gap: 0, starved: [] };
  if (open.length === n || (open.length === 0 && sum <= 0))
    return {
      bps: equalSplit(whole, n),
      sum,
      kind: open.length === n ? 'equal' : 'unusable',
      gap: 0,
      starved: [],
    };
  const isWhole = Math.abs(sum - 1) <= 0.001;
  const over = sum > 1 && !isWhole;
  const short = open.length === 0 && sum < 1 && !isWhole;
  const scale = over || (short && !gapAllowed) || (isWhole && open.length === 0) ? 1 / sum : 1;
  const bps = given.map((g) => (g == null ? 0 : Math.round(g * scale * whole)));
  const placed = () => bps.reduce((a, b) => a + b, 0);
  let gap = 0;
  let starved: number[] = [];
  if (open.length) {
    const rest = Math.max(0, whole - placed());
    if (rest === 0) starved = open;
    else {
      const shares = equalSplit(rest, open.length);
      open.forEach((i, k) => {
        bps[i] = shares[k] ?? 0;
      });
    }
  } else if (short && gapAllowed) gap = whole - placed();
  const off = whole - placed() - gap;
  if (off !== 0) {
    const first = bps.findIndex((b) => b > 0);
    bps[first >= 0 ? first : 0] = (bps[first >= 0 ? first : 0] ?? 0) + off;
  }
  const kind =
    over || (short && !gapAllowed) ? 'scaled' : short ? 'gap' : open.length ? 'mixed' : 'stated';
  return { bps, sum, kind, gap, starved };
}

/** What a split did, in the person's words: every case but an equal split of one entry is said. */
function sayShares(
  split: ReturnType<typeof splitShares>,
  o: { where: string; of: string; open: string; cashName: string; starved?: string[] },
): string[] {
  const out: string[] = [];
  const came = `The shares you gave${o.where} came to ${pctOf(split.sum)}`;
  if (split.kind === 'equal' && split.bps.length > 1)
    out.push(`Equal split${o.where} until you say otherwise.`);
  if (split.kind === 'stated') out.push(`The shares you gave${o.where} are applied exactly.`);
  if (split.kind === 'mixed')
    out.push(
      `The shares you gave${o.where} are applied exactly; the rest is split equally over ${o.open}.`,
    );
  if (split.kind === 'scaled') out.push(`${came}; scaled to the whole.`);
  if (split.kind === 'gap')
    out.push(
      `${came}; they are applied exactly, and the other ${pctOf(1 - split.sum)} of ${o.of} is held in ${o.cashName} until you say where it goes.`,
    );
  if (split.kind === 'unusable') out.push(`${came}; split equally until you say otherwise.`);
  const starved = (o.starved ?? []).filter(Boolean);
  if (starved.length)
    out.push(
      `The shares you gave${o.where} take all of it, so ${starved.join(', ')} ${starved.length === 1 ? 'holds' : 'hold'} nothing in this draft.`,
    );
  return out;
}
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export type RelaxedGoalAgent = {
  id: string;
  reply(request: VaultAgentRequest, context: GoalAgentContext): Promise<VaultAgentResult>;
};

export function createRelaxedGoalAgent(options: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** The allowance of model calls shared with the other conversations; one is reserved before each call. */
  quota?: ModelQuota;
  log?: (msg: string, detail?: unknown) => void;
  /** The model call; tests pass a stub so no request leaves the machine. Default: the Anthropic API. */
  create?: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => Promise<Pick<Anthropic.Message, 'stop_reason' | 'content'>>;
}): RelaxedGoalAgent {
  const model = options.model ?? 'claude-sonnet-5-5';
  const log =
    options.log ?? ((msg, detail) => console.warn(`relaxed goal agent: ${msg}`, detail ?? ''));
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 0,
  });
  const create =
    options.create ??
    ((params: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(params));
  return {
    id: model,
    async reply(request, context) {
      const parsed = VaultAgentRequest.safeParse(request);
      if (!parsed.success) return { kind: 'failure', reason: 'invalid' };
      const { language, messages, messageId } = parsed.data;
      const assets = context.assets.filter((asset) => asset.chain === context.chain);
      const catalog = new Map(assets.map((asset) => [asset.id, asset]));
      const caps = new Map(
        assets.map((asset) => [
          asset.id,
          Math.min(catalogCap(asset), context.caps?.[asset.id] ?? catalogCap(asset)),
        ]),
      );
      const sourceById = new Map(context.evidence.map((source) => [source.id, source]));
      const readings = readingsOf(context.evidence, (id) => catalog.get(id)?.symbol ?? id);

      // ---- the model: talks freely, names ids ----
      // A paid call: reserved from the shared budget first, as the model-led conversation does.
      const denied = options.quota?.reserve(context.person) ?? null;
      if (denied !== null) return { kind: 'failure', reason: 'budget', detail: denied };
      let raw: unknown;
      try {
        const response = await create({
          model,
          max_tokens: 4000,
          system: systemPrompt(
            tableOf(assets, context, caps, readings),
            language,
            new Date().toISOString().slice(0, 10),
          ),
          messages: turnsOf(messages),
          output_config: {
            format: { type: 'json_schema', schema: REPLY_SCHEMA },
            effort: 'medium',
          },
        } as unknown as Anthropic.MessageCreateParamsNonStreaming);
        if (response.stop_reason !== 'end_turn') {
          log('model stopped early', response.stop_reason);
          return { kind: 'failure', reason: 'invalid' };
        }
        const block = response.content.find((item) => item.type === 'text');
        raw = block?.type === 'text' ? JSON.parse(block.text) : null;
      } catch (error) {
        log('model call failed', error instanceof Error ? error.message : error);
        return {
          kind: 'failure',
          reason: error instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : 'unavailable',
        };
      }
      const read = Reply.safeParse(raw);
      if (!read.success) {
        log('reply did not fit the sheet', read.error.issues);
        return { kind: 'failure', reason: 'invalid' };
      }
      const r = read.data;

      // ---- code: ids, eligibility, split, caps ----
      const notes: string[] = [];
      const dropped: string[] = [];
      // The goal the server read in the person's own words (DEPOSIT-STEP): `goal/accept` checks the
      // whole plan against it, so the preview does too, with the same rule (`goalFit`). The model's
      // shape counts as well where it is to protect or pay income, for the plan and for each pot. A
      // stock outside the goal stays only when the person asked for it themselves, as the server reads
      // their words (ANY-COMPOSITION), and is then warned; any other class outside it is left out.
      const serverGoal = statedPurposeIn(messages, context).goal;
      const companies = new Map<string, string[]>();
      for (const row of context.stockAttributes?.stocks ?? [])
        for (const asset of assets)
          if (asset.symbol === row.symbol) companies.set(asset.id, [row.company]);
      const requested = requestedStocks(messages, language, assets, companies);
      const planGoal = goalOfShape(r.shape);
      const askedOutside = new Map<string, Goal>();
      const pots: {
        name: string;
        shape: Shape;
        given: number | null;
        lines: { asset: BasketAsset; why: string; share: number | null }[];
      }[] = [];
      // An id as the model wrote it, matched to the catalog: exactly, then ignoring case, then by the
      // token's symbol or the company it tracks (Haiku writes `solana:NVDAx` for `solana:nvdax`).
      const plain = (v: string) =>
        v
          .toLowerCase()
          .replace(/^[a-z]+:/, '')
          .replace(/^t(?=[a-z]{2,}x?$)/, '')
          .replace(/x$/, '');
      const resolve = (id: string) =>
        catalog.get(id) ??
        assets.find((a) => a.id.toLowerCase() === id.toLowerCase()) ??
        assets.find((a) => a.symbol.toLowerCase() === id.toLowerCase().replace(/^[a-z]+:/, '')) ??
        assets.find(
          (a) => plain(a.symbol) === plain(id) || a.underlying.toLowerCase() === plain(id),
        );
      const keep = (lines: { id: string; why: string; share?: number | null }[], shape: Shape) => {
        const goals = [
          ...new Set(
            [serverGoal, planGoal, goalOfShape(shape)].filter((g): g is Goal => g != null),
          ),
        ];
        const out: { asset: BasketAsset; why: string; share: number | null }[] = [];
        for (const line of lines) {
          const asset = resolve(line.id);
          if (!asset) {
            dropped.push(line.id);
            continue;
          }
          if (out.some((o) => o.asset.id === asset.id)) continue;
          const fits = goals.map((goal) => ({ goal, fit: goalFit(asset, goal) }));
          const barred = fits.find((f) => f.fit === 'barred');
          if (barred) {
            notes.push(
              `${asset.symbol} left out: a plan to ${GOAL_WORDS[barred.goal]} cannot hold ${CLASS_WORDS[asset.cls]}, by the asset registry's rule.`,
            );
            continue;
          }
          const outside = fits.find((f) => f.fit === 'stock_outside');
          if (outside) {
            if (!requested.has(asset.id)) {
              notes.push(
                `${asset.symbol} left out: a plan to ${GOAL_WORDS[outside.goal]} holds no stock tokens unless you ask for one yourself.`,
              );
              continue;
            }
            askedOutside.set(asset.id, outside.goal);
          }
          out.push({ asset, why: line.why, share: line.share ?? null });
        }
        return out;
      };
      const split = r.buckets?.length && (r.shape === 'split' || !r.lines.length);
      if (split && r.buckets) {
        for (const b of r.buckets) {
          // A pot with no shape of its own takes the plan's: a pot of a plan to pay income pays income.
          const shape: Shape = b.shape ?? (r.shape === 'split' ? 'pick' : r.shape);
          pots.push({ name: b.name, shape, given: b.share ?? null, lines: keep(b.lines, shape) });
        }
      } else
        pots.push({ name: r.shape, shape: r.shape, given: null, lines: keep(r.lines, r.shape) });
      if (dropped.length) log('ids not on the catalog', dropped);
      if (dropped.length)
        notes.push(`Dropped, not on this chain's catalog: ${dropped.join(', ')}.`);
      for (const n of r.not_available)
        notes.push(
          `${n.name} is not on this chain's catalog${n.why ? `: ${n.why.replace(/[.\s]+$/, '')}` : ''}.`,
        );

      // The split (RELAXED-INTAKE, ANY-COMPOSITION): the shares the person gave, for pots and for the
      // holdings in a pot, applied exactly; the rest equally over what has none. Shares that come to
      // less than the whole leave the rest in cash, said; shares above it are scaled to it, said.
      // Nothing is reassigned to a holding in silence, and nothing is clipped to a cap: a line above
      // its cap is kept and named in the warning on the plan (overCap below).
      const cashAsset = assets.find((a) => a.cls === 'cash');
      const cashName = cashAsset ? `${cashAsset.symbol}, the cash line,` : '';
      const live = pots.filter((p) => p.lines.length > 0);
      if (pots.length > 1)
        for (const p of pots)
          if (!p.lines.length)
            notes.push(`The ${p.name} pot has no holding left, so it is not in this draft.`);
      const potSplit = splitShares(
        live.map((p) => (pots.length > 1 ? p.given : null)),
        10_000,
        Boolean(cashAsset),
      );
      if (live.length > 1 || potSplit.kind === 'gap')
        notes.push(
          ...sayShares(potSplit, {
            where: ' for the pots',
            of: 'the money',
            open: 'the pots',
            cashName,
          }),
        );
      const weights = new Map<string, { asset: BasketAsset; bps: number; why: string[] }>();
      const add = (asset: BasketAsset, bps: number, why: string) => {
        if (bps <= 0) return;
        const held = weights.get(asset.id);
        if (held) {
          held.bps += bps;
          if (!held.why.includes(why)) held.why.push(why);
        } else weights.set(asset.id, { asset, bps, why: [why] });
      };
      const gaps: number[] = [potSplit.gap];
      live.forEach((pot, p) => {
        const potBps = potSplit.bps[p] ?? 0;
        const label = (why: string) => (live.length > 1 ? `${pot.name}: ${why}` : why);
        const lineSplit = splitShares(
          pot.lines.map((l) => l.share),
          potBps,
          Boolean(cashAsset),
        );
        const where = live.length > 1 ? ` in ${pot.name}` : '';
        notes.push(
          ...sayShares(lineSplit, {
            where,
            of: live.length > 1 ? 'that pot' : 'the money',
            open: 'the holdings you gave none',
            cashName,
            starved: lineSplit.starved.map((i) => pot.lines[i]?.asset.symbol ?? ''),
          }),
        );
        pot.lines.forEach((l, i) => {
          add(l.asset, lineSplit.bps[i] ?? 0, label(l.why));
        });
        gaps.push(lineSplit.gap);
      });
      const gap = gaps.reduce((a, b) => a + b, 0);
      if (cashAsset && gap > 0)
        add(
          cashAsset,
          gap,
          'The part your shares left unplaced, held as cash until you say where.',
        );
      if (live.length)
        notes.push(
          'The deposit step buys exactly these holdings and shares, after the server checks every line again.',
        );
      if (
        live.length &&
        !cashAsset &&
        [...weights.values()].reduce((a, w) => a + w.bps, 0) !== 10_000
      ) {
        log('the split left weight with nowhere to go');
        return { kind: 'failure', reason: 'invalid' };
      }
      const lines = [...weights.values()].filter((w) => w.bps > 0);
      // A vault holds at most sixteen lines besides cash and `goal/accept` refuses more
      // (`TOO_MANY_LINES`), so no preview shows a mix the deposit step would turn down.
      const invested = lines.filter((l) => l.asset.id !== cashAsset?.id).length;
      if (invested > ORDER_POLICY.maxLines) {
        const tooMany = VaultAgentReply.safeParse({
          version: 1,
          messageId,
          message: `That names ${invested} holdings, and a vault holds at most ${ORDER_POLICY.maxLines} besides cash. Tell me which to keep, or ask for a shorter list.`,
          question: null,
          warnings: [],
          weightNotes: [],
          proposal: null,
        });
        if (!tooMany.success) return { kind: 'failure', reason: 'invalid' };
        return { kind: 'reply', reply: tooMany.data };
      }
      // Lines above the cap the vault holds them to today: kept as asked, and said plainly.
      const overCap = lines.filter((l) => l.bps > (caps.get(l.asset.id) ?? 0));
      const capWarning = overCap.length
        ? `Above the vault's cap today: ${overCap
            .map(
              (l) => `${l.asset.symbol} at ${pct(l.bps)} (cap ${pct(caps.get(l.asset.id) ?? 0)})`,
            )
            .join(
              ', ',
            )}. The vault would refuse this split as it stands; it can be bought only once the cap is lifted.`
        : null;
      if (capWarning) notes.unshift(capWarning);
      // A stock outside the goal that the person asked for: kept, and warned (ANY-COMPOSITION).
      const requestedLines = lines.filter((l) => askedOutside.has(l.asset.id));
      for (const l of requestedLines)
        notes.unshift(
          `${l.asset.symbol} is a stock token in a plan to ${GOAL_WORDS[askedOutside.get(l.asset.id) as Goal]}: it is here only because you asked for it yourself.`,
        );

      // Thom's guard on limits the person wrote ("at most 20% in Tesla"): kept as is.
      for (const constraint of holdingConstraints(messages, assets)) {
        const actual = lines.reduce((a, l) => a + (constraint.matches(l.asset) ? l.bps : 0), 0);
        if (lines.length && (actual < constraint.min || actual > constraint.max))
          notes.push(
            `This draft does not yet meet "${constraint.quote}"; say how you want it held.`,
          );
      }

      const missing = [
        ...new Set([
          ...REQUIRED[r.shape].filter((k) => r.stated[k] == null || r.stated[k] === ''),
          ...r.open,
        ]),
      ];
      const evidenceFor = (asset: BasketAsset) =>
        [
          `catalog:${asset.id}`,
          `tier:${asset.id}`,
          `price:${asset.id}`,
          `liquidity:${asset.id}`,
          ...(readings.get(asset.id)?.ids ?? []),
        ].filter((id) => sourceById.has(id));
      const used = new Set<string>();
      const allocations = lines.map((l) => {
        const evidenceIds = evidenceFor(l.asset);
        for (const id of evidenceIds) used.add(id);
        return {
          assetId: l.asset.id,
          symbol: l.asset.symbol,
          weightBps: l.bps,
          why: clip(l.why.join(' · '), 1000),
          evidenceIds,
        };
      });
      const stated = r.stated;
      // The arithmetic, by code from the sourced readings, under the model's words.
      const projection = project({
        lines: allocations,
        readings,
        today: new Date(),
        currency: stated.currency ?? null,
        amount: stated.amount ?? null,
        needBy: stated.need_by ?? null,
        monthly: stated.monthly ?? null,
        months: stated.withdraw_months ?? null,
        withdrawStart: stated.withdraw_start ?? null,
      });
      for (const id of projection?.sourceIds ?? []) if (sourceById.has(id)) used.add(id);
      // The same arithmetic month by month, for the chart beside the plan; none for stocks only.
      const monthly = series({
        lines: allocations,
        readings,
        today: new Date(),
        currency: stated.currency ?? null,
        amount: stated.amount ?? null,
        needBy: stated.need_by ?? null,
        monthly: stated.monthly ?? null,
        months: stated.withdraw_months ?? null,
        withdrawStart: stated.withdraw_start ?? null,
      });
      for (const id of monthly?.sourceIds ?? []) if (sourceById.has(id)) used.add(id);
      const message = projection
        ? `${clip(r.say, 2400 - projection.text.length - 2)}\n\n${projection.text}`
        : clip(r.say, 2400);
      const objective = [
        r.shape === 'split' ? 'Split' : r.shape[0]?.toUpperCase() + r.shape.slice(1),
        stated.amount != null ? `${stated.amount} ${stated.currency ?? 'USD'}` : null,
        stated.when ?? null,
        stated.monthly != null ? `${stated.monthly} a month` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const holdings =
        live.length > 1
          ? live
              .map(
                (p) => `${p.name} (${p.shape}): ${p.lines.map((l) => l.asset.symbol).join(', ')}`,
              )
              .join('; ')
          : `${lines.map((l) => l.asset.symbol).join(', ')}`;
      const summary = capWarning ? `⚠ ${capWarning} ${holdings}` : holdings;
      const reply = VaultAgentReply.safeParse({
        version: 1,
        messageId,
        message,
        question: null,
        // The relaxed intake says its notes in the plan's tradeoffs; of the model-led conversation's
        // codes (ANY-COMPOSITION) it sets only `outside_goal_requested`, on the asset's catalog listing.
        warnings: requestedLines
          .filter((l) => used.has(`catalog:${l.asset.id}`))
          .map((l) => ({
            code: 'outside_goal_requested' as const,
            assetId: l.asset.id,
            evidenceId: `catalog:${l.asset.id}`,
          })),
        weightNotes: [],
        proposal: allocations.length
          ? {
              objective: clip(objective || 'Draft', 800),
              summary: clip(summary || 'Draft', 1600),
              allocations,
              tradeoffs: [...new Set(notes)].slice(0, 12).map((n) => clip(n, 600)),
              unknowns: [
                ...(missing.length
                  ? [`Still needed before this can be confirmed: ${missing.join(', ')}.`]
                  : []),
                ...context.unknowns,
              ]
                .slice(0, 12)
                .map((n) => clip(n, 600)),
              sources: [...used].map((id) => sourceById.get(id) as AgentSource),
              ...(monthly
                ? {
                    projection: {
                      ...monthly,
                      basis: clip(monthly.basis, 1200),
                      sourceIds: monthly.sourceIds.filter((id) => sourceById.has(id)),
                    },
                  }
                : {}),
            }
          : null,
      });
      if (!reply.success) {
        log('final reply did not validate', reply.error.issues);
        return { kind: 'failure', reason: 'invalid' };
      }
      return { kind: 'reply', reply: reply.data };
    },
  };
}

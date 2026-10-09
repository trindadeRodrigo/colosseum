import Anthropic from '@anthropic-ai/sdk';
import { eligibleForGoal } from '@colosseum/engine/personal';
import type { BasketAsset } from '@colosseum/schemas';
import {
  type VaultAgentSource as AgentSource,
  VaultAgentReply,
  VaultAgentRequest,
  type VaultAgentResult,
} from '@colosseum/schemas';
import { z } from 'zod';
import { catalogCap, holdingConstraints } from './relaxed-limits';
import { project, type Reading, readingsOf, series } from './relaxed-projection';
import type { GoalAgentContext } from './vault-agent';

// The relaxed intake (gate RELAXED-INTAKE, from scripts/relaxed/intake.ts and RELAXED-1): the goal
// agent behind /goal whenever a model key is set (`relaxedGoalAgentFromEnv`). The model is free where
// it talks and constrained where it touches money: it reads intent against this chain's live catalog,
// says what it understood in its own words (the person's own numbers included) and names holdings by
// id. Code then keeps only ids on the catalog, drops stock tokens from a plan to protect or pay income,
// splits equally or by the shares the person gave, names any line above its cap in a warning on the
// plan, and cites the server's own sources. Never a weight from the model, never a source from it.

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
): RelaxedGoalAgent | null {
  const choice = env.GOAL_AGENT?.trim() || GOAL_AGENT_RELAXED;
  if (choice !== GOAL_AGENT_RELAXED && choice !== GOAL_AGENT_MODEL_LED)
    throw new Error(
      `GOAL_AGENT must be "${GOAL_AGENT_RELAXED}" (the default) or "${GOAL_AGENT_MODEL_LED}", not "${choice}".`,
    );
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (choice === GOAL_AGENT_MODEL_LED || !apiKey) return null;
  const model = env.RELAXED_MODEL?.trim();
  return createRelaxedGoalAgent({ apiKey, ...(model ? { model } : {}) });
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

Shapes: "pick" for named things, equal split; "grow", "income" or "protect" when the words call for it; "split" when they want part of the money doing one thing and part another (for example a liquid reserve and a growth pot), one pot per bucket with its own shape. A plan or pot to protect or to pay income holds no stock tokens; use cash, yield rows, Treasury funds and gold there.

Direct instructions: when the person tells you what to hold or how to split ("make all the income part syrupUSDC", "put 80% in the highest yield"), do it in this turn. Do not ask permission and do not argue. A cap does not stop it: do exactly what they asked and add one short sentence that the vault caps that holding today, so this split would need the cap lifted to be bought. Only the rule on stock tokens in a plan to protect or pay income still applies: if that stops part of the instruction, do the closest version and say why in one sentence. Do not offer alternatives unless they ask. Ask at most one question per turn, and only for something rule 4 still needs, at the end of your message.

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
    ? `yield ${(r.rate * 100).toFixed(2)}% a year${r.haircut != null && r.quoted != null ? ` after haircut (quoted ${(r.quoted * 100).toFixed(2)}%)` : ''}, read ${r.fetchedAt.slice(0, 10)}${r.provenance === 'sandbox' ? ', mainnet reading on a test token' : ''}`
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

/** Basis points summing to 10,000 to the unit; the remainder goes to the first. */
const equalSplit = (n: number) => {
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
};
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
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
  log?: (msg: string, detail?: unknown) => void;
}): RelaxedGoalAgent {
  const model = options.model ?? 'claude-sonnet-5-5';
  const log =
    options.log ?? ((msg, detail) => console.warn(`relaxed goal agent: ${msg}`, detail ?? ''));
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 0,
  });
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
      let raw: unknown;
      try {
        const response = await client.messages.create({
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
      const pots: {
        name: string;
        shape: Shape;
        shareBps: number;
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
        const out: { asset: BasketAsset; why: string; share: number | null }[] = [];
        for (const line of lines) {
          const asset = resolve(line.id);
          if (!asset) {
            dropped.push(line.id);
            continue;
          }
          if (out.some((o) => o.asset.id === asset.id)) continue;
          if ((shape === 'income' || shape === 'protect') && !eligibleForGoal(asset, shape)) {
            notes.push(
              `${asset.symbol} left out: no stock tokens in a plan to ${shape === 'protect' ? 'protect' : 'pay income'}.`,
            );
            continue;
          }
          out.push({ asset, why: line.why, share: line.share ?? null });
        }
        return out;
      };
      if (r.buckets?.length && (r.shape === 'split' || !r.lines.length)) {
        const given = r.buckets.map((b) => b.share);
        let shares = equalSplit(r.buckets.length);
        if (given.every((g) => g != null)) {
          const sum = (given as number[]).reduce((a, b) => a + b, 0);
          if (sum > 0) {
            shares = (given as number[]).map((g) => Math.round((g / sum) * 10_000));
            shares[0] = (shares[0] ?? 0) + 10_000 - shares.reduce((a, b) => a + b, 0);
            if (Math.abs(sum - 1) > 0.001)
              notes.push(
                `The pot shares you gave summed to ${Math.round(sum * 100)}%; scaled to the whole.`,
              );
          }
        } else notes.push('Equal shares between the pots until you give them.');
        r.buckets.forEach((b, i) => {
          const shape = b.shape ?? 'pick';
          pots.push({ name: b.name, shape, shareBps: shares[i] ?? 0, lines: keep(b.lines, shape) });
        });
      } else {
        pots.push({
          name: r.shape,
          shape: r.shape,
          shareBps: 10_000,
          lines: keep(r.lines, r.shape),
        });
        if (r.shape === 'pick' && r.lines.length > 1)
          notes.push('Equal split until you say otherwise.');
      }
      if (r.shape !== 'pick')
        notes.push(
          'A preview split equally inside each pot; the solver sizes the lines on the parameter table once you confirm.',
        );
      if (dropped.length) log('ids not on the catalog', dropped);
      if (dropped.length)
        notes.push(`Dropped, not on this chain's catalog: ${dropped.join(', ')}.`);
      for (const n of r.not_available)
        notes.push(
          `${n.name} is not on this chain's catalog${n.why ? `: ${n.why.replace(/[.\s]+$/, '')}` : ''}.`,
        );

      // A pot whose lines were all dropped hands its share to the pots that kept lines. Inside a pot
      // the lines split equally; a line over its cap (EXIT-SOURCE) is clipped and the excess goes to
      // the pot's other lines with room, so each pot keeps the share the person gave it. What no line
      // of the pot can take is held as cash, and said.
      const live = pots.filter((p) => p.lines.length > 0);
      const liveShare = live.reduce((a, p) => a + p.shareBps, 0);
      const potShares = live.map((p) =>
        liveShare > 0 ? Math.round((p.shareBps / liveShare) * 10_000) : 0,
      );
      if (potShares.length)
        potShares[0] = (potShares[0] ?? 0) + 10_000 - potShares.reduce((a, b) => a + b, 0);
      const cashAsset = assets.find((a) => a.cls === 'cash');
      const weights = new Map<string, { asset: BasketAsset; bps: number; why: string[] }>();
      const add = (asset: BasketAsset, bps: number, why: string) => {
        if (bps <= 0) return;
        const held = weights.get(asset.id);
        if (held) {
          held.bps += bps;
          if (!held.why.includes(why)) held.why.push(why);
        } else weights.set(asset.id, { asset, bps, why: [why] });
      };
      live.forEach((pot, p) => {
        const potBps = potShares[p] ?? 0;
        const label = (why: string) => (live.length > 1 ? `${pot.name}: ${why}` : why);
        // Rodrigo, Oct 8 (RELAXED-1): the person's split is applied exactly. Shares they gave
        // for holdings in this pot, the rest of the pot equally over the holdings with none (all of
        // it equally when they gave none). Nothing is clipped to a cap here: a line above its cap is
        // kept and named in the warning on the plan (overCap below).
        const stated = pot.lines.filter((l) => l.share != null);
        const given = stated.reduce((a, l) => a + (l.share as number), 0);
        const scale = given > 1 ? 1 / given : 1;
        const rest = pot.lines.filter((l) => l.share == null);
        const statedBps = stated.length ? Math.round(given * scale * potBps) : 0;
        const restBps = rest.length ? Math.max(0, potBps - statedBps) : 0;
        const restSplit = rest.length ? equalSplit(rest.length) : [];
        const target = new Map<string, number>();
        for (const l of stated)
          target.set(l.asset.id, Math.round((l.share as number) * scale * potBps));
        rest.forEach((l, i) => {
          target.set(l.asset.id, Math.floor(((restSplit[i] ?? 0) * restBps) / 10_000));
        });
        // Rounding, and shares that sum below the pot with no other holding to take the rest: the
        // difference goes to the first holding, so the pot keeps the share it was given.
        const placed = [...target.values()].reduce((a, b) => a + b, 0);
        const firstLine = pot.lines[0];
        if (firstLine && placed !== potBps)
          target.set(firstLine.asset.id, (target.get(firstLine.asset.id) ?? 0) + potBps - placed);
        for (const l of pot.lines) add(l.asset, target.get(l.asset.id) ?? 0, label(l.why));
      });
      if (
        live.length &&
        !cashAsset &&
        [...weights.values()].reduce((a, w) => a + w.bps, 0) !== 10_000
      ) {
        log('caps left weight with nowhere to go');
        return { kind: 'failure', reason: 'invalid' };
      }
      const lines = [...weights.values()].filter((w) => w.bps > 0);
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
        // The relaxed intake says its notes in the plan's tradeoffs; it sets none of the model-led
        // conversation's codes (ANY-COMPOSITION), which the reply's shape requires all the same.
        warnings: [],
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

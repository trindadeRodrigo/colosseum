import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '@colosseum/db';
import type { BasketAsset, ChainId, Provenance, VaultAgentSource } from '@colosseum/schemas';
import {
  type AssetLookups,
  LOOKUP_WINDOWS,
  type LookupAnswer,
  type LookupFact,
  type LookupMissing,
  type LookupWindow,
} from './lookups';
import { type FigureReferences, NULL_REASONS, type WindowGap } from './vault-figures';

// The lookups in the conversations (gate FIGURES-BY-REFERENCE as amended 2026-10-14, ledger
// API-AGENT-LOOKUPS-2): one loop, used by the relaxed intake behind /goal and by a vault's own
// conversation. The model may ask, through four read-only tools, for the facts the server holds of one
// listed asset of the conversation's chain; the server runs each call through the asset lookups
// (asset-lookups.ts, handed in), adds each answer's facts to this request's evidence and hands the model
// per fact its id, what it measures, its value, unit, time and provenance, never its source or method,
// which the server writes. The model still writes no number: a looked-up figure is stated by reference
// under the unchanged rules of vault-figures.ts. At most three lookup rounds a reply, each round's reads
// waited for at most 2.5 s; the shared quota is reserved before every paid call, and a denial ends the
// loop with no further call. A lookup that fails answers the model an error and never fails the reply.

/** At most this many lookup rounds in one reply; the call after the last one may not look up again. */
export const LOOKUP_MAX_ROUNDS = 3;
/** How long one round's reads are waited for; what is late answers "reading". */
export const LOOKUP_WAIT_MS = 2_500;

const assetId = {
  type: 'string',
  description:
    "The asset's id exactly as the catalog of this chain lists it (for example solana:nvdax); one listed asset of this chain; the cash token only for asset_lending.",
} as const;
const READ_ONLY = 'Read-only: it changes nothing and places no order.';
const SAY =
  'State any figure it returns by reference, {{fact:<id>}} with the id it gives, never by typing the value.';

/**
 * The four tools, sorted by name, the same bytes on every request: tools render before the system
 * prompt, so the system's cache breakpoint caches them too. Bearing's figures are not a tool: they are
 * handed up front.
 */
export const LOOKUP_TOOLS: Anthropic.Tool[] = [
  {
    name: 'asset_lending',
    description: `The lending markets the server holds for one listed asset, per market: the supply rate and the borrow rate (rates a year, past readings), the share of supply lent out, and the dollars a lender can withdraw now. ${READ_ONLY} ${SAY}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId'],
      properties: { assetId },
    },
    strict: true,
  },
  {
    name: 'asset_pools',
    description: `The DEX pools of one listed asset, at most five, by dollars held: the dollars each holds, its volume over the last day and its share of the dollars in the asset's pools, each pool named by its venue. ${READ_ONLY} ${SAY}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId'],
      properties: { assetId },
    },
    strict: true,
  },
  {
    name: 'asset_price_history',
    description: `The price history of one listed asset over a window, from hourly bars across its DEX pools in dollars: the latest close, the high, the low, the change from the window's first close to its last (a past change over that window, never a return), volume, the dollars traded on the entry side (swaps into the asset) and on the exit side (swaps out of it), the number of swaps and the hours with no priced swap. ${READ_ONLY} ${SAY}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId', 'window'],
      properties: {
        assetId,
        window: {
          type: 'string',
          enum: [...LOOKUP_WINDOWS],
          description: 'The window: the last day (24h), week (7d) or month (30d).',
        },
      },
    },
    strict: true,
  },
  {
    name: 'asset_profile',
    description: `The newest reading of each metric the server holds of one listed asset: its total supply and the supply its issuer reports, the share held by its twenty largest token accounts, the dollars in its DEX pools, its DEX volume over the last day, the TVL of the protocol behind it, its exchange rate and each yield reading (a rate a year, a past figure). ${READ_ONLY} ${SAY}`,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['assetId'],
      properties: { assetId },
    },
    strict: true,
  },
];

/**
 * When and how the model looks up, for the system prompt of either conversation: the same text on every
 * request, so it stays in the cached prefix with the tools.
 */
export const LOOKUP_RULES = [
  'LOOKUPS. Four read-only tools give the figures the server holds of one listed asset of this chain: asset_profile (its supply, the share its largest holders hold, the dollars in its pools, its volume, its exchange rate, its yield readings), asset_price_history (its price over the last day, week or month: the latest close, the high, the low, the change, volume, the dollars traded on the entry side and on the exit side, swaps), asset_pools (its pools by dollars held) and asset_lending (its lending markets: supply and borrow rate, how much is lent out, what can be withdrawn).',
  "- When: the person asks about an asset's price, how it moved, its supply, who holds it, its pools or lending, or a caution you give needs a figure. The figures handed to you up front come first: look up only what they do not answer. Never to decorate a reply.",
  '- How: name only assets listed on this chain, by their exact id, and the cash token only for its lending markets (asset_lending); one asset a call, every call a round needs in that round. At most three rounds in one reply; then answer with what you have.',
  '- What comes back: per figure its id, what it measures, its value, unit, time and provenance (sandbox: a test network, with the mainnet token it is modelled on), or that it is not measured and why. State a looked-up figure exactly as any other, by {{fact:<id>}} with its id, under the same rules: never its value typed, never a comparison, a ranking, arithmetic, a forecast or a promise.',
  '- Each looked-up figure is the asset\'s or its market\'s, never the person\'s: no "you", "your", "my" or "I" in a sentence that holds one.',
  '- A change over a window is a change in price over that window ("NVDAx\'s price changed by {{fact:<id>}} over the last week."), never a return, a gain, a profit, a loss or a performance.',
  '- A lending market\'s supply rate and borrow rate are rates a year: call each by its name, with the token it is of and the market ("The borrow rate of USDC in that market is {{fact:<id>}} a year."), never a yield, a return or what anyone earns. A yield reading of an asset\'s profile is a yield, said as its measurement alone, in a sentence that ends there ("Its quoted yield is {{fact:<id>}} a year.").',
  '- A pool\'s share is a share of the dollars in the asset\'s pools ("Its largest pool holds {{fact:<id>}} of the dollars in its pools."), never a bare share. Asked which of two is deeper or better, each figure in its own sentence and no verdict.',
  '- A lookup that answers an error (not listed here, the cash token for anything but lending, could not be read) or that the figures are still being read: say so in words and state no figure of it. A lookup is never a reason to name an asset that is not listed.',
].join('\n');

/** The lookups a conversation may make, handed in by its route: the reader, its database and the chain's label. */
export type LookupBase = { service: AssetLookups; db: Db; provenance?: Provenance };
/** The base with this request's chain and its catalog: what every call of the loop reads against. */
export type LookupScope = LookupBase & { chain: ChainId; catalog: readonly BasketAsset[] };

/** What the loop adds to the request's evidence, ready to merge into the resolver. */
export type LookedUp = {
  /** Each measured looked-up figure, by id: a source as the resolver reads it. */
  sources: Map<string, VaultAgentSource>;
  /** Each looked-up figure that is not measured, by id, with why. */
  missing: FigureReferences['missing'];
  /** The age of a looked-up reading past its age limit, by id. */
  staleAgeSec: Record<string, number>;
  /** The hours not collected of a looked-up figure's window, by id, where any is. */
  windowGaps: Record<string, WindowGap>;
  /** The ids whose value is a lower bound. */
  lowerBound: Set<string>;
  /** For the log: lookup rounds, tool calls, facts added and calls answered with an error. */
  counts: LookupCounts;
};
export type LookupCounts = { rounds: number; calls: number; facts: number; errors: number };

/** One model response, as much of it as the loop reads. */
export type LookupResponse = Pick<Anthropic.Message, 'stop_reason' | 'content'>;
/** One paid model call: the messages, and the tools with their choice when lookups are on. */
export type LookupCall = (request: {
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  tool_choice?: Anthropic.ToolChoice;
  /** The time this call may take: what is left of the reply's deadline, when it has one. */
  timeoutMs?: number;
}) => Promise<LookupResponse>;

/**
 * Below this much time left before the reply's deadline, the next call may not look up: it answers with
 * what it has, and it is given at least this long, so a deadline is overrun by one such call at most. A
 * reply with little time keeps a third of it for its answer (`finalMsFor`).
 */
export const LOOKUP_FINAL_MS = 10_000;
/** The time a reply with `budgetMs` keeps for its last call: a third of it, ten seconds at most. */
export const finalMsFor = (budgetMs: number) => Math.min(LOOKUP_FINAL_MS, Math.floor(budgetMs / 3));
/** What a tool call the loop will not run answers, so no turn ever goes on with a call left unanswered. */
const NOT_RUN = JSON.stringify({
  error: 'No lookup was run: this reply may look up nothing more. Answer with what you have.',
});

export type LookupRun =
  | {
      kind: 'answered';
      /** The final response: it asked for no lookup, or it was made with lookups off. */
      response: LookupResponse;
      /**
       * Every message of the reply's calls, each assistant turn exactly as it came (thinking included),
       * the final one too when it has content: what a repair call sends on.
       */
      transcript: Anthropic.MessageParam[];
      looked: LookedUp;
    }
  | {
      /** The shared quota refused a call: no further paid call was made. */
      kind: 'denied';
      detail: string;
      looked: LookedUp;
    };

export function emptyLooked(): LookedUp {
  return {
    sources: new Map(),
    missing: {},
    staleAgeSec: {},
    windowGaps: {},
    lowerBound: new Set(),
    counts: { rounds: 0, calls: 0, facts: 0, errors: 0 },
  };
}

/** The tool result for one fact: what it measures and its value, never its source or method. */
function factOut(fact: LookupFact, modelledOn: string | null) {
  return {
    id: fact.id,
    measures: fact.label,
    value: fact.value,
    unit: fact.unit,
    asOf: fact.fetchedAt,
    provenance: fact.provenance,
    ...(fact.lowerBound ? { lowerBound: true } : {}),
    ...(fact.staleAgeSec === undefined ? {} : { ageSeconds: fact.staleAgeSec }),
    // no count: the model types no number; the server writes how many hours beside the figure
    ...(fact.missingHours
      ? {
          window:
            'Some hours of this window were not collected; the server writes how many beside the figure.',
        }
      : {}),
    ...(modelledOn && fact.provenance !== 'live' ? { modelledOn } : {}),
  };
}
const missingOut = (missing: LookupMissing) => ({
  id: missing.id,
  measures: missing.label,
  notMeasured: NULL_REASONS[missing.reason],
});

type ToolAnswer = { content: string; isError: boolean };
const failed = (reason: string): ToolAnswer => ({
  content: JSON.stringify({ error: reason }),
  isError: true,
});

/** The listed asset a tool call names: its id exactly, in another letter case, or its symbol when one asset has it. */
function assetOf(catalog: readonly BasketAsset[], id: string): BasketAsset | undefined {
  const lower = id.trim().toLowerCase();
  const exact = catalog.find((asset) => asset.id === id);
  if (exact) return exact;
  const byId = catalog.filter((asset) => asset.id.toLowerCase() === lower);
  if (byId.length === 1) return byId[0];
  const bySymbol = catalog.filter((asset) => asset.symbol.toLowerCase() === lower);
  return bySymbol.length === 1 ? bySymbol[0] : undefined;
}

const PARTS = {
  asset_profile: 'profile',
  asset_price_history: 'price_history',
  asset_pools: 'pools',
  asset_lending: 'lending',
} as const;

/**
 * Runs one tool call through the lookups; never throws. The answer's facts and missing figures go into
 * `looked`, but an id the request already holds (handed up front, or looked up before) keeps the first.
 */
async function runTool(
  use: Anthropic.ToolUseBlock,
  scope: LookupScope,
  waitMs: number,
  looked: LookedUp,
  taken: (id: string) => boolean,
): Promise<ToolAnswer> {
  const part = Object.hasOwn(PARTS, use.name) ? PARTS[use.name as keyof typeof PARTS] : null;
  if (!part) return failed('There is no such lookup.');
  const input = (use.input ?? {}) as Record<string, unknown>;
  if (typeof input.assetId !== 'string' || !input.assetId.trim())
    return failed('The lookup needs the assetId of one listed asset of this chain.');
  const window = input.window;
  if (
    part === 'price_history' &&
    !(typeof window === 'string' && (LOOKUP_WINDOWS as readonly string[]).includes(window))
  )
    return failed('The window must be 24h, 7d or 30d.');
  const asset = assetOf(
    scope.catalog.filter((listed) => listed.chain === scope.chain),
    input.assetId,
  );
  if (!asset)
    return failed(
      'That asset is not on the catalog of this chain: say it is not listed here, and name no other in its place.',
    );
  // The cash token has lending markets and nothing else to look up (FIGURES-BY-REFERENCE as amended
  // 2026-10-14, after the second review of #288): "can I lend USDC?" is answered by its markets.
  if (asset.cls === 'cash' && part !== 'lending')
    return failed(
      'That is the cash token of this chain: only its lending markets can be looked up, with asset_lending.',
    );
  const query = {
    db: scope.db,
    chain: scope.chain,
    asset,
    waitMs,
    ...(scope.provenance ? { provenance: scope.provenance } : {}),
  };
  let answer: LookupAnswer;
  try {
    answer =
      part === 'profile'
        ? await scope.service.profile(query)
        : part === 'pools'
          ? await scope.service.pools(query)
          : part === 'lending'
            ? await scope.service.lending(query)
            : await scope.service.priceHistory({ ...query, window: window as LookupWindow });
  } catch {
    answer = { facts: [], missing: [], modelledOn: null, unread: 'failed' };
  }
  if (answer.unread === 'failed') return failed('The figures could not be read just now.');
  const head = {
    assetId: asset.id,
    part,
    ...(part === 'price_history' ? { window } : {}),
    ...(answer.modelledOn
      ? {
          modelledOn: `${answer.modelledOn}: this test-network token's figures are those of its mainnet model`,
        }
      : {}),
  };
  if (answer.unread === 'reading')
    return {
      content: JSON.stringify({
        ...head,
        reading:
          'The figures are still being read. Say they are being read and can be asked for again in a moment; state none of them.',
      }),
      isError: false,
    };
  const facts: ReturnType<typeof factOut>[] = [];
  const missing: ReturnType<typeof missingOut>[] = [];
  const handed: string[] = [];
  for (const fact of answer.facts) {
    if (taken(fact.id)) {
      handed.push(fact.id);
      continue;
    }
    looked.sources.set(fact.id, {
      id: fact.id,
      assetId: fact.assetId,
      label: fact.label,
      value: fact.value,
      unit: fact.unit,
      source: fact.source,
      method: fact.method,
      fetchedAt: fact.fetchedAt,
      provenance: fact.provenance,
    });
    if (fact.lowerBound) looked.lowerBound.add(fact.id);
    if (fact.staleAgeSec !== undefined) looked.staleAgeSec[fact.id] = fact.staleAgeSec;
    if (fact.missingHours && fact.windowHours)
      looked.windowGaps[fact.id] = {
        missingHours: fact.missingHours,
        windowHours: fact.windowHours,
      };
    looked.counts.facts += 1;
    facts.push(factOut(fact, answer.modelledOn));
  }
  for (const gap of answer.missing) {
    if (taken(gap.id)) {
      handed.push(gap.id);
      continue;
    }
    looked.missing[gap.id] = { assetId: gap.assetId, label: gap.label, reason: gap.reason };
    missing.push(missingOut(gap));
  }
  return {
    content: JSON.stringify({
      ...head,
      facts,
      ...(missing.length ? { notMeasured: missing } : {}),
      // figures the request already holds under these ids: referenced as they were handed
      ...(handed.length ? { alreadyHanded: handed } : {}),
      ...(facts.length || missing.length || handed.length
        ? {}
        : { note: 'The server holds no figure of this kind for this asset.' }),
    }),
    isError: false,
  };
}

/**
 * The reply's model calls, with the lookups between them. Each call reserves the shared quota first;
 * a denial ends the loop and no further call is made. A response that asks for lookups has every one of
 * them run at once, and the assistant turn goes back exactly as it came, followed by one user message
 * with all their results; after `maxRounds` rounds the next call may not look up (`tool_choice: none`).
 * With no `scope` the lookups are off: one call, with no tools. A model call that throws is the caller's
 * to handle, as before.
 */
export async function runLookupLoop(input: {
  call: LookupCall;
  messages: Anthropic.MessageParam[];
  reserve: () => string | null;
  /** Null or absent: no tools, as before the lookups. */
  scope?: LookupScope | null;
  /** The ids the request already holds: a looked-up id among them keeps the one handed. */
  handed?: (id: string) => boolean;
  maxRounds?: number;
  waitMs?: number;
  /**
   * When the reply's calls must be done (epoch ms): each call is given what is left, and with less than
   * `LOOKUP_FINAL_MS` left the next one may not look up. Absent: each call has its client's own limit.
   */
  deadline?: number;
  /** The least time a last call is given, and below which none looks up; `LOOKUP_FINAL_MS` by default. */
  finalMs?: number;
  now?: () => number;
}): Promise<LookupRun> {
  const finalMs = input.finalMs ?? LOOKUP_FINAL_MS;
  const maxRounds = input.maxRounds ?? LOOKUP_MAX_ROUNDS;
  const now = input.now ?? Date.now;
  const waitMs = input.waitMs ?? LOOKUP_WAIT_MS;
  const looked = emptyLooked();
  const taken = (id: string) =>
    (input.handed?.(id) ?? false) || looked.sources.has(id) || Object.hasOwn(looked.missing, id);
  const messages = [...input.messages];
  const scope = input.scope ?? null;
  for (let round = 0; ; round += 1) {
    const denied = input.reserve();
    if (denied !== null) return { kind: 'denied', detail: denied, looked };
    const left = input.deadline === undefined ? undefined : input.deadline - now();
    // the last call a reply may make: past the rounds, or with too little time left for another
    const last = round >= maxRounds || (left !== undefined && left < finalMs);
    const response = await input.call({
      // a copy: the next round adds to the list, never to what an earlier call was sent
      messages: [...messages],
      ...(scope
        ? { tools: LOOKUP_TOOLS, ...(last ? { tool_choice: { type: 'none' as const } } : {}) }
        : {}),
      ...(left !== undefined ? { timeoutMs: Math.max(finalMs, left) } : {}),
    });
    const uses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!scope || response.stop_reason !== 'tool_use' || !uses.length || last) {
      const transcript: Anthropic.MessageParam[] = response.content.length
        ? [
            ...messages,
            {
              role: 'assistant' as const,
              content: response.content as Anthropic.ContentBlockParam[],
            },
            // A tool call the loop does not run (one asked for past the last round, or cut off at the
            // token limit) is answered all the same: a repair that sends this transcript on is never
            // refused for a call left without its result.
            ...(uses.length
              ? [
                  {
                    role: 'user' as const,
                    content: uses.map(
                      (use): Anthropic.ToolResultBlockParam => ({
                        type: 'tool_result',
                        tool_use_id: use.id,
                        content: NOT_RUN,
                        is_error: true,
                      }),
                    ),
                  },
                ]
              : []),
          ]
        : messages;
      return { kind: 'answered', response, transcript, looked };
    }
    looked.counts.rounds += 1;
    looked.counts.calls += uses.length;
    const answers = await Promise.all(
      uses.map((use) =>
        runTool(use, scope, waitMs, looked, taken).catch(() =>
          failed('The figures could not be read just now.'),
        ),
      ),
    );
    looked.counts.errors += answers.filter((answer) => answer.isError).length;
    messages.push(
      // the assistant's turn exactly as it came, thinking blocks and all
      { role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] },
      {
        role: 'user',
        content: uses.map(
          (use, at): Anthropic.ToolResultBlockParam => ({
            type: 'tool_result',
            tool_use_id: use.id,
            content: answers[at]?.content ?? '',
            ...(answers[at]?.isError ? { is_error: true } : {}),
          }),
        ),
      },
    );
  }
}

/** `into` with every looked-up figure it does not already hold: the first id stands. */
export function mergeLooked(
  into: {
    sources: Map<string, VaultAgentSource>;
    references: FigureReferences;
    lowerBound: Set<string>;
  },
  looked: LookedUp | undefined,
): void {
  if (!looked) return;
  const held = (id: string) => into.sources.has(id) || Object.hasOwn(into.references.missing, id);
  for (const [id, source] of looked.sources) {
    if (held(id)) continue;
    into.sources.set(id, source);
    if (looked.lowerBound.has(id)) into.lowerBound.add(id);
    const age = looked.staleAgeSec[id];
    if (age !== undefined) into.references.staleAgeSec[id] = age;
    const gap = looked.windowGaps[id];
    if (gap) into.references.windowGaps = { ...into.references.windowGaps, [id]: gap };
  }
  for (const [id, missing] of Object.entries(looked.missing))
    if (!held(id)) into.references.missing[id] = missing;
}

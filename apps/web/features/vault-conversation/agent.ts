import {
  AssetId,
  type ChainId,
  FIGURE_REFERENCE,
  Provenance,
  VaultAgentFigure,
  type VaultResponse,
} from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import { sameAddress } from '../portfolio/vault-name';
import type { Turn } from './storage';

/**
 * A figure a reply stated by reference (gate FIGURES-BY-REFERENCE): written by our server from what it
 * measured, with its source and time, or null with the reason. Never the model's own number.
 */
export type Figure = VaultAgentFigure;
/** A text with each figure a `{{fact:<id>}}` placeholder, and what each one is. */
export type Figured = { template: string; facts: Figure[] };
/** The reply's prose with its placeholders, field by field. */
export type ReplyFigures = {
  prose: {
    message: string;
    question?: string;
    proposal?: {
      objective: string;
      summary: string;
      tradeoffs: string[];
      unknowns: string[];
      why: Record<string, string>;
    };
  };
  facts: Figure[];
};

/** The facts as our server wrote them, each once; null when any is not one. */
export function factsOf(value: unknown): Figure[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null;
  const facts: Figure[] = [];
  for (const raw of value) {
    const fact = VaultAgentFigure.safeParse(raw);
    if (!fact.success || facts.some((old) => old.id === fact.data.id)) return null;
    facts.push(fact.data);
  }
  return facts;
}

/** The ids a template's placeholders name, in order. */
export const referencesIn = (template: string): string[] =>
  [...template.matchAll(FIGURE_REFERENCE)].map((match) => match[1] ?? '');

/** `template` with the facts its placeholders name, or undefined when it names none of them. */
export function figuredOf(template: string, facts: readonly Figure[]): Figured | undefined {
  const named = new Set(referencesIn(template));
  const own = facts.filter((fact) => named.has(fact.id));
  return own.length > 0 && own.length === named.size ? { template, facts: own } : undefined;
}

export type VaultStrategyPreview = {
  objective: string;
  summary: string;
  allocations: {
    assetId: string;
    weightBps: number;
    why: string;
    evidenceIds: string[];
    symbol?: string;
  }[];
  tradeoffs: string[];
  unknowns: string[];
  sources: {
    id: string;
    source: string;
    fetchedAt: string;
    method: string;
    provenance: Provenance;
    label?: string;
    value?: number | null;
    unit?: string;
  }[];
  /**
   * Server-written notes on the proposal (gate ANY-COMPOSITION): a weight above measured exit capacity,
   * citing that figure among `sources`, and a stock outside the goal that the person asked for.
   */
  warnings: {
    code: 'over_exit_capacity' | 'outside_goal_requested';
    assetId: string;
    evidenceId: string;
  }[];
  /** What the server did with the weights, so nothing it did is silent. Codes, assets and the person's words. */
  weightNotes: WeightNote[];
  /** The relaxed intake's month-by-month projection from the server's sourced yields, when any. */
  projection?: StrategyProjection;
};
export type WeightNote = {
  code:
    | 'equal_split'
    | 'stated'
    | 'scaled'
    | 'pick_dropped'
    | 'share_unmet'
    | 'share_unread'
    | 'share_withdrawn';
  assetIds: string[];
  quote?: string;
};
const NOTE_CODES = new Set<WeightNote['code']>([
  'equal_split',
  'stated',
  'scaled',
  'pick_dropped',
  'share_unmet',
  'share_unread',
  'share_withdrawn',
]);
/** The notes that can stand on a reply with no proposal: each is about the person's own words. */
const ALONE_CODES = new Set<WeightNote['code']>(['share_unmet', 'share_unread', 'share_withdrawn']);
const WARNING_CODES = new Set(['over_exit_capacity', 'outside_goal_requested']);
export type StrategyProjection = {
  currency: string;
  rate: number;
  /** Months between two points: 1, or 12 for a long term. */
  step: 1 | 12;
  months: { month: string; balance: number; earned: number; withdrawn: number }[];
  basis: string;
  sourceIds: string[];
};
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
/** A malformed projection is left out; it never voids the rest of the preview. */
function projectionOf(value: unknown): StrategyProjection | undefined {
  const p =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !p ||
    typeof p.currency !== 'string' ||
    !finite(p.rate) ||
    typeof p.basis !== 'string' ||
    !Array.isArray(p.sourceIds) ||
    !p.sourceIds.every((id) => typeof id === 'string') ||
    !Array.isArray(p.months) ||
    p.months.length > 121
  )
    return undefined;
  const months: StrategyProjection['months'] = [];
  for (const raw of p.months) {
    const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    if (
      !m ||
      typeof m.month !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(m.month) ||
      !finite(m.balance) ||
      !finite(m.earned) ||
      !finite(m.withdrawn)
    )
      return undefined;
    months.push({ month: m.month, balance: m.balance, earned: m.earned, withdrawn: m.withdrawn });
  }
  const step = p.step === 12 ? 12 : 1;
  return {
    currency: p.currency,
    rate: p.rate,
    step,
    basis: p.basis,
    sourceIds: p.sourceIds as string[],
    months,
  };
}
/** Independent from the new-goal wizard; the provider owns grounded dialogue and policy checks. */
export type VaultAgentRequest = {
  vault: VaultResponse;
  transcript: readonly Turn[];
  language: 'en' | 'pt';
  signal?: AbortSignal;
};
export type VaultAgentReply = {
  message: string;
  question?: string;
  /**
   * Present when the reply stated figures by reference. `message`, `question` and the proposal's prose
   * are then plain text with each value written in; this is the same prose with its placeholders.
   */
  figures?: ReplyFigures;
  proposal?: VaultStrategyPreview;
  /** Notes on a reply with no proposal: a share the server did not apply, could not meet, or dropped. */
  notes?: WeightNote[];
};
export type VaultAgent = (request: VaultAgentRequest) => Promise<unknown>;
export class VaultAgentError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'failed',
    readonly reason?: 'unavailable' | 'timeout' | 'budget' | 'invalid',
  ) {
    super(kind);
  }
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const texts = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= 20 && value.every((v) => text(v, max));

/**
 * What a reply says, as one text: its message, then its question. A model often ends its message with
 * the very question it also sends on its own, and then the question is said once. That is so only when
 * the message itself ends by asking, with a question mark: "It depends on how long." has not asked
 * "How long?". Past that the two are compared as words: case, spacing, and quotes or emphasis round
 * the question do not make it a second one. A question the message does not end with is always said.
 */
export function replyText(message: string, question?: string | null): string {
  if (!question) return message;
  const bare = (text: string) => text.replace(/["'“”‘’«»*_`()[\]]/g, '').trim();
  const words = (text: string) =>
    bare(text)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[\s?.!:]+$/, '');
  const asked = words(question);
  return asked && bare(message).endsWith('?') && words(message).endsWith(asked)
    ? message
    : `${message}\n\n${question}`;
}

/**
 * The figures of a reply, when every placeholder of its prose names one of its facts. Anything else
 * and the reply is shown from its plain fields, which hold the same values as text: a malformed
 * `figures` never voids the reply, and never shows a brace.
 */
function replyFiguresOf(value: unknown, withProposal: boolean): ReplyFigures | undefined {
  const row = record(value);
  const prose = record(row?.prose);
  const facts = factsOf(row?.facts);
  if (!prose || !facts || !text(prose.message, 9600)) return undefined;
  if (prose.question != null && !text(prose.question, 2000)) return undefined;
  let proposal: ReplyFigures['prose']['proposal'];
  if (withProposal) {
    const p = record(prose.proposal);
    const why = record(p?.why);
    if (
      !p ||
      !why ||
      !text(p.objective, 3200) ||
      !text(p.summary, 6400) ||
      !texts(p.tradeoffs, 2400) ||
      !texts(p.unknowns, 2400) ||
      !Object.values(why).every((reason) => text(reason, 4000))
    )
      return undefined;
    proposal = {
      objective: p.objective,
      summary: p.summary,
      tradeoffs: p.tradeoffs,
      unknowns: p.unknowns,
      why: why as Record<string, string>,
    };
  }
  const known = new Set(facts.map((fact) => fact.id));
  const all = [
    prose.message,
    (prose.question as string | null | undefined) ?? '',
    ...(proposal
      ? [
          proposal.objective,
          proposal.summary,
          ...proposal.tradeoffs,
          ...proposal.unknowns,
          ...Object.values(proposal.why),
        ]
      : []),
  ];
  if (all.some((words) => referencesIn(words).some((id) => !known.has(id)))) return undefined;
  return {
    prose: {
      message: prose.message,
      ...(prose.question ? { question: prose.question as string } : {}),
      ...(proposal ? { proposal } : {}),
    },
    facts,
  };
}

/** A provider reply is plain data. A preview grants no signing or funded-vault update capability. */
export function strategyReplyOf(value: unknown, chain: ChainId): VaultAgentReply | null {
  const row = record(value);
  if (
    row?.version !== 1 ||
    row.chain !== chain ||
    !text(row.messageId, 64) ||
    !text(row.message, 2400) ||
    (row.question != null && !text(row.question, 500))
  )
    return null;
  // An older server sends no notes: none are shown, never a guess. Without a proposal only a note on
  // the person's own words can stand (a share unmet, unread or withdrawn), and no warning.
  if (row.weightNotes != null && !Array.isArray(row.weightNotes)) return null;
  const notes: WeightNote[] = [];
  for (const raw of Array.isArray(row.weightNotes) ? row.weightNotes : []) {
    const n = record(raw);
    if (
      !n ||
      typeof n.code !== 'string' ||
      !NOTE_CODES.has(n.code as WeightNote['code']) ||
      (row.proposal == null && !ALONE_CODES.has(n.code as WeightNote['code'])) ||
      !Array.isArray(n.assetIds) ||
      n.assetIds.length > 64 ||
      !n.assetIds.every((id) => AssetId.safeParse(id).success) ||
      (n.quote !== undefined && !text(n.quote, 400))
    )
      return null;
    notes.push({
      code: n.code as WeightNote['code'],
      assetIds: n.assetIds as string[],
      ...(n.quote !== undefined ? { quote: n.quote as string } : {}),
    });
  }
  if (row.proposal == null && Array.isArray(row.warnings) && row.warnings.length > 0) return null;
  let proposal: VaultStrategyPreview | undefined;
  if (row.proposal != null) {
    const p = record(row.proposal);
    if (
      !p ||
      !text(p.objective, 800) ||
      !text(p.summary, 1600) ||
      !texts(p.tradeoffs, 600) ||
      !texts(p.unknowns, 600) ||
      !Array.isArray(p.sources) ||
      p.sources.length > 1024 ||
      !Array.isArray(p.allocations) ||
      !p.allocations.length ||
      p.allocations.length > 64
    )
      return null;
    const sources: VaultStrategyPreview['sources'] = [];
    for (const raw of p.sources) {
      const s = record(raw);
      const provenance = Provenance.safeParse(s?.provenance);
      if (
        !s ||
        !text(s.id, 160) ||
        !text(s.source, 2000) ||
        !text(s.method, 2000) ||
        !text(s.fetchedAt, 100) ||
        !Number.isFinite(Date.parse(s.fetchedAt)) ||
        !provenance.success ||
        sources.some((old) => old.id === s.id)
      )
        return null;
      if (
        (s.label !== undefined && !text(s.label, 200)) ||
        (s.unit !== undefined && !text(s.unit, 80)) ||
        (s.value !== undefined &&
          s.value !== null &&
          (typeof s.value !== 'number' || !Number.isFinite(s.value)))
      )
        return null;
      sources.push({
        id: s.id,
        source: s.source,
        method: s.method,
        fetchedAt: s.fetchedAt,
        provenance: provenance.data,
        ...(s.label !== undefined ? { label: s.label as string } : {}),
        ...(s.unit !== undefined ? { unit: s.unit as string } : {}),
        ...(s.value !== undefined ? { value: s.value as number | null } : {}),
      });
    }
    const allocations: VaultStrategyPreview['allocations'] = [];
    for (const raw of p.allocations) {
      const a = record(raw);
      const asset = AssetId.safeParse(a?.assetId);
      if (
        !a ||
        !asset.success ||
        !asset.data.startsWith(`${chain}:`) ||
        !Number.isInteger(a.weightBps) ||
        (a.weightBps as number) <= 0 ||
        (a.weightBps as number) > 10_000 ||
        !text(a.why, 1000) ||
        !texts(a.evidenceIds, 160) ||
        a.evidenceIds.length < 1 ||
        a.evidenceIds.length > 16 ||
        (a.symbol !== undefined && !text(a.symbol, 80)) ||
        !a.evidenceIds.every((id) => sources.some((s) => s.id === id)) ||
        allocations.some((old) => old.assetId === asset.data)
      )
        return null;
      allocations.push({
        assetId: asset.data,
        weightBps: a.weightBps as number,
        why: a.why,
        evidenceIds: a.evidenceIds,
        ...(a.symbol ? { symbol: a.symbol as string } : {}),
      });
    }
    if (allocations.reduce((sum, a) => sum + a.weightBps, 0) !== 10_000) return null;
    // An older server sends neither list: no warning and no note, never a guess.
    const warnings: VaultStrategyPreview['warnings'] = [];
    if (row.warnings != null && !Array.isArray(row.warnings)) return null;
    for (const raw of Array.isArray(row.warnings) ? row.warnings : []) {
      const w = record(raw);
      if (
        !w ||
        typeof w.code !== 'string' ||
        !WARNING_CODES.has(w.code) ||
        !allocations.some((a) => a.assetId === w.assetId) ||
        !sources.some((source) => source.id === w.evidenceId)
      )
        return null;
      warnings.push({
        code: w.code as VaultStrategyPreview['warnings'][number]['code'],
        assetId: w.assetId as string,
        evidenceId: w.evidenceId as string,
      });
    }
    proposal = {
      objective: p.objective,
      summary: p.summary,
      allocations,
      tradeoffs: p.tradeoffs,
      unknowns: p.unknowns,
      sources,
      warnings,
      weightNotes: notes,
      ...(projectionOf(p.projection) ? { projection: projectionOf(p.projection) } : {}),
    };
  }
  const figures = replyFiguresOf(row.figures, proposal !== undefined);
  return {
    message: row.message,
    ...(row.question ? { question: row.question as string } : {}),
    ...(figures ? { figures } : {}),
    ...(proposal ? { proposal } : notes.length ? { notes } : {}),
  };
}

/** Vault replies additionally bind the owner-only conversation to its actual address. */
export function agentReplyOf(value: unknown, vault: VaultResponse): VaultAgentReply | null {
  const row = record(value);
  if (
    typeof row?.address !== 'string' ||
    !sameAddress(vault.chain, row.address, vault.vault.address)
  )
    return null;
  return strategyReplyOf(value, vault.chain);
}

export function vaultAgent(
  api: ApiFetch,
  chain: VaultResponse['chain'],
  address: string,
): VaultAgent {
  return async (request) => {
    const response = await api(
      `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/conversation/reply`,
      {
        method: 'POST',
        signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          language: request.language,
          // An earlier reply goes back with its placeholders, not with the values of its day: the
          // model never reads a number of its own there to repeat.
          messages: request.transcript.map(({ who, text, figures }) => ({
            who,
            text: figures?.template ?? text,
          })),
          messageId: request.transcript.at(-1)?.id,
        }),
      },
    );
    if (!response.ok)
      throw new VaultAgentError(
        [404, 405, 501, 503].includes(response.status) ? 'unavailable' : 'failed',
      );
    const body = await response.json();
    if (
      body.messageId !== request.transcript.at(-1)?.id ||
      body.chain !== chain ||
      typeof body.address !== 'string' ||
      !sameAddress(chain, body.address, address)
    )
      throw new VaultAgentError('failed');
    return body;
  };
}

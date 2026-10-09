import { z } from 'zod';
import { AssetId, Bps, Sourced } from './chain';
import { FactNullReason } from './facts';

const prose = (max: number) => z.string().trim().min(1).max(max);
export const VaultAgentMessage = z.discriminatedUnion('who', [
  z.strictObject({ who: z.literal('person'), text: prose(2000) }),
  z.strictObject({ who: z.literal('app'), text: prose(8000) }),
]);
export const VaultAgentRequest = z
  .strictObject({
    version: z.literal(1),
    language: z.enum(['en', 'pt']),
    messageId: prose(64),
    messages: z.array(VaultAgentMessage).min(1).max(400),
  })
  .superRefine((request, context) => {
    if (request.messages.at(-1)?.who !== 'person')
      context.addIssue({
        code: 'custom',
        path: ['messages'],
        message: 'The latest message must be from the person.',
      });
    const people = request.messages.filter((message) => message.who === 'person');
    if (
      people.length > 200 ||
      people.map((message) => message.text).join('\n\n').length > 22_000 ||
      request.messages.map((message) => message.text).join('\n\n').length > 220_000
    )
      context.addIssue({
        code: 'custom',
        path: ['messages'],
        message: 'The conversation exceeds its capacity.',
      });
  });
export type VaultAgentRequest = z.infer<typeof VaultAgentRequest>;

/** What the model picks: an asset, why, and the evidence. It never sets a weight (ANY-COMPOSITION). */
export const VaultAgentPick = z.strictObject({
  assetId: AssetId,
  why: prose(1000),
  evidenceIds: z.array(prose(160)).min(1).max(16),
});
/** A served line: the pick and the weight the server set from the person's words. */
export const VaultAgentAllocation = VaultAgentPick.extend({
  weightBps: Bps.refine((value) => value > 0, 'An allocation must have a positive share.'),
});
/**
 * A share the person stated, as the model understood it (Rodrigo's `stated`): the assets it covers,
 * exact, at least or at most, in basis points, and the person's own words. It sets no weight: the
 * server reads the person's shares from their messages itself (ANY-COMPOSITION), and a share here that
 * it did not read is refused once so the model asks the person. It is never served back.
 */
export const VaultAgentStatedShare = z.strictObject({
  assetIds: z.array(AssetId).min(1).max(64),
  kind: z.enum(['exact', 'min', 'max']),
  bps: Bps,
  quote: prose(400),
});
export type VaultAgentStatedShare = z.infer<typeof VaultAgentStatedShare>;
export const VaultAgentModelProposal = z.strictObject({
  objective: prose(800),
  summary: prose(1600),
  allocations: z.array(VaultAgentPick).min(1).max(64),
  stated: z.array(VaultAgentStatedShare).max(16),
  tradeoffs: z.array(prose(600)).max(12),
  unknowns: z.array(prose(600)).max(12),
});
/**
 * What a new goal's money is for and the risk the person accepts, as the server read them in the
 * person's own messages (`statedPurpose`, apps/api). Null: the person has not plainly said it. Never
 * the model's reading, and never a default.
 */
export const VaultAgentStatedPurpose = z.strictObject({
  goal: z.enum(['grow', 'income', 'protect']).nullable(),
  risk: z.enum(['low', 'medium', 'high']).nullable(),
});
export type VaultAgentStatedPurpose = z.infer<typeof VaultAgentStatedPurpose>;
export const VaultAgentModelReply = z.strictObject({
  message: prose(2400),
  question: prose(500).nullable(),
  proposal: VaultAgentModelProposal.nullable(),
});
export type VaultAgentModelReply = z.infer<typeof VaultAgentModelReply>;

/** Sources and display metrics are authored by the server, never accepted from the model. */
export const VaultAgentSource = Sourced.extend({
  id: prose(160),
  assetId: AssetId.optional(),
  label: prose(200).optional(),
  value: z.number().finite().nullable().optional(),
  unit: prose(80).optional(),
});
export type VaultAgentSource = z.infer<typeof VaultAgentSource>;
/**
 * The month-by-month balance a plan with sourced yield lines is projected to (the relaxed intake, gate
 * RELAXED-INTAKE), worked out by the server from those readings. Past-rate arithmetic, never a promise: `basis` says so and
 * names the readings, and `sourceIds` point at them in `sources`. Empty `months`: no amount yet.
 */
export const VaultAgentProjection = z.strictObject({
  currency: prose(8),
  rate: z.number().finite(),
  step: z.union([z.literal(1), z.literal(12)]),
  months: z
    .array(
      z.strictObject({
        month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        balance: z.number().finite(),
        earned: z.number().finite(),
        withdrawn: z.number().finite(),
      }),
    )
    .max(121),
  basis: prose(1200),
  sourceIds: z.array(prose(160)).max(64),
});
export type VaultAgentProjection = z.infer<typeof VaultAgentProjection>;
export const VaultAgentProposal = VaultAgentModelProposal.omit({ stated: true }).extend({
  allocations: z
    .array(VaultAgentAllocation.extend({ symbol: prose(80) }))
    .min(1)
    .max(64),
  sources: z.array(VaultAgentSource).max(1024),
  projection: VaultAgentProjection.optional(),
});
/**
 * Server-written notes on a proposal the person may still choose (gate ANY-COMPOSITION). The code names
 * the condition and `evidenceId` the source behind it, one of the reply's `proposal.sources`; the screen
 * writes the words. `over_exit_capacity`: the weight is above what the measured exit capacity can sell
 * at the vault's current size, and the source is that measured figure. `outside_goal_requested`: a stock
 * outside the goal's eligibility (an income or protect goal) that is there because the person asked for
 * it, and the source is the asset's catalog listing.
 */
export const VaultAgentWarning = z.strictObject({
  code: z.enum(['over_exit_capacity', 'outside_goal_requested']),
  assetId: AssetId,
  evidenceId: prose(160),
});
export type VaultAgentWarning = z.infer<typeof VaultAgentWarning>;
/**
 * What the server did with the weights, so nothing it did is silent (ANY-COMPOSITION). The screen writes
 * the words from the code, the served weights and the person's own `quote`, which the server cut from
 * their message; no figure or word here is the model's. `equal_split`: these picks share equally.
 * `stated`: these picks follow the share the server read in the person's words, `quote` ("from your
 * words: 70% TSLA"). `scaled`: the shares the person gave did not add up to the whole and were scaled to it.
 * `pick_dropped`: the person's shares left nothing for this pick, so it is not in the proposal.
 * `share_unmet`: the picks cannot meet the share in `quote`, and the person is asked about it.
 * `share_unread`: the person's latest message holds what reads as a share and the server did not apply
 * it (`quote`): anything that is not a plain ask with the number beside the asset ("mostly Tesla",
 * "70% TSLA is too risky", "a third in TSLA", "I don't want 70% TSLA", "60% TSLA for growth", "the rest
 * in gold" when the rest did not go there). The weights do not follow it. `share_withdrawn`: the
 * person's latest message withdrew the share in `quote` ("Forget TSLA", "split it equally").
 * `pick_outside_goal`: the model picked these assets and a plan for the vault's goal cannot hold them
 * (in an income or protect plan: any class outside the goal but a stock, which the review of the
 * targets refuses, or a stock the person did not ask for), so they are not in the proposal.
 */
export const VaultAgentWeightNote = z.strictObject({
  code: z.enum([
    'equal_split',
    'stated',
    'scaled',
    'pick_dropped',
    'share_unmet',
    'share_unread',
    'share_withdrawn',
    'pick_outside_goal',
  ]),
  assetIds: z.array(AssetId).max(64),
  quote: prose(400).optional(),
});
export type VaultAgentWeightNote = z.infer<typeof VaultAgentWeightNote>;
/**
 * A figure the conversation states by reference (gate `FIGURES-BY-REFERENCE`). The model writes
 * `{{fact:<id>}}` where a number would stand and never the number; the server resolves the id against
 * the evidence of that request and writes everything here. Measured: the value, its unit, `text` as it
 * is shown ("$1,234.56", "0.42%"), its pin, and `staleAgeSec` when the figure has an age limit and is
 * past it (a price the chain's vault no longer trades on), else null. Not measured: null with the
 * reason, and `text` says so in words with no number.
 */
const figureHead = {
  id: prose(160),
  assetId: AssetId.optional(),
  label: prose(200).optional(),
  text: prose(200),
};
export const VaultAgentFigure = z.union([
  z.strictObject({
    ...figureHead,
    value: z.number().finite(),
    unit: prose(80),
    source: prose(2000),
    method: prose(2000),
    fetchedAt: Sourced.shape.fetchedAt,
    provenance: Sourced.shape.provenance,
    staleAgeSec: z.number().finite().nonnegative().nullable(),
    /** The true value is at least this: `text` says "at least". */
    lowerBound: z.literal(true).optional(),
  }),
  z.strictObject({ ...figureHead, value: z.null(), reason: FactNullReason }),
]);
export type VaultAgentFigure = z.infer<typeof VaultAgentFigure>;
/** How a figure stands in prose that keeps its place: `{{fact:<id>}}`, the id one of `facts`. */
export const FIGURE_REFERENCE = /\{\{fact:([^{}\s]{1,160})\}\}/gu;
/**
 * The figures of one reply. The reply's own prose fields hold each figure's `text` inline, so a client
 * that does not know this field shows plain words and no braces. `prose` is the same prose with each
 * figure a `{{fact:<id>}}` placeholder, for a client that draws the figure with its pin: `why` by asset,
 * the lists in the order of the proposal's. Every placeholder names one of `facts`.
 */
export const VaultAgentFigures = z
  .strictObject({
    prose: z.strictObject({
      message: prose(9600),
      question: prose(2000).nullable(),
      proposal: z
        .strictObject({
          objective: prose(3200),
          summary: prose(6400),
          tradeoffs: z.array(prose(2400)).max(12),
          unknowns: z.array(prose(2400)).max(12),
          why: z.record(AssetId, prose(4000)),
        })
        .nullable(),
    }),
    facts: z.array(VaultAgentFigure).min(1).max(64),
  })
  .superRefine((figures, context) => {
    const ids = figures.facts.map((fact) => fact.id);
    const known = new Set(ids);
    if (known.size !== ids.length)
      context.addIssue({ code: 'custom', path: ['facts'], message: 'A figure is listed once.' });
    const { message, question, proposal } = figures.prose;
    const texts = [
      message,
      question ?? '',
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
    for (const text of texts)
      for (const match of text.matchAll(FIGURE_REFERENCE))
        if (!known.has(match[1] ?? ''))
          context.addIssue({
            code: 'custom',
            path: ['prose'],
            message: 'A placeholder names one of the facts.',
          });
  });
export type VaultAgentFigures = z.infer<typeof VaultAgentFigures>;
/** The reply's fields; `VaultAgentReply` adds the rule that ties its notes to its proposal. */
export const VaultAgentReplyShape = z.strictObject({
  version: z.literal(1),
  messageId: prose(64),
  message: prose(2400),
  question: prose(500).nullable(),
  proposal: VaultAgentProposal.nullable(),
  warnings: z.array(VaultAgentWarning).max(128),
  weightNotes: z.array(VaultAgentWeightNote).max(64),
  /** Present when the reply states a figure by reference; absent otherwise. */
  figures: VaultAgentFigures.optional(),
});
/**
 * A warning belongs to the proposal: none without one, and each on one of its assets and sources. A
 * note on served weights (`equal_split`, `stated`, `scaled`) names served picks; without a proposal only
 * `share_unmet`, `share_unread` and `pick_outside_goal` can stand. An asset left out for the goal is
 * not among the proposal's.
 */
export function warningsBelong(
  reply: Pick<z.infer<typeof VaultAgentReplyShape>, 'proposal' | 'warnings' | 'weightNotes'>,
  context: z.RefinementCtx,
): void {
  const assets = new Set(reply.proposal?.allocations.map((line) => line.assetId));
  const sources = new Set(reply.proposal?.sources.map((source) => source.id));
  reply.warnings.forEach((warning, index) => {
    if (!assets.has(warning.assetId) || !sources.has(warning.evidenceId))
      context.addIssue({
        code: 'custom',
        path: ['warnings', index],
        message: 'A warning names an asset and a source of the proposal.',
      });
  });
  reply.weightNotes.forEach((note, index) => {
    const served = note.code === 'equal_split' || note.code === 'stated' || note.code === 'scaled';
    if (
      (served && (!reply.proposal || note.assetIds.some((id) => !assets.has(id)))) ||
      (note.code === 'pick_dropped' && !reply.proposal) ||
      (note.code === 'pick_outside_goal' && note.assetIds.some((id) => assets.has(id)))
    )
      context.addIssue({
        code: 'custom',
        path: ['weightNotes', index],
        message: 'A note names picks of the proposal, or for the goal none of them.',
      });
  });
}
export const VaultAgentReply = VaultAgentReplyShape.superRefine(warningsBelong);
export type VaultAgentReply = z.infer<typeof VaultAgentReply>;
export type VaultAgentFailure = 'unavailable' | 'timeout' | 'budget' | 'invalid';
/**
 * Present when the first reply failed check `failed` and the model was asked once to correct it:
 * `outcome` is `repaired`, `prose_figure_trimmed` when the second attempt was served without the
 * `sentencesCut` sentences that still stated a figure, or the code the second attempt ended on. Codes
 * and a count only, for the server log.
 */
export type VaultAgentRepairNote = { failed: string; outcome: string; sentencesCut?: number };
/**
 * What became of the references in the model's prose, for the server log: counts only. `resolved` and
 * `missing` (a figure that is not measured, said with its reason) are in the served reply; `unknown`
 * counts, over both attempts, what was found wrong with a reference: one that named no figure of the
 * request, a malformed one, or one that did not stand alone as the figure it is.
 */
export type VaultAgentFigureCounts = { resolved: number; missing: number; unknown: number };
export type VaultAgentResult =
  | {
      kind: 'reply';
      reply: VaultAgentReply;
      repair?: VaultAgentRepairNote;
      figures?: VaultAgentFigureCounts;
    }
  /** `detail` is a fixed code for the server log (which check failed); never the person's text. */
  | { kind: 'failure'; reason: VaultAgentFailure; detail?: string; repair?: VaultAgentRepairNote };

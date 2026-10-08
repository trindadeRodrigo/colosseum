import { z } from 'zod';
import { AssetId, Bps, Sourced } from './chain';

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
 * What the money is for and the risk the person accepts, as the model read them in a new-goal
 * conversation: each a value the person stated or confirmed, with their own words for it, or null when
 * unsaid. The server keeps a value only where its quote is in one of the person's messages
 * (`VaultAgentStatedPurpose`); it never fills one in.
 */
export const VaultAgentPurpose = z.strictObject({
  goal: z.enum(['grow', 'income', 'protect']).nullable(),
  goalQuote: prose(400).nullable(),
  risk: z.enum(['low', 'medium', 'high']).nullable(),
  riskQuote: prose(400).nullable(),
});
export type VaultAgentPurpose = z.infer<typeof VaultAgentPurpose>;
/** The goal and risk the person said, as served with a new-goal reply. Null: the person has not said. */
export const VaultAgentStatedPurpose = VaultAgentPurpose.pick({ goal: true, risk: true });
export type VaultAgentStatedPurpose = z.infer<typeof VaultAgentStatedPurpose>;
export const VaultAgentModelReply = z.strictObject({
  message: prose(2400),
  question: prose(500).nullable(),
  proposal: VaultAgentModelProposal.nullable(),
  purpose: VaultAgentPurpose.nullable().optional(),
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
export const VaultAgentProposal = VaultAgentModelProposal.omit({ stated: true }).extend({
  allocations: z
    .array(VaultAgentAllocation.extend({ symbol: prose(80) }))
    .min(1)
    .max(64),
  sources: z.array(VaultAgentSource).max(1024),
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
  ]),
  assetIds: z.array(AssetId).max(64),
  quote: prose(400).optional(),
});
export type VaultAgentWeightNote = z.infer<typeof VaultAgentWeightNote>;
/** The reply's fields; `VaultAgentReply` adds the rule that ties its notes to its proposal. */
export const VaultAgentReplyShape = z.strictObject({
  version: z.literal(1),
  messageId: prose(64),
  message: prose(2400),
  question: prose(500).nullable(),
  proposal: VaultAgentProposal.nullable(),
  warnings: z.array(VaultAgentWarning).max(128),
  weightNotes: z.array(VaultAgentWeightNote).max(64),
});
/**
 * A warning belongs to the proposal: none without one, and each on one of its assets and sources. A
 * note on served weights (`equal_split`, `stated`, `scaled`) names served picks; without a proposal only
 * `share_unmet` and `share_unread` can stand.
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
      (note.code === 'pick_dropped' && !reply.proposal)
    )
      context.addIssue({
        code: 'custom',
        path: ['weightNotes', index],
        message: 'A note on served weights names picks of the proposal.',
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
export type VaultAgentResult =
  /** `purpose`: a new-goal reply's goal and risk as the person said them; absent for a vault. */
  | {
      kind: 'reply';
      reply: VaultAgentReply;
      purpose?: VaultAgentStatedPurpose;
      repair?: VaultAgentRepairNote;
    }
  /** `detail` is a fixed code for the server log (which check failed); never the person's text. */
  | { kind: 'failure'; reason: VaultAgentFailure; detail?: string; repair?: VaultAgentRepairNote };

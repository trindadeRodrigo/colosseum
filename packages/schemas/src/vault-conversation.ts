import { z } from 'zod';
import { BasketSheet } from './basket-sheet';
import { ChainId } from './chain';
import { Network } from './chain-config';
import { Language, Provenance } from './enums';

// Private user data, never an executable sheet, confirmation, or source of financial figures.
// App text is displayed as plain text history; reopening must ask intake for a fresh reading.
export const VAULT_CONVERSATION_LIMITS = {
  personMax: 200,
  personTextMax: 2000,
  personChars: 22_000,
  transcriptMax: 400,
  appTextMax: 8000,
  transcriptChars: 220_000,
  bodyBytes: 512 * 1024,
} as const;
const plain = z.string().refine(
  (s) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls and bidi overrides
    !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
      s,
    ),
  'plain text only',
);
const personText = plain
  .min(1)
  .max(VAULT_CONVERSATION_LIMITS.personTextMax)
  .refine((s) => s.trim().length > 0, 'a message says something');
const budget = (words: readonly string[]) => words.map((s) => s.trim()).join('\n\n').length;
export const VaultConversationAnswers = BasketSheet.pick({
  goal: true,
  amountUsd: true,
  incomeTargetUsdMonthly: true,
  horizonMonths: true,
  horizonOpen: true,
  risk: true,
  currency: true,
})
  .partial()
  .strict();
const held = z
  .strictObject({
    growthBps: z.number().int().min(0).max(10_000),
    dollarYieldBps: z.number().int().min(0).max(10_000),
    goldBps: z.number().int().min(0).max(10_000),
    cashBps: z.number().int().min(0).max(10_000),
  })
  .refine((m) => Object.values(m).reduce((n, v) => n + v, 0) === 10_000, 'shares total 10000');
export const VaultConversationCheckpoint = z
  .strictObject({
    version: z.literal(1),
    language: Language,
    words: z.array(personText).max(VAULT_CONVERSATION_LIMITS.personMax),
    answers: VaultConversationAnswers,
    answersThen: z.array(VaultConversationAnswers).max(199),
    held: held.nullable().optional(),
    questionThen: z.array(z.literal('interestClarification').nullable()).max(199).optional(),
    pendingInterest: z
      .strictObject({ quote: personText.max(160), sourceTurn: z.number().int().min(0) })
      .nullable()
      .optional(),
    allocationKeptThrough: z.number().int().min(0).optional(),
    allocation: z
      .strictObject({ text: personText, baseline: z.null(), minimum: z.boolean() })
      .optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (budget(v.words) > VAULT_CONVERSATION_LIMITS.personChars)
      issue('words', 'conversation exceeds 22000 characters');
    const n = Math.max(0, v.words.length - 1);
    if (v.answersThen.length !== n) issue('answersThen', 'one answer snapshot per later message');
    if (v.questionThen && v.questionThen.length !== n)
      issue('questionThen', 'one question origin per later message');
    if (
      v.pendingInterest &&
      !v.words[v.pendingInterest.sourceTurn]?.includes(v.pendingInterest.quote)
    )
      issue('pendingInterest', 'quote must be in the named person message');
    if ((v.allocationKeptThrough ?? 0) > v.words.length)
      issue('allocationKeptThrough', 'position exceeds conversation');
    if (v.allocation && !v.words.slice(v.allocationKeptThrough ?? 0).includes(v.allocation.text))
      issue('allocation', 'allocation must name a person message');
  });
export type VaultConversationCheckpoint = z.infer<typeof VaultConversationCheckpoint>;
const row = { id: plain.min(1).max(64) };
export const VaultConversationTranscript = z
  .array(
    z.discriminatedUnion('who', [
      z.strictObject({ ...row, who: z.literal('person'), text: personText }),
      z.strictObject({
        ...row,
        who: z.literal('app'),
        text: plain.min(1).max(VAULT_CONVERSATION_LIMITS.appTextMax),
      }),
    ]),
  )
  .max(VAULT_CONVERSATION_LIMITS.transcriptMax)
  .superRefine((rows, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const words = rows.filter((r) => r.who === 'person').map((r) => r.text);
    if (
      words.length > VAULT_CONVERSATION_LIMITS.personMax ||
      budget(words) > VAULT_CONVERSATION_LIMITS.personChars
    )
      issue('person history exceeds conversation capacity');
    if (rows.reduce((n, r) => n + r.text.length, 0) > VAULT_CONVERSATION_LIMITS.transcriptChars)
      issue('history exceeds display capacity');
    if (new Set(rows.map((r) => r.id)).size !== rows.length) issue('message ids must be unique');
  });
export type VaultConversationTranscript = z.infer<typeof VaultConversationTranscript>;
export const VaultConversationParams = z.strictObject({
  chain: ChainId,
  address: z.string().min(1).max(128),
});
export const VaultConversationWrite = z.strictObject({
  version: z.literal(1),
  expectedNetwork: Network,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  transcript: VaultConversationTranscript,
  checkpoint: VaultConversationCheckpoint.nullable(),
});
export type VaultConversationWrite = z.infer<typeof VaultConversationWrite>;
export const VaultConversationResponse = z.strictObject({
  version: z.literal(1),
  chain: ChainId,
  address: z.string(),
  provenance: Provenance,
  network: Network,
  revision: z.number().int().min(0),
  transcript: VaultConversationTranscript,
  checkpoint: VaultConversationCheckpoint.nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type VaultConversationResponse = z.infer<typeof VaultConversationResponse>;
export const VaultConversationUnavailable = z.strictObject({
  error: z.string(),
  code: z.literal('CONVERSATION_STORE_UNAVAILABLE'),
});
export const VaultConversationRevisionError = z.strictObject({
  error: z.string(),
  details: z.strictObject({
    reason: z.literal('REVISION_CONFLICT'),
    revision: z.number().int().min(0),
  }),
});

export const VaultConversationNetworkError = z.strictObject({
  error: z.string(),
  details: z.strictObject({ reason: z.literal('NETWORK_CONFLICT') }),
});

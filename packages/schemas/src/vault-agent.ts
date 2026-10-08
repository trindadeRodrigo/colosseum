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

export const VaultAgentAllocation = z.strictObject({
  assetId: AssetId,
  weightBps: Bps.refine((value) => value > 0, 'An allocation must have a positive share.'),
  why: prose(1000),
  evidenceIds: z.array(prose(160)).min(1).max(16),
});
export const VaultAgentModelProposal = z.strictObject({
  objective: prose(800),
  summary: prose(1600),
  allocations: z.array(VaultAgentAllocation).min(1).max(64),
  tradeoffs: z.array(prose(600)).max(12),
  unknowns: z.array(prose(600)).max(12),
});
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
export const VaultAgentProposal = VaultAgentModelProposal.extend({
  allocations: z
    .array(VaultAgentAllocation.extend({ symbol: prose(80) }))
    .min(1)
    .max(64),
  sources: z.array(VaultAgentSource).max(1024),
});
export const VaultAgentReply = z.strictObject({
  version: z.literal(1),
  messageId: prose(64),
  message: prose(2400),
  question: prose(500).nullable(),
  proposal: VaultAgentProposal.nullable(),
});
export type VaultAgentReply = z.infer<typeof VaultAgentReply>;
export type VaultAgentFailure = 'unavailable' | 'timeout' | 'budget' | 'invalid';
export type VaultAgentResult =
  | { kind: 'reply'; reply: VaultAgentReply }
  | { kind: 'failure'; reason: VaultAgentFailure };

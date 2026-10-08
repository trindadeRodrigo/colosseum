import type { ChainId } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import {
  strategyReplyOf,
  VaultAgentError,
  type VaultAgentReply,
} from '../vault-conversation/agent';
import type { Turn } from '../vault-conversation/storage';

/** Creation has a chain and person history, never an existing vault or fabricated address. */
export async function goalAgent(
  api: ApiFetch,
  chain: ChainId,
  language: 'en' | 'pt',
  turns: Turn[],
  signal: AbortSignal,
): Promise<VaultAgentReply> {
  const messageId = turns.at(-1)?.id;
  const response = await api(`/v1/conversations/${encodeURIComponent(chain)}/goal/reply`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      messageId,
      language,
      messages: turns.map(({ who, text }) => ({ who, text })),
    }),
  });
  if (!response.ok)
    throw new VaultAgentError(
      [404, 405, 501, 503].includes(response.status) ? 'unavailable' : 'failed',
    );
  const body = await response.json();
  if (body?.messageId !== messageId || body?.address !== undefined)
    throw new VaultAgentError('failed');
  const reply = strategyReplyOf(body, chain);
  if (!reply) throw new VaultAgentError('failed');
  return reply;
}

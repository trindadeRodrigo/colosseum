import type { ChainId } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import {
  strategyReplyOf,
  VaultAgentError,
  type VaultAgentReply,
} from '../vault-conversation/agent';
import type { Turn } from '../vault-conversation/storage';

const GOALS = ['grow', 'income', 'protect'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  allowed.find((option) => option === value) ?? null;

/**
 * A new goal's reply: the conversation's, with what the person said the money is for, the risk they
 * accept and the sum they start with. Each is the server's reading of the person's own words, or null:
 * a server that sends none, or a value this app does not know, is read as not said, and nothing is
 * ever filled in here. The sum only starts the deposit step's amount, which the person can change
 * (gate DEPOSIT-DERIVE).
 */
export type GoalReply = VaultAgentReply & {
  goal: (typeof GOALS)[number] | null;
  risk: (typeof RISKS)[number] | null;
  amountUsd: number | null;
};

const sum = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** Creation has a chain and person history, never an existing vault or fabricated address. */
export async function goalAgent(
  api: ApiFetch,
  chain: ChainId,
  language: 'en' | 'pt',
  turns: Turn[],
  signal: AbortSignal,
): Promise<GoalReply> {
  const messageId = turns.at(-1)?.id;
  const response = await api(`/v1/conversations/${encodeURIComponent(chain)}/goal/reply`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      messageId,
      language,
      // A reply that stated figures goes back with each figure's place held, never its value: the
      // model reads what it wrote, and no served number is read as the person's.
      messages: turns.map(({ who, text, figures }) => ({ who, text: figures?.template ?? text })),
    }),
  });
  if (!response.ok) {
    // Only the server's closed failure vocabulary is surfaced; never its arbitrary error text.
    if (response.status === 503) {
      const failure: unknown = await response.json().catch(() => null);
      if (failure && typeof failure === 'object') {
        const value = failure as Record<string, unknown>;
        if (
          value.code === 'GOAL_AGENT_UNAVAILABLE' &&
          (value.reason === 'unavailable' ||
            value.reason === 'timeout' ||
            value.reason === 'budget' ||
            value.reason === 'invalid')
        )
          throw new VaultAgentError('unavailable', value.reason);
      }
    }
    throw new VaultAgentError(
      [404, 405, 501, 503].includes(response.status) ? 'unavailable' : 'failed',
    );
  }
  const body = await response.json();
  if (body?.messageId !== messageId || body?.address !== undefined)
    throw new VaultAgentError('failed');
  const reply = strategyReplyOf(body, chain);
  if (!reply) throw new VaultAgentError('failed');
  return {
    ...reply,
    goal: oneOf(GOALS, body.goal),
    risk: oneOf(RISKS, body.risk),
    amountUsd: sum(body.amountUsd),
  };
}

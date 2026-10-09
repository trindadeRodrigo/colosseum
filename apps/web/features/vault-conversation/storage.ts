import { type ChainId, chainFamily, type Network, normalizeAddress } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import { networkFor } from '../order/readiness';
import { CONVERSATION_PREFIX } from './forget';

export type Turn = { id: string; who: 'person' | 'app'; text: string };
export type Transcript = { revision: number; transcript: Turn[] };
export type ConversationStore = {
  read: () => Promise<Transcript | null>;
  write: (value: Transcript) => Promise<'saved' | 'conflict' | 'unavailable'>;
};

/** The app's configured network; a mock label never selects or invents a network. */
export function conversationNetwork(chain: ChainId): Network | null {
  const network = networkFor(chain, false);
  return network === 'mock' ? null : network;
}

export function conversationKey(
  user: string,
  chain: ChainId,
  address: string,
  provenance: string,
  network: Network | null,
) {
  // Version two deliberately does not import history written without a network scope.
  return `${CONVERSATION_PREFIX}2:${encodeURIComponent(user)}:${chain}:${network ?? 'unconfigured'}:${normalizeAddress(chainFamily(chain), address)}:${provenance}`;
}

// What our server refuses in a conversation's text (VaultConversationTranscript in packages/schemas):
// control characters but tab and line feed, and the marks that reorder text. A carriage return ends a
// line as a line feed does.
const NOT_PLAIN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters taken out
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A message as our server keeps it: one that held such a character would refuse every later save. */
export function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(NOT_PLAIN, '');
}

/** History is plain text, never a restored sheet, confirmation or executable proposal. */
export function transcriptOf(value: unknown): Transcript | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.revision) || (v.revision as number) < 0 || !Array.isArray(v.transcript))
    return null;
  if (v.transcript.length > 400) return null;
  const rows: Turn[] = [];
  const ids = new Set<string>();
  let personWords = '';
  let total = 0;
  for (const item of v.transcript) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? plainText(row.text) : null;
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 64 ||
      ids.has(row.id) ||
      (row.who !== 'person' && row.who !== 'app') ||
      text === null ||
      !text.trim() ||
      text.length > (row.who === 'person' ? 2000 : 8000)
    )
      return null;
    ids.add(row.id);
    total += text.length;
    if (row.who === 'person') personWords += `${personWords ? '\n\n' : ''}${text.trim()}`;
    rows.push({ id: row.id, who: row.who, text });
  }
  if (
    total > 220_000 ||
    personWords.length > 22_000 ||
    rows.filter((r) => r.who === 'person').length > 200
  )
    return null;
  return { revision: v.revision as number, transcript: rows };
}

export function readLocal(key: string): Transcript {
  try {
    return (
      transcriptOf(JSON.parse(localStorage.getItem(key) ?? 'null')) ?? {
        revision: 0,
        transcript: [],
      }
    );
  } catch {
    return { revision: 0, transcript: [] };
  }
}
export function writeLocal(key: string, value: Transcript): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Our server's route for this history is not on every API yet: a 404 that Fastify says is for a route
// it does not have ("Route GET:… not found") is remembered for the tab, and nothing more is asked of it,
// read or write. A 404 for one vault is that vault's answer and is not remembered.
const NOT_SERVED = 'tf-vault-conversation-server:not-served';
const served = () => {
  try {
    return sessionStorage.getItem(NOT_SERVED) === null;
  } catch {
    return true;
  }
};
async function noteNotServed(response: Response): Promise<void> {
  if (response.status !== 404) return;
  try {
    const body = (await response.json()) as { message?: unknown } | null;
    if (/^Route /.test(String(body?.message ?? ''))) sessionStorage.setItem(NOT_SERVED, '1');
  } catch {
    // Not read, or not kept: the route is asked again next time.
  }
}

/** Optional server adapter. Server text is displayed as history, never replayed as instructions. */
export function serverConversation(
  api: ApiFetch,
  chain: ChainId,
  address: string,
  provenance: string,
  network: Network | null,
  signal?: AbortSignal,
): ConversationStore {
  const path = `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/conversation`;
  return {
    async read() {
      if (network === null || !served()) return null;
      try {
        const response = await api(path, { signal });
        if (!response.ok) {
          await noteNotServed(response);
          return null;
        }
        const body = await response.json();
        if (
          body.version !== 1 ||
          body.chain !== chain ||
          body.network !== network ||
          normalizeAddress(chainFamily(chain), body.address) !==
            normalizeAddress(chainFamily(chain), address) ||
          body.provenance !== provenance
        )
          return null;
        return transcriptOf(body);
      } catch {
        return null;
      }
    },
    async write(value) {
      if (network === null || !served()) return 'unavailable';
      // The one place a conversation is sent from: nothing leaves here with a character our server
      // refuses, whoever made the text. One refused row would refuse every later save of this vault's.
      // A row with nothing left in it is refused too: it is left out.
      const transcript = value.transcript
        .map((row) => ({ ...row, text: plainText(row.text) }))
        .filter((row) => row.text.trim() !== '');
      try {
        const response = await api(path, {
          method: 'PUT',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            expectedNetwork: network,
            expectedRevision: value.revision,
            transcript,
            checkpoint: null,
          }),
        });
        if (!response.ok) {
          await noteNotServed(response);
          return response.status === 409 ? 'conflict' : 'unavailable';
        }
        const body = await response.json();
        const saved = transcriptOf(body);
        return body.version === 1 &&
          body.chain === chain &&
          body.network === network &&
          normalizeAddress(chainFamily(chain), body.address) ===
            normalizeAddress(chainFamily(chain), address) &&
          body.provenance === provenance &&
          saved?.revision === value.revision + 1 &&
          JSON.stringify(saved.transcript) === JSON.stringify(transcript)
          ? 'saved'
          : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

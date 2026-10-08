import { type ChainId, chainFamily, normalizeAddress } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';

export type Turn = { id: string; who: 'person' | 'app'; text: string };
export type Transcript = { revision: number; transcript: Turn[] };
export type ConversationStore = {
  read: () => Promise<Transcript | null>;
  write: (value: Transcript) => Promise<'saved' | 'conflict' | 'unavailable'>;
};

export function conversationKey(user: string, chain: ChainId, address: string, provenance: string) {
  return `tf-vault-conversation:1:${encodeURIComponent(user)}:${chain}:${normalizeAddress(chainFamily(chain), address)}:${provenance}`;
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
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 64 ||
      ids.has(row.id) ||
      (row.who !== 'person' && row.who !== 'app') ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      row.text.length > (row.who === 'person' ? 2000 : 8000)
    )
      return null;
    ids.add(row.id);
    total += row.text.length;
    if (row.who === 'person') personWords += `${personWords ? '\n\n' : ''}${row.text.trim()}`;
    rows.push({ id: row.id, who: row.who, text: row.text });
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

/** Optional server adapter. Server text is displayed as history, never replayed as instructions. */
export function serverConversation(
  api: ApiFetch,
  chain: ChainId,
  address: string,
  provenance: string,
  signal?: AbortSignal,
): ConversationStore {
  const path = `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/conversation`;
  return {
    async read() {
      try {
        const response = await api(path, { signal });
        if (!response.ok) return null;
        const body = await response.json();
        if (
          body.version !== 1 ||
          body.chain !== chain ||
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
      try {
        const response = await api(path, {
          method: 'PUT',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            expectedRevision: value.revision,
            transcript: value.transcript,
            checkpoint: null,
          }),
        });
        if (!response.ok) return response.status === 409 ? 'conflict' : 'unavailable';
        const body = await response.json();
        const saved = transcriptOf(body);
        return body.version === 1 &&
          body.chain === chain &&
          normalizeAddress(chainFamily(chain), body.address) ===
            normalizeAddress(chainFamily(chain), address) &&
          body.provenance === provenance &&
          saved?.revision === value.revision + 1 &&
          JSON.stringify(saved.transcript) === JSON.stringify(value.transcript)
          ? 'saved'
          : 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

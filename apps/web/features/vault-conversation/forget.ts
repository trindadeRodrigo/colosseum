// What this browser keeps of a person's vault conversations, by key, and how it is forgotten. Apart
// from storage.ts so the account can forget it without loading the conversation's network reads.

/** Every conversation key begins so; the next parts are its version and the person's id, encoded. */
export const CONVERSATION_PREFIX = 'tf-vault-conversation:';

/**
 * Forgets the vault conversations kept here for a person (they signed out, or another person signed
 * in), or for everyone when nobody is known. Like the order records, they are private words about money.
 */
export function forgetConversations(userId: string | null): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(CONVERSATION_PREFIX)) continue;
      const user = key.slice(CONVERSATION_PREFIX.length).split(':')[1];
      if (userId === null || user === encodeURIComponent(userId)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

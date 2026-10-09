// Rodrigo, Oct 8 (RELAXED-1): the new-goal conversations kept in this browser, one per id, with
// an index of them. The conversation that existed before the index ('main') keeps its original key, so
// nothing saved earlier is lost. Each conversation's transcript and last preview live under its own
// key; the index only holds ids, a title (the person's first words) and when it was last written.
// What a conversation is called on screen is read from its own turns (`conversationName`, Thom,
// Oct 9), so one saved before that is named the same way; the index's title is no longer read.

import { readLocal } from '../vault-conversation/storage';
import { conversationTitle } from './title';

export type SavedConversation = { id: string; title: string; updatedAt: string };
export type ConversationIndex = { current: string; items: SavedConversation[] };

const MAIN = 'main';
const MAX_ITEMS = 50;

export const conversationStoreKey = (base: string, id: string) =>
  id === MAIN ? base : `${base}:c:${id}`;
const indexKey = (base: string) => `${base}:index`;

function parse(raw: string | null): ConversationIndex | null {
  try {
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== 'object') return null;
    const { current, items } = value as Record<string, unknown>;
    if (typeof current !== 'string' || !Array.isArray(items)) return null;
    const clean = items.filter(
      (item): item is SavedConversation =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as SavedConversation).id === 'string' &&
        typeof (item as SavedConversation).title === 'string' &&
        typeof (item as SavedConversation).updatedAt === 'string',
    );
    return { current, items: clean.slice(0, MAX_ITEMS) };
  } catch {
    return null;
  }
}

export function readIndex(base: string): ConversationIndex {
  try {
    const saved = parse(localStorage.getItem(indexKey(base)));
    if (saved) return saved;
    // Before the index: the one conversation under the base key, if it has words.
    return {
      current: MAIN,
      items: localStorage.getItem(base) ? [{ id: MAIN, title: '', updatedAt: '' }] : [],
    };
  } catch {
    return { current: MAIN, items: [] };
  }
}

export function writeIndex(base: string, index: ConversationIndex) {
  try {
    localStorage.setItem(indexKey(base), JSON.stringify(index));
  } catch {
    // storage full or blocked: the conversation on screen is unaffected
  }
}

/**
 * The name of a conversation kept in this browser: its person's first message, shortened, read from
 * its own turns; `neutral` while it has none.
 */
export const conversationName = (base: string, id: string, neutral: string) =>
  conversationTitle(
    readLocal(conversationStoreKey(base, id)).transcript.find((turn) => turn.who === 'person')
      ?.text,
    neutral,
  );

/**
 * Records that a conversation was written: its first words and time, newest first. Written with no
 * words (started over), nothing is recorded; the index comes back anew, so its names are read again.
 */
export function touch(base: string, index: ConversationIndex, id: string, first: string) {
  if (!first.trim()) return { ...index };
  const rest = index.items.filter((item) => item.id !== id);
  const old = index.items.find((item) => item.id === id);
  const next: ConversationIndex = {
    ...index,
    items: [
      {
        id,
        title: old?.title || conversationTitle(first, ''),
        updatedAt: new Date().toISOString(),
      },
      ...rest,
    ].slice(0, MAX_ITEMS),
  };
  writeIndex(base, next);
  return next;
}

export const newConversationId = () => crypto.randomUUID().slice(0, 8);

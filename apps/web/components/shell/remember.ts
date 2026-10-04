// A choice the person made in the shell (the language, light or dark), kept in a cookie so the server
// reads it and the first paint is already right. One year; nothing but the choice is in it.

const YEAR = 60 * 60 * 24 * 365;

/** Stores the choice, or forgets it when `value` is null. */
export function remember(name: string, value: string | null): void {
  // Forgetting says it both ways: a lifetime of nothing, and a date long past.
  const life =
    value === null ? 'max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT' : `max-age=${YEAR}`;
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not in every browser this app supports, and the cookie is one word the person chose
  document.cookie = `${name}=${value ?? ''}; path=/; ${life}; samesite=lax`;
}

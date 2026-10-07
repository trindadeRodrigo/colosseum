// Whether the sign-in service takes sign-ins from this page's address. A Privy app lists the origins it
// allows (its dashboard's domains, public in the app's settings: `allowed_domains`); from any other its
// API answers 403 `invalid_origin` and its wallet frame is refused, so nobody can sign in there, and a
// session kept there is never refreshed. Its hooks say nothing of it until a call fails, so the bridge
// reads the same public settings itself as it starts, and the screen then says the address is not set
// up: no wait, and no button that could only fail. Asked once per tab: an address found allowed is
// remembered for the tab, so a page load costs the sign-in service no extra call.

const SETTINGS_WAIT_MS = 5_000;
const KEY = (appId: string, origin: string) => `tf-origin-ok:${appId}:${origin}`;

/** This tab already heard that the address is allowed. */
export function originKnownAllowed(appId: string, origin: string): boolean {
  try {
    return window.sessionStorage.getItem(KEY(appId, origin)) === '1';
  } catch {
    return false;
  }
}

export function rememberOriginAllowed(appId: string, origin: string): void {
  try {
    window.sessionStorage.setItem(KEY(appId, origin), '1');
  } catch {
    // No storage in this browser: it is asked again on the next page.
  }
}

/**
 * True only when the settings list the origins they allow and this one is not among them. No list, an
 * empty one (every origin is taken), or an answer that is not the settings: not refused.
 */
export function originRefused(settings: unknown, origin: string): boolean {
  const listed =
    typeof settings === 'object' && settings !== null
      ? (settings as { allowed_domains?: unknown }).allowed_domains
      : undefined;
  if (!Array.isArray(listed) || listed.length === 0) return false;
  const allowed = listed.filter((d): d is string => typeof d === 'string');
  if (allowed.length !== listed.length) return false;
  const bare = (o: string) => o.trim().toLowerCase().replace(/\/+$/, '');
  return !allowed.some((d) => bare(d) === bare(origin));
}

/**
 * Asks the app's public settings: true when they refuse this address, false when they take it, null
 * when they cannot be read. Nothing is said, and nothing remembered, on a guess.
 */
export async function asksOriginRefused(
  appId: string,
  origin: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const res = await fetchFn(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}`, {
      headers: { 'privy-app-id': appId },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(SETTINGS_WAIT_MS),
    });
    if (!res.ok) return null;
    const settings: unknown = await res.json();
    // only settings that read as this app's are an answer either way
    if (typeof settings !== 'object' || settings === null || !('allowed_domains' in settings))
      return null;
    return originRefused(settings, origin);
  } catch {
    return null;
  }
}

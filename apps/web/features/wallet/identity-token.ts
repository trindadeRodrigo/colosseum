// The identity token the API reads a person's wallets from (apps/api/src/plugins/auth.ts). Privy's
// `getIdentityToken()` asks Privy's server for a new one on every call: asked once per API call, Privy
// answered 429 and the call went out without it, so the API answered 401. The token Privy already
// holds (it comes with every sign-in and every refresh of the session) is used as it is. A new one is
// asked for only when there is none, when it has run out, when it does not list a wallet linked since
// it was made, or when the API refused the sign-in; one call at a time, and never again for a while
// after Privy refused. What was held is still sent when asking fails.

/** A token this close to its end is treated as ended: it could run out on the way. */
const MARGIN_SECONDS = 60;
/** After Privy refused or failed, how long before it is asked again. */
export const QUIET_MS = 30_000;
/** A token fetched this recently is fresh enough for a call the API refused. */
export const FRESH_MS = 10_000;

/**
 * A wallet as the identity token lists it, and as the bridge names Privy's linked accounts. A 0x
 * address is the same in any case; a Solana address is not.
 */
export const walletKey = (chainType: string, address: string) =>
  `${chainType}:${/^0x/i.test(address) ? address.toLowerCase() : address}`;

type Claims = { sub: string | null; exp: number | null; wallets: Set<string> };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** What the payload says, unverified: whose token, until when, which wallets. Null if it is not a JWT. */
export function readIdentityToken(token: string): Claims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = record(
      JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))),
    );
    // Privy sends the linked accounts as a JSON string.
    const linked: unknown =
      typeof payload.linked_accounts === 'string'
        ? JSON.parse(payload.linked_accounts)
        : payload.linked_accounts;
    const wallets = new Set<string>();
    for (const item of Array.isArray(linked) ? linked : []) {
      const account = record(item);
      if (
        account.type === 'wallet' &&
        typeof account.chain_type === 'string' &&
        typeof account.address === 'string'
      )
        wallets.add(walletKey(account.chain_type, account.address));
    }
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : null,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
      wallets,
    };
  } catch {
    return null;
  }
}

export type IdentityAsk = {
  /** Who is signed in: a token of anyone else is never sent. */
  userId: string;
  /** The token Privy holds now, or null. */
  held: string | null;
  /** The person's linked wallets as Privy lists them (`walletKey`): the token has to list them too. */
  wallets: readonly string[];
  /** The API refused the sign-in: a new token is wanted, unless one was fetched a moment ago. */
  fresh?: boolean;
};

/** The identity token for each call, from `fetchToken` (Privy's `getIdentityToken`) only when needed. */
export function identityTokens(
  fetchToken: () => Promise<string | null>,
  now: () => number = Date.now,
): (ask: IdentityAsk) => Promise<string | null> {
  let user: string | null = null;
  let fetched: { token: string; at: number } | null = null;
  // The wallets a token was last asked for: a token that does not list them is asked for once.
  let askedFor: string | null = null;
  let quietUntil = 0;
  let inFlight: Promise<string | null> | null = null;

  return async (ask) => {
    if (user !== ask.userId) {
      user = ask.userId;
      fetched = null;
      askedFor = null;
      quietUntil = 0;
    }
    const mine = (token: string | null | undefined) => {
      const claims = token ? readIdentityToken(token) : null;
      return token && claims && claims.sub === ask.userId ? { token, claims } : null;
    };
    const best =
      [mine(ask.held), mine(fetched?.token)]
        .filter((t) => t !== null)
        .sort((a, b) => (b.claims.exp ?? 0) - (a.claims.exp ?? 0))[0] ?? null;
    const alive =
      best !== null && best.claims.exp !== null && best.claims.exp - MARGIN_SECONDS > now() / 1000;
    const want = [...ask.wallets].sort().join(',');
    const lists = best !== null && ask.wallets.every((w) => best.claims.wallets.has(w));
    const justFetched = fetched !== null && now() - fetched.at < FRESH_MS;
    const stale = !alive || (!lists && askedFor !== want) || (ask.fresh === true && !justFetched);
    if (!stale || now() < quietUntil) return best?.token ?? null;

    askedFor = want;
    inFlight ??= fetchToken().finally(() => {
      inFlight = null;
    });
    try {
      const got = mine(await inFlight);
      if (got) {
        fetched = { token: got.token, at: now() };
        return got.token;
      }
    } catch {
      // Privy refused (429) or did not answer: what was held is sent, and Privy is left alone a while.
    }
    quietUntil = now() + QUIET_MS;
    return best?.token ?? null;
  };
}

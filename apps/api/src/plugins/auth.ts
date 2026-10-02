import {
  type Chain,
  type EnvLike,
  normalizeAddress,
  type Owner,
  type Principal,
  type WalletAccount,
} from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';

// Sign-in (DESIGN-VAULT section 9). A person is whoever two Privy tokens say they are, both verified
// here against the app's public keys:
//   Authorization: Bearer <access token>   names the person and proves a live session
//   privy-id-token: <identity token>       lists the wallets linked to that person
// Wallets are read only from the identity token, never from what the request says. The server holds no
// Privy secret, and this file can verify a token and nothing else: it signs nothing.

/** Whose tokens the API trusts: one issuer, one audience, one key set. */
export type TokenIssuer = {
  /** The `iss` claim both tokens must carry. */
  issuer: string;
  /** The `aud` claim both tokens must carry: the app id of this environment. */
  audience: string;
  /** The issuer's public keys. A remote set fetches them on the first token, never at start. */
  keys: JWTVerifyGetKey;
};

const PRIVY_ISSUER = 'privy.io';
/** What Privy signs with. A token that names another algorithm is refused. */
const ALGORITHMS = ['ES256'];
export const IDENTITY_TOKEN_HEADER = 'privy-id-token';

/**
 * The Privy app this environment trusts, from PRIVY_APP_ID (an app id, not a secret) and, optionally,
 * PRIVY_JWKS_URL. Null when no app id is set: every route that needs a person then answers 503. There
 * is no other way to be signed in: no flag skips the check.
 */
export function authFromEnv(env: EnvLike): TokenIssuer | null {
  const appId = env.PRIVY_APP_ID?.trim();
  if (!appId) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error('PRIVY_APP_ID: expected an app id');
  const given = env.PRIVY_JWKS_URL?.trim();
  let url: URL;
  try {
    url = new URL(given || `https://auth.privy.io/api/v1/apps/${appId}/jwks.json`);
  } catch {
    throw new Error('PRIVY_JWKS_URL: expected an https URL');
  }
  if (url.protocol !== 'https:') throw new Error('PRIVY_JWKS_URL: expected an https URL');
  return { issuer: PRIVY_ISSUER, audience: appId, keys: createRemoteJWKSet(url) };
}

/**
 * The wallets in an identity token's `linked_accounts`, which Privy sends as a JSON string. Only wallet
 * entries on Solana or an EVM chain count; an address that is not one of its family's is left out.
 */
export function walletsFromClaim(claim: unknown): WalletAccount[] {
  let list: unknown = claim;
  if (typeof claim === 'string') {
    try {
      list = JSON.parse(claim);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const found = new Map<string, WalletAccount>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const account = item as Record<string, unknown>;
    if (account.type !== 'wallet' || typeof account.address !== 'string') continue;
    const family: Chain | null =
      account.chain_type === 'solana' ? 'solana' : account.chain_type === 'ethereum' ? 'evm' : null;
    if (!family) continue;
    try {
      const address = normalizeAddress(family, account.address);
      found.set(`${family}:${address}`, {
        family,
        address,
        kind: account.wallet_client_type === 'privy' ? 'embedded' : 'external',
      });
    } catch {
      // Not an address of that family: not a wallet this API can act for.
    }
  }
  return [...found.values()];
}

/** 401 when the caller is not signed in; 503 when the issuer's keys could not be read. */
export class AuthError extends Error {
  readonly status: 401 | 503;
  constructor(message: string, status: 401 | 503 = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** jose could not get the key set, which says nothing about the token. */
const keysUnreadable = (e: unknown) =>
  !(e instanceof errors.JOSEError) ||
  e.code === 'ERR_JWKS_TIMEOUT' ||
  e.code === 'ERR_JOSE_GENERIC';

const one = (header: string | string[] | undefined) => (Array.isArray(header) ? header[0] : header);

/** Verifies both tokens and returns who is calling. Throws AuthError, which says what was missing. */
export async function authenticate(
  issuer: TokenIssuer,
  headers: Record<string, string | string[] | undefined>,
  ip: string,
): Promise<Principal> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(one(headers.authorization) ?? '')?.[1];
  if (!bearer) throw new AuthError('sign in first: no access token was sent');
  const identity = one(headers[IDENTITY_TOKEN_HEADER])?.trim();
  if (!identity) throw new AuthError('sign in first: no identity token was sent');
  const check = (token: string, what: string) =>
    jwtVerify(token, issuer.keys, {
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ALGORITHMS,
      requiredClaims: ['sub', 'exp'],
    }).catch((e: unknown) => {
      if (keysUnreadable(e)) throw new AuthError('the sign-in keys could not be read', 503);
      // jose's reason (expired, wrong audience, bad signature) stays in the server: one answer for all.
      throw new AuthError(`the ${what} token is not valid for this app`);
    });
  const access = await check(bearer, 'access');
  const id = await check(identity, 'identity');
  if (!access.payload.sub || access.payload.sub !== id.payload.sub)
    throw new AuthError('the two tokens name different people');
  return {
    kind: 'user',
    userId: access.payload.sub,
    wallets: walletsFromClaim(id.payload.linked_accounts),
    ip,
  };
}

/** True when every address of `owner` is one of the caller's verified wallets. */
export function holds(principal: Principal, owner: Owner): boolean {
  const has = (family: Chain, address: string | undefined) =>
    address === undefined ||
    principal.wallets.some((w) => w.family === family && w.address === address);
  return has('solana', owner.solana) && has('evm', owner.evm);
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `user` needs a signed-in person. A route that says nothing is public if it is a GET and refused if not. */
    auth?: 'public' | 'user';
  }
  interface FastifyRequest {
    /** Set on routes whose `config.auth` is `user`. */
    principal: Principal | null;
  }
}

/**
 * Adds sign-in to a scope. Every route in it declares `config.auth`; a route that does not is served
 * only if it is a GET.
 */
export function registerAuth(scope: FastifyInstance, issuer: TokenIssuer | null): void {
  scope.decorateRequest('principal', null);
  scope.addHook('onRequest', async (req, reply) => {
    const rule = req.routeOptions.config.auth;
    if (rule === 'public') return;
    if (rule !== 'user') {
      if (req.method === 'GET' || req.method === 'HEAD') return;
      return reply.code(403).send({ error: 'this route is closed: it declares no sign-in rule' });
    }
    if (!issuer) return reply.code(503).send({ error: 'sign-in is not set up on this server' });
    try {
      req.principal = await authenticate(issuer, req.headers, req.ip);
    } catch (e) {
      if (e instanceof AuthError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
}

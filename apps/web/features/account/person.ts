import { type Chain, ChainId, PersonResponse, type WalletAccount } from '@colosseum/schemas';

// Who is signed in, and the one chain their plan lives on (gates ONE-CHAIN and CHAIN-PICK). The API
// decides and stores it: GET /v1/me and PUT /v1/me/chain (API-2). Their shape is the shared
// `PersonResponse` (packages/schemas/src/account-api.ts):
//   wallets       the wallets of the verified sign-in, as the API read them
//   chain         null until there is one: the person made their wallet here and has not chosen yet
//   chainSource   `wallet`: the chain of the outside wallet they connected. `picked`: they chose, once
//   chainOptions  what may be chosen. Empty once there is a chain

/** The answer of GET /v1/me and of PUT /v1/me/chain. */
export type Person = PersonResponse;

/** Reads an answer in that shape, or null when it is not one. */
export function readPerson(body: unknown): Person | null {
  const read = PersonResponse.safeParse(body);
  return read.success ? read.data : null;
}

/** `useApiFetch()`: a call to the API with the sign-in headers. */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Why a call about the person failed, for the sentence a screen says.
 * - `unreachable`: the API did not answer, or not in a form this app reads. Asking again may work.
 * - `signed_out`: the API does not know who is asking (401): the sign-in ran out.
 * - `no_identity`: the API was sent no identity token (401), even after the wallet was asked for a new
 *   one: the sign-in service did not give one. Asking again later may work.
 * - `taken`: the chain was set before and is another one (409). It never changes.
 * - `not_offered`: this person cannot choose that chain (422).
 * - `busy`: the API asked for fewer requests (429).
 */
export type PersonFailure =
  | 'unreachable'
  | 'signed_out'
  | 'no_identity'
  | 'taken'
  | 'not_offered'
  | 'busy';

export class PersonError extends Error {
  readonly kind: PersonFailure;
  constructor(kind: PersonFailure) {
    super(kind);
    this.name = 'PersonError';
    this.kind = kind;
  }
}

const KIND_OF_STATUS: Record<number, PersonFailure> = {
  401: 'signed_out',
  409: 'taken',
  422: 'not_offered',
  429: 'busy',
};

/**
 * Why the API refused a sign-in (401), from what it says (apps/api/src/plugins/auth.ts): no identity
 * token was sent, or it does not know the sign-in.
 */
export async function signInRefusal(res: Response): Promise<'no_identity' | 'signed_out'> {
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  const error =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).error : null;
  return typeof error === 'string' && /no identity token/i.test(error)
    ? 'no_identity'
    : 'signed_out';
}

async function ask(apiFetch: ApiFetch, path: string, init?: RequestInit): Promise<Person> {
  let res: Response;
  try {
    res = await apiFetch(path, init);
  } catch {
    throw new PersonError('unreachable');
  }
  if (res.status === 401) throw new PersonError(await signInRefusal(res));
  if (!res.ok) throw new PersonError(KIND_OF_STATUS[res.status] ?? 'unreachable');
  const person = readPerson(await res.json().catch(() => null));
  if (!person) throw new PersonError('unreachable');
  return person;
}

/** GET /v1/me. */
export const fetchPerson = (apiFetch: ApiFetch): Promise<Person> => ask(apiFetch, '/v1/me');

/**
 * PUT /v1/me/chain. The API stores it once: the same chain again answers as before, another one is
 * refused (`taken`).
 */
export const storeChain = (apiFetch: ApiFetch, chain: ChainId): Promise<Person> =>
  ask(apiFetch, '/v1/me/chain', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chain }),
  });

/**
 * The chain a wallet family means. A Solana wallet is on Solana. An EVM address serves every EVM
 * chain; while Base is not deployed it means Robinhood Chain. The API holds the same table.
 */
export const HOME_CHAIN: Record<Chain, ChainId> = { solana: 'solana', evm: 'robinhood' };

/**
 * The person as the API would describe them, worked out here, for the throwaway wallet of development
 * only: it has no account on the API. An outside wallet names the chain of its family; a wallet made
 * in the app needs a choice, which `picked` holds for as long as the page is open.
 */
export function localPerson(
  userId: string,
  wallets: readonly WalletAccount[],
  picked: ChainId | null,
): Person {
  const mine = [...wallets];
  if (picked)
    return { userId, wallets: mine, chain: picked, chainSource: 'picked', chainOptions: [] };
  const outside = new Set(mine.filter((w) => w.kind === 'external').map((w) => w.family));
  const [only] = outside;
  if (outside.size === 1 && only)
    return {
      userId,
      wallets: mine,
      chain: HOME_CHAIN[only],
      chainSource: 'wallet',
      chainOptions: [],
    };
  const held = new Set(mine.map((w) => HOME_CHAIN[w.family]));
  return {
    userId,
    wallets: mine,
    chain: null,
    chainSource: null,
    chainOptions: ChainId.options.filter((chain) => held.has(chain)),
  };
}

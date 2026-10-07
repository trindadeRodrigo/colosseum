import { type ReactNode, useEffect, useRef, useSyncExternalStore } from 'react';

// What stands in for Privy's hooks in the test of the bridge (privy-bridge.events.test.ts):
//
//   vi.mock('@privy-io/react-auth', async () => (await import('./test/privy-double')).reactAuth);
//   vi.mock('@privy-io/react-auth/solana', async () => (await import('./test/privy-double')).solana);
//
// It keeps a person the way Privy does: a list of linked accounts that grows when a wallet is made.
// A call to make a wallet does not answer by itself: the test answers it, so it sees what the bridge
// does while a call is on its way. It hands out identity tokens the way Privy does: one with the
// sign-in, listing the wallets linked at that moment, and a new one from each `getIdentityToken()`,
// which is a call to Privy's server that the double counts and can refuse with a 429.

type Family = 'solana' | 'ethereum';
type Linked = { type: string; chainType?: Family; walletClientType?: string; address?: string };
type Person = { id: string; linkedAccounts: Linked[] };
type Snapshot = {
  ready: boolean;
  authenticated: boolean;
  user: Person | null;
  /** What `useIdentityToken()` answers: the token Privy holds. */
  identityToken: string | null;
};

/** A call to make a wallet that has not answered yet. */
export type PendingWallet = {
  family: Family;
  /** Privy makes the wallet: the person's list has it, then the call returns. */
  made(): void;
  /** The call fails, and no wallet is made. */
  fails(message?: string): void;
  /**
   * Privy's answer when the person has a wallet of this family already, in the words it throws.
   * `listed` is whether the person's list on this page shows that wallet by then.
   */
  alreadyThere(listed?: boolean): void;
};

const listeners = new Set<() => void>();
let snapshot: Snapshot = { ready: true, authenticated: false, user: null, identityToken: null };
let inFlight = 0;

const ADDRESS: Record<Family, string> = {
  solana: 'So11111111111111111111111111111111111111112',
  ethereum: '0x204faca1764b154221e35c0d20abb3c525710498',
};

function show(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * An identity token as Privy's payload has it, unsigned (the API checks the signature; the bridge only
 * reads it): whose, until when, and the linked accounts as a JSON string.
 */
export function identityTokenOf(person: Person, expiresInSeconds = 3600): string {
  const linked = person.linkedAccounts
    .filter((a) => a.type === 'wallet')
    .map((a) => ({ type: 'wallet', address: a.address, chain_type: a.chainType }));
  const payload = {
    iss: 'privy.io',
    aud: 'app-id',
    sub: person.id,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    linked_accounts: JSON.stringify(linked),
  };
  return `${base64url({ alg: 'ES256', typ: 'JWT' })}.${base64url(payload)}.signature`;
}

/** Adds a wallet to the person it was made for, if they are still the one signed in. */
function link(owner: string | undefined, account: Linked) {
  if (!snapshot.user || snapshot.user.id !== owner) return;
  show({
    ...snapshot,
    user: { ...snapshot.user, linkedAccounts: [...snapshot.user.linkedAccounts, account] },
  });
}

export const privyDouble = {
  /** Every call to make a wallet, in the order it was made. */
  calls: [] as Family[],
  /** The calls that have not answered yet. */
  pending: [] as PendingWallet[],
  /** The most calls that were on their way at the same moment. */
  mostAtOnce: 0,
  /** Calls made through the hooks of a provider that was no longer mounted. */
  deadCalls: 0,
  /** How many times the bridge asked Privy's server for an identity token. */
  identityFetches: 0,
  /** Privy's server answers an identity-token call with 429 while this is true. */
  limited: false,
  /** What a sign-in with a passkey answers: at once, unless a test holds it open. */
  passkey: (async () => ({})) as () => Promise<unknown>,
  /** Starts over: Privy loaded, and this person signed in (or nobody), with an identity token. */
  reset(user: Person | null = null) {
    privyDouble.calls.length = 0;
    privyDouble.pending.length = 0;
    privyDouble.mostAtOnce = 0;
    privyDouble.deadCalls = 0;
    privyDouble.identityFetches = 0;
    privyDouble.limited = false;
    privyDouble.passkey = async () => ({});
    inFlight = 0;
    show({
      ready: true,
      authenticated: user !== null,
      user,
      identityToken: user ? identityTokenOf(user) : null,
    });
  },
  /** Privy has not loaded: its hooks say `ready: false`, and nobody. */
  notLoaded() {
    show({ ready: false, authenticated: false, user: null, identityToken: null });
  },
  /** Privy now holds this identity token, as after a refresh of the session. */
  holdIdentity(token: string | null) {
    show({ ...snapshot, identityToken: token });
  },
  /** A person who signed in with a passkey and has no wallet yet. */
  passkeyPerson: (id = 'did:privy:one'): Person => ({ id, linkedAccounts: [{ type: 'passkey' }] }),
  /** A person who signed in with an outside wallet. */
  walletPerson: (family: Family, id = 'did:privy:two'): Person => ({
    id,
    linkedAccounts: [
      { type: 'wallet', chainType: family, walletClientType: 'phantom', address: ADDRESS[family] },
    ],
  }),
  signIn(user: Person) {
    show({ ready: true, authenticated: true, user, identityToken: identityTokenOf(user) });
  },
  signOut() {
    show({ ready: true, authenticated: false, user: null, identityToken: null });
  },
  linked: () => snapshot.user?.linkedAccounts ?? [],
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const useSnapshot = () => useSyncExternalStore(subscribe, () => snapshot);

/** Whether the component that called a hook is still mounted. */
const useAlive = () => {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
};

const createWallet = (family: Family, alive: { current: boolean }) => () =>
  new Promise<unknown>((resolve, reject) => {
    privyDouble.calls.push(family);
    if (!alive.current) privyDouble.deadCalls += 1;
    const owner = snapshot.user?.id;
    inFlight += 1;
    privyDouble.mostAtOnce = Math.max(privyDouble.mostAtOnce, inFlight);
    const wallet: Linked = {
      type: 'wallet',
      chainType: family,
      walletClientType: 'privy',
      address: ADDRESS[family],
    };
    const answer = (act: () => void) => {
      inFlight -= 1;
      act();
    };
    privyDouble.pending.push({
      family,
      made: () =>
        answer(() => {
          link(owner, wallet);
          resolve({});
        }),
      fails: (message = 'the wallet service did not answer') =>
        answer(() => reject(new Error(message))),
      alreadyThere: (listed = true) =>
        answer(() => {
          if (listed) link(owner, wallet);
          reject(new Error('User already has an embedded wallet.'));
        }),
    });
  });

const wallets = (family: Family) =>
  (snapshot.user?.linkedAccounts ?? [])
    .filter((a) => a.type === 'wallet' && a.chainType === family)
    .map((a) => ({ address: a.address, walletClientType: a.walletClientType }));

const nothing = async () => ({});

/** `@privy-io/react-auth`, as far as the bridge uses it. */
export const reactAuth = {
  getIdentityToken: async () => {
    privyDouble.identityFetches += 1;
    if (privyDouble.limited)
      throw Object.assign(new Error('Too many requests'), {
        status: 429,
        privyErrorCode: 'too_many_requests',
      });
    if (!snapshot.user) return null;
    const token = identityTokenOf(snapshot.user);
    privyDouble.holdIdentity(token);
    return token;
  },
  useIdentityToken: () => ({ identityToken: useSnapshot().identityToken }),
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  usePrivy: () => ({
    ...useSnapshot(),
    logout: async () => privyDouble.signOut(),
    getAccessToken: async () => 'access-token',
  }),
  useWallets: () => {
    useSnapshot();
    return { ready: true, wallets: wallets('ethereum') };
  },
  useCreateWallet: () => ({ createWallet: createWallet('ethereum', useAlive()) }),
  useExportWallet: () => ({ exportWallet: nothing }),
  useLoginWithPasskey: () => ({ loginWithPasskey: () => privyDouble.passkey() }),
  useSignupWithPasskey: () => ({ signupWithPasskey: nothing }),
  useLoginWithSiwe: () => ({ generateSiweMessage: async () => '', loginWithSiwe: nothing }),
  useLoginWithSiws: () => ({ generateSiwsMessage: async () => '', loginWithSiws: nothing }),
  useSignMessage: () => ({ signMessage: nothing }),
  useSignTransaction: () => ({ signTransaction: nothing }),
};

/** `@privy-io/react-auth/solana`, as far as the bridge uses it. */
export const solana = {
  toSolanaWalletConnectors: () => ({}),
  useCreateWallet: () => ({ createWallet: createWallet('solana', useAlive()) }),
  useExportWallet: () => ({ exportWallet: nothing }),
  useSignMessage: () => ({ signMessage: nothing }),
  useSignTransaction: () => ({ signTransaction: nothing }),
  useWallets: () => {
    useSnapshot();
    return { ready: true, wallets: wallets('solana') };
  },
  useStandardWallets: () => ({ wallets: [] }),
};

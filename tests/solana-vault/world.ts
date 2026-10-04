import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawAccount, VaultRpc } from '@colosseum/chain-solana/vault';
import { type BasketAsset, type ChainConfig, parseChainConfigs } from '@colosseum/schemas';
import type { Address } from '@solana/kit';

// The world that programs/tests builds with the real program (programs/tests/src/world.ts), as the
// root suite sees it: by name, with what the script did written down beside the account bytes. The
// committed copy came out of LiteSVM; the integration test builds the same world on a local validator.

export type MintName = 'usdc' | 'spyx' | 'nvdax' | 'gold' | 'tslax';
export type VaultName = 'following' | 'manual' | 'partial' | 'others';
export type RecipeName = 'core';
type Amounts = Partial<Record<MintName, string>>;
type Weights = { mint: MintName; weightBps: number }[];

export type World = {
  names: {
    program: string;
    config: string;
    admin: string;
    guardian: string;
    keeper: string;
    router: string;
    priceOwner: string;
    /** The platform's asset list. */
    assets: string;
    /** The wallet that published the shared portfolios. */
    creator: string;
    owner: string;
    other: string;
    stranger: string;
    mints: Record<MintName, string>;
    vaults: Record<VaultName, string>;
    recipes: Record<RecipeName, string>;
  };
  expected: {
    mints: Record<
      MintName,
      {
        tokenProgram: 'token' | 'token-2022';
        decimals: number;
        multiplier: number | null;
        scheduled: { multiplier: number; effectiveAt: string } | null;
      }
    >;
    vaults: Record<
      VaultName,
      {
        owner: 'owner' | 'other';
        basketId: string;
        autoFollow: boolean;
        /** The shared portfolio the vault follows, and the version whose weights it took. */
        recipe: RecipeName | null;
        acceptedVersion: number;
        targets: { mint: MintName; targetBps: number }[];
        held: Amounts;
        tracked: Amounts;
      }
    >;
    wallets: Record<'owner' | 'other', Amounts>;
    recipes: Record<
      RecipeName,
      {
        familyId: string;
        active: { version: number; components: Weights };
        /** Null on a chain whose clock the script cannot move: a second version needs a delay to pass. */
        pending: { version: number; effectiveAt: string; components: Weights } | null;
      }
    >;
  };
  prices: {
    account: string;
    owner: string;
    entries: Record<
      MintName,
      {
        index: number;
        usdPerToken: string;
        ageSeconds: number;
        /** Where the asset's one-hour average sits; null for cash, which the program never prices. */
        twapIndex: number | null;
        /** The admin's switch on the asset in the program's own list. */
        keeperOn: boolean;
        /** The plausible price range in dollars; null for an asset that has none. */
        range: { min: number; max: number } | null;
      }
    >;
    emptyIndex: number;
  };
};

export type Fixture = World & {
  provenance: 'fixture';
  clock: { slot: string; unixTimestamp: string };
  strayLamports: { vault: VaultName; mint: MintName; address: string };
  accounts: { role: string; address: string; owner: string; lamports: string; data: string }[];
};

export const REPO_ROOT = join(__dirname, '..', '..');

export function loadFixture(): Fixture {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'fixtures', 'solana-vault', 'world.json'), 'utf8'),
  );
}

/** The account a fixture holds under a role such as 'config' or 'vault:following'. */
export function accountOf(fixture: Fixture, role: string): RawAccount {
  const found = fixture.accounts.find((a) => a.role === role);
  if (!found) throw new Error(`the fixture has no account with the role ${role}`);
  return {
    address: found.address as Address,
    owner: found.owner as Address,
    lamports: BigInt(found.lamports),
    data: new Uint8Array(Buffer.from(found.data, 'base64')),
  };
}

const SHELF: Record<
  MintName,
  Pick<BasketAsset, 'symbol' | 'cls' | 'underlying' | 'session'> & { priced: boolean }
> = {
  // Cash has no price source in the default list, as on the mock's shelf.
  usdc: { symbol: 'tUSD', cls: 'cash', underlying: 'USD', session: 'always', priced: false },
  spyx: { symbol: 'tSPY', cls: 'etf', underlying: 'SPY', session: 'us_equity', priced: true },
  nvdax: { symbol: 'tNVDA', cls: 'stock', underlying: 'NVDA', session: 'us_equity', priced: true },
  gold: { symbol: 'tGOLD', cls: 'gold', underlying: 'XAU', session: 'always', priced: true },
  tslax: { symbol: 'tTSLA', cls: 'stock', underlying: 'TSLA', session: 'us_equity', priced: true },
};

export const assetId = (name: MintName) => `solana:${name}`;

/** The asset list a deploy would hand the reader for this world. `provenance` is the reader's to set. */
export function assetsOf(world: World): BasketAsset[] {
  return (Object.keys(SHELF) as MintName[]).map((name) => {
    const { priced, ...row } = SHELF[name];
    return {
      ...row,
      id: assetId(name),
      chain: 'solana',
      address: world.names.mints[name],
      decimals: world.expected.mints[name].decimals,
      issuer: 'test',
      tier: 'A',
      priceKind: priced ? 'scope' : 'none',
      priceRef: priced ? String(world.prices.entries[name].index) : '',
      autoFollowEligible: true,
      maxWeightBps: row.cls === 'cash' ? 0 : 5000,
      blockedCountries: [],
      sheet: 'test',
      provenance: 'fixture',
    };
  });
}

/** The chain config a deploy of this world would produce, through the schemas' own parser. */
export function configOf(
  world: World,
  network: 'mainnet' | 'testnet' | 'local' = 'testnet',
): ChainConfig {
  return parseChainConfigs(
    {
      CHAIN_NETWORK_SOLANA: network,
      CHAIN_ROUTER_SOLANA: world.names.router,
      CHAIN_PRICE_SOURCE_SOLANA: world.prices.account,
    },
    { solana: { program: world.names.program } },
  ).solana;
}

// ---- a node that serves accounts from memory ----

type Status = { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown };

export type FakeNode = {
  rpc: VaultRpc;
  accounts: Map<string, RawAccount>;
  /** Every call made, by method name, in order. */
  calls: string[];
  /** The commitment of each getBlockHeight call. */
  heightsAsked: string[];
  statuses: Map<string, Status>;
  logs: Map<string, string[]>;
  blockHeight: bigint;
  /** A height per commitment, where they differ: a fork not yet finalized is ahead. */
  heights: Partial<Record<string, bigint>>;
  /** What the node hands back from getProgramAccounts on top of what matches, as a node that lies does. */
  strays: RawAccount[];
  /** Methods that fail as a node that is down does. */
  down: Set<string>;
  /** Runs before each call is answered: what happens on the chain between two questions. */
  before?: (method: string) => void;
};

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fromBase58(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(BASE58.indexOf(ch));
  const bytes: number[] = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/**
 * Stands in for a Solana node. It answers the seven methods the reader calls, applies
 * getProgramAccounts filters to the real bytes, and holds to the node's own limits: a hundred accounts
 * a call, four filters.
 */
export function fakeNode(accounts: RawAccount[]): FakeNode {
  const node: FakeNode = {
    rpc: undefined as unknown as VaultRpc,
    accounts: new Map(accounts.map((a) => [a.address, a])),
    calls: [],
    heightsAsked: [],
    statuses: new Map(),
    logs: new Map(),
    blockHeight: 1_000n,
    heights: {},
    strays: [],
    down: new Set(),
  };
  const context = { slot: 1n };
  const call = <T>(method: string, answer: () => T) => ({
    send: async () => {
      node.calls.push(method);
      node.before?.(method);
      if (node.down.has(method))
        throw new Error('fetch failed: https://rpc.example/?api-key=SECRET');
      return answer();
    },
  });
  const wire = (a: RawAccount, slice?: { offset: number; length: number }) => ({
    data: [
      Buffer.from(
        slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data,
      ).toString('base64'),
      'base64',
    ],
    executable: false,
    lamports: a.lamports,
    owner: a.owner,
    rentEpoch: 0n,
    space: BigInt(a.data.length),
  });
  type Filter = { dataSize?: bigint; memcmp?: { offset: bigint; bytes: string; encoding: string } };

  const api = {
    getMultipleAccounts: (addresses: string[]) =>
      call('getMultipleAccounts', () => {
        if (addresses.length > 100) throw new Error('Too many inputs provided; max 100');
        return {
          context,
          value: addresses.map((a) => {
            const account = node.accounts.get(a);
            return account ? wire(account) : null;
          }),
        };
      }),
    getProgramAccounts: (
      program: string,
      config: { filters?: Filter[]; dataSlice?: { offset: number; length: number } },
    ) =>
      call('getProgramAccounts', () => {
        const filters = config.filters ?? [];
        if (filters.length > 4) throw new Error('Too many filters provided; max 4');
        const matching = [...node.accounts.values()]
          .filter((a) => a.owner === program)
          .filter((a) =>
            filters.every((f) => {
              if (f.dataSize !== undefined) return BigInt(a.data.length) === f.dataSize;
              const { memcmp } = f;
              if (memcmp?.encoding !== 'base58') throw new Error('unknown filter');
              const want = fromBase58(memcmp.bytes);
              const at = Number(memcmp.offset);
              return want.every((byte, i) => a.data[at + i] === byte);
            }),
          );
        return [...matching, ...node.strays].map((a) => ({
          pubkey: a.address,
          account: wire(a, config.dataSlice),
        }));
      }),
    getBalance: (address: string) =>
      call('getBalance', () => ({ context, value: node.accounts.get(address)?.lamports ?? 0n })),
    getMinimumBalanceForRentExemption: (size: bigint) =>
      call('getMinimumBalanceForRentExemption', () => (size + 128n) * 6_960n),
    getBlockHeight: (config?: { commitment?: string }) =>
      call('getBlockHeight', () => {
        node.heightsAsked.push(config?.commitment ?? 'default');
        return node.heights[config?.commitment ?? ''] ?? node.blockHeight;
      }),
    getSignatureStatuses: (signatures: string[]) =>
      call('getSignatureStatuses', () => ({
        context,
        value: signatures.map((s) => {
          const status = node.statuses.get(s);
          return status ? { ...status, confirmations: null, slot: 1n } : null;
        }),
      })),
    getTransaction: (signature: string) =>
      call('getTransaction', () => {
        const logMessages = node.logs.get(signature);
        return logMessages ? { meta: { logMessages } } : null;
      }),
  };
  node.rpc = api as unknown as VaultRpc;
  return node;
}

/** A node holding the committed fixture. */
export function fixtureNode(fixture: Fixture): FakeNode {
  return fakeNode(fixture.accounts.map((a) => accountOf(fixture, a.role)));
}

/** A copy of an account with some bytes changed, for cases no transaction can produce today. */
export function patched(account: RawAccount, edits: { at: number; bytes: ArrayLike<number> }[]) {
  const data = new Uint8Array(account.data);
  for (const { at, bytes } of edits) data.set(bytes, at);
  return { ...account, data };
}

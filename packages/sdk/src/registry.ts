import type { AssetId } from '@colosseum/schemas';
import { base58Encode, base64Decode, hexEncode, sameBytes, utf8Encode } from './bytes';
import type { RpcCall } from './executor/chain-read';
import { BASKET_PROGRAM } from './guard/generated/basket-program';
import { recipeAddress } from './guard/solana/addresses';
import type { SolanaDeployment } from './guard/types';
import { sha256 } from './hash';

// A shared portfolio as the Solana registry holds it, read by the caller from its own node: what a
// follow is held to, instead of the API's answer. The account is at ["recipe", creator, family id] of
// the vault program; its layout is programs/basket's `Recipe` (DESIGN-VAULT 3.7, idl/basket.json):
//
//   discriminator 8 · creator 32 · family_id 32 · current RecipeVersion 453 · pending RecipeVersion 453
//   · last_publish_ts 8 · … (1,022 bytes)
//   RecipeVersion: version u32 · effective_at i64 · meta_hash 32 · count u8 · 12 × (mint 32, weight u16)
//
// Which version is in effect is the program's rule, by the cluster's clock: a version that waited and
// whose time has come is in effect with no transaction. registry.test.ts holds this to the layout, and
// tests/solana-vault/shared-routes.test.ts to an account the program wrote.

export const RECIPE_ACCOUNT_SIZE = 1022;
const VERSION_SIZE = 453;
const COMPONENT_SIZE = 34;
const MAX_COMPONENTS = 12;
const CURRENT_AT = 72;
const PENDING_AT = CURRENT_AT + VERSION_SIZE;
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
/** sha256("account:Recipe")[0..8], as Anchor writes it. */
const DISCRIMINATOR = sha256(utf8Encode('account:Recipe')).slice(0, 8);

export type ChainRecipeLine = {
  /** The deployment's id for the mint, or null for a token the deployment does not list. */
  asset: AssetId | null;
  mint: string;
  weightBps: number;
};

export type ChainRecipeVersion = {
  version: number;
  /** Unix seconds. */
  effectiveAt: number;
  /** 32 bytes as lower-case hex. */
  metaHash: string;
  components: ChainRecipeLine[];
};

export type ChainRecipe = {
  /** The recipe account: what a follow names as `recipeOnchainId`. */
  address: string;
  creator: string;
  familyId: string;
  /** The version in effect at the cluster's clock. */
  active: ChainRecipeVersion;
  /** The version that waits for its time, if any. */
  pending: ChainRecipeVersion | null;
  /** The cluster's clock when it was read, in unix seconds. */
  clock: number;
};

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number) => u16(b, at) + u16(b, at + 2) * 0x10000;
function i64(b: Uint8Array, at: number): number {
  let n = 0n;
  for (let i = 7; i >= 0; i -= 1) n = (n << 8n) | BigInt(b[at + i] ?? 0);
  if (n >= 1n << 63n) n -= 1n << 64n;
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('a time out of range');
  return Number(n);
}

function versionAt(data: Uint8Array, at: number, mints: Map<string, AssetId>): ChainRecipeVersion {
  const count = data[at + 44] ?? 0;
  if (count > MAX_COMPONENTS) throw new Error(`a version of a shared portfolio has ${count} lines`);
  const components: ChainRecipeLine[] = [];
  for (let i = 0; i < count; i += 1) {
    const line = at + 45 + i * COMPONENT_SIZE;
    const mint = base58Encode(data.slice(line, line + 32));
    components.push({ asset: mints.get(mint) ?? null, mint, weightBps: u16(data, line + 32) });
  }
  return {
    version: u32(data, at),
    effectiveAt: i64(data, at + 4),
    metaHash: hexEncode(data.slice(at + 12, at + 44)),
    components,
  };
}

type Account = { data: unknown; owner: unknown } | null;

const bytesOf = (account: Account): Uint8Array | null => {
  const data = account?.data;
  if (!Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') return null;
  return base64Decode(data[0]);
};

/**
 * The shared portfolio of `creator` and `familyId` on Solana, read from the caller's node, or null when
 * the registry has none there. Throws on an account that is not the program's recipe, or that names
 * another creator or family than its address says.
 */
export async function readSolanaRecipe(
  rpc: RpcCall,
  deployment: Pick<SolanaDeployment, 'assets'>,
  at: { creator: string; familyId: string },
): Promise<ChainRecipe | null> {
  if (!/^[0-9a-f]{64}$/.test(at.familyId)) throw new Error('a family id is 32 bytes of hex');
  const program = BASKET_PROGRAM.address;
  const address = recipeAddress(program, at.creator, at.familyId);
  const answer = (await rpc('getMultipleAccounts', [
    [address, CLOCK_SYSVAR],
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value?: Account[] } | null;
  const [recipe, clock] = answer?.value ?? [];
  const clockBytes = bytesOf(clock ?? null);
  if (!clockBytes || clockBytes.length < 40) throw new Error('the node gave no clock');
  if (!recipe) return null;
  const data = bytesOf(recipe);
  if (
    recipe.owner !== program ||
    !data ||
    data.length !== RECIPE_ACCOUNT_SIZE ||
    !sameBytes(data.slice(0, 8), DISCRIMINATOR)
  )
    throw new Error(`the account at ${address} is not a shared portfolio of the vault program`);
  const creator = base58Encode(data.slice(8, 40));
  const familyId = hexEncode(data.slice(40, 72));
  if (creator !== at.creator || familyId !== at.familyId)
    throw new Error(`the account at ${address} names another creator or family`);

  const mints = new Map(Object.entries(deployment.assets).map(([id, a]) => [a.mint, id]));
  const current = versionAt(data, CURRENT_AT, mints);
  const waiting = versionAt(data, PENDING_AT, mints);
  // unix_timestamp is the Clock sysvar's fifth field, after slot, epoch_start_timestamp, epoch and
  // leader_schedule_epoch.
  const now = i64(clockBytes, 32);
  const active = waiting.version !== 0 && now >= waiting.effectiveAt ? waiting : current;
  const pending = waiting.version !== 0 && now < waiting.effectiveAt ? waiting : null;
  return { address, creator, familyId, active, pending, clock: now };
}

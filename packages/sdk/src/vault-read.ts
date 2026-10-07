import type { AssetId } from '@colosseum/schemas';
import { base58Encode, base64Decode, hexDecode, hexEncode, sameBytes, utf8Encode } from './bytes';
import type { RpcCall } from './executor/chain-read';
import { type AbiValue, decodeArgs, parseType } from './guard/evm/abi';
import { evmVaultAddress, planIdOf } from './guard/evm/addresses';
import { BASKET_PROGRAM } from './guard/generated/basket-program';
import { vaultAddress } from './guard/solana/addresses';
import type { EvmDeployment, SolanaDeployment } from './guard/types';
import { keccak256, sha256 } from './hash';

// A vault's targets as its chain holds them, read by the caller from its own node: what more money
// into a vault is held to, instead of the API's answer. The guard holds a deposit to the vault and
// the amount, and a swap to the vault and the tokens the deployment lists; it does not hold a swap to
// the vault's targets, so a screen that offers an add reads them here and holds the order's trades to
// them before anything is signed.
//
// Solana: the account at ["vault", owner, basket_id] of the vault program, programs/basket's `Vault`
// (idl/basket.json; the field order is frozen):
//
//   discriminator 8 · owner 32 · recipe 32 · accepted_version u32 · auto_follow u8 · basket_id u64
//   · bump u8 · keeper 32 · count u8 · 16 × (mint 32, target_bps u16, tracked u64, last_keeper_ts i64)
//   · loss_accum u64 · loss_ts i64 · reserved 128 (1,063 bytes)
//
// EVM: `snapshot()` of the vault at the address the factory derives from the owner and the plan's
// number (`evmVaultAddress`); its tokens are the targets, in the vault's order, with the cash token
// last. vault-read.test.ts holds both to the layout and to the committed ABI.

export const VAULT_ACCOUNT_SIZE = 1063;
const POSITIONS_AT = 119;
const POSITION_SIZE = 50;
const MAX_POSITIONS = 16;
/** sha256("account:Vault")[0..8], as Anchor writes it. */
const DISCRIMINATOR = sha256(utf8Encode('account:Vault')).slice(0, 8);

export const SNAPSHOT_SIGNATURE = 'snapshot()';
const SNAPSHOT = parseType(
  '(address,bytes32,uint32,bool,address,address[],uint16[],uint256[],uint256[],uint64[],uint64[],uint16,bytes32)',
);

export type ChainTarget = {
  /** The deployment's id for the token, or null for a token the deployment does not list. */
  asset: AssetId | null;
  /** The mint on Solana, the token contract (lower case) on an EVM chain. */
  token: string;
  weightBps: number;
};

export type ChainVault = {
  /** The vault's address, derived here from the owner and the plan's number. */
  address: string;
  autoFollow: boolean;
  /** Every target the vault has, in the chain's order, one at weight zero included. */
  targets: ChainTarget[];
};

type Account = { data?: unknown; owner?: unknown } | null;

/**
 * The vault of `owner` for the plan number `basketId` on Solana, or null when the chain has none
 * there. Throws on an account that is not the program's vault of that owner and number.
 */
export async function readSolanaVault(
  rpc: RpcCall,
  deployment: Pick<SolanaDeployment, 'assets'>,
  at: { owner: string; basketId: string },
): Promise<ChainVault | null> {
  const program = BASKET_PROGRAM.address;
  const address = vaultAddress(program, at.owner, at.basketId);
  const answer = (await rpc('getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { value?: Account } | null;
  if (!answer || !('value' in answer)) throw new Error('the node gave no answer about the vault');
  const account = answer.value ?? null;
  if (!account) return null;
  const raw = account.data;
  const data =
    Array.isArray(raw) && raw[1] === 'base64' && typeof raw[0] === 'string'
      ? base64Decode(raw[0])
      : null;
  if (
    account.owner !== program ||
    !data ||
    data.length !== VAULT_ACCOUNT_SIZE ||
    !sameBytes(data.slice(0, 8), DISCRIMINATOR)
  )
    throw new Error(`the account at ${address} is not a vault of the vault program`);
  let number = 0n;
  for (let i = 7; i >= 0; i -= 1) number = (number << 8n) | BigInt(data[77 + i] ?? 0);
  if (base58Encode(data.slice(8, 40)) !== at.owner || number !== BigInt(at.basketId))
    throw new Error(`the account at ${address} names another owner or plan`);
  const flag = data[76] ?? 0;
  const count = data[118] ?? 0;
  if (flag > 1 || count > MAX_POSITIONS)
    throw new Error(`the account at ${address} does not read as a vault`);
  const mints = new Map(Object.entries(deployment.assets).map(([id, a]) => [a.mint, id]));
  const targets: ChainTarget[] = [];
  for (let i = 0; i < count; i += 1) {
    const line = POSITIONS_AT + i * POSITION_SIZE;
    const token = base58Encode(data.slice(line, line + 32));
    targets.push({
      asset: mints.get(token) ?? null,
      token,
      weightBps: (data[line + 32] ?? 0) | ((data[line + 33] ?? 0) << 8),
    });
  }
  return { address, autoFollow: flag === 1, targets };
}

/**
 * The vault of `owner` for the plan number `basketId` on an EVM chain, or null when no contract
 * answers at its address. Throws on an answer that is not the snapshot of that owner's vault for that
 * number.
 */
export async function readEvmVault(
  rpc: RpcCall,
  deployment: Pick<EvmDeployment, 'factory' | 'beacon' | 'proxyCreationCode' | 'assets' | 'cash'>,
  at: { owner: string; basketId: string },
): Promise<ChainVault | null> {
  const address = evmVaultAddress(deployment, at.owner, at.basketId);
  const selector = hexEncode(keccak256(utf8Encode(SNAPSHOT_SIGNATURE)).slice(0, 4));
  // No code at the address answers a call with nothing: asked first, so a revert is told from it.
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (typeof code !== 'string') throw new Error('the node gave no answer about the vault');
  if (code === '0x') return null;
  const answer = await rpc('eth_call', [{ to: address, data: `0x${selector}` }, 'latest']);
  if (typeof answer !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(answer))
    throw new Error(`the contract at ${address} did not answer as a vault`);
  const [snap] = decodeArgs([SNAPSHOT], hexDecode(answer)) as [AbiValue[]];
  const [owner, , , autoFollow, , tokens, bps, , , , , , planId] = snap as [
    string,
    string,
    bigint,
    boolean,
    string,
    string[],
    bigint[],
    ...unknown[],
  ] &
    AbiValue[];
  if (owner !== at.owner.toLowerCase() || planId !== planIdOf(at.basketId))
    throw new Error(`the contract at ${address} names another owner or plan`);
  const byToken = new Map(
    Object.entries(deployment.assets).map(([id, a]) => [a.token.toLowerCase(), id]),
  );
  const cash = deployment.assets[deployment.cash]?.token.toLowerCase();
  const n = tokens.length - 1;
  if (n < 0 || tokens[n] !== cash || bps.length < n)
    throw new Error(`the snapshot of ${address} does not end with the cash token`);
  return {
    address,
    autoFollow,
    targets: tokens.slice(0, n).map((token, i) => ({
      asset: byToken.get(token) ?? null,
      token,
      weightBps: Number(bps[i] ?? 0n),
    })),
  };
}

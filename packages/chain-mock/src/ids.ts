import { createHash } from 'node:crypto';
import { type ChainId, chainFamily } from '@colosseum/schemas';

// Every id the mock hands out is a hash of what it names, so two runs give the same ids.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function base58(hex: string): string {
  let n = BigInt(`0x${hex}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  // A leading zero byte is a leading '1', as in a real address.
  for (let i = 0; i < hex.length && hex.startsWith('00', i); i += 2) out = `1${out}`;
  return out;
}

/** An address in the chain's own format that belongs to nobody: base58 on Solana, lower-case 0x on EVM. */
export function mockAddress(chain: ChainId, label: string): string {
  const hex = sha256Hex(`mock:${chain}:${label}`);
  return chainFamily(chain) === 'solana' ? base58(hex) : `0x${hex.slice(0, 40)}`;
}

/** Solana: the recipe account. EVM: a bytes32, standing in for keccak256(abi.encode(creator, familyId)). */
export function mockRecipeId(chain: ChainId, creator: string, familyId: string): string {
  const hex = sha256Hex(`mock:${chain}:recipe:${creator}:${familyId}`);
  return chainFamily(chain) === 'solana' ? base58(hex) : `0x${hex}`;
}

export function mockTxId(chain: ChainId, messageHash: string): string {
  const hex = sha256Hex(`mock:${chain}:tx:${messageHash}`);
  return chainFamily(chain) === 'solana' ? base58(hex) : `0x${hex}`;
}

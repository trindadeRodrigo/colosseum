import { concatBytes, hexDecode, hexEncode, utf8Encode } from '../../bytes';
import { keccak256 } from '../../hash';
import { VAULT_PROXY_CREATION_CODE } from '../generated/vault-proxy';
import { encodeArgs, parseType } from './abi';

// The address of a person's vault for a plan on an EVM chain, worked out here from the person's own
// address. It is the same before the vault exists and after, so it is what an approval names and what
// every later call targets.
//
// The rule is the factory's own (`VaultFactory.vaultOf` in contracts/src/VaultFactory.sol): CREATE2
// from the factory, with the salt keccak256(abi.encode(owner, planId)) and, as the code, the vault
// proxy's creation code followed by abi.encode(beacon, initialize(owner, planId)). The plan's number is
// the same number as 32 bytes. abi.test.ts holds the arithmetic to viem on recorded cases, and
// tables.test.ts holds the creation code to the hash the contracts' own test pins.

const INITIALIZE = 'initialize(address,bytes32)';
const ADDRESS = parseType('address');
const BYTES32 = parseType('bytes32');
const BYTES = parseType('bytes');

/** A plan's number as the 32 bytes a contract takes it as: 0x hex. */
export function planIdOf(basketId: string): string {
  return `0x${BigInt(basketId).toString(16).padStart(64, '0')}`;
}

export function evmVaultAddress(
  deployment: { factory: string; beacon: string; proxyCreationCode?: string },
  owner: string,
  basketId: string,
): string {
  const planId = planIdOf(basketId);
  const named = encodeArgs([ADDRESS, BYTES32], [owner.toLowerCase(), planId]);
  const init = concatBytes(keccak256(utf8Encode(INITIALIZE)).slice(0, 4), named);
  const code = concatBytes(
    hexDecode(deployment.proxyCreationCode ?? VAULT_PROXY_CREATION_CODE),
    encodeArgs([ADDRESS, BYTES], [deployment.beacon.toLowerCase(), init]),
  );
  const hash = keccak256(
    concatBytes(
      Uint8Array.of(0xff),
      hexDecode(deployment.factory.toLowerCase()),
      keccak256(named),
      keccak256(code),
    ),
  );
  return `0x${hexEncode(hash.slice(12))}`;
}

/**
 * The id of a creator's shared portfolio on an EVM chain, as `IndexRegistry.create` makes it:
 * keccak256(abi.encode(creator, familyId)). The family id is 32 bytes as hex, with or without 0x.
 */
export function evmIndexId(creator: string, familyId: string): string {
  const family = `0x${familyId.replace(/^0x/, '').toLowerCase()}`;
  return `0x${hexEncode(keccak256(encodeArgs([ADDRESS, BYTES32], [creator.toLowerCase(), family])))}`;
}

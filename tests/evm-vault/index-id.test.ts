import { indexIdOf } from '@colosseum/chain-evm/vault';
import { evmIndexId, familyIdOf } from '@colosseum/sdk';
import { describe, expect, it } from 'vitest';

// A creator's shared portfolio's id on an EVM chain, keccak256(abi.encode(creator, familyId)), worked
// out twice: by the API's adapter with viem (`indexIdOf`) and by the guard with its own Keccak
// (`evmIndexId`). The API names the recipe by the one, the guard holds the bytes to the other.

describe('the id of a shared portfolio on an EVM chain', () => {
  it('is the same from the adapter and from the guard, for any creator and family', () => {
    const creators = [
      '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65',
      '0xF474920851f97dC8797e78470095206DFD8367d8',
      '0x0000000000000000000000000000000000000001',
    ];
    const families = ['sand-to-server', 'a', 'three-of-the-largest'].map(familyIdOf);
    for (const creator of creators)
      for (const family of families) {
        const id = indexIdOf(creator, family);
        expect(evmIndexId(creator, family)).toBe(id);
        expect(evmIndexId(creator, `0x${family}`)).toBe(id);
      }
    expect(indexIdOf(creators[0] ?? '', families[0] ?? '')).not.toBe(
      indexIdOf(creators[1] ?? '', families[0] ?? ''),
    );
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainId, chainFamily, evmCallPreimage, WalletErrorCode } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { hexDecode, hexEncode, utf8Encode } from '../src/bytes';
import { familyOf } from '../src/guard/context';
import { GUARDED_EVM_FUNCTIONS } from '../src/guard/evm/check';
import { BASKET_PROGRAM } from '../src/guard/generated/basket-program';
import { EVM_INTERFACE } from '../src/guard/generated/evm-interface';
import { VAULT_PROXY_CREATION_CODE } from '../src/guard/generated/vault-proxy';
import { ASSOCIATED_TOKEN_PROGRAM, SEEDS } from '../src/guard/solana/addresses';
import { keccak256 } from '../src/hash';
import { ROOT, readSources } from './sources';
import { interfaceTable, programTable } from './tables';

// The guard's tables are generated, and this holds them to what they were generated from: the Solana
// interface file, the EVM ABIs, and the hash the contracts' own test pins for the vault proxy. A change
// to any of those without `pnpm --filter @colosseum/sdk tables` fails here.

type Seed = { kind: string; value?: number[]; path?: string };
type IdlAccount = { name: string; pda?: { seeds: Seed[]; program?: Seed } };
const { idl, abis } = readSources();
const instructions = (idl as { instructions: { name: string; accounts: IdlAccount[] }[] })
  .instructions;
const ascii = (text: string) => [...utf8Encode(text)];

describe('the generated tables', () => {
  it('the vault program is idl/basket.json: its id, and every instruction as the file has it', () => {
    expect(BASKET_PROGRAM).toEqual(programTable(idl));
    expect(BASKET_PROGRAM.address).toBe((idl as { address: string }).address);
    expect(Object.keys(BASKET_PROGRAM.instructions).sort()).toEqual(
      instructions.map((i) => i.name).sort(),
    );
  });

  it('the EVM selectors are idl/evm: every function of every committed ABI', () => {
    expect(EVM_INTERFACE).toEqual(interfaceTable(abis));
    expect(Object.keys(EVM_INTERFACE).sort()).toEqual([...Object.keys(abis), 'ERC20'].sort());
    expect(EVM_INTERFACE.ERC20?.['approve(address,uint256)']).toBe('0x095ea7b3');
  });

  it("the vault proxy's creation code is the one the contracts' own test pins", () => {
    const test = readFileSync(join(ROOT, 'contracts', 'test', 'VaultFactory.t.sol'), 'utf8');
    const pinned = /keccak256\(type\(BeaconProxy\)\.creationCode\),\s*(0x[0-9a-f]{64})/.exec(test);
    expect(pinned?.[1], 'the pin in contracts/test/VaultFactory.t.sol').toBeDefined();
    expect(`0x${hexEncode(keccak256(hexDecode(VAULT_PROXY_CREATION_CODE)))}`).toBe(pinned?.[1]);
  });

  it('every function the guard was written against is in the ABIs, or belongs to the keeper path', () => {
    const missing = GUARDED_EVM_FUNCTIONS.filter(
      ([contract, signature]) => !EVM_INTERFACE[contract]?.[signature],
    ).map(([, signature]) => signature);
    // The keeper path (EVM-3) brings these two. Until its ABI is committed and the tables are generated
    // again, the guard refuses an accept and the auto-follow switch on an EVM chain as unsupported.
    for (const signature of missing)
      expect(['acceptVersion(bytes32,uint32)', 'setAutoFollow(bool)']).toContain(signature);
  });
});

describe("the addresses the guard derives are the program's own", () => {
  const seedsOf = (instruction: string, account: string) =>
    instructions.find((i) => i.name === instruction)?.accounts.find((a) => a.name === account)?.pda;

  it('a vault is ["vault", owner, basket_id]', () => {
    expect(seedsOf('create_vault', 'vault')?.seeds).toEqual([
      { kind: 'const', value: ascii(SEEDS.vault) },
      { kind: 'account', path: 'owner' },
      { kind: 'arg', path: 'basket_id' },
    ]);
  });

  it('the config and the asset list are fixed seeds, wherever an instruction names them', () => {
    let seen = 0;
    for (const ix of instructions)
      for (const account of ix.accounts) {
        if (account.name !== 'config' && account.name !== 'assets') continue;
        seen += 1;
        expect(account.pda?.seeds, `${ix.name}.${account.name}`).toEqual([
          { kind: 'const', value: ascii(SEEDS[account.name]) },
        ]);
      }
    expect(seen).toBeGreaterThan(10);
  });

  it("a vault's token account is the associated one: [vault, token program, mint]", () => {
    const expected = (program: string, mint: string) => ({
      seeds: [
        { kind: 'account', path: 'vault' },
        { kind: 'account', path: program },
        { kind: 'account', path: mint },
      ],
      program: { kind: 'const', value: [...addressBytes(ASSOCIATED_TOKEN_PROGRAM)] },
    });
    expect(seedsOf('deposit', 'vault_token_account')).toEqual(expected('token_program', 'mint'));
    expect(seedsOf('withdraw', 'vault_token_account')).toEqual(expected('token_program', 'mint'));
    expect(seedsOf('owner_swap', 'vault_input')).toEqual(
      expected('input_token_program', 'input_mint'),
    );
    expect(seedsOf('owner_swap', 'vault_output')).toEqual(
      expected('output_token_program', 'output_mint'),
    );
  });
});

describe('the rules the guard repeats from the shared types', () => {
  it('a chain is in the family the shared types put it in', () => {
    for (const chain of ChainId.options) expect(familyOf(chain)).toBe(chainFamily(chain));
  });

  it('the text an EVM message hash is made of is the shared one', () => {
    // evm/check.ts writes the preimage itself: the built package carries no workspace code.
    const call = {
      chainId: 46630,
      signer: `0x${'ab'.repeat(20)}`,
      to: `0x${'cd'.repeat(20)}`,
      value: '0',
      data: '0xdeadbeef',
    };
    expect(evmCallPreimage(call)).toBe(
      `evm:${call.chainId}:${call.signer}:${call.to}:${call.value}:${call.data}`,
    );
  });

  it('the wallet codes are the shared ones', async () => {
    const { WALLET_CODES } = await import('../src/executor/wallet');
    expect([...WALLET_CODES].sort()).toEqual([...WalletErrorCode.options].sort());
  });
});

function addressBytes(address: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of address) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

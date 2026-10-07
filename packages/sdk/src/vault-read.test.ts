import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASKET_VAULT_ABI } from '../../chain-evm/src/vault/generated/abi';
import { base58Decode, base58Encode, hexEncode } from './bytes';
import type { RpcCall } from './executor/chain-read';
import { encodeArgs, parseType } from './guard/evm/abi';
import { evmVaultAddress, planIdOf } from './guard/evm/addresses';
import { BASKET_PROGRAM } from './guard/generated/basket-program';
import { EVM_INTERFACE } from './guard/generated/evm-interface';
import { vaultAddress } from './guard/solana/addresses';
import {
  readEvmVault,
  readSolanaVault,
  SNAPSHOT_SIGNATURE,
  VAULT_ACCOUNT_SIZE,
} from './vault-read';

// A vault's targets as a screen reads them from its own node, against bytes laid out here from the
// program's `Vault` (idl/basket.json) and against the snapshot the vault contract's committed ABI
// declares.

const idl = JSON.parse(readFileSync(new URL('../../../idl/basket.json', import.meta.url), 'utf8'));
const KEY = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const OWNER = KEY(9);
const SOLANA = {
  assets: {
    'solana:spyx': { mint: KEY(1), tokenProgram: 'token' as const, decimals: 8 },
    'solana:paxg': { mint: KEY(3), tokenProgram: 'token' as const, decimals: 6 },
  },
};

function account(o: {
  owner?: string;
  basketId?: bigint;
  autoFollow?: number;
  lines: [mint: number, bps: number][];
  count?: number;
}) {
  const b = new Uint8Array(VAULT_ACCOUNT_SIZE);
  const view = new DataView(b.buffer);
  b.set(createHash('sha256').update('account:Vault').digest().subarray(0, 8), 0);
  b.set(base58Decode(o.owner ?? OWNER), 8);
  b[76] = o.autoFollow ?? 0;
  view.setBigUint64(77, o.basketId ?? 42n, true);
  b[118] = o.count ?? o.lines.length;
  o.lines.forEach(([mint, bps], i) => {
    b.set(base58Decode(KEY(mint)), 119 + i * 50);
    view.setUint16(119 + i * 50 + 32, bps, true);
    // tracked and last_keeper_ts follow the weight: filled, to show they are not read as one
    view.setBigUint64(119 + i * 50 + 34, 0xffff_ffff_ffffn, true);
  });
  return b;
}

const solanaNode =
  (data: Uint8Array | null, by = BASKET_PROGRAM.address): RpcCall =>
  async (method, params) => {
    expect(method).toBe('getAccountInfo');
    expect((params as [string])[0]).toBe(vaultAddress(BASKET_PROGRAM.address, OWNER, '42'));
    return {
      value: data ? { data: [Buffer.from(data).toString('base64'), 'base64'], owner: by } : null,
    };
  };
const at = { owner: OWNER, basketId: '42' };

describe("a Solana vault's targets, read from the caller's own node", () => {
  it('is the layout of the program: its fields in order, its size and its discriminator', () => {
    const vault = idl.accounts.find((a: { name: string }) => a.name === 'Vault');
    expect(account({ lines: [] }).slice(0, 8)).toEqual(new Uint8Array(vault.discriminator));
    const type = idl.types.find((t: { name: string }) => t.name === 'Vault').type;
    expect(type.fields.map((f: { name: string }) => f.name)).toEqual([
      'owner',
      'recipe',
      'accepted_version',
      'auto_follow',
      'basket_id',
      'bump',
      'keeper',
      'count',
      'positions',
      'loss_accum',
      'loss_ts',
      'reserved',
    ]);
    const position = idl.types.find((t: { name: string }) => t.name === 'Position').type;
    expect(position.fields.map((f: { name: string }) => f.name)).toEqual([
      'mint',
      'target_bps',
      'tracked',
      'last_keeper_ts',
    ]);
    expect(8 + 32 + 32 + 4 + 1 + 8 + 1 + 32 + 1 + 16 * 50 + 8 + 8 + 128).toBe(VAULT_ACCOUNT_SIZE);
  });

  it('answers the targets in the program’s order, a token the deployment does not list by its mint', async () => {
    const read = await readSolanaVault(
      solanaNode(
        account({
          lines: [
            [3, 2500],
            [1, 6000],
            [7, 500],
            [5, 0],
          ],
        }),
      ),
      SOLANA,
      at,
    );
    expect(read).toEqual({
      address: vaultAddress(BASKET_PROGRAM.address, OWNER, '42'),
      autoFollow: false,
      targets: [
        { asset: 'solana:paxg', token: KEY(3), weightBps: 2500 },
        { asset: 'solana:spyx', token: KEY(1), weightBps: 6000 },
        { asset: null, token: KEY(7), weightBps: 500 },
        { asset: null, token: KEY(5), weightBps: 0 },
      ],
    });
    const following = await readSolanaVault(
      solanaNode(account({ autoFollow: 1, lines: [[1, 9000]] })),
      SOLANA,
      at,
    );
    expect(following?.autoFollow).toBe(true);
  });

  it('answers null where the chain has no vault, and refuses what is not that owner’s vault', async () => {
    expect(await readSolanaVault(solanaNode(null), SOLANA, at)).toBeNull();
    const refused = [
      solanaNode(account({ lines: [] }), KEY(8)),
      solanaNode(account({ lines: [] }).slice(0, 500)),
      solanaNode(account({ lines: [] }).fill(0, 0, 8)),
      solanaNode(account({ owner: KEY(8), lines: [] })),
      solanaNode(account({ basketId: 43n, lines: [] })),
      solanaNode(account({ autoFollow: 2, lines: [] })),
      solanaNode(account({ lines: [], count: 17 })),
      (async () => null) as RpcCall,
    ];
    for (const node of refused) await expect(readSolanaVault(node, SOLANA, at)).rejects.toThrow();
  });
});

const EVM_OWNER = '0x204FaCA1764B154221e35c0d20aBb3c525710498';
const TOKEN = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;
const EVM = {
  factory: TOKEN(0xf1),
  beacon: TOKEN(0xb2),
  cash: 'robinhood:usdg',
  assets: {
    'robinhood:usdg': { token: TOKEN(0xca), decimals: 6 },
    'robinhood:tspy': { token: `0x${'AB'.repeat(20)}`, decimals: 18 },
  },
};
const VAULT = evmVaultAddress(EVM, EVM_OWNER, '42');
const SNAPSHOT_TYPE =
  '(address,bytes32,uint32,bool,address,address[],uint16[],uint256[],uint256[],uint64[],uint64[],uint16,bytes32)';

function snapshot(o: {
  owner?: string;
  planId?: string;
  autoFollow?: boolean;
  tokens: string[];
  bps: number[];
}) {
  const zeros = o.tokens.map(() => 0n);
  const bytes = encodeArgs(
    [parseType(SNAPSHOT_TYPE)],
    [
      [
        (o.owner ?? EVM_OWNER).toLowerCase(),
        `0x${'00'.repeat(32)}`,
        1n,
        o.autoFollow ?? false,
        TOKEN(0x0e),
        o.tokens,
        o.bps.map(BigInt),
        zeros,
        zeros,
        zeros,
        zeros,
        0n,
        o.planId ?? planIdOf('42'),
      ],
    ],
  );
  return `0x${hexEncode(bytes)}`;
}

const evmNode =
  (answer: string | null): RpcCall =>
  async (method, params) => {
    if (method === 'eth_getCode') return answer === null ? '0x' : '0x60';
    expect(method).toBe('eth_call');
    const [call] = params as [{ to: string; data: string }];
    expect(call.to).toBe(VAULT);
    // the selector the generated interface table has for it
    expect(call.data).toBe(EVM_INTERFACE.BasketVault?.['snapshot()']);
    return answer;
  };
const evmAt = { owner: EVM_OWNER, basketId: '42' };

describe("an EVM vault's targets, read from the caller's own node", () => {
  it('reads the snapshot the vault’s committed ABI declares', () => {
    const fn = BASKET_VAULT_ABI.find((f) => f.type === 'function' && f.name === 'snapshot');
    if (fn?.type !== 'function') throw new Error('the vault has a snapshot');
    expect(SNAPSHOT_SIGNATURE).toBe('snapshot()');
    expect(fn.inputs).toEqual([]);
    const [out] = fn.outputs as unknown as { components: { name: string; type: string }[] }[];
    expect(`(${out?.components.map((c) => c.type).join(',')})`).toBe(SNAPSHOT_TYPE);
    expect(out?.components.map((c) => c.name)).toEqual([
      'owner',
      'indexId',
      'acceptedVersion',
      'autoFollow',
      'operator',
      'tokens',
      'targetBps',
      'balances',
      'prices',
      'priceUpdatedAt',
      'lastKeeperAt',
      'lossUsedBps',
      'planId',
    ]);
  });

  it('answers the targets in the vault’s order, the cash token left out', async () => {
    const read = await readEvmVault(
      evmNode(
        snapshot({
          autoFollow: true,
          tokens: [TOKEN(0xab), TOKEN(0x77), TOKEN(0xca)],
          bps: [9000, 0, 0],
        }),
      ),
      EVM,
      evmAt,
    );
    expect(read).toEqual({
      address: VAULT,
      autoFollow: true,
      targets: [
        { asset: 'robinhood:tspy', token: TOKEN(0xab), weightBps: 9000 },
        { asset: null, token: TOKEN(0x77), weightBps: 0 },
      ],
    });
  });

  it('answers null where no contract is, and refuses what is not that owner’s vault', async () => {
    expect(await readEvmVault(evmNode(null), EVM, evmAt)).toBeNull();
    const cash = [TOKEN(0xca)];
    const refused = [
      snapshot({ owner: TOKEN(0x01), tokens: cash, bps: [0] }),
      snapshot({ planId: planIdOf('43'), tokens: cash, bps: [0] }),
      // does not end with the cash token
      snapshot({ tokens: [TOKEN(0xab)], bps: [9000] }),
      snapshot({ tokens: [], bps: [] }),
      '0x',
      '0x00',
      `${snapshot({ tokens: cash, bps: [0] })}00`,
    ];
    for (const answer of refused)
      await expect(
        readEvmVault(evmNode(answer), EVM, evmAt),
        answer.slice(0, 20),
      ).rejects.toThrow();
  });
});

import { createMockAdapter } from '@colosseum/chain-mock';
import { parseChainConfigs } from '@colosseum/schemas';
import { address, generateKeyPairSigner } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ChainEntry, SolanaInputs } from '../orders/chains';
import { createFaucetSenders, evmTestFundsCalls, solanaTestFundsInstructions } from './signer';

// What the faucet's signing file builds, without a network: the instructions of a Solana send and the
// calls of an EVM one, and that it makes no sender for a chain that is not on a test network.

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TO = 'So11111111111111111111111111111111111111112';

describe('the faucet signer', () => {
  it('on Solana: makes the token account, mints the test dollar into it, and sends SOL', async () => {
    const faucet = await generateKeyPairSigner();
    const ixs = await solanaTestFundsInstructions(
      faucet,
      { to: TO, cashAddress: MINT, cashRaw: 202_000_000n, gasRaw: 12_625_000n },
      TOKEN_PROGRAM_ADDRESS,
    );
    expect(ixs.map((ix) => ix.programAddress)).toEqual([
      address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    // mintTo: instruction 7, then the amount, little-endian; to the account the first one makes.
    const mint = ixs[1];
    expect(mint?.data?.[0]).toBe(7);
    expect(Buffer.from(mint?.data ?? []).readBigUInt64LE(1)).toBe(202_000_000n);
    expect(mint?.accounts?.[1]?.address).toBe(ixs[0]?.accounts?.[1]?.address);
    expect(mint?.accounts?.[2]?.address).toBe(faucet.address);
    // transferSol: instruction 2, then the lamports; to the wallet itself.
    const sol = ixs[2];
    expect(Buffer.from(sol?.data ?? []).readUInt32LE(0)).toBe(2);
    expect(Buffer.from(sol?.data ?? []).readBigUInt64LE(4)).toBe(12_625_000n);
    expect(sol?.accounts?.[1]?.address).toBe(TO);
    // Nothing missing of a token: nothing built for it.
    const gasOnly = await solanaTestFundsInstructions(
      faucet,
      { to: TO, cashAddress: MINT, cashRaw: 0n, gasRaw: 1n },
      TOKEN_PROGRAM_ADDRESS,
    );
    expect(gasOnly.map((ix) => ix.programAddress)).toEqual([SYSTEM_PROGRAM_ADDRESS]);
  });

  it('on Robinhood Chain: mints the test dollar to the wallet, then sends ETH', () => {
    const to = '0x1111111111111111111111111111111111111111';
    const cash = '0xd3d6e7bf284d922651983468b75492be4f3f689a';
    const calls = evmTestFundsCalls({ to, cashAddress: cash, cashRaw: 101_000_000n, gasRaw: 7n });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.to).toBe(cash);
    expect(calls[0]?.value).toBe(0n);
    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'mint',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [],
        },
      ],
      data: calls[0]?.data ?? '0x',
    });
    expect(decoded.args).toEqual([to, 101_000_000n]);
    expect(calls[1]).toEqual({ to, data: '0x', value: 7n });
    expect(() =>
      evmTestFundsCalls({ to: 'not-an-address', cashAddress: cash, cashRaw: 1n, gasRaw: 0n }),
    ).toThrow();
  });

  it('makes no sender for a chain on mainnet, even with a key handed in', async () => {
    const config = parseChainConfigs({ CHAIN_NETWORK_SOLANA: 'mainnet' }).solana;
    const entry: ChainEntry = {
      chain: 'solana',
      mode: 'live',
      provenance: 'live',
      source: 'a mainnet node',
      config,
      adapter: createMockAdapter({ chain: 'solana' }),
    };
    await expect(
      createFaucetSenders({ solana: '[]' }, [entry], {
        solana: { rpc: {} as SolanaInputs['rpc'], assets: [] },
      }),
    ).rejects.toThrow(/not on a test network/);
  });

  it('refuses a key in the wrong form without repeating it', async () => {
    const config = parseChainConfigs({}).solana;
    const entry: ChainEntry = {
      chain: 'solana',
      mode: 'live',
      provenance: 'sandbox',
      source: 'a devnet node',
      config,
      adapter: createMockAdapter({ chain: 'solana' }),
    };
    const err = await createFaucetSenders({ solana: 'secret-words' }, [entry], {
      solana: { rpc: {} as SolanaInputs['rpc'], assets: [] },
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('secret-words');
  });
});

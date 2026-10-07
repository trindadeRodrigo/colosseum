import { generateKeyPairSync } from 'node:crypto';
import { createMockAdapter } from '@colosseum/chain-mock';
import { MAINNET_GENESIS_HASH } from '@colosseum/chain-solana/vault';
import { parseChainConfigs } from '@colosseum/schemas';
import { address, generateKeyPairSigner } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { decodeFunctionData, type PublicClient } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import type { ChainEntry, SolanaInputs } from '../orders/chains';
import { createFaucetSenders, evmTestFundsCalls, solanaTestFundsInstructions } from './signer';

// What the faucet's signing file builds, without a network: the instructions of a Solana send and the
// calls of an EVM one, and that it makes no sender for a chain that is not on a test network.

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const TO = 'So11111111111111111111111111111111111111112';

describe('the faucet signer', () => {
  it('on Solana: makes the token account, moves the test dollar into it from the float, and sends SOL', async () => {
    const faucet = await generateKeyPairSigner();
    const ixs = await solanaTestFundsInstructions(
      faucet,
      { to: TO, cashAddress: MINT, cashRaw: 202_000_000n, gasRaw: 12_625_000n },
      { tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6 },
    );
    expect(ixs.map((ix) => ix.programAddress)).toEqual([
      address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
    ]);
    // transferChecked (12), never mintTo (7): the amount and the decimals, from the faucet's own
    // token account to the one the first instruction makes, the faucet signing as its owner.
    const move = ixs[1];
    expect(move?.data?.[0]).toBe(12);
    expect(Buffer.from(move?.data ?? []).readBigUInt64LE(1)).toBe(202_000_000n);
    expect(move?.data?.[9]).toBe(6);
    const [faucetAta] = await findAssociatedTokenPda({
      owner: faucet.address,
      mint: address(MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    expect(move?.accounts?.[0]?.address).toBe(faucetAta);
    expect(move?.accounts?.[1]?.address).toBe(MINT);
    expect(move?.accounts?.[2]?.address).toBe(ixs[0]?.accounts?.[1]?.address);
    expect(move?.accounts?.[3]?.address).toBe(faucet.address);
    // transferSol: instruction 2, then the lamports; to the wallet itself.
    const sol = ixs[2];
    expect(Buffer.from(sol?.data ?? []).readUInt32LE(0)).toBe(2);
    expect(Buffer.from(sol?.data ?? []).readBigUInt64LE(4)).toBe(12_625_000n);
    expect(sol?.accounts?.[1]?.address).toBe(TO);
    // Nothing missing of a token: nothing built for it.
    const gasOnly = await solanaTestFundsInstructions(
      faucet,
      { to: TO, cashAddress: MINT, cashRaw: 0n, gasRaw: 1n },
      { tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6 },
    );
    expect(gasOnly.map((ix) => ix.programAddress)).toEqual([SYSTEM_PROGRAM_ADDRESS]);
  });

  it('on Robinhood Chain: transfers the test dollar from the float to the wallet, then sends ETH', () => {
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
          name: 'transfer',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      data: calls[0]?.data ?? '0x',
    });
    expect(decoded.functionName).toBe('transfer');
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
        solana: { rpc: solanaNode(DEVNET).rpc, genesisHash: DEVNET },
      }),
    ).rejects.toThrow(/not on a test network/);
  });

  it('refuses a key in the wrong form without repeating it', async () => {
    const err = await createFaucetSenders({ solana: 'secret-words' }, [testnetEntry('solana')], {
      solana: { rpc: solanaNode(DEVNET).rpc, genesisHash: DEVNET },
    }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/JSON array of 64 bytes/);
    expect((err as Error).message).not.toContain('secret-words');
  });
});

describe('the faucet signer asks its node which network it is', () => {
  it('on Solana: makes no sender for a node whose genesis is not devnet’s, nor without one to hold it to', async () => {
    const make = (node: string, genesisHash: string | null) =>
      createFaucetSenders({ solana: solanaKeyText() }, [testnetEntry('solana')], {
        solana: { rpc: solanaNode(node).rpc, genesisHash },
      });
    await expect(make(MAINNET_GENESIS_HASH, DEVNET)).rejects.toThrow(/not the test network/);
    await expect(make('another-network', DEVNET)).rejects.toThrow(/not the test network/);
    await expect(make(DEVNET, null)).rejects.toThrow(/genesis hash/);
    await expect(make(MAINNET_GENESIS_HASH, MAINNET_GENESIS_HASH)).rejects.toThrow(/genesis hash/);
    expect(await make(DEVNET, DEVNET)).toHaveLength(1);
  });

  it('on Solana: a send asks again, and signs nothing when the node has become another network', async () => {
    const node = solanaNode(DEVNET);
    const [sender] = await createFaucetSenders(
      { solana: solanaKeyText() },
      [testnetEntry('solana')],
      {
        solana: { rpc: node.rpc, genesisHash: DEVNET },
      },
    );
    node.answer(MAINNET_GENESIS_HASH);
    await expect(
      sender?.send({ to: TO, cashAddress: MINT, cashRaw: 1n, gasRaw: 1n }),
    ).rejects.toThrow(/not the test network/);
    expect(node.sent).not.toHaveBeenCalled();
  });

  it('on Robinhood Chain: makes no sender for a node of another chain id, and a send asks again', async () => {
    const entry = testnetEntry('robinhood');
    const chainId = entry.config.evmChainId as number;
    const node = evmNode(1);
    await expect(
      createFaucetSenders({ robinhood: generatePrivateKey() }, [entry], {
        robinhood: { rpc: node.rpc },
      }),
    ).rejects.toThrow(/chain 1, not/);
    node.answer(chainId);
    const [sender] = await createFaucetSenders({ robinhood: generatePrivateKey() }, [entry], {
      robinhood: { rpc: node.rpc },
    });
    node.answer(1);
    await expect(
      sender?.send({
        to: '0x1111111111111111111111111111111111111111',
        cashAddress: '0xd3d6e7bf284d922651983468b75492be4f3f689a',
        cashRaw: 1n,
        gasRaw: 1n,
      }),
    ).rejects.toThrow(/chain 1, not/);
    expect(node.sent).not.toHaveBeenCalled();
  });
});

const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** A chain on its real adapter on the test network, as the registry makes one. */
function testnetEntry(chain: 'solana' | 'robinhood'): ChainEntry {
  return {
    chain,
    mode: 'live',
    provenance: 'sandbox',
    source: 'a test network node',
    config: parseChainConfigs({})[chain],
    adapter: createMockAdapter({ chain }),
  };
}

/** A Solana key in solana-keygen's form. */
function solanaKeyText(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return JSON.stringify([...seed, ...pub]);
}

/** A Solana node that answers a genesis hash, which a test can change, and records any send. */
function solanaNode(genesis: string) {
  let now = genesis;
  const sent = vi.fn();
  const rpc = {
    getGenesisHash: () => ({ send: async () => now }),
    sendTransaction: (...args: unknown[]) => ({ send: async () => sent(...args) }),
  } as unknown as SolanaInputs['rpc'];
  return { rpc, sent, answer: (g: string) => (now = g) };
}

/** An EVM node that answers a chain id, which a test can change, and records any send. */
function evmNode(chainId: number) {
  let now = chainId;
  const sent = vi.fn();
  const rpc = {
    getChainId: async () => now,
    sendRawTransaction: sent,
    call: sent,
  } as unknown as PublicClient;
  return { rpc, sent, answer: (id: number) => (now = id) };
}

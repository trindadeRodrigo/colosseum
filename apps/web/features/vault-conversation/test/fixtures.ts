import { VaultResponse } from '@colosseum/schemas';
import { vaultOf } from '../../shared/test/fixtures';

// Sample chain reads and agent replies, confined to tests.
export const read = VaultResponse.parse({
  chain: 'solana',
  name: 'Solana',
  mode: 'live',
  provenance: 'sandbox',
  vault: {
    ...vaultOf({
      valueUsd: '100',
      cash: { asset: 'solana:usdc', raw: '80000000', multiplier: '1', display: '80' },
      positions: [
        {
          asset: 'solana:gldx',
          raw: '1',
          multiplier: '1',
          display: '1',
          valueUsd: '20',
          weightBps: 2000,
          targetBps: 3000,
          driftBps: -1000,
          lastKeeperAt: null,
        },
      ],
    }),
    provenance: 'sandbox',
  },
  prices: [],
  disclaimer: 'Test disclaimer',
});
export const preview = {
  objective: 'Consider a different allocation without changing this vault.',
  summary: 'A preview for discussion.',
  allocations: [
    {
      assetId: 'solana:gldx',
      weightBps: 4000,
      why: 'An explanation grounded in the supplied observation.',
      evidenceIds: ['exit'],
      symbol: 'tGLDx',
    },
    {
      assetId: 'solana:usdc',
      weightBps: 6000,
      why: 'Keeps a cash share.',
      evidenceIds: ['exit'],
      symbol: 'USDC',
    },
  ],
  tradeoffs: ['The weights differ from the current strategy.'],
  unknowns: ['No funded update command is available.'],
  sources: [
    {
      id: 'exit',
      source: 'fixture exit read',
      fetchedAt: '2026-10-05T12:00:00.000Z',
      method: 'test measured exit',
      provenance: 'sandbox',
      label: 'Measured cost',
      value: 0,
      unit: 'bps',
    },
    {
      id: 'unknown',
      source: 'fixture',
      fetchedAt: '2026-10-05T12:00:00.000Z',
      method: 'not observed',
      provenance: 'sandbox',
      label: 'Missing observation',
      value: null,
    },
  ],
};
export const reply = {
  version: 1,
  chain: read.chain,
  address: read.vault.address,
  messageId: 'message',
  message: 'Here is a preview to discuss, not an applied change.',
  question: null,
  proposal: preview,
};
export const emptyRead = VaultResponse.parse({
  ...read,
  vault: { ...vaultOf(), provenance: 'sandbox' },
});
export const cashRead = VaultResponse.parse({
  ...read,
  vault: { ...read.vault, positions: [], valueUsd: '80' },
});
export const unpricedRead = VaultResponse.parse({
  ...read,
  vault: {
    ...read.vault,
    positions: read.vault.positions.map((row) => ({ ...row, valueUsd: null, weightBps: 0 })),
    valueUsd: '80',
  },
});
export const otherRead = VaultResponse.parse({
  ...read,
  vault: { ...read.vault, address: read.vault.owner, basketId: '43' },
});
export const evmRead = VaultResponse.parse({
  ...read,
  chain: 'robinhood',
  vault: {
    ...read.vault,
    chain: 'robinhood',
    address: '0x204faca1764b154221e35c0d20abb3c525710498',
    owner: '0x204faca1764b154221e35c0d20abb3c525710498',
    keeper: '0x204faca1764b154221e35c0d20abb3c525710498',
    cash: { ...read.vault.cash, asset: 'robinhood:tusdg' },
    positions: read.vault.positions.map((row) => ({ ...row, asset: 'robinhood:tgld' })),
  },
});
export const longSourceLabel = 'A measured observation with a longer source label. '
  .repeat(5)
  .slice(0, 200);
export const longSourceReply = {
  ...reply,
  proposal: {
    ...reply.proposal,
    sources: reply.proposal.sources.map((source) =>
      source.id === 'exit' ? { ...source, label: longSourceLabel } : source,
    ),
  },
};

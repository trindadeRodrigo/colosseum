import { adapterContract } from './contract';
import { mockFixture } from './fixture';

// The check in the ledger row FRAME-1: the adapter contract tests pass on the mock, in both chain
// shapes (Solana: one trade a transaction, no approval; EVM: eight, with an approval).
adapterContract('chain-mock, solana', () => mockFixture('solana'));
adapterContract('chain-mock, robinhood', () => mockFixture('robinhood'));
adapterContract('chain-mock, base', () => mockFixture('base'));
adapterContract('chain-mock, solana, no new version', () =>
  mockFixture('solana', { newVersion: false }),
);

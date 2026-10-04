import { adapterContract } from '@colosseum/chain-mock/contract';
import { afterAll, describe, it, vi } from 'vitest';
import { PROGRAMS_BUILT } from './svm-node';
import { type Started, startValidator } from './validator';

// The adapter contract's two groups that need a node's own answers, on a local validator: signed bytes
// read back, relayed and found on the chain, a landing nobody reported found by `fate`, and the state
// each kind of transaction leaves once it lands, read back over RPC. The other five groups run in
// LiteSVM (contract.test.ts). Nothing leaves the machine. It needs the Solana tools and the built
// programs, and only runs when asked:
//
//   anchor build --no-idl -- --tools-version v1.54
//   SOLANA_LOCAL_VALIDATOR=1 pnpm exec vitest run tests/solana-vault/validator.test.ts
//
// SOLANA_ADAPTER_VALIDATOR_PORT moves it off 28999 and the forty ports above it.

const RUN = process.env.SOLANA_LOCAL_VALIDATOR === '1' && PROGRAMS_BUILT;
const PORT = Number(process.env.SOLANA_ADAPTER_VALIDATOR_PORT ?? 28_999);
const notBefore = new Date().toISOString();

let started: Promise<Started> | undefined;
/** One validator for the file, started the first time a setup asks for it. */
const validator = () => {
  started ??= startValidator(PORT, notBefore);
  return started;
};

if (RUN) {
  // Starting the validator and building the world takes a few minutes: two publish delays are waited.
  vi.setConfig({ hookTimeout: 600_000, testTimeout: 120_000 });
  afterAll(async () => {
    (await started)?.stop();
  });
  adapterContract('solana, on a local validator', async () => (await validator()).world.fixture, {
    groups: ['signed bytes', 'state after a transaction lands'],
  });
} else
  describe.skip('adapter contract: solana, on a local validator (SOLANA_LOCAL_VALIDATOR=1 runs it)', () => {
    it('needs a validator and the built programs', () => {});
  });

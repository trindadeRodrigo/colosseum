import type { BasketTx } from './basket-tx';
import type { ChainId } from './chain';
import type { Chain } from './enums';
import type { Leg } from './order';
import type { TxStatus } from './vault';

// DESIGN-VAULT 3.5. The keeper plans from chain state and signs in the same pass. A keeper_legs row is
// its own log and idempotency key, unique on (vault_id, keeper_run_id, seq). It never signs from a
// stored row.

export interface Submitter {
  chain: ChainId;
  submit(leg: Leg): Promise<{ txId: string; validUntil?: string; nonce?: number }>;
  status(txId: string, validUntil?: string): Promise<TxStatus['status']>;
}

export interface Signer {
  address(family: Chain): string;
  sign(family: Chain, tx: BasketTx): Promise<string>;
}

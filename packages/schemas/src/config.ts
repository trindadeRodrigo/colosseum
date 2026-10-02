import { z } from 'zod';
import { ChainConfig } from './chain-config';
import { Provenance } from './enums';
import { ChainMode, Flags } from './flags';

/**
 * One chain as GET /v1/config reports it: where it is, how it is run, and the label its figures carry
 * (chainProvenance). The label is null for a chain that is off.
 */
export const ChainStatus = ChainConfig.extend({
  mode: ChainMode,
  provenance: Provenance.nullable(),
});
export type ChainStatus = z.infer<typeof ChainStatus>;

/** GET /v1/config. No secret and no RPC URL is part of it. */
export const ConfigResponse = z.object({ flags: Flags, chains: z.array(ChainStatus) });
export type ConfigResponse = z.infer<typeof ConfigResponse>;

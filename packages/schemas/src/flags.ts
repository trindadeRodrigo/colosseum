import { z } from 'zod';
import { ChainId } from './chain';

// DESIGN-VAULT section 2. A failed gate flips a flag; it does not change code. No library reads
// process.env: each app calls parseFlags once and passes the result down.

/** What an app hands in: process.env or any record shaped like it. */
export type EnvLike = Record<string, string | undefined>;

/**
 * `live` trades, `readonly` reads the chain and builds nothing, `mock` runs on packages/chain-mock.
 * `off` is not in the design's list: it is how a chain that is in the types but not deployed stays out.
 */
export const ChainMode = z.enum(['live', 'readonly', 'mock', 'off']);
export type ChainMode = z.infer<typeof ChainMode>;

export const Flags = z.object({
  /** CHAIN_MODE_<CHAIN> */
  chainMode: z.record(ChainId, ChainMode),
  /** AUTO_FOLLOW_<CHAIN> */
  autoFollow: z.record(ChainId, z.boolean()),
  /** KEEPER_ENABLED */
  keeperEnabled: z.boolean(),
  /** AGENT_SURFACE */
  agentSurface: z.boolean(),
  /** LEGACY_STRUCTURER: the structurer's server-signing routes. */
  legacyStructurer: z.boolean(),
});
export type Flags = z.infer<typeof Flags>;

/** With nothing set, no chain is touched, nothing signs on its own, and Base is out. */
export const DEFAULT_FLAGS: Flags = {
  chainMode: { solana: 'mock', robinhood: 'mock', base: 'off' },
  autoFollow: { solana: false, robinhood: false, base: false },
  keeperEnabled: false,
  agentSurface: false,
  legacyStructurer: false,
};

const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['off', 'false', '0', 'no']);

function read(env: EnvLike, key: string): string | undefined {
  const v = env[key]?.trim().toLowerCase();
  return v === '' ? undefined : v;
}

function bool(env: EnvLike, key: string, fallback: boolean): boolean {
  const v = read(env, key);
  if (v === undefined) return fallback;
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  throw new Error(`${key}: expected on or off, got "${env[key]}"`);
}

/** The env key of a per-chain setting: envKey('CHAIN_MODE', 'robinhood') is CHAIN_MODE_ROBINHOOD. */
export function envKey(prefix: string, chain: ChainId): string {
  return `${prefix}_${chain.toUpperCase()}`;
}

/**
 * Pure: reads only the record it is given. An unset or empty variable takes the default; a value it
 * does not know throws, so a typo stops the app at start instead of switching something silently.
 */
export function parseFlags(env: EnvLike): Flags {
  const chainMode = { ...DEFAULT_FLAGS.chainMode };
  const autoFollow = { ...DEFAULT_FLAGS.autoFollow };
  for (const chain of ChainId.options) {
    const key = envKey('CHAIN_MODE', chain);
    const v = read(env, key);
    if (v !== undefined) {
      const mode = ChainMode.safeParse(v);
      if (!mode.success)
        throw new Error(`${key}: expected ${ChainMode.options.join(', ')}, got "${env[key]}"`);
      chainMode[chain] = mode.data;
    }
    autoFollow[chain] = bool(env, envKey('AUTO_FOLLOW', chain), DEFAULT_FLAGS.autoFollow[chain]);
  }
  return {
    chainMode,
    autoFollow,
    keeperEnabled: bool(env, 'KEEPER_ENABLED', DEFAULT_FLAGS.keeperEnabled),
    agentSurface: bool(env, 'AGENT_SURFACE', DEFAULT_FLAGS.agentSurface),
    legacyStructurer: bool(env, 'LEGACY_STRUCTURER', DEFAULT_FLAGS.legacyStructurer),
  };
}

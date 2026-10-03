import { z } from 'zod';
import { ChainId } from './chain';

// DESIGN-VAULT section 2. A failed gate flips a flag; it does not change code. No library reads
// process.env: each app calls parseFlags once and passes the result down.

/** What an app hands in: process.env or any record shaped like it. */
export type EnvLike = Record<string, string | undefined>;

/**
 * `live` trades, `readonly` reads the chain and builds nothing, `mock` runs on packages/chain-mock,
 * `off` leaves the chain out: no adapter, nothing shown.
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

/**
 * With nothing set, no chain is touched, nothing signs on its own, and Base is out.
 * `legacyStructurer` is off: the API registers the structurer's server-signing routes only when it is
 * on (API-2), so with nothing set no route reaches a signer.
 */
export const DEFAULT_FLAGS: Flags = {
  chainMode: { solana: 'mock', robinhood: 'mock', base: 'off' },
  autoFollow: { solana: false, robinhood: false, base: false },
  keeperEnabled: false,
  agentSurface: false,
  legacyStructurer: false,
};

/** The env key of a per-chain setting: envKey('CHAIN_MODE', 'robinhood') is CHAIN_MODE_ROBINHOOD. */
export function envKey(prefix: string, chain: ChainId): string {
  return `${prefix}_${chain.toUpperCase()}`;
}

/** Per-chain settings read by parseFlags and by parseChainConfigs. */
const PER_CHAIN = [
  'CHAIN_MODE',
  'AUTO_FOLLOW',
  'CHAIN_NETWORK',
  'CHAIN_ROUTER',
  'CHAIN_PRICE_SOURCE',
];
/** Names under these prefixes are ours: one that is not known is a typo, and a typo is refused. */
const OWNED_PREFIXES = ['CHAIN_', 'AUTO_FOLLOW_', 'KEEPER_'];

/** Every variable the flags and the chain configs read. */
export const KNOWN_ENV_KEYS: readonly string[] = [
  ...PER_CHAIN.flatMap((prefix) => ChainId.options.map((chain) => envKey(prefix, chain))),
  'KEEPER_ENABLED',
  'AGENT_SURFACE',
  'LEGACY_STRUCTURER',
];

/**
 * Throws on a set variable that starts with CHAIN_, AUTO_FOLLOW_ or KEEPER_ and is not one we read:
 * CHAIN_MODE_ROBINHOD=live would otherwise leave the chain on its default without a word. An app that
 * reads more variables under those prefixes (a keeper key path) lists them in `alsoKnown`.
 */
export function checkEnvNames(env: EnvLike, alsoKnown: readonly string[] = []): void {
  const known = new Set([...KNOWN_ENV_KEYS, ...alsoKnown]);
  const unknown = Object.keys(env).filter(
    (key) =>
      env[key] !== undefined &&
      OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
      !known.has(key),
  );
  if (unknown.length) throw new Error(`unknown variable: ${unknown.sort().join(', ')}`);
}

const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['off', 'false', '0', 'no']);

/** A trimmed, lower-cased value, or undefined when unset or empty. */
export function readEnv(env: EnvLike, key: string): string | undefined {
  const v = env[key]?.trim().toLowerCase();
  return v === '' ? undefined : v;
}

// An error names the variable and what it may hold. It never repeats the value: a secret pasted into
// the wrong variable must not reach a log.
function bool(env: EnvLike, key: string, fallback: boolean): boolean {
  const v = readEnv(env, key);
  if (v === undefined) return fallback;
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  throw new Error(`${key}: expected on or off`);
}

/**
 * Pure: reads only the record it is given. An unset or empty variable takes the default; a value or a
 * name it does not know throws, so a typo stops the app at start instead of switching something
 * silently.
 */
export function parseFlags(env: EnvLike, alsoKnown: readonly string[] = []): Flags {
  checkEnvNames(env, alsoKnown);
  const chainMode = { ...DEFAULT_FLAGS.chainMode };
  const autoFollow = { ...DEFAULT_FLAGS.autoFollow };
  for (const chain of ChainId.options) {
    const key = envKey('CHAIN_MODE', chain);
    const v = readEnv(env, key);
    if (v !== undefined) {
      const mode = ChainMode.safeParse(v);
      if (!mode.success) throw new Error(`${key}: expected ${ChainMode.options.join(', ')}`);
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

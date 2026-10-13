// The token list of a chain, from the issuer's own registry, each address checked on chain
// (PLAN-UNIVERSE RU.2). No I/O here but the two readers at the bottom; the rest is pure.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Call, decodeSymbol, decodeUint, SEL } from './abi';
import type { Reply } from './multicall';

/** The issuer's registry per chain id of config.ts. A public GET, no key. */
export const REGISTRY_URL: Record<string, string> = {
  robinhood: 'https://api.robinhood.com/rhj/assets',
};

export const UNIVERSE_METHOD = 'issuer_registry_confirmed_onchain';

export type RegistryToken = {
  /** The key of a token everywhere below: two tokens may share a symbol, never an address. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  isin: string | null;
  /** The registry's own status word, as given. */
  status: string;
  /** Underlying shares per token as the registry states it, a decimal string; null when absent. */
  multiplier: string | null;
  registryId: string;
};

export type Skipped = { symbol: string; reason: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * The tokens the registry deploys on `chainId`, in the registry's order. An entry with no deployment
 * there, no valid address, or an address already listed is left out with the reason.
 */
export function parseRegistry(
  json: unknown,
  chainId: number,
): { tokens: RegistryToken[]; skipped: Skipped[] } {
  const assets = (json as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) throw new Error('registry: no list of assets in the answer');
  const tokens: RegistryToken[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const a of assets as Array<Record<string, unknown>>) {
    const symbol = text(a?.tokenSymbol) ?? '?';
    const deployments = Array.isArray(a?.deployments)
      ? (a.deployments as Array<Record<string, unknown>>)
      : [];
    const here = deployments.filter((d) => d?.chainId === chainId);
    if (here.length === 0) {
      skipped.push({ symbol, reason: 'no_deployment_on_this_chain' });
      continue;
    }
    for (const d of here) {
      const address = d.contractAddress;
      const decimals = a.tokenDecimals;
      if (!isAddress(address)) skipped.push({ symbol, reason: 'not_an_address' });
      else if (symbol === '?') skipped.push({ symbol: address, reason: 'no_symbol' });
      else if (!(Number.isInteger(decimals) && (decimals as number) >= 0))
        skipped.push({ symbol, reason: 'no_decimals' });
      else if (seen.has(address.toLowerCase()))
        skipped.push({ symbol, reason: 'address_listed_twice' });
      else {
        seen.add(address.toLowerCase());
        tokens.push({
          address,
          symbol,
          name: text(a.tokenName) ?? symbol,
          decimals: decimals as number,
          isin: text(a.isin),
          status: text(a.status) ?? 'unknown',
          multiplier: text(a.currentMultiplier),
          registryId: text(a.id) ?? '',
        });
      }
    }
  }
  return { tokens, skipped };
}

/** Two reads per token: decimals() and symbol(). */
export const tokenChecks = (tokens: Array<{ address: string }>): Call[] =>
  tokens.flatMap((t) => [
    { target: t.address, callData: `0x${SEL.decimals}` },
    { target: t.address, callData: `0x${SEL.symbol}` },
  ]);

export type UniverseToken = RegistryToken & {
  /** What the contract itself answered; null where it gave no answer. */
  onchain: { symbol: string | null; decimals: number | null };
  /** True when the contract answers and agrees with the registry on both. */
  confirmed: boolean;
  /** Why not, when it is not. */
  reason: 'no_answer_from_the_contract' | 'decimals_differ' | 'symbol_differs' | null;
};

/** The registry's tokens with the chain's word on each. `replies` are the answers to tokenChecks. */
export function confirmTokens(tokens: RegistryToken[], replies: Reply[]): UniverseToken[] {
  if (replies.length !== tokens.length * 2)
    throw new Error(`confirmTokens: ${tokens.length} tokens, ${replies.length} answers`);
  return tokens.map((t, i) => {
    const [dec, sym] = [replies[i * 2] as Reply, replies[i * 2 + 1] as Reply];
    const decimals = dec.success && dec.data.length === 66 ? Number(decodeUint(dec.data)) : null;
    const symbol = sym.success ? decodeSymbol(sym.data) : null;
    const reason =
      decimals === null || symbol === null
        ? 'no_answer_from_the_contract'
        : decimals !== t.decimals
          ? 'decimals_differ'
          : symbol !== t.symbol
            ? 'symbol_differs'
            : null;
    return { ...t, onchain: { symbol, decimals }, confirmed: reason === null, reason };
  });
}

export type UniverseFile = {
  chain: string;
  chainId: number;
  provenance: 'live';
  source: string;
  method: string;
  /** Time of the block the contracts were read at. */
  fetchedAt: string;
  block: number;
  registry: { url: string; fetchedAt: string; assets: number };
  counts: { tokens: number; confirmed: number; notConfirmed: number; skipped: number };
  rpc: { rpcCalls: number; httpRequests: number; seconds: number };
  tokens: UniverseToken[];
  skipped: Skipped[];
};

/** `20261005T1810` for a file name: the minute, in UTC. */
export const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, '');

/** The newest `<prefix>-<chain>-<stamp>.json` in `dir`, or null. The stamp sorts as text. */
export function latestFile(dir: string, prefix: string, chain: string): string | null {
  if (!existsSync(dir)) return null;
  const re = new RegExp(`^${prefix}-${chain}-\\d{8}T\\d{4}\\.json$`);
  const names = readdirSync(dir)
    .filter((n) => re.test(n))
    .sort();
  const last = names.at(-1);
  return last ? join(dir, last) : null;
}

export function readUniverse(path: string): UniverseFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as UniverseFile;
  if (!Array.isArray(file?.tokens) || typeof file.chainId !== 'number')
    throw new Error(`${path} is not a universe file`);
  return file;
}

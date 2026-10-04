import type { FoundWallet } from './driver';

// The outside wallets a person can sign in with, found in the browser itself, so the sign-in screen
// lists them on our own primitives and the wallet provider's window is never opened.
//
// EVM wallets announce themselves (EIP-6963): the page asks, and each wallet answers with its name and
// its provider. Solana wallets register with the wallet standard; the provider's own hook reads that
// registry and hands the list in (privy-bridge.tsx). A wallet that only sets `window.ethereum`, with
// no announcement, is not listed: every current wallet announces.

/** What an EVM wallet hands a page (EIP-1193). */
export type Eip1193 = {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
};

export type AnnouncedWallet = {
  /** The wallet's reverse domain name: "io.metamask". It is what tells two wallets apart. */
  rdns: string;
  name: string;
  provider: Eip1193;
};

type Announcement = { info?: { rdns?: unknown; name?: unknown }; provider?: unknown };

const isProvider = (value: unknown): value is Eip1193 =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { request?: unknown }).request === 'function';

/** What an announcement holds, or null when it is not one. A name is cut to what a button can show. */
export function readAnnouncement(detail: unknown): AnnouncedWallet | null {
  const { info, provider } = (
    typeof detail === 'object' && detail !== null ? detail : {}
  ) as Announcement;
  if (typeof info?.rdns !== 'string' || typeof info.name !== 'string' || !isProvider(provider))
    return null;
  const rdns = info.rdns.trim();
  const name = info.name.trim().slice(0, 40);
  return rdns && name ? { rdns, name, provider } : null;
}

/**
 * Asks the browser's EVM wallets to announce themselves and reports the list each time it grows.
 * Returns what stops the listening.
 */
export function watchEvmWallets(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener' | 'dispatchEvent'>,
  onChange: (wallets: AnnouncedWallet[]) => void,
): () => void {
  const found = new Map<string, AnnouncedWallet>();
  const heard = (event: Event) => {
    const wallet = readAnnouncement((event as CustomEvent<unknown>).detail);
    if (!wallet || found.has(wallet.rdns)) return;
    found.set(wallet.rdns, wallet);
    onChange([...found.values()]);
  };
  target.addEventListener('eip6963:announceProvider', heard);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', heard);
}

export const evmWalletId = (rdns: string) => `evm:${rdns}`;
export const solanaWalletId = (name: string) => `solana:${name}`;

/** What the sign-in screen lists: Solana first, then EVM, each by name. */
export function foundWallets(
  solana: readonly { name: string }[],
  evm: readonly AnnouncedWallet[],
): FoundWallet[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [
    ...[...solana].sort(byName).map((w) => ({
      id: solanaWalletId(w.name),
      name: w.name,
      family: 'solana' as const,
    })),
    ...[...evm]
      .sort(byName)
      .map((w) => ({ id: evmWalletId(w.rdns), name: w.name, family: 'evm' as const })),
  ];
}

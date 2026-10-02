/**
 * Shipped in every build, as the name of the wallet context. scripts/check-build.mjs looks for it to
 * prove it is reading the files a build writes. Never rename without that script.
 */
export const WALLET_MARKER = 'wallet-port:shipped';

import type { FrameRule } from './frame-policy';

// What every address answers with, beside who may frame it (frame-policy.ts). Each is one a browser
// obeys without the page's help, and none depends on what the page loads:
//
// - Strict-Transport-Security: the browser comes back over https for two years. No `includeSubDomains`
//   and no `preload`: both bind names this app does not own alone, and are a person's decision.
// - X-Content-Type-Options: a response is read as the type it says, never sniffed into a script.
// - Referrer-Policy: another site learns the origin a person came from, never the path. A plan's
//   link (`/plan/<id>`) and a vault's address are in the path.
// - Permissions-Policy: the device features nothing here uses are off for the page and its frames.
//   Passkeys (`publickey-credentials-*`), the clipboard and USB or HID wallets are left as they are.
//
// A policy for scripts and connections (`script-src`, `connect-src`) is not here: it needs a nonce on
// every script Next writes and the full list of what the sign-in library reaches, and is its own
// piece of work (SEC-PASS-1 in the ledger).

export const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
] as const;

/** One rule for every address, the embed's included. */
export function securityHeaders(): FrameRule[] {
  return [{ source: '/:path*', headers: SECURITY_HEADERS.map((h) => ({ ...h })) }];
}

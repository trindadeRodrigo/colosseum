// What a page may load and reach, as a policy the browser only reports on (SEC-PASS-1, decision 3):
// `Content-Security-Policy-Report-Only`. Nothing is blocked. A page that breaks the policy says so in
// the browser's console, and to `CSP_REPORT_URI` when a deployment names one; the reports are how the
// list below is finished before the policy is ever enforced. Who may frame a page is not here: that
// policy is enforced, in its own header (frame-policy.ts), and a browser ignores `frame-ancestors`
// in a policy it only reports on.
//
// Scripts: this app's own, by a nonce made for each request (proxy.ts), and what those load
// (`strict-dynamic`). Next puts the nonce on every script it writes into a page rendered for the
// request; a page built ahead of time has none, and reports its scripts until it is rendered so.
// Styles: this app's own and inline ones, which the charts and the embed's theme set as attributes.
// Connections: this app, its API, the nodes the wallet and the executor read, and what the sign-in
// library reaches (Privy and WalletConnect, from Privy's own guide to a policy).

/** What the policy is made from: the public addresses a build was given. */
export type PolicyEnv = {
  api?: string;
  riskApi?: string;
  /** The nodes a deployment names, beside the defaults of features/wallet/chains.ts. */
  nodes?: (string | undefined)[];
  /** Where reports go, when a deployment names an address; console only without. */
  reportUri?: string;
};

/** The nodes the wallet reads by default on each chain's two networks (features/wallet/chains.ts). */
export const DEFAULT_NODES = [
  'https://api.mainnet-beta.solana.com',
  'https://api.devnet.solana.com',
  'https://rpc.mainnet.chain.robinhood.com',
  'https://rpc.testnet.chain.robinhood.com',
  'https://mainnet.base.org',
  'https://sepolia.base.org',
] as const;

/** The sign-in library's hosts (Privy's guide to a content security policy). */
const SIGN_IN = {
  connect: [
    'https://auth.privy.io',
    'https://*.rpc.privy.systems',
    'https://explorer-api.walletconnect.com',
    'https://pulse.walletconnect.org',
    'https://api.web3modal.org',
    'wss://relay.walletconnect.com',
    'wss://relay.walletconnect.org',
    'wss://www.walletlink.org',
  ],
  frame: [
    'https://auth.privy.io',
    'https://verify.walletconnect.com',
    'https://verify.walletconnect.org',
    'https://challenges.cloudflare.com',
  ],
  script: ['https://challenges.cloudflare.com'],
} as const;

/** An address as an origin a policy can name: https or wss, or http on this machine. Else null. */
export function sourceOf(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    !['https:', 'wss:'].includes(url.protocol) &&
    !(local && ['http:', 'ws:'].includes(url.protocol))
  )
    return null;
  // the origin only: a path or a key in the address is never written into a header
  return url.origin;
}

/** A node's origin and the socket beside it: a Solana node is subscribed to over wss. */
const withSocket = (origin: string) => [origin, origin.replace(/^http/, 'ws')];

/** Every origin a page may connect to, each once. */
export function connectSources(env: PolicyEnv): string[] {
  const nodes = [...DEFAULT_NODES, ...(env.nodes ?? [])]
    .map(sourceOf)
    .filter((origin): origin is string => origin !== null)
    .flatMap(withSocket);
  const apis = [env.api, env.riskApi].map(sourceOf).filter((o): o is string => o !== null);
  return [...new Set(["'self'", ...apis, ...nodes, ...SIGN_IN.connect])];
}

/** The policy for one request, as the header's value. `dev`: React's debugging needs `eval`. */
export function reportOnlyPolicy(nonce: string, env: PolicyEnv, dev = false): string {
  const report = sourceOf(env.reportUri) ? env.reportUri : null;
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''} ${SIGN_IN.script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connectSources(env).join(' ')}`,
    `frame-src 'self' ${SIGN_IN.frame.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(report ? [`report-uri ${report}`] : []),
  ];
  return directives.join('; ');
}

export const REPORT_ONLY = 'Content-Security-Policy-Report-Only';

/** A nonce for one request: 128 bits, base64. */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

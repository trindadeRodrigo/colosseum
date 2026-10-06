import { type NextRequest, NextResponse } from 'next/server';
import { makeNonce, REPORT_ONLY, reportOnlyPolicy } from './lib/content-policy';
import { FRAMED_BY_NOBODY, isEmbedPage } from './lib/frame-policy';

// Two things, on every page.
//
// The frame policy's last word (lib/frame-policy.ts): next.config.ts gives the embed's two addresses
// the partners' policy, matched without regard to case; an address that took it and is not one of
// the two, exactly, is held to nobody here.
//
// The policy the browser only reports on (lib/content-policy.ts): a nonce for this request, in the
// header the page is rendered with, so Next puts it on the scripts it writes, and in the answer.

/** The public addresses the build was given. Each is named in full: a build writes them in. */
const ENV = {
  api: process.env.NEXT_PUBLIC_API_URL,
  riskApi: process.env.NEXT_PUBLIC_RISK_API_URL,
  nodes: [
    process.env.NEXT_PUBLIC_CHAIN_READ_RPC_SOLANA,
    process.env.NEXT_PUBLIC_CHAIN_READ_RPC_ROBINHOOD,
    process.env.NEXT_PUBLIC_CHAIN_READ_RPC_BASE,
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
  ],
  reportUri: process.env.CSP_REPORT_URI,
};

export function proxy(request: NextRequest) {
  const policy = reportOnlyPolicy(makeNonce(), ENV, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set(REPORT_ONLY, policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REPORT_ONLY, policy);
  // Only where the rule of next.config.ts is wrong: an address it takes for the embed that is not.
  // On every other page that rule already answers, and an enforced policy set here would be the one
  // Next reads the nonce from: it has none, and the page's scripts would go without.
  const { pathname } = request.nextUrl;
  if (/^\/embed(\/|$)/i.test(pathname) && !isEmbedPage(pathname))
    for (const { key, value } of FRAMED_BY_NOBODY) response.headers.set(key, value);
  return response;
}

// Next matches a proxy's paths with their case, so the first two spell each letter of /embed both
// ways: every address the frame rule in next.config.ts takes reaches this function, a prefetch
// included. The third is every other page; a prefetch and a built file need no policy of their own.
export const config = {
  matcher: [
    '/([eE][mM][bB][eE][dD])',
    '/([eE][mM][bB][eE][dD])/:path*',
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
